// Shared, provider-agnostic pieces for the harness runners (openrouter-runner.mjs
// drives @openrouter/agent; local-runner.mjs drives any OpenAI chat/completions
// endpoint incl. Ollama/LM Studio). Kept here so the security-relevant system
// preamble and the tool set (names/descriptions/executors) live in ONE place and
// can't drift between the two runners; each runner only renders the tool specs
// into its provider's format (zod for the Agent SDK, JSON Schema for chat/
// completions). The security-critical executors themselves live in
// openrouter-tools.mjs.
import { runCli, readFile, writeFile, editFile, loadSkill } from "./openrouter-tools.mjs";

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// A diagnostic breadcrumb rendered into the daemon log (`[id] note: ...`). Unlike
// console.error (which runAgent only surfaces on a NON-zero exit), a note is a
// normal stdout event, so it's visible on successful runs too -- used to show
// when a nudge/poke fires and whether an openrouter resume failed.
export function note(text) {
  emit({ t: "note", text });
}

// Sent once when the model ends a turn with NO text and NO tool call -- a
// degenerate non-answer some models emit after a tool error, then give up.
// Because Baxter's own reply is itself a tool call (discord-cli/gmail reply), an
// empty turn means it stops without ever replying. Nudging once turns that into
// a real finish (or a retry) instead of a silent empty "success". Shared by both
// runners so the wording can't drift.
export const EMPTY_TURN_NUDGE =
  "You ended your turn with no message and no tool call. If a tool just failed, correct it and try again (or use a different approach); otherwise send your reply to the user now using the appropriate tool. Do not stop with an empty response.";

// Sent once when a reply-expecting run ends with a composed answer as TEXT but
// never actually sent it (no discord-cli/gmail reply|send). The user only sees
// what's posted via a tool -- a final message is invisible to them -- so weak
// models that "present" the answer instead of sending it leave the user in
// silence. This pokes the model to reformat that text into the send tool call.
export const UNSENT_REPLY_NUDGE =
  "You wrote a reply but never sent it -- the user only receives messages you post with a tool, NOT your final message text. Send it now: reformat that reply into the appropriate tool call (e.g. run_cli discord-cli reply <channelId> <messageId> with the text as stdin) and post it. Respond with only that tool call.";

// True iff a tool call actually delivers a message to the user (a reply/send),
// as opposed to a reaction/edit/read/etc. Used to tell "answered but never sent"
// (a give-up) from a run that legitimately replied. Covers Discord + email.
export function isDeliveryCall(toolName, params) {
  if (toolName !== "run_cli" || !params) return false;
  const sub = Array.isArray(params.args) ? params.args[0] : undefined;
  if (params.cli === "discord-cli") return sub === "reply" || sub === "send" || sub === "send-thread";
  if (params.cli === "gmail") return sub === "reply" || sub === "send";
  return false;
}

