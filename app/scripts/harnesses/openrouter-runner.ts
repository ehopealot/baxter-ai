#!/usr/bin/env node
// OpenRouter harness runner -- an alternative to `claude -p` for driving Baxter.
// Spawned by runtime.ts's runAgent (via harnesses/openrouter.ts) exactly like
// claude: it reads the rendered prompt on STDIN, runs @openrouter/agent's
// callModel loop with our structured tools, and emits normalized JSONL events on
// stdout (decoded by the adapter's parseEvents) plus a final `result` line.
//
// The security-critical tool logic (CLI allowlist, cwd confinement) lives in
// openrouter-tools.ts; the shared preamble + tool set live in runner-common.ts;
// this file only renders those specs into the SDK's zod tool() form and drives
// callModel. cwd is set by the spawning daemon to MEMORY_DIR (bounds file
// access); runAgent also strips the Discord and Resend credentials from this env.
import { OpenRouter, tool, stepCountIs, maxTokensUsed } from "@openrouter/agent";
import { HTTPClient } from "@openrouter/sdk/lib/http";
import type { Tool, StateAccessor, ConversationState } from "@openrouter/agent";
import { z } from "zod";
import { parseAllowedTools } from "./openrouter-tools.ts";
import { ACCESS_LOG_PATH } from "../paths.ts";
import { emit, note, argOf, readStdin, systemPreamble, withNow, toolSpecs, runTool, trimStateToolOutputs, isContextFullError, isInvalidResponseError, isTransientStreamError, shouldEscalateModel, malformedEnvValue, isTerminalRun, OUT_OF_TOKENS_RE, EMPTY_TURN_NUDGE, unsentReplyNudge, isDeliveryCall, isIntentionalSkip, skipNote, skipAnomaly, nudgeDecision, buildMediaParts } from "./runner-common.ts";
import type { ToolSpec, ToolExecutorCtx, MediaPart } from "./runner-common.ts";
import { envInt } from "../schedule-store.ts";
import { emptyAccum, addTurnUsage, finalizeUsage } from "./openrouter-usage.ts";
import { openRouterFunctionOutputCompatibilityHook } from "./openrouter-compat.ts";
import { providerFetch } from "../provider-lease-transport.ts";

// The runner's own tool-execution context: the shared ToolExecutorCtx plus
// `delivered`, set by a tool's execute wrapper (buildTools) once a reply/send
// actually goes out -- read by main()'s recovery loops via ctx.delivered.
interface RunnerCtx extends ToolExecutorCtx {
  delivered: boolean;
  skipped: boolean;
}

// An error thrown by the SDK's callModel (or a plain Error re-thrown from this
// file) -- `status`/`message` are read by the classification logic throughout.
// SDK errors are otherwise untyped at this boundary (a genuine external
// boundary -- see the ToolSpec.executor comment in runner-common.ts), so this stays a
// loose shape rather than importing an SDK error class.
interface RunnerError extends Error {
  status?: number;
}

// The `input` shape callModel() accepts is a deep SDK union (Item[] | string |
// an async-fn form) driven by generics keyed off the tools array; this runner
// only ever sends a bare string or a one-item [{role:"user", content}] array,
// so it's tracked as this narrower local shape and cast at the callModel
// boundary rather than fighting the SDK's generics (an external-boundary type,
// per the migration plan).
type CallInput = string | Array<{ role: string; content: unknown }>;

