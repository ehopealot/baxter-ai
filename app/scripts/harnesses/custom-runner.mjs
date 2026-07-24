#!/usr/bin/env node
// Custom-API harness runner (BAXTER_HARNESS=custom). Same contract as the
// openrouter/local runners (rendered prompt on STDIN -> normalized JSONL events ->
// a final `result`), but drives ANY keyed LLM HTTP API by swapping only the wire
// DIALECT (CUSTOM_API_DIALECT). Ships anthropic + gemini -- the two big NON-OpenAI
// native shapes; OpenAI-compatible endpoints stay on the `local` harness.
//
// It reuses the ENTIRE structured-tool layer -- preamble, tool specs, cwd-confined
// executors, nudges, delivery detection, error classification (runner-common +
// openrouter-tools). The only thing that differs per provider is the 4-piece dialect
// (dialects/<name>.mjs). To generalize across wire formats it keeps a dialect-NEUTRAL
// normalized transcript and asks the dialect to render it per call (local-runner's
// in-place OpenAI-array mutation doesn't generalize):
//   { role:"user", text } | { role:"assistant", text, toolCalls:[{id,name,args}] }
//                          | { role:"tool", results:[{id,name,content}] }
//
// Config: CUSTOM_API_DIALECT (anthropic|gemini), CUSTOM_API_MODEL, CUSTOM_API_KEY,
// CUSTOM_API_BASE_URL (optional; dialect default otherwise), CUSTOM_API_MAX_OUTPUT_TOKENS.
import { getDialect } from "./dialects/index.mjs";
import { parseAllowedTools } from "./openrouter-tools.mjs";
import { emit, note, argOf, readStdin, systemPreamble, toolSpecs, runTool, fitTranscript, estTokens, isContextFullError, OUT_OF_TOKENS_RE, EMPTY_TURN_NUDGE, UNSENT_REPLY_NUDGE, isDeliveryCall, nudgeDecision } from "./runner-common.mjs";
import { envInt } from "../schedule-store.mjs";

const EXPECT_REPLY = process.env.BAXTER_EXPECT_REPLY === "1";
const REPLY_REQUIRED = process.env.BAXTER_REPLY_REQUIRED === "1";
const EMPTY_NUDGE_MAX = REPLY_REQUIRED ? envInt("CUSTOM_API_EMPTY_NUDGE_MAX", 3) : 1;

const DIALECT_NAME = process.env.CUSTOM_API_DIALECT || "";
const MODEL = process.env.CUSTOM_API_MODEL || "";
const API_KEY = process.env.CUSTOM_API_KEY || "";
const BASE_URL = process.env.CUSTOM_API_BASE_URL || ""; // "" -> dialect.defaultBaseUrl
const MAX_OUTPUT_TOKENS = envInt("CUSTOM_API_MAX_OUTPUT_TOKENS", 8192);
const CLI_OUT_MAX_BYTES = envInt("CUSTOM_API_CLI_OUTPUT_MAX_BYTES", 256 * 1024);
const CLI_TIMEOUT_MS = envInt("CUSTOM_API_CLI_TIMEOUT_MS", 120000);
const MAX_STEPS = envInt("CUSTOM_API_MAX_STEPS", 40);
const REQUEST_TIMEOUT_MS = envInt("CUSTOM_API_REQUEST_TIMEOUT_MS", 300000);
const TOOL_RESULT_MAX = 128 * 1024; // cap a SINGLE tool result fed back to the model
// Cumulative-context budget (tokens). 0 (default) disables -- unlike local's 24000,
// there's no single window across dialects, and the daemons already bound history.
const CONTEXT_MAX_TOKENS = envInt("CUSTOM_API_CONTEXT_MAX_TOKENS", 0);
const CONTEXT_RETRY_MAX = envInt("CUSTOM_API_CONTEXT_RETRY_MAX", 2);