export function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Bridge the Claude-oriented prompt (which names "the Bash tool", "the Skill
// tool", a "restricted shell", heredocs/pipes) onto our structured tools. Shared
// verbatim by both runners -- a second copy would silently drift on edits.
export function systemPreamble(cliMap) {
  const clis = Object.keys(cliMap).join(", ") || "(none)";
  return [
    "You are an autonomous agent. You can ACT ONLY by calling the tools provided -- there is no shell and no other way to run commands.",
    "",
    "Tool mapping (the task instructions below were written for a different tool naming; translate as follows):",
    `- Any command the instructions show as \`discord-cli …\`, \`code-cli …\`, \`schedule-cli …\`, \`playwright-cli …\`, \`invisible-cli …\` (or \`node <gmail> …\`) is a **run_cli** call: run_cli({cli, args:[…], stdin}). Available CLIs: ${clis}. Put any message/program body in \`stdin\` (never a heredoc or pipe -- there is no shell).`,
    "- Web research the instructions call `WebSearch`/`WebFetch` (or \"search the web\" / \"read a page's content\") is the **web-cli** CLI via run_cli: run_cli({cli:\"web-cli\", args:[\"search\", \"<query>\"]}) or run_cli({cli:\"web-cli\", args:[\"fetch\", \"<url>\"]}). For a JavaScript-heavy page or when search is blocked, use playwright-cli / invisible-cli via run_cli instead.",
    "- \"Use/open/see the X skill\" or \"the Skill tool\" means **load_skill({name:\"X\"})** to read that skill's reference, then act with run_cli.",
    "- Reading or writing files means **read_file / write_file / edit_file**; you can only touch files in your working directory.",
    "- Ignore guidance about a \"restricted shell\", allowed/denied Bash, compound commands, or heredocs -- those describe the other harness; here you just call the structured tools above.",
    "",
    "ACT, don't describe: sending a message to the user (a Discord reply, an email) is itself a tool call (run_cli discord-cli / gmail ...), never just text in your final message. Do NOT end your turn by describing an action you have not performed -- if your final message says you are replying, sending, or about to do something, you MUST have already made that tool call in this same run. A message that only narrates intent (e.g. \"now I'll send the reply\") leaves the task UNDONE.",
    "",
    "Do the task the instructions describe -- including actually sending any reply it calls for -- then stop with a short final message.",
  ].join("\n");
}

// The tools applicable to a run, given its cli allowlist + native-tool grants.
// Each spec: { name, description, params, executor }, where params is a list of
// { name, type: "string" | "string[]", required, description } that each runner
// converts to its provider's schema form. run_cli's text depends on the cli list.
export function toolSpecs(cliMap, native) {
  const clis = Object.keys(cliMap).join(", ");
  const specs = [];
  if (Object.keys(cliMap).length) {
    specs.push({
      name: "run_cli",
      description: `Run one of Baxter's command-line tools (${clis}). No shell -- pass the CLI name, its arguments as a string array, and an optional stdin body (for tools that read a message/program on stdin, e.g. discord-cli/code-cli). Example: run_cli({cli:"discord-cli", args:["reply","<channelId>","<messageId>"], stdin:"your reply text"}).`,
      params: [
        { name: "cli", type: "string", required: true, description: `the CLI to run; one of: ${clis}` },
        { name: "args", type: "string[]", required: false, description: "arguments, as a list of strings" },
        { name: "stdin", type: "string", required: false, description: "text piped to the CLI's stdin (message body, program source, etc.)" },
      ],
      executor: runCli,
    });
  }
  if (native.has("Read")) {
    specs.push({ name: "read_file", description: "Read a file in your working directory.", params: [{ name: "path", type: "string", required: true }], executor: readFile });
  }
  if (native.has("Write")) {
    specs.push({ name: "write_file", description: "Create or overwrite a file in your working directory.", params: [{ name: "path", type: "string", required: true }, { name: "content", type: "string", required: true }], executor: writeFile });
  }
  if (native.has("Edit")) {
    specs.push({ name: "edit_file", description: "Replace an exact, unique substring in a file in your working directory.", params: [{ name: "path", type: "string", required: true }, { name: "old_string", type: "string", required: true }, { name: "new_string", type: "string", required: true }], executor: editFile });
  }
  if (native.has("Skill")) {
    specs.push({ name: "load_skill", description: "Read a skill's SKILL.md for its full command reference.", params: [{ name: "name", type: "string", required: true }], executor: loadSkill });
  }
  return specs;
}

// Render a spec's params as an OpenAI-style JSON Schema (for chat/completions).
export function toJsonSchema(spec) {
  const properties = {};
  const required = [];
  for (const p of spec.params) {
    properties[p.name] = p.type === "string[]" ? { type: "array", items: { type: "string" } } : { type: "string" };
    if (p.description) properties[p.name].description = p.description;
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required };
}

// Execute one tool call: emit tool_use, run the executor (never throws), emit
// tool_result, and return the result to the model. Shared by both runners so the
// event shape + error handling stay identical.
export async function runTool(spec, params, ctx) {
  emit({ t: "tool_use", name: spec.name, input: params });
  let result;
  try {
    result = await spec.executor(params, ctx);
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  emit({ t: "tool_result", is_error: result?.ok === false, content: result });
  return result;
}