// envInt fails loud on a non-integer value rather than propagating NaN: a NaN
// step cap makes stepCountIs never fire (unbounded loop on a paid API), a NaN
// timeout is falsy (no CLI timeout), and a NaN byte cap blanks every output.
const CLI_OUT_MAX_BYTES = envInt("OPENROUTER_CLI_OUTPUT_MAX_BYTES", 256 * 1024);
const CLI_TIMEOUT_MS = envInt("OPENROUTER_CLI_TIMEOUT_MS", 120000);
// Per-model-REQUEST timeout (ms), handed to the SDK as RequestOptions.timeoutMs -- it bounds
// each HTTP request inside callModel's agentic loop. A stalled completion (2026-08-05: an
// ~8.5-min hang on a degraded route, which nothing timed out) is now aborted at this cap and,
// being neither out-of-credits nor rate-limit, routes through the SAME one-shot escalation
// (tryEscalate -> fallback model) as any other failure -- a fast failover instead of a
// multi-minute hang. 0 = off. Default 120s: well above a healthy single completion (seconds),
// well below a pathological stall. NOTE: openrouter-only (its SDK exposes timeoutMs); the
// openai/custom runners aren't covered -- openrouter is the fleet harness.
const REQUEST_TIMEOUT_MS = envInt("OPENROUTER_REQUEST_TIMEOUT_MS", 120000);
const REQ_OPTS = REQUEST_TIMEOUT_MS > 0 ? { timeoutMs: REQUEST_TIMEOUT_MS } : undefined;
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
// Same-model retry for a TRANSIENT stream failure (isTransientStreamError -- the SDK's opaque
// "Response failed", a dropped/5xx stream) BEFORE spending the one-shot model escalation: OpenRouter
// often served the turn 200 and the stream just blipped, so re-issuing the same turn usually clears
// it, and it's cheaper than switching models. Bounded + backed off; 0 disables. Every retry logs
// LOUDLY so a fallback is never silent.
const STREAM_RETRY_MAX = envInt("OPENROUTER_STREAM_RETRY_MAX", 2);
const STREAM_RETRY_BASE_MS = envInt("OPENROUTER_STREAM_RETRY_BASE_MS", 800);
// A REF'd timer on purpose (unlike getTextWithUsage's drain cap): the retry path AWAITs this on
// the critical control path, so it must hold the event loop open. An unref'd timer here could let
// Node exit 0 mid-backoff (e.g. an ECONNREFUSED where no socket ever kept the loop alive), emitting
// no result line -- reintroducing the very silent failure this retry exists to prevent.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Cap on audio forwarded to the multimodal model (base64, so no URL passthrough --
// worth bounding). At module top like the other knobs so a bad value fails the run
// LOUDLY at startup, not swallowed by main()'s BAXTER_MEDIA-parse catch.
const MEDIA_AUDIO_MAX_BYTES = envInt("OPENROUTER_MEDIA_AUDIO_MAX_BYTES", 8 * 1024 * 1024);

// Run-scoped usage tally, summed across EVERY callModel result (main loop, all
// resumes, and the nudge's separate call) via getTextWithUsage below. Real USD
// cost + tokens for the ledger. Module-level (single-run process) so it's in
// scope at both getText sites and the emits.
const usageAcc = emptyAccum();

// Drive a ModelResult to text WHILE summing per-turn usage off its full-response
// stream. The SDK broadcaster only receives follow-up-turn events if a stream is
// already being consumed (getText alone never creates it), so start iterating the
// stream BEFORE awaiting getText. Fully isolated: any stream error is swallowed
// and getText's result/exception propagate EXACTLY as before -- metering can't
// touch the run's control flow or its duplicate-send guards. A 2s drain cap (with
// an unref'd timer) guarantees the run never hangs on metering.
async function getTextWithUsage(
  result: { getText(): Promise<string>; getFullResponsesStream(): AsyncIterable<unknown> },
): Promise<string> {
  const summing = (async () => {
    try {
      for await (const ev of result.getFullResponsesStream()) {
        const e = ev as { type?: string; response?: { usage?: { cost?: number | null; inputTokens?: number; outputTokens?: number } } };
        if (e?.type === "response.completed" && e.response?.usage) addTurnUsage(usageAcc, e.response.usage);
      }
    } catch {
      /* usage is best-effort; never disturb the run */
    }
  })();
  try {
    return await result.getText();
  } finally {
    await Promise.race([summing, new Promise((r) => { const h = setTimeout(r, 2000); (h as { unref?: () => void }).unref?.(); })]);
  }
}
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
function zodSchema(spec: ToolSpec): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  for (const p of spec.params) {
    let s: z.ZodType = p.type === "string[]" ? z.array(z.string()) : z.string();
    if (p.description) s = s.describe(p.description);
    if (!p.required) s = s.optional();
    shape[p.name] = s;
  }
  return z.object(shape);
}

