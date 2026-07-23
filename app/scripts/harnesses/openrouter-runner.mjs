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
// access); runAgent also strips the Discord token + AgentMail key from this env.
import { OpenRouter, tool, stepCountIs, maxTokensUsed } from "@openrouter/agent";
import { z } from "zod";
import { parseAllowedTools } from "./openrouter-tools.mjs";
import { emit, note, argOf, readStdin, systemPreamble, toolSpecs, runTool, trimStateToolOutputs, isContextFullError, isInvalidResponseError, shouldEscalateModel, OUT_OF_TOKENS_RE, EMPTY_TURN_NUDGE, UNSENT_REPLY_NUDGE, isDeliveryCall, nudgeDecision, buildMediaParts } from "./runner-common.mjs";
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
// Last-resort fallback model: if a request fails on the default model for any
// reason other than out-of-credits/rate-limit (crucially incl. minimax's generic
// "invalid_prompt" for an over-long request, which isContextFullError can't see),
// resume the run ONCE on this larger-context model before giving up -- so a big
// tool payload becomes survivable instead of a dropped reply. Defaults to the
// already-configured multimodal model (historically minimax-m3, whose ~1M window
// vs m2.7's ~205k motivated the escalation); set OPENROUTER_FALLBACK_MODEL to
// override, or "" to disable.
const FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL ?? process.env.OPENROUTER_MULTIMODAL_MODEL ?? "";
// Cap on audio forwarded to the multimodal model (base64, so no URL passthrough --
// worth bounding). At module top like the other knobs so a bad value fails the run
// LOUDLY at startup, not swallowed by main()'s BAXTER_MEDIA-parse catch.
const MEDIA_AUDIO_MAX_BYTES = envInt("OPENROUTER_MEDIA_AUDIO_MAX_BYTES", 8 * 1024 * 1024);
// OUT_OF_TOKENS_RE (402 = out of credits, 429 = rate limited -- the out-of-tokens
// analog) is imported from runner-common so this runner's classification and
// isContextFullError share the one definition (see its comment). Used by both the
// nudge catch and the outer catch below.
// Set by the daemon for runs where the user is waiting on a reply (Discord
// @mention/DM/reply, an email thread). When true, a run that composed an answer
// but never SENT it gets one poke to post it. Unset for reaction/heartbeat runs.
const EXPECT_REPLY = process.env.BAXTER_EXPECT_REPLY === "1";
// A run where a reply is genuinely OWED (a real DM/@mention/reply, or an email --
// see the daemons) rather than optional (channel chatter, reactions). When such a
// run comes back EMPTY, nudge harder (up to EMPTY_NUDGE_MAX) rather than accepting
// the silence; a non-owed empty turn gets one nudge then stands.
const REPLY_REQUIRED = process.env.BAXTER_REPLY_REQUIRED === "1";
const EMPTY_NUDGE_MAX = REPLY_REQUIRED ? envInt("OPENROUTER_EMPTY_NUDGE_MAX", 3) : 1;

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
  // BAXTER_MODEL_OVERRIDE lets the daemon route a single run to a different model
  // (the multimodal M3 for a media-bearing Discord post) without touching the
  // default OPENROUTER_MODEL; empty/unset -> the default, as always.
  // `let` (not const): the retry loop may escalate to FALLBACK_MODEL on a failure.
  // callOnce/the nudge resume both close over this binding, so reassigning it
  // switches the model for every subsequent call.
  let model = process.env.BAXTER_MODEL_OVERRIDE || process.env.OPENROUTER_MODEL;
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
  // BAXTER_MEDIA (set by the daemon when a Discord trigger carries media) turns the
  // first turn into a structured multimodal message: the text prompt as an
  // input_text part, followed by an image/video/file/audio part per attachment.
  // Absent/empty -> `input` stays the bare prompt string, exactly as before.
  let mediaParts = [];
  if (process.env.BAXTER_MEDIA) {
    try {
      mediaParts = await buildMediaParts(JSON.parse(process.env.BAXTER_MEDIA), {
        maxAudioBytes: MEDIA_AUDIO_MAX_BYTES,
        note,
      });
    } catch (e) {
      note(`media: failed to parse BAXTER_MEDIA: ${e?.message ?? e}`);
    }
    if (mediaParts.length) note(`media: attached ${mediaParts.length} part(s) to the first turn (model ${model})`);
  }
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
    // through to the escalation check below and then the graceful stop) and RESUME
    // with a continue message, reusing the same stateStore exactly like the nudge
    // below. Bounded by CONTEXT_RETRY_MAX.
    let text;
    // The FIRST call carries the media (as a structured user message); every resume
    // below (context-trim continue, invalid-response retry, nudge) is text-only --
    // the media already lives in the saved conversation state.
    let resumeInput = mediaParts.length
      ? [{ role: "user", content: [{ type: "input_text", text: prompt }, ...mediaParts] }]
      : prompt;
    // Kept for a model-escalation that fires BEFORE the SDK saved any state (a
    // first-call failure): there's nothing to resume, so we re-send the whole
    // original task to the fallback model rather than a bare "continue" message.
    const originalInput = resumeInput;
    let invalidNudged = false;
    let escalated = false;
    // One-shot escalation to the larger-context fallback model, shared by the main
    // retry loop and the nudge loop below so the two can't diverge. Reassigns the
    // outer `model`/`escalated` and returns whether it escalated (the caller then
    // re-issues the failed call on the new model). Guarded by shouldEscalateModel:
    // never on out-of-credits/rate-limit, never twice, never onto the model in use.
    const tryEscalate = (err, label) => {
      if (!shouldEscalateModel({ err, model, fallbackModel: FALLBACK_MODEL, alreadyEscalated: escalated })) return false;
      const prev = model;
      model = FALLBACK_MODEL;
      escalated = true;
      note(`${label} on ${prev} -> escalating once to ${FALLBACK_MODEL} (larger context window) and resuming: ${String(err?.message ?? err).slice(0, 140)}`);
      return true;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        text = await callOnce(resumeInput).getText();
        break;
      } catch (err) {
        // A reply already went out via a tool call; a later step then failed. Do
        // NOT trim/nudge/escalate-resume -- ANY resume tells the model to "continue
        // and finish" and risks a DUPLICATE send (worst in the escalation null-state
        // path that re-sends the whole task; and trimStateToolOutputs may have just
        // stubbed the very tool output that would show the model its reply went out).
        // The trigger's answered, so we're done. Checked first so it covers every
        // resume path below.
        if (ctx.delivered) {
          note("request failed, but a reply was already delivered -> treating as done");
          text = "";
          break;
        }
        // Context window exceeded -> trim the oldest tool outputs + resume (bounded).
        if (attempt < CONTEXT_RETRY_MAX && isContextFullError(err)) {
          const trimmed = trimStateToolOutputs(savedState);
          if (trimmed) {
            note(`context full -> trimmed ${trimmed} old tool output(s) from saved state, resuming (attempt ${attempt + 1}/${CONTEXT_RETRY_MAX})`);
            resumeInput = [{ role: "user", content: "(the conversation was trimmed to fit the context window; continue and finish the task)" }];
            continue;
          }
        }
        // The model produced an empty/invalid FINAL response -- the SDK THROWS this
        // (rather than returning empty text), so the empty-turn nudge below never
        // catches it and the run would hard-fail, leaving the trigger unanswered.
        // Nudge ONCE to re-emit a proper response instead. (The delivered case is
        // already handled at the top of the catch.) Best-effort: if the resume
        // itself fails, we fall through to `throw err` (no worse than now).
        if (isInvalidResponseError(err) && !invalidNudged) {
          invalidNudged = true;
          note("model returned an empty/invalid final response -> nudging once to retry");
          resumeInput = [{ role: "user", content: EMPTY_TURN_NUDGE }];
          continue;
        }
        // LAST RESORT: nothing above recovered it. If the failure isn't out-of-
        // credits/rate-limit, escalate ONCE to the larger-context fallback model and
        // resume -- catches minimax's opaque over-long "invalid_prompt" (which the
        // classifiers above miss) and a context-full that survived trimming, without
        // fragile error-string matching. If the SDK had already saved state, resume
        // with a continue message; if it failed before saving (a first-call failure),
        // re-send the whole original task so the fallback run isn't context-less.
        if (tryEscalate(err, "request failed")) {
          resumeInput = savedState
            ? [{ role: "user", content: "(retrying on a larger-context model; continue and finish the task)" }]
            : originalInput;
          continue;
        }
        throw err; // context retries exhausted / not-trimmable, or an unrecoverable error
      }
    }
    // Recover a give-up before finishing, each via a resumed callModel (reusing the
    // now-populated state store) with a follow-up user MESSAGE ITEM -- a bare string
    // is invalid on a resumed input array, it must be an EasyInputMessage
    // {role, content}. The which/whether decision is `nudgeDecision` (shared with
    // the local runner so the two loops can't drift -- that drift is what once let
    // this loop gate the unsent poke on the loop index and silently drop an owed
    // reply); see its comment for the two independent recovery shapes.
    // Best-effort: any resume failure keeps the current result (never worse).
    let unsentPoked = false;
    let n = 0; // empty-turn nudges spent (hoisted so the give-up log reports the real count)
    for (;;) {
      const empty = !text || !text.trim();
      const kind = nudgeDecision({ empty, delivered: ctx.delivered, expectReply: EXPECT_REPLY, emptyNudges: n, emptyNudgeMax: EMPTY_NUDGE_MAX, unsentPoked });
      if (!kind) break;
      const nudgeEmpty = kind === "empty";
      if (nudgeEmpty) n++; else unsentPoked = true;
      note(nudgeEmpty ? `empty turn -> nudging (${n}/${EMPTY_NUDGE_MAX})` : "answered but never sent the reply -> poking once to post it");
      const nudgeInput = [{ role: "user", content: nudgeEmpty ? EMPTY_TURN_NUDGE : UNSENT_REPLY_NUDGE }];
      // Issue the nudge with the SAME one-shot escalation the main loop has: if the
      // nudge's own call fails in an escalatable way -- most importantly when its
      // extra turn tips the saved state over the window -- escalate to the bigger-
      // context model and re-issue the same nudge on it. Without this, an overflow at
      // the nudge silently dropped the owed reply (the 2026-07-20 incident: the main
      // loop fit under m2.7's ~196k window but the poke's added turn pushed past it).
      let nudgeFailed = false;
      for (;;) {
        try {
          const nudged = client.callModel({
            model,
            instructions,
            input: nudgeInput,
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
          break;
        } catch (nudgeErr) {
          // A reply already went out via the poke's own send tool call, THEN this
          // follow-up request failed. Checked FIRST (mirrors the main loop's catch):
          // any resume -- escalate-and-reissue OR the out-of-tokens rethrow below --
          // would re-issue "send it now" and risk a DUPLICATE post. Break the inner
          // loop; the outer nudgeDecision then returns null (delivered) and finishes.
          if (ctx.delivered) {
            note("nudge failed, but a reply was already delivered -> treating as done");
            break;
          }
          const m = String(nudgeErr?.message ?? nudgeErr);
          // A rate-limit/credit error DURING the nudge is still out-of-tokens --
          // let the outer catch classify it (a pricier model would fail the same).
          if (OUT_OF_TOKENS_RE.test(m)) throw nudgeErr;
          if (tryEscalate(nudgeErr, "nudge failed")) continue; // re-issue this nudge on the bigger model
          note(`nudge resume FAILED: ${m}`); // <- if this shows in logs, the SDK resume isn't firing
          nudgeFailed = true;
          break;
        }
      }
      if (nudgeFailed) break;
    }
    if (REPLY_REQUIRED && (!text || !text.trim()) && !ctx.delivered) {
      note(`reply was owed but the model produced no response after ${n} nudge(s)`);
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
