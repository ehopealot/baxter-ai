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

// The single source of truth both runners share for "should this ended turn be
// nudged, and how?" -- pulled out because the two loops each reimplemented it and
// drifted (the openrouter loop once gated the unsent poke on the loop index, so an
// empty nudge permanently blocked it and a genuinely-owed reply was silently lost).
// Two INDEPENDENT recovery shapes, each with its own cap:
//   "empty"  -- the turn produced no text and delivered nothing: nudge with
//               EMPTY_TURN_NUDGE, up to emptyNudgeMax times (>1 only when a reply
//               is truly owed; otherwise once, then the silence stands).
//   "unsent" -- text present but never SENT via a delivery tool call while a reply
//               is expected: poke ONCE (unsentPoked) with UNSENT_REPLY_NUDGE. This
//               can follow an empty nudge (model finally answers as text but still
//               doesn't send), so it's gated on its own flag, not the empty count.
// `delivered` short-circuits both: an empty/textless turn AFTER a reply already
// went out is the model signing off -- re-nudging would duplicate the send.
// Returns "empty" | "unsent" | null (nothing to do -> finish).
export function nudgeDecision({ empty, delivered, expectReply, emptyNudges, emptyNudgeMax, unsentPoked }) {
  if (empty && !delivered && emptyNudges < emptyNudgeMax) return "empty";
  if (!empty && expectReply && !delivered && !unsentPoked) return "unsent";
  return null;
}

// --- multimodal input (Discord media -> @openrouter/agent content parts) ---

// The only hosts a Discord attachment url legitimately uses. The url always comes
// from Discord's own API (so it's already one of these); validating hard-stops any
// future path that feeds an arbitrary url into the model or the audio fetch below.
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
export function isDiscordCdnUrl(url) {
  try {
    return DISCORD_CDN_HOSTS.has(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

// content_type -> the SDK audio `format`. Only mp3/wav are named by the SDK's
// FormatEnum; the rest are best-effort (OpenEnum accepts them client-side, but
// server-side support is model-dependent). Unknown audio/* falls back to the
// subtype (audio/flac -> "flac"), then "mp3".
const AUDIO_FORMATS = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "mp4", "audio/aac": "aac" };

// Build @openrouter/agent (Responses-API) content parts from Discord attachment
// metadata (BAXTER_MEDIA items: {id,url,content_type,filename,size}).
// CAMELCASE by design: callModel serializes `input` through CreateResponsesRequest's
// OUTBOUND zod schema (betaResponsesSend), so the SDK's typed camelCase shape
// (imageUrl/videoUrl/fileUrl/inputAudio) is expected -- it converts to snake_case on
// the wire, and a wrong shape throws "Input validation failed" (loud, not silent).
//   image/*          -> input_image (imageUrl; url passthrough, OpenRouter fetches it)
//   video/*          -> input_video (videoUrl; url passthrough)
//   application/pdf  -> input_file  (fileUrl;  url passthrough)
//   audio/*          -> input_audio (base64 -- audio has NO url field; fetch+encode,
//                       size-capped, since base64 also inflates tokens ~1.33x)
// Best-effort per item: an unrepresentable type, a non-Discord host, or an over-cap
// / failed audio fetch drops just that item (noted) and never throws -- a media post
// must still run. Async only for the audio fetch.
export async function buildMediaParts(media, { fetchFn = fetch, maxAudioBytes = 8 * 1024 * 1024, note: noteFn = () => {} } = {}) {
  const parts = [];
  for (const m of Array.isArray(media) ? media : []) {
    const url = m?.url;
    const ct = String(m?.content_type || "");
    const name = m?.filename || "attachment";
    if (!isDiscordCdnUrl(url)) { noteFn(`media: skipping ${name} (url not a Discord CDN host)`); continue; }
    if (ct.startsWith("image/")) {
      parts.push({ type: "input_image", imageUrl: url, detail: "auto" });
    } else if (ct.startsWith("video/")) {
      parts.push({ type: "input_video", videoUrl: url });
    } else if (ct === "application/pdf") {
      parts.push({ type: "input_file", fileUrl: url, filename: m?.filename || "file.pdf" });
    } else if (ct.startsWith("audio/")) {
      if (m?.size != null && Number(m.size) > maxAudioBytes) { noteFn(`media: skipping audio ${name} (${m.size} bytes > ${maxAudioBytes} cap)`); continue; }
      try {
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxAudioBytes) { noteFn(`media: skipping audio ${name} (${buf.length} bytes > cap)`); continue; }
        const format = AUDIO_FORMATS[ct] || ct.split("/")[1] || "mp3";
        parts.push({ type: "input_audio", inputAudio: { data: buf.toString("base64"), format } });
      } catch (e) {
        noteFn(`media: audio fetch failed for ${name}: ${e?.message ?? e}`);
      }
    } else {
      noteFn(`media: skipping ${name} (unsupported type ${ct || "unknown"})`);
    }
  }
  return parts;
}

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

// Placeholder swapped in for an old tool result's content OR an oversized
// tool-call argument when trimming to fit the context budget (see fitContext).
// Kept short so a stubbed message is cheap; "data" (not "output") since it covers
// both tool results and tool inputs.
export const CONTEXT_STUB = "[older tool data elided to fit the context budget]";

// Rough char/4 token estimate over a whole chat message (content + any tool_calls
// + ids). Deliberately approximate -- a safety budget only needs a ballpark, and
// the real tokenizer varies per (local) model anyway.
export function estTokens(msg) {
  try {
    return Math.ceil(JSON.stringify(msg).length / 4);
  } catch {
    return 0;
  }
}

// Keep a chat/completions message array under a rough token budget so a long,
// tool-heavy loop can't grow it past the model's context window (common on small
// local models). The SDK-less local runner owns its `messages` array, so this
// trims-and-CONTINUES rather than just stopping. Two oldest-first passes, each
// stopping once under budget so recent context survives:
//   1. stub the oldest tool-RESULT contents (the usual bulk);
//   2. if still over, stub the oldest oversized assistant tool_call ARGUMENTS --
//      a write_file/edit_file carries its whole payload there, not in the (tiny)
//      tool result, so pass 1 can't reclaim it.
// It never drops a message and never touches a tool_call *id*, so the system(0) +
// original user-prompt(1) must-keeps AND the assistant/tool_result pairing the
// chat API requires (an orphaned `tool` message 400s) stay intact. A 0 budget
// disables it. Returns true iff it stubbed anything, so the caller can log it
// once. NOTE: it can't shrink the system message or the one-shot user prompt, so
// a prompt that alone exceeds the window isn't helped here (the daemons bound
// history sizes upstream).
export function fitContext(messages, maxTokens) {
  if (!maxTokens) return false;
  let total = messages.reduce((n, m) => n + estTokens(m), 0);
  if (total <= maxTokens) return false;
  let trimmed = false;
  const STUB_ARGS = JSON.stringify({ elided: CONTEXT_STUB });
  // Pass 1: oldest tool-result contents. Skip ones no larger than the stub --
  // replacing a tiny result would GROW it (the stub isn't free).
  for (let i = 2; i < messages.length && total > maxTokens; i++) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= CONTEXT_STUB.length) continue;
    const before = estTokens(m);
    m.content = CONTEXT_STUB;
    total -= before - estTokens(m);
    trimmed = true;
  }
  // Pass 2: oldest oversized assistant tool_call arguments (id preserved).
  for (let i = 2; i < messages.length && total > maxTokens; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      const args = c.function?.arguments;
      if (typeof args !== "string" || args.length <= STUB_ARGS.length) continue;
      const before = estTokens(m);
      c.function.arguments = STUB_ARGS;
      total -= before - estTokens(m);
      trimmed = true;
      if (total <= maxTokens) break;
    }
  }
  return trimmed;
}

