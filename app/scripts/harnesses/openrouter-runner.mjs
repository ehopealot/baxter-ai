#!/usr/bin/env node
// OpenRouter harness runner -- an alternative to `claude -p` for driving Baxter.
// Spawned by runtime.mjs's runAgent (via harnesses/openrouter.mjs) exactly like
// claude: it reads the rendered prompt on STDIN, runs @openrouter/agent's
// callModel loop with our structured tools, and emits normalized JSONL events on
// stdout (decoded by the adapter's parseEvents) plus a final `result` line.
//
// The security-critical tool logic (CLI allowlist, cwd confinement) lives in
// openrouter-tools.mjs; the shared preamble + tool set live in runner-common.mjs;
// this file only renders those specs into the SDK's zod tool() form and drives
// callModel. cwd is set by the spawning daemon to MEMORY_DIR (bounds file
// access); the daemon also strips the Discord/Gmail tokens from this env.
import { OpenRouter, tool, stepCountIs, maxTokensUsed } from "@openrouter/agent";
import { z } from "zod";
import { parseAllowedTools } from "./openrouter-tools.mjs";
import { emit, note, argOf, readStdin, systemPreamble, toolSpecs, runTool, trimStateToolOutputs, isContextFullError, EMPTY_TURN_NUDGE, UNSENT_REPLY_NUDGE, isDeliveryCall } from "./runner-common.mjs";
import { envInt } from "../schedule-store.mjs";

// envInt fails loud on a non-integer value rather than propagating NaN: a NaN
// step cap makes stepCountIs never fire (unbounded loop on a paid API), a NaN
// timeout is falsy (no CLI timeout), and a NaN byte cap blanks every output.
const CLI_OUT_MAX_BYTES = envInt("OPENROUTER_CLI_OUTPUT_MAX_BYTES", 256 * 1024);
const CLI_TIMEOUT_MS = envInt("OPENROUTER_CLI_TIMEOUT_MS", 120000);
const MAX_STEPS = envInt("OPENROUTER_MAX_STEPS", 40);
// Optional cumulative-token budget. With @openrouter/agent owning the message
// array we can't trim it mid-loop (unlike the local runner), so the lever is to
// STOP before the window blows: maxTokensUsed halts the callModel loop once total
// usage crosses this, and allowFinalResponse (set below) turns that into a clean
// wrap-up turn instead of a context-length error. It sums BILLED tokens across
// steps, and every step re-bills the whole current history, so cumulative usage
// crosses this threshold WELL before the live context reaches it (roughly a
// multiple earlier on a long tool loop) -- so set OPENROUTER_MAX_TOKENS to a few
// multiples of the model's window, not the window itself. 0 disables it (the
// default: windows vary too much to guess a good number).
const MAX_TOKENS = envInt("OPENROUTER_MAX_TOKENS", 0);
// One stop-condition set for both the main call and the nudge resume, so they
// can't drift. stepCountIs always bounds iterations; maxTokensUsed is added only
// when a budget is configured.
const STOP_WHEN = MAX_TOKENS ? [stepCountIs(MAX_STEPS), maxTokensUsed(MAX_TOKENS)] : [stepCountIs(MAX_STEPS)];
// After a context-full error we can't trim mid-loop, but we hold the SDK's
// ConversationState via our stateStore -- so truncate its oldest tool OUTPUTS and
// resume, up to this many times, before falling back to the graceful stop.
const CONTEXT_RETRY_MAX = envInt("OPENROUTER_CONTEXT_RETRY_MAX", 2);
// OpenRouter: 402 = out of credits, 429 = rate limited -- the out-of-tokens
// analog. One copy, used by both the nudge catch and the outer catch below (they
// must agree so a nudge-time credit error is rethrown and reclassified, not
// swallowed as "nudge failed").
const OUT_OF_TOKENS_RE = /\b402\b|\b429\b|insufficient|rate.?limit|quota|too many requests/i;
// Set by the daemon for runs where the user is waiting on a reply (Discord
// @mention/DM/reply, an email thread). When true, a run that composed an answer
// but never SENT it gets one poke to post it. Unset for reaction/heartbeat runs.
const EXPECT_REPLY = process.env.BAXTER_EXPECT_REPLY === "1";

// Render a shared tool spec's params into the Agent SDK's zod input schema.
function zodSchema(spec) {
  const shape = {};
  for (const p of spec.params) {
    let s = p.type === "string[]" ? z.array(z.string()) : z.string();
    if (p.description) s = s.describe(p.description);
    if (!p.required) s = s.optional();
    shape[p.name] = s;
  }
  return z.object(shape);
}