function buildTools(specs: ToolSpec[], ctx: RunnerCtx): Tool[] {
  return specs.map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      inputSchema: zodSchema(spec),
      // emits tool_use/tool_result, runs the executor; also flags on ctx when a
      // reply/send actually goes out, so the runner can tell "answered but never
      // sent" from a run that legitimately replied.
      execute: async (params: Record<string, unknown>) => {
        const result = await runTool(spec, params, ctx);
        if (isDeliveryCall(spec.name, params) && result?.ok !== false) ctx.delivered = true;
        if (isIntentionalSkip(spec.name, params) && result?.ok !== false) {
          ctx.skipped = true;
          const n = skipNote(params as Record<string, unknown>);
          if (n) note(n);
        }
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
  const failHard = (text: string) => {
    emit({ t: "result", subtype: "error", text, out_of_tokens: false, resets_at: null });
    process.exitCode = 1;
  };
  if (!apiKey) return failHard("OPENROUTER_API_KEY is not set");
  if (!model) return failHard("OPENROUTER_MODEL is not set");
  const bad = malformedEnvValue(["OPENROUTER_MODEL", "OPENROUTER_API_KEY"]);
  if (bad) return failHard(`${bad.name} in app/.env looks malformed -- it contains a space or '#', almost always a leftover inline "# comment" after the value (docker --env-file keeps everything after '='). Fix it: set keys with \`baxter set-key openrouter <key>\`, or move the comment to its own line.`);

  const { cliMap, native } = parseAllowedTools(argOf("--allowed") ?? "");
  const prompt = await readStdin();
  // BAXTER_MEDIA (set by a daemon when a trigger carries media) turns the first turn into
  // a structured multimodal message: the text
  // prompt as an input_text part, followed by an image/video/file/audio part per attachment.
  // Absent/empty -> `input` stays the bare prompt string, exactly as before.
  let mediaParts: MediaPart[] = [];
  if (process.env.BAXTER_MEDIA) {
    try {
      mediaParts = await buildMediaParts(JSON.parse(process.env.BAXTER_MEDIA), {
        maxAudioBytes: MEDIA_AUDIO_MAX_BYTES,
        note,
      });
    } catch (e) {
      note(`media: failed to parse BAXTER_MEDIA: ${(e as Error)?.message ?? e}`);
    }
    if (mediaParts.length) note(`media: attached ${mediaParts.length} part(s) to the first turn (model ${model})`);
  }
  const ctx: RunnerCtx = { cwd: process.cwd(), cliMap, env: process.env, timeoutMs: CLI_TIMEOUT_MS, maxBytes: CLI_OUT_MAX_BYTES, accessLogPath: ACCESS_LOG_PATH, delivered: false, skipped: false };
  const tools = buildTools(toolSpecs(cliMap, native), ctx);

  // @openrouter/agent synthesizes an optional `output_${call_id}` item ID that
  // some Responses providers now reject; the hook removes only that exact ID.
  // The SDK may make several calls per agent turn (tools, retries and fallback).
  // Its injected HTTP client routes each one through the one-request lease gate.
  const client = new OpenRouter({ apiKey, httpClient: new HTTPClient({ fetcher: providerFetch }), hooks: openRouterFunctionOutputCompatibilityHook });
  const instructions = systemPreamble(cliMap, { terminal: isTerminalRun() });
  try {
    // callModel takes `instructions` (system text) + `input` (the user prompt, a
    // string), NOT a `messages` array -- an unknown key is dropped silently.
    // An in-memory state store so the conversation can be resumed for the nudge.
    // `state` MUST be passed to this FIRST call for a resume to work: callModel
    // only tracks conversation state when given a StateAccessor -- without one the
    // loaded state is null and getState()/resume throws "State not initialized".
    let savedState: ConversationState | null = null;
    const stateStore: StateAccessor = { load: async () => savedState, save: async (s) => { savedState = s; } };
    const callOnce = (input: CallInput) =>
      // Cast at the SDK boundary: `input` is this runner's own narrower CallInput
      // (a bare string or a one-item role/content array), not the SDK's full Item[]
      // union -- see CallInput's comment above.
      client.callModel({ model, instructions, input: input as unknown as string, tools, stopWhen: STOP_WHEN, allowFinalResponse: true, state: stateStore }, REQ_OPTS);
    // Run the loop; on a context-full error, truncate the oldest tool OUTPUTS in the
    // saved state (best-effort -- a no-op if the SDK hadn't saved yet, which falls
    // through to the escalation check below and then the graceful stop) and RESUME
    // with a continue message, reusing the same stateStore exactly like the nudge
    // below. Bounded by CONTEXT_RETRY_MAX.
    let text: string;
    // The FIRST call carries the media (as a structured user message); every resume
    // below (context-trim continue, invalid-response retry, nudge) is text-only --
    // the media already lives in the saved conversation state.
    // withNow: the current-time line rides the USER turn (not `instructions`/system) so
    // the system+tools prefix stays byte-stable and prompt-cacheable across runs.
    let resumeInput: CallInput = mediaParts.length
      ? [{ role: "user", content: [{ type: "input_text", text: withNow(prompt) }, ...mediaParts] }]
      : withNow(prompt);
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
    const tryEscalate = (err: unknown, label: string): boolean => {
      if (!shouldEscalateModel({ err, model, fallbackModel: FALLBACK_MODEL, alreadyEscalated: escalated })) return false;
      const prev = model;
      model = FALLBACK_MODEL;
      escalated = true;
      note(`FALLBACK[escalate]: ${label} on ${prev} -> switching model to ${FALLBACK_MODEL} (larger context window) and resuming: ${String((err as RunnerError)?.message ?? err).slice(0, 140)}`);
      return true;
    };
    // Separate budgets per recovery path so one can't starve another: the trim path used to gate on
    // the loop index, which stream retries / the invalid-response nudge also advance -- two early
    // blips could exhaust the trim budget before a single trim ran. Each counter increments ONLY
    // when its own recovery actually fires.
    let streamRetries = 0;
    let contextRetries = 0;
    for (;;) {
      try {
        text = await getTextWithUsage(callOnce(resumeInput));
        streamRetries = 0; // recovered -> reset, so the cap bounds CONSECUTIVE blips per call-site
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
        // Context window exceeded -> trim the oldest tool outputs + resume (bounded by its OWN
        // counter, incremented only on an actual trim).
        if (contextRetries < CONTEXT_RETRY_MAX && isContextFullError(err)) {
          const trimmed = trimStateToolOutputs(savedState);
          if (trimmed) {
            contextRetries++;
            note(`context full -> trimmed ${trimmed} old tool output(s) from saved state, resuming (attempt ${contextRetries}/${CONTEXT_RETRY_MAX})`);
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
        // TRANSIENT STREAM FAILURE: the SDK's opaque "Response failed" (a mid-stream
        // response.failed event with no message -- OpenRouter served the turn 200, the stream
        // just blipped), a dropped/5xx stream, a socket reset. Retry the SAME model a few times
        // with backoff BEFORE spending the one-shot escalation -- most clear on retry, and it's
        // cheaper than switching models. Resume from saved state (or re-send the task if the SDK
        // failed before saving). LOUD log every retry so a fallback is never silent.
        if (streamRetries < STREAM_RETRY_MAX && isTransientStreamError(err)) {
          streamRetries++;
          const backoff = STREAM_RETRY_BASE_MS * streamRetries;
          note(`FALLBACK[retry]: transient stream failure on ${model} -> retry ${streamRetries}/${STREAM_RETRY_MAX} in ${backoff}ms: ${String((err as RunnerError)?.message ?? err).slice(0, 140)}`);
          await sleep(backoff);
          resumeInput = savedState
            ? [{ role: "user", content: "(the previous turn failed to stream; continue and finish the task)" }]
            : originalInput;
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
      const kind = nudgeDecision({ empty, delivered: ctx.delivered, skipped: ctx.skipped, expectReply: EXPECT_REPLY, emptyNudges: n, emptyNudgeMax: EMPTY_NUDGE_MAX, unsentPoked });
      if (!kind) {
        if (ctx.skipped && !ctx.delivered) {
          const anom = skipAnomaly(true, EXPECT_REPLY, unsentPoked);
          if (anom) note(anom);
        }
        break;
      }
      const nudgeEmpty = kind === "empty";
      if (nudgeEmpty) n++; else unsentPoked = true;
      note(nudgeEmpty ? `empty turn -> nudging (${n}/${EMPTY_NUDGE_MAX})` : "answered but never sent the reply -> poking once to post it");
      const nudgeInput = [{ role: "user", content: nudgeEmpty ? EMPTY_TURN_NUDGE : unsentReplyNudge(cliMap) }];
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
            model: model as string,
            instructions,
            input: nudgeInput as unknown as string,
            tools,
            stopWhen: STOP_WHEN,
            allowFinalResponse: true,
            state: stateStore,
          }, REQ_OPTS);
          const nudgedText = await getTextWithUsage(nudged);
          streamRetries = 0; // recovered -> reset (bounds consecutive blips; nudges are themselves capped)
          // The poke's SUCCESS shape is a send tool call with no closing text
          // (unsentReplyNudge says "respond with only that tool call"), so empty
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
          const m = String((nudgeErr as RunnerError)?.message ?? nudgeErr);
          // A rate-limit/credit error DURING the nudge is still out-of-tokens --
          // let the outer catch classify it (a pricier model would fail the same).
          if (OUT_OF_TOKENS_RE.test(m)) throw nudgeErr;
          // The SAME transient-stream retry the main loop has: a bare "Response failed" during the
          // poke is a blip, not a reason to spend the one-shot escalation on it (2026-07-20: the
          // nudge path diverging from the main loop's recovery is exactly what dropped an owed
          // reply). The shared streamRetries counter bounds the total across both loops.
          if (streamRetries < STREAM_RETRY_MAX && isTransientStreamError(nudgeErr)) {
            streamRetries++;
            note(`FALLBACK[retry]: transient stream failure on ${model} (nudge) -> retry ${streamRetries}/${STREAM_RETRY_MAX} in ${STREAM_RETRY_BASE_MS * streamRetries}ms: ${m.slice(0, 140)}`);
            await sleep(STREAM_RETRY_BASE_MS * streamRetries);
            continue; // re-issue this same nudge on the same model
          }
          if (tryEscalate(nudgeErr, "nudge failed")) continue; // re-issue this nudge on the bigger model
          note(`nudge resume FAILED: ${m}`); // <- if this shows in logs, the SDK resume isn't firing
          nudgeFailed = true;
          break;
        }
      }
      if (nudgeFailed) break;
    }
    if (REPLY_REQUIRED && (!text || !text.trim()) && !ctx.delivered && !ctx.skipped) {
      note(`reply was owed but the model produced no response after ${n} nudge(s)`);
    }
    if (text && text.trim()) emit({ t: "text", text });
    emit({ t: "result", subtype: "success", text: text ?? "", resolution: ctx.delivered ? "delivered" : ctx.skipped ? "no-reply" : "unresolved", out_of_tokens: false, resets_at: null, usage: finalizeUsage(usageAcc, String(model)) });
  } catch (err) {
    const msg = String((err as RunnerError)?.message ?? err);
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
      usage: finalizeUsage(usageAcc, String(model)),
    });
    if (!outOfTokens && !contextFull) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  emit({ t: "result", subtype: "error", text: `runner crashed: ${e?.message ?? err}`, out_of_tokens: false, resets_at: null });
  process.exit(1);
});