// Match a "context window exceeded" error across providers (OpenAI-style, and the
// various phrasings OpenRouter passes through from upstream models). Distinct from
// out-of-tokens (402/429): a context overflow won't fix on a later retry (the same
// oversized history re-overflows), so the daemons must end the run cleanly rather
// than retry into the same wall. Deliberately broad but anchored on context/token
// length wording so an unrelated error isn't misread.
const CONTEXT_FULL_RE = /context[_ ](length|window)|maximum context|context_length_exceeded|too many tokens|reduce the (length|size|number)|prompt is too long|exceeds? the (maximum |model'?s )?(context|token)/i;
// Rate-limit / out-of-credit signals (the out-of-tokens class). A run hitting
// these must NEVER be classified as context-full: trimming/retrying won't help,
// and it needs the daemons' "couldn't get to this, retry later" path, not a
// done/graceful finish. The ONE definition, shared by isContextFullError below
// AND both runners' out-of-tokens classification -- they must agree byte-for-byte
// (isContextFullError returning false for a message is only correct if the
// runner's own check then matches the same message), so it lives here once.
export const OUT_OF_TOKENS_RE = /\b402\b|\b429\b|insufficient|rate.?limit|quota|too many requests/i;
export function isContextFullError(errOrMsg) {
  // Trust a definitive HTTP status first: 402/429 is rate/credit, never overflow.
  const status = errOrMsg && typeof errOrMsg === "object" ? errOrMsg.status : null;
  if (status === 402 || status === 429) return false;
  const msg = typeof errOrMsg === "string" ? errOrMsg : String(errOrMsg?.message ?? errOrMsg ?? "");
  // ...and by message, so a rate-limit note that happens to mention "too many
  // tokens" / "reduce the number of ..." isn't misread as a context overflow
  // (which would trim+retry against a limited endpoint and mark the task done
  // rather than take the retry-later path).
  if (OUT_OF_TOKENS_RE.test(msg)) return false;
  return CONTEXT_FULL_RE.test(msg);
}

// A flaky, retriable "the model produced no usable final answer" failure. The
// @openrouter/agent SDK THROWS this (rather than returning empty text), so the
// empty-turn nudge -- which only sees a clean empty RETURN -- never catches it,
// and the run hard-fails (a ping left unanswered). Narrow to the observed
// phrasings so a real error isn't swallowed as recoverable.
const INVALID_RESPONSE_RE = /invalid final response|empty or invalid output/i;
export function isInvalidResponseError(errOrMsg) {
  const msg = typeof errOrMsg === "string" ? errOrMsg : String(errOrMsg?.message ?? errOrMsg ?? "");
  return INVALID_RESPONSE_RE.test(msg);
}

// Best-effort recovery for the OpenRouter runner after a context-full error: the
// SDK owns the message array, but we hold its ConversationState via our own
// stateStore, so truncate the largest/oldest tool-call OUTPUTS in that saved state
// so a resumed callModel fits. Only mutates a tool output's string content, never
// a call/output id, so the SDK's call/result pairing survives the resume. Keeps
// the most recent `keepRecent` outputs intact. Returns the count trimmed (0 if the
// state isn't an item array or nothing was large enough) -- the caller falls back
// to a clean stop when nothing could be trimmed. Deliberately lenient about the
// item shape (matches any item carrying a long string `output`), and fully
// guarded, since it operates on SDK-internal types that could shift. keepRecent
// defaults to 1 (aggressive): this only runs to recover from an overflow, where
// getting back under the window matters more than retaining old tool context.
export function trimStateToolOutputs(state, { keepRecent = 1 } = {}) {
  try {
    const msgs = state?.messages;
    if (!Array.isArray(msgs)) return 0;
    const big = msgs.filter((it) => it && typeof it.output === "string" && it.output.length > CONTEXT_STUB.length);
    let trimmed = 0;
    for (let k = 0; k < big.length - keepRecent; k++) {
      big[k].output = CONTEXT_STUB;
      trimmed++;
    }
    return trimmed;
  } catch {
    return 0;
  }
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
  // Current time, injected fresh each run. Unlike Claude Code (which tells the
  // model the date itself), these harnesses give the model no clock otherwise --
  // so a time-relative task ("today", "this weekend", a scheduled daily job) would
  // fall back to stale training data. tz is BAXTER_TZ || HEARTBEAT_TZ || Pacific;
  // a bad tz degrades to UTC-only rather than throwing.
  const now = new Date();
  const tz = process.env.BAXTER_TZ || process.env.HEARTBEAT_TZ || "America/Los_Angeles";
  let localNow = null;
  try {
    localNow = now.toLocaleString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  } catch { /* invalid tz -> UTC only */ }
  const nowLine = `The current date and time is ${localNow ? `${localNow} ` : ""}(${now.toISOString()} UTC). Use THIS as "now" for anything time-relative ("today", "this week", a due date) -- do NOT rely on training data for the current date.`;
  return [
    nowLine,
    "",
    "You are an autonomous agent. You can ACT ONLY by calling the tools provided -- there is no shell and no other way to run commands.",
    "",
    "Tool mapping (the task instructions below were written for a different tool naming; translate as follows):",
    `- Any command the instructions show as \`discord-cli …\`, \`code-cli …\`, \`schedule-cli …\`, \`playwright-cli …\`, \`invisible-cli …\` (or \`node <gmail> …\`) is a **run_cli** call: run_cli({cli, args:[…], stdin}). Available CLIs: ${clis}. Put any message/program body in \`stdin\` (never a heredoc or pipe -- there is no shell).`,
    "- Web research the instructions call `WebSearch`/`WebFetch` (or \"read a page's content\") is the **web-cli** CLI via run_cli: run_cli({cli:\"web-cli\", args:[\"fetch\", \"<url>\"]}) to read a page. To SEARCH, web-cli's own `search` is disabled -- open Bing in the browser: run_cli({cli:\"playwright-cli\", args:[\"open\", \"https://www.bing.com/search?q=<query>\"]}) then run_cli({cli:\"playwright-cli\", args:[\"snapshot\"]}). Use **playwright-cli** for search (Bing serves it fine) and for JavaScript-heavy pages, NOT invisible-cli.",
    "- If **playwright-cli is blocked** on a specific page you need -- a Cloudflare \"Just a moment…\"/\"Checking your browser\" interstitial, an \"Access denied\"/HTTP 403 bot page, or a snapshot stuck on such a challenge -- retry that EXACT url ONCE with **invisible-cli** (the stealth browser): run_cli({cli:\"invisible-cli\", args:[\"open\", \"<url>\"]}) then run_cli({cli:\"invisible-cli\", args:[\"snapshot\"]}). That is what it's for. It's slower to start and self-recovers from a stuck command in ~30s, so use it only as this one-shot escalation for a walled page, never for search. If it's also blocked, move on.",
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