function buildTools(specs, ctx) {
  return specs.map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      inputSchema: zodSchema(spec),
      // emits tool_use/tool_result, runs the executor; also flags on ctx when a
      // reply/send actually goes out, so the runner can tell "answered but never
      // sent" from a run that legitimately replied.
      execute: async (params) => {
        const result = await runTool(spec, params, ctx);
        if (isDeliveryCall(spec.name, params) && result?.ok !== false) ctx.delivered = true;
        return result;
      },
    }),
  );
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

  const { cliMap, native } = parseAllowedTools(argOf("--allowed") ?? "");
  const prompt = await readStdin();
  const ctx = { cwd: process.cwd(), cliMap, env: process.env, timeoutMs: CLI_TIMEOUT_MS, maxBytes: CLI_OUT_MAX_BYTES, delivered: false };
  const tools = buildTools(toolSpecs(cliMap, native), ctx);

  const client = new OpenRouter({ apiKey });
  const instructions = systemPreamble(cliMap);
  try {
    // callModel takes `instructions` (system text) + `input` (the user prompt, a
    // string), NOT a `messages` array -- an unknown key is dropped silently.
    // An in-memory state store so the conversation can be resumed for the nudge.
    // `state` MUST be passed to this FIRST call for a resume to work: callModel
    // only tracks conversation state when given a StateAccessor -- without one the
    // loaded state is null and getState()/resume throws "State not initialized".
    let savedState = null;
    const stateStore = { load: async () => savedState, save: async (s) => { savedState = s; } };
    const callOnce = (input) =>
      client.callModel({ model, instructions, input, tools, stopWhen: STOP_WHEN, allowFinalResponse: true, state: stateStore });
    // Run the loop; on a context-full error, truncate the oldest tool OUTPUTS in the
    // saved state (best-effort -- a no-op if the SDK hadn't saved yet, which falls
    // through to the graceful stop) and RESUME with a continue message, reusing the
    // same stateStore exactly like the nudge below. Bounded by CONTEXT_RETRY_MAX.
    let text;
    let resumeInput = prompt;
    for (let attempt = 0; ; attempt++) {
      try {
        text = await callOnce(resumeInput).getText();
        break;
      } catch (err) {
        if (attempt >= CONTEXT_RETRY_MAX || !isContextFullError(err)) throw err;
        const trimmed = trimStateToolOutputs(savedState);
        if (!trimmed) throw err; // nothing to trim (or state not populated) -> graceful stop
        note(`context full -> trimmed ${trimmed} old tool output(s) from saved state, resuming (attempt ${attempt + 1}/${CONTEXT_RETRY_MAX})`);
        resumeInput = [{ role: "user", content: "(the conversation was trimmed to fit the context window; continue and finish the task)" }];
      }
    }
    // Two give-up shapes get ONE poke, via a resumed callModel (reusing
    // stateStore, now populated by the call above) with a follow-up user MESSAGE
    // ITEM (a bare string is invalid on a resumed input array -- must be an
    // EasyInputMessage {role, content}):
    //  (a) EMPTY final turn (no text, no tool call) -- a give-up after e.g. a
    //      tool error; nudged with EMPTY_TURN_NUDGE.
    //  (b) a reply-expecting run that composed an answer as TEXT but never SENT
    //      it (ctx.delivered stayed false) -- the user only sees tool-posted
    //      messages, so a final-message answer never reaches them; nudged with
    //      UNSENT_REPLY_NUDGE to reformat it into the send tool call.
    // Best-effort: any resume failure falls back to the current result (never
    // worse); the reused `tools` mean the nudged turn's send still executes+emits.
    const empty = !text || !text.trim();
    const answeredButUnsent = !empty && EXPECT_REPLY && !ctx.delivered;
    // `empty && !ctx.delivered`, not just `empty`: an empty turn AFTER a reply was
    // already delivered is the model signing off, not a give-up -- nudging it to
    // "send your reply now" would prompt a DUPLICATE send.
    if ((empty && !ctx.delivered) || answeredButUnsent) {
      try {
        note(empty ? "empty turn -> nudging once" : "answered but never sent the reply -> poking once to post it");
        const nudged = client.callModel({
          model,
          instructions,
          input: [{ role: "user", content: empty ? EMPTY_TURN_NUDGE : UNSENT_REPLY_NUDGE }],
          tools,
          stopWhen: STOP_WHEN,
          allowFinalResponse: true,
          state: stateStore,
        });
        const nudgedText = await nudged.getText();
        // The poke's SUCCESS shape is a send tool call with no closing text
        // (UNSENT_REPLY_NUDGE says "respond with only that tool call"), so empty
        // nudgedText + ctx.delivered is success, NOT "returned nothing".
        if (nudgedText && nudgedText.trim()) { text = nudgedText; note("nudge: model responded after the poke"); }
        else note(ctx.delivered ? "nudge: reply delivered via tool call (no closing text)" : "nudge: model still returned nothing");
      } catch (nudgeErr) {
        const m = String(nudgeErr?.message ?? nudgeErr);
        // A rate-limit/credit error DURING the nudge is still out-of-tokens --
        // let the outer catch classify it. Anything else: keep the current result.
        if (OUT_OF_TOKENS_RE.test(m)) throw nudgeErr;
        note(`nudge resume FAILED: ${m}`); // <- if this shows in logs, the SDK resume isn't firing
      }
    }
    if (text && text.trim()) emit({ t: "text", text });
    emit({ t: "result", subtype: "success", text: text ?? "", out_of_tokens: false, resets_at: null });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // A context-full error that survived the trim-and-resume above won't fix on a
    // later retry, so end GRACEFULLY (exit 0): heartbeat treats it as done rather
    // than retrying into the same wall, and discord/poll don't count it a hard
    // failure. Checked first because it's neither out-of-tokens nor a bug.
    const contextFull = isContextFullError(err);
    // OpenRouter: 402 = out of credits, 429 = rate limited -- the analog of
    // Claude's out-of-tokens, so the daemons' "couldn't get to this" path fires.
    // Everything else is a HARD error: exit nonzero so runAgent's `failed` fires.
    const outOfTokens = !contextFull && OUT_OF_TOKENS_RE.test(msg);
    emit({
      t: "result",
      subtype: "error",
      text: contextFull ? `context full -- didn't fit the model's window even after trimming: ${msg}` : msg,
      out_of_tokens: outOfTokens,
      resets_at: null,
    });
    if (!outOfTokens && !contextFull) process.exitCode = 1;
  }
}

main().catch((err) => {
  emit({ t: "result", subtype: "error", text: `runner crashed: ${err?.message ?? err}`, out_of_tokens: false, resets_at: null });
  process.exit(1);
});