async function main() {
  const failHard = (text) => {
    emit({ t: "result", subtype: "error", text, out_of_tokens: false, resets_at: null });
    process.exitCode = 1;
  };
  if (!DIALECT_NAME) return failHard("CUSTOM_API_DIALECT is not set (the wire dialect: anthropic|gemini)");
  let dialect;
  try {
    dialect = getDialect(DIALECT_NAME);
  } catch (err) {
    return failHard(err.message);
  }
  if (!MODEL) return failHard("CUSTOM_API_MODEL is not set (the model to run)");
  if (!API_KEY) return failHard("CUSTOM_API_KEY is not set (the API key for the provider)");

  const { cliMap, native } = parseAllowedTools(argOf("--allowed") ?? "");
  const prompt = await readStdin();
  const ctx = { cwd: process.cwd(), cliMap, env: process.env, timeoutMs: CLI_TIMEOUT_MS, maxBytes: CLI_OUT_MAX_BYTES };
  const specs = toolSpecs(cliMap, native);
  const specByName = Object.fromEntries(specs.map((s) => [s.name, s]));
  const system = systemPreamble(cliMap);

  // The dialect-neutral transcript. Item 0 (the prompt) is a must-keep for fitTranscript.
  const transcript = [{ role: "user", text: prompt }];

  // POST the current transcript to the provider and normalize the reply. toolChoice
  // "none" (the wrap-up turn) forbids further tool calls to force a final text answer;
  // the tools are STILL sent (Anthropic/Gemini reject a request that carries tool
  // blocks in the transcript but drops the tool declarations), so it's suppression,
  // not omission.
  const callModel = async (toolChoice = "auto") => {
    const req = dialect.buildRequest({
      baseUrl: BASE_URL,
      model: MODEL,
      apiKey: API_KEY,
      system,
      transcript,
      specs,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      toolChoice,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(req.url, { method: "POST", signal: controller.signal, headers: req.headers, body: JSON.stringify(req.body) });
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      // Node's fetch puts the real reason (ECONNREFUSED/ENOTFOUND/TLS) in err.cause.
      const cause = err.cause ? ` (${err.cause.code ?? err.cause.message})` : "";
      throw new Error(`request to ${req.url} failed: ${err.message}${cause}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      let body = bodyText;
      try { body = JSON.parse(bodyText); } catch { /* keep the text */ }
      const { kind, message } = dialect.classifyError({ status: res.status, body });
      const e = new Error(message);
      e.status = res.status;
      e.kind = kind; // out_of_tokens | context_full | auth | error -- the outer catch acts on it
      throw e;
    }
    return dialect.parseResponse(await res.json());
  };

  let finalText = "";
  let finished = false;
  let emptyNudges = 0;
  let unsentPoked = false;
  let delivered = false;
  let contextTrimNoted = false;
  const fitToBudget = () => {
    if (fitTranscript(transcript, CONTEXT_MAX_TOKENS) && !contextTrimNoted) {
      contextTrimNoted = true;
      note(`context over ~${CONTEXT_MAX_TOKENS} tokens -> stubbing oldest tool results/arguments (raise CUSTOM_API_CONTEXT_MAX_TOKENS toward your model's window if this loses needed context)`);
    }
  };
  // "is this a context-window overflow?" -- trust the dialect's classification first (a
  // Gemini overflow is recognized ONLY by its classifyError -> kind, not the shared regex),
  // then fall back to the shared matcher. ONE helper used at all three sites below so they
  // can't drift -- that drift is exactly what once let the wrap-up catch swallow a Gemini
  // overflow into a stale success.
  const isCtxFull = (err) => err?.kind === "context_full" || isContextFullError(err);
  // callModel, but recover from a context-full error by HALVING the transcript and
  // retrying (window-agnostic, converges). Give up after CONTEXT_RETRY_MAX or once
  // nothing is left to trim -> the outer catch ends the run gracefully. Never retries
  // once a reply was delivered (a resend would duplicate it).
  const callWithContextRetry = async (toolChoice = "auto") => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callModel(toolChoice);
      } catch (err) {
        const ctxFull = isCtxFull(err);
        if (attempt >= CONTEXT_RETRY_MAX || !ctxFull || delivered) throw err;
        const total = transcript.reduce((n, m) => n + estTokens(m), 0);
        const budget = Math.max(500, Math.floor(total / 2));
        if (!fitTranscript(transcript, budget)) throw err; // nothing left to trim
        note(`context full -> trimmed transcript to ~${budget} tokens, retrying (attempt ${attempt + 1}/${CONTEXT_RETRY_MAX})`);
      }
    }
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      fitToBudget();
      let turn;
      try {
        turn = await callWithContextRetry();
      } catch (err) {
        // Once a reply has gone out, DON'T retry/hard-fail (either would duplicate the
        // send or re-fire an answered task) -- finish with what we have. Mirrors the
        // local/openrouter runners' delivered short-circuit.
        if (!delivered) throw err;
        note(`request failed (${err.message}), but a reply was already delivered -> treating as done`);
        finished = true;
        break;
      }

      const turnText = turn.text && String(turn.text).trim() ? String(turn.text) : "";
      const calls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
      // Record the assistant turn in the transcript (even when empty, so the next
      // user nudge keeps strict user/assistant alternation the dialects require).
      transcript.push({ role: "assistant", text: turnText, toolCalls: calls });
      if (turnText) {
        finalText = turnText;
        emit({ t: "text", text: finalText });
      }

      if (!calls.length) {
        // Same two give-up shapes the other runners nudge (via the shared nudgeDecision
        // so the loops can't drift): an EMPTY turn (nudged up to EMPTY_NUDGE_MAX), or a
        // reply-expecting run that wrote an answer as TEXT but never SENT it (poked once).
        const kind = nudgeDecision({ empty: !turnText, delivered, expectReply: EXPECT_REPLY, emptyNudges, emptyNudgeMax: EMPTY_NUDGE_MAX, unsentPoked });
        if (!kind) {
          if (REPLY_REQUIRED && !turnText && !delivered) note(`reply was owed but the model produced no response after ${emptyNudges} nudge(s)`);
          finished = true;
          break;
        }
        const nudgeEmpty = kind === "empty";
        if (nudgeEmpty) emptyNudges++; else unsentPoked = true;
        note(nudgeEmpty ? `empty turn -> nudging (${emptyNudges}/${EMPTY_NUDGE_MAX})` : "answered but never sent the reply -> poking once to post it");
        transcript.push({ role: "user", text: nudgeEmpty ? EMPTY_TURN_NUDGE : UNSENT_REPLY_NUDGE });
        continue;
      }

      // Run every tool call; bundle the results as one transcript item.
      const results = [];
      for (const call of calls) {
        const spec = specByName[call.name];
        let result;
        if (!spec) {
          emit({ t: "tool_use", name: call.name || "?", input: call.args });
          result = { ok: false, error: `unknown tool: ${call.name}` };
          emit({ t: "tool_result", is_error: true, content: result });
        } else {
          result = await runTool(spec, call.args ?? {}, ctx);
        }
        if (isDeliveryCall(call.name, call.args) && result?.ok !== false) delivered = true;
        let content = JSON.stringify(result);
        if (content.length > TOOL_RESULT_MAX) content = content.slice(0, TOOL_RESULT_MAX) + "…[truncated]";
        results.push({ id: call.id, name: call.name, content });
      }
      transcript.push({ role: "tool", results });
    }

    if (!finished) {
      // Hit the step cap mid-tool-loop: force ONE final turn with NO tools so the
      // model wraps up with what it has (mirrors the other runners) instead of a
      // silent truncation into a stale success.
      try {
        fitToBudget();
        const wrap = await callWithContextRetry("none");
        if (wrap.text && String(wrap.text).trim()) {
          finalText = String(wrap.text);
          emit({ t: "text", text: finalText });
        }
      } catch (err) {
        // Let the outer catch classify an out-of-tokens / context-full wrap-up failure
        // rather than swallow it into a stale success -- UNLESS a reply already went out
        // (then a retry-later would duplicate the send), in which case fall through as done.
        // isCtxFull covers BOTH kind:"context_full" (a Gemini overflow the shared regex
        // doesn't match) and isContextFullError -- without it this catch once swallowed a
        // Gemini overflow into a stale success.
        if (!delivered && (err?.kind === "out_of_tokens" || err?.status === 402 || err?.status === 429 || isCtxFull(err))) throw err;
      }
    }
    emit({ t: "result", subtype: "success", text: finalText, out_of_tokens: false, resets_at: null });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // A context-full error won't fix on a later retry (same oversized prompt
    // re-overflows) -> end GRACEFULLY (exit 0) so heartbeat doesn't retry into the
    // same wall and discord/poll don't count a hard failure. Trust the dialect's
    // classification first, then the shared helpers as a fallback.
    const contextFull = isCtxFull(err);
    const outOfTokens =
      !contextFull &&
      (err?.kind === "out_of_tokens" ||
        (err?.status != null ? err.status === 402 || err.status === 429 : OUT_OF_TOKENS_RE.test(msg)));
    emit({
      t: "result",
      subtype: "error",
      text: contextFull ? `context full -- the task didn't fit the model's window even after trimming: ${msg}` : msg,
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
