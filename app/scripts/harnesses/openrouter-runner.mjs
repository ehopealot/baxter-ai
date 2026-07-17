#!/usr/bin/env node
// OpenRouter harness runner -- an alternative to `claude -p` for driving Baxter.
// Spawned by runtime.mjs's runAgent (via harnesses/openrouter.mjs) exactly like
// claude: it reads the rendered prompt on STDIN, runs @openrouter/agent's
// callModel loop with our structured tools, and emits normalized JSONL events on
// stdout (decoded by the adapter's parseEvents) plus a final `result` line.
//
// The security-critical tool logic (CLI allowlist, cwd confinement) lives in
// openrouter-tools.mjs; this file only wraps it in the SDK's tool()/callModel and
// bridges the Claude-oriented prompt onto structured tools. cwd is set by the
// spawning daemon to MEMORY_DIR, so process.cwd() bounds file access; the daemon
// also strips the Discord/Gmail tokens from this process's env (RUN_ENV).
import { OpenRouter, tool, stepCountIs } from "@openrouter/agent";
import { z } from "zod";
import { parseAllowedTools, runCli, readFile, writeFile, editFile, loadSkill } from "./openrouter-tools.mjs";
import { envInt } from "../schedule-store.mjs";

// envInt fails loud on a non-integer value rather than propagating NaN: a NaN
// step cap makes stepCountIs never fire (unbounded loop on a paid API), a NaN
// timeout is falsy (no CLI timeout), and a NaN byte cap blanks every output.
// Same fail-closed posture as the daemons' numeric knobs.
const CLI_OUT_MAX_BYTES = envInt("OPENROUTER_CLI_OUTPUT_MAX_BYTES", 256 * 1024);
const CLI_TIMEOUT_MS = envInt("OPENROUTER_CLI_TIMEOUT_MS", 120000);
const MAX_STEPS = envInt("OPENROUTER_MAX_STEPS", 40);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Wrap a pure executor as an SDK tool that emits tool_use before and tool_result
// after -- live per-tool visibility without needing SDK step hooks.
function wrap(name, description, inputSchema, executor, ctx) {
  return tool({
    name,
    description,
    inputSchema,
    execute: async (params) => {
      emit({ t: "tool_use", name, input: params });
      let result;
      try {
        result = await executor(params, ctx);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      emit({ t: "tool_result", is_error: result?.ok === false, content: result });
      return result;
    },
  });
}

function buildTools(cliMap, native, ctx) {
  const tools = [];
  if (Object.keys(cliMap).length) {
    tools.push(
      wrap(
        "run_cli",
        `Run one of Baxter's command-line tools (${Object.keys(cliMap).join(", ")}). No shell -- pass the CLI name, its arguments as a string array, and an optional stdin body (for tools that read a message/program on stdin, e.g. discord-cli/code-cli). Example: run_cli({cli:"discord-cli", args:["reply","<channelId>","<messageId>"], stdin:"your reply text"}).`,
        z.object({
          cli: z.string().describe(`the CLI to run; one of: ${Object.keys(cliMap).join(", ")}`),
          args: z.array(z.string()).optional().describe("arguments, as a list of strings"),
          stdin: z.string().optional().describe("text piped to the CLI's stdin (message body, program source, etc.)"),
        }),
        runCli,
        ctx,
      ),
    );
  }
  if (native.has("Read")) {
    tools.push(wrap("read_file", "Read a file in your working directory.", z.object({ path: z.string() }), readFile, ctx));
  }
  if (native.has("Write")) {
    tools.push(wrap("write_file", "Create or overwrite a file in your working directory.", z.object({ path: z.string(), content: z.string() }), writeFile, ctx));
  }
  if (native.has("Edit")) {
    tools.push(wrap("edit_file", "Replace an exact, unique substring in a file in your working directory.", z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }), editFile, ctx));
  }
  if (native.has("Skill")) {
    tools.push(wrap("load_skill", "Read a skill's SKILL.md for its full command reference.", z.object({ name: z.string() }), loadSkill, ctx));
  }
  return tools;
}

// Bridge the Claude-oriented prompt (which names "the Bash tool", "the Skill
// tool", a "restricted shell", heredocs/pipes) onto our structured tools.
function systemPreamble(cliMap) {
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
    "Do the task the instructions describe, then stop (return your final message with no further tool calls).",
  ].join("\n");
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  // A missing key/model is a HARD error, not "clean but capped": exit nonzero so
  // runAgent's `failed` fires (heartbeat retries; poll/discord don't drop it as a
  // successful no-reply). Only 402/429 (out-of-tokens) is the exit-0 case.
  const failHard = (text) => {
    emit({ t: "result", subtype: "error", text, out_of_tokens: false, resets_at: null });
    process.exitCode = 1;
  };
  if (!apiKey) return failHard("OPENROUTER_API_KEY is not set");
  if (!model) return failHard("OPENROUTER_MODEL is not set");

  const allowedTools = argOf("--allowed") ?? "";
  const prompt = await readStdin();
  const { cliMap, native } = parseAllowedTools(allowedTools);
  const ctx = { cwd: process.cwd(), cliMap, env: process.env, timeoutMs: CLI_TIMEOUT_MS, maxBytes: CLI_OUT_MAX_BYTES };
  const tools = buildTools(cliMap, native, ctx);

  const client = new OpenRouter({ apiKey });
  try {
    // The SDK's callModel takes `instructions` (system text) + `input` (the user
    // prompt, a string), NOT a `messages` array -- an unknown key is dropped, so
    // the prompt would never reach the model.
    const result = client.callModel({
      model,
      instructions: systemPreamble(cliMap),
      input: prompt,
      tools,
      stopWhen: [stepCountIs(MAX_STEPS)],
      allowFinalResponse: true,
    });
    const text = await result.getText();
    if (text && text.trim()) emit({ t: "text", text });
    emit({ t: "result", subtype: "success", text: text ?? "", out_of_tokens: false, resets_at: null });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // OpenRouter: 402 = out of credits, 429 = rate limited -- the analog of
    // Claude's out-of-tokens, so the daemons' "couldn't get to this" path fires.
    // Everything else is a HARD error: exit nonzero so runAgent's `failed` fires
    // (heartbeat retries) rather than logging the fire as a silent "completed".
    const outOfTokens = /\b402\b|\b429\b|insufficient|rate.?limit|quota|too many requests/i.test(msg);
    emit({ t: "result", subtype: "error", text: msg, out_of_tokens: outOfTokens, resets_at: null });
    if (!outOfTokens) process.exitCode = 1;
  }
}

main().catch((err) => {
  emit({ t: "result", subtype: "error", text: `runner crashed: ${err?.message ?? err}`, out_of_tokens: false, resets_at: null });
  process.exit(1);
});
