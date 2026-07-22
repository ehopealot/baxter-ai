#!/usr/bin/env node
// Local / OpenAI-compatible harness runner. Same contract as openrouter-runner
// (rendered prompt on STDIN -> normalized JSONL events -> a final `result`), but
// drives any OpenAI CHAT/COMPLETIONS endpoint -- a self-hosted model via Ollama /
// LM Studio / llama.cpp (the default), or OpenAI / OpenRouter -- so Baxter can run
// off a local model. Reuses the shared preamble + tool set (runner-common) and the
// security-critical executors (openrouter-tools); only the loop differs from the
// OpenRouter runner (raw chat/completions instead of the Agent SDK's callModel).
//
// Config: OPENAI_BASE_URL (default local Ollama), OPENAI_MODEL (required),
// OPENAI_API_KEY (optional -- most local servers ignore it).
import { parseAllowedTools } from "./openrouter-tools.mjs";
import { emit, note, argOf, readStdin, systemPreamble, toolSpecs, toJsonSchema, runTool, fitContext, estTokens, isContextFullError, OUT_OF_TOKENS_RE, EMPTY_TURN_NUDGE, UNSENT_REPLY_NUDGE, isDeliveryCall, nudgeDecision } from "./runner-common.mjs";

// Set by the daemon (BAXTER_EXPECT_REPLY=1) for runs where the user is waiting
// on a reply -- a Discord @mention/DM/reply, an email thread. When true, a run
// that ends having composed an answer but never SENT it (see isDeliveryCall) is
// a give-up worth one poke. Left unset for reaction/no-op and heartbeat runs.
const EXPECT_REPLY = process.env.BAXTER_EXPECT_REPLY === "1";
import { envInt } from "../schedule-store.mjs";
// A run where a reply is genuinely OWED (a real DM/@mention/reply, or an email)
// rather than optional (channel chatter, reactions). An empty turn on such a run
// is nudged harder (up to EMPTY_NUDGE_MAX); otherwise it gets one nudge and stands.
const REPLY_REQUIRED = process.env.BAXTER_REPLY_REQUIRED === "1";
const EMPTY_NUDGE_MAX = REPLY_REQUIRED ? envInt("OPENAI_EMPTY_NUDGE_MAX", 3) : 1;

const BASE_URL = (process.env.OPENAI_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.OPENAI_MODEL || "";
const API_KEY = process.env.OPENAI_API_KEY || "local"; // local servers ignore it but often want a non-empty header
const CLI_OUT_MAX_BYTES = envInt("OPENAI_CLI_OUTPUT_MAX_BYTES", 256 * 1024);
const CLI_TIMEOUT_MS = envInt("OPENAI_CLI_TIMEOUT_MS", 120000);
const MAX_STEPS = envInt("OPENAI_MAX_STEPS", 40);
const REQUEST_TIMEOUT_MS = envInt("OPENAI_REQUEST_TIMEOUT_MS", 300000); // generous -- local gen can be slow
const TOOL_RESULT_MAX = 128 * 1024; // cap a SINGLE tool result fed back to the model
// Rough cumulative-context budget (tokens). Before each model call, oldest tool
// results (then oversized tool-call arguments) are stubbed in place (see
// fitContext) to keep the whole message array under this, so a long tool-heavy
// loop can't grow past the model's context
// window -- the common blow-up on small local models. Set it to ~your model's
// context size (num_ctx); default suits a ~32k window, lower it for smaller
// local models, 0 disables. Distinct from TOOL_RESULT_MAX (per-result) and
// MAX_STEPS (iteration count) -- this is the only bound on the TOTAL.
const CONTEXT_MAX_TOKENS = envInt("OPENAI_CONTEXT_MAX_TOKENS", 24000);
// How many times to trim-harder-and-retry after a context-full error before
// giving up to the graceful stop (a genuinely unfittable prompt shouldn't loop).
const CONTEXT_RETRY_MAX = envInt("OPENAI_CONTEXT_RETRY_MAX", 2);

function chatTools(specs) {
  return specs.map((spec) => ({ type: "function", function: { name: spec.name, description: spec.description, parameters: toJsonSchema(spec) } }));
}

async function chat(messages, tools) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    // Node's fetch puts the real reason (ECONNREFUSED when the local server isn't
    // running, ENOTFOUND, TLS) in err.cause -- surface it so the log distinguishes
    // "server down" from a base-URL typo.
    const cause = err.cause ? ` (${err.cause.code ?? err.cause.message})` : "";
    throw new Error(`request to ${BASE_URL} failed: ${err.message}${cause}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const e = new Error(`chat/completions ${res.status}: ${body.slice(0, 500)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function main() {
  const failHard = (text) => {
    emit({ t: "result", subtype: "error", text, out_of_tokens: false, resets_at: null });
    process.exitCode = 1;
  };
  if (!MODEL) return failHard("OPENAI_MODEL is not set (the local/OpenAI-compatible model to run)");

  const { cliMap, native } = parseAllowedTools(argOf("--allowed") ?? "");
  const prompt = await readStdin();
  const ctx = { cwd: process.cwd(), cliMap, env: process.env, timeoutMs: CLI_TIMEOUT_MS, maxBytes: CLI_OUT_MAX_BYTES };
  const specs = toolSpecs(cliMap, native);
  const specByName = Object.fromEntries(specs.map((s) => [s.name, s]));
  const tools = chatTools(specs);

  const messages = [
    { role: "system", content: systemPreamble(cliMap) },
    { role: "user", content: prompt },
  ];

  let finalText = "";
  let finished = false;
  let emptyNudges = 0;   // empty-turn nudges spent (capped at EMPTY_NUDGE_MAX)
  let unsentPoked = false; // whether the answered-but-unsent poke has fired (once)
  let delivered = false; // set once a discord-cli/mail reply|send actually goes out (isDeliveryCall)
  let contextTrimNoted = false; // log the first trim once, not every step
  const fitToBudget = () => {
    if (fitContext(messages, CONTEXT_MAX_TOKENS) && !contextTrimNoted) {
      contextTrimNoted = true;
      note(`context over ~${CONTEXT_MAX_TOKENS} tokens -> stubbing oldest tool results/arguments (raise OPENAI_CONTEXT_MAX_TOKENS toward your model's window if this loses needed context)`);
    }
  };
  // `chat`, but recover from a context-full error: the model's real window may be
  // smaller than OPENAI_CONTEXT_MAX_TOKENS (or the prompt itself was large). We
  // don't know the true window, but we know the current history was too big, so
  // HALVE it (budget = half the current estimate, forcing fitContext to actually
  // stub) and retry -- window-agnostic, converges in a couple of attempts. Give up
  // after CONTEXT_RETRY_MAX or once there's nothing left to trim -> the outer catch
  // ends the run gracefully.
  const chatWithContextRetry = async (callTools = tools) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await chat(messages, callTools);
      } catch (err) {
        // Never trim-and-retry once a reply has already gone out: the retry
        // re-sends the same history and the model can re-issue the delivery call.
        // Throw instead -> the step-loop caller treats a delivered failure as done.
        // (Mirrors the openrouter runner's top-of-catch delivered short-circuit.)
        if (attempt >= CONTEXT_RETRY_MAX || !isContextFullError(err) || delivered) throw err;
        const total = messages.reduce((n, m) => n + estTokens(m), 0);
        const budget = Math.max(500, Math.floor(total / 2));
        if (!fitContext(messages, budget)) throw err; // nothing left to trim -> can't recover
        note(`context full -> trimmed history to ~${budget} tokens, retrying (attempt ${attempt + 1}/${CONTEXT_RETRY_MAX})`);
      }
    }
  };
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      fitToBudget(); // keep the growing history under the context budget
      // One guarded block for the whole step model-call: an HTTP failure OR a 200
      // with no usable choices. Once a reply has gone out via a tool call, DON'T
      // resume/retry (any re-call risks a DUPLICATE send) and don't hard-fail (which
      // would make heartbeat re-fire the answered task) -- finish as done with
      // whatever text we have. Mirrors the openrouter runner's top-of-catch delivered
      // short-circuit. When NOT delivered, both errors rethrow unchanged (the
      // status-less "no choices" one hard-fails a genuinely-unanswered task, as before).
      let msg;
      try {
        const data = await chatWithContextRetry();
        msg = data?.choices?.[0]?.message;
        if (!msg) throw new Error("no choices in chat/completions response");
      } catch (err) {
        if (!delivered) throw err;
        note(`request failed (${err.message}), but a reply was already delivered -> treating as done`);
        finished = true; // else the `if (!finished)` wrap-up below re-issues the failed request
        break;
      }
      messages.push(msg);
      const turnText = msg.content && String(msg.content).trim() ? String(msg.content) : "";
      if (turnText) {
        finalText = turnText;
        emit({ t: "text", text: finalText });
      }
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        // A turn with no tool calls normally ends the run. Two give-up shapes get
        // nudged via `nudgeDecision` (shared with the openrouter runner so the two
        // loops can't drift): (a) an EMPTY turn (no text, no call) some models emit
        // after a tool error -- nudged up to EMPTY_NUDGE_MAX times (>1 only when a
        // reply is OWED; else once); (b) a reply-expecting run that composed an
        // answer as TEXT but never SENT it -- poked ONCE. Once ANY message was
        // DELIVERED, an empty turn is a real finish, not a nudge (which would prompt
        // a duplicate send). Tradeoff: this also skips the after-a-tool-error
        // recovery nudge once something was sent (e.g. an interim "on it 👍") --
        // accepted, since a duplicate user-visible send is worse than a short run.
        const kind = nudgeDecision({ empty: !turnText, delivered, expectReply: EXPECT_REPLY, emptyNudges, emptyNudgeMax: EMPTY_NUDGE_MAX, unsentPoked });
        if (!kind) {
          if (REPLY_REQUIRED && !turnText && !delivered) note(`reply was owed but the model produced no response after ${emptyNudges} nudge(s)`);
          finished = true;
          break;
        }
        const nudgeEmpty = kind === "empty";
        if (nudgeEmpty) emptyNudges++; else unsentPoked = true;
        note(nudgeEmpty ? `empty turn -> nudging (${emptyNudges}/${EMPTY_NUDGE_MAX})` : "answered but never sent the reply -> poking once to post it");
        // An assistant message with null content + no tool_calls trips some
        // chat APIs; normalize before appending the nudge.
        if (messages[messages.length - 1].content == null) messages[messages.length - 1].content = "";
        messages.push({ role: "user", content: nudgeEmpty ? EMPTY_TURN_NUDGE : UNSENT_REPLY_NUDGE });
        continue;
      }
      for (const call of calls) {
        const name = call.function?.name;
        const rawArgs = call.function?.arguments ?? "{}";
        let params;
        let badJson = false;
        try {
          params = JSON.parse(rawArgs || "{}");
        } catch {
          badJson = true;
        }
        const spec = specByName[name];
        let result;
        if (badJson) {
          // Local models mangle tool-call JSON routinely -- feed the REAL problem
          // back instead of coercing to {} (which makes the executor complain about
          // the wrong thing, e.g. cli "undefined" / EISDIR, steering the model to
          // "fix" the wrong field and loop).
          emit({ t: "tool_use", name: name || "?", input: rawArgs });
          result = { ok: false, error: `tool call arguments were not valid JSON: ${String(rawArgs).slice(0, 200)}` };
          emit({ t: "tool_result", is_error: true, content: result });
        } else if (!spec) {
          emit({ t: "tool_use", name: name || "?", input: params });
          result = { ok: false, error: `unknown tool: ${name}` };
          emit({ t: "tool_result", is_error: true, content: result });
        } else {
          result = await runTool(spec, params, ctx);
        }
        if (!badJson && isDeliveryCall(name, params) && result?.ok !== false) delivered = true;
        const content = JSON.stringify(result);
        messages.push({ role: "tool", tool_call_id: call.id, content: content.length > TOOL_RESULT_MAX ? content.slice(0, TOOL_RESULT_MAX) + "…[truncated]" : content });
      }
    }
    if (!finished) {
      // Hit the step cap while still tool-calling. Force ONE final turn with NO
      // tools so the model wraps up with what it has (mirrors the openrouter
      // runner's allowFinalResponse) instead of silently truncating into a success
      // with empty/stale text.
      try {
        fitToBudget(); // the wrap-up turn re-sends the whole history too
        // Through the retry helper: this is the LARGEST the history ever gets, so
        // it's the most likely place to overflow -- trim-and-retry here too.
        const wrap = (await chatWithContextRetry([]))?.choices?.[0]?.message?.content;
        if (wrap && String(wrap).trim()) {
          finalText = String(wrap);
          emit({ t: "text", text: finalText });
        }
      } catch (err) {
        // A 402/429 on the wrap-up turn is still out-of-tokens (and likely, having
        // just made MAX_STEPS calls), and a context overflow the retry couldn't fix
        // is a graceful context-full stop -- let the outer catch classify EITHER
        // rather than swallow it into a stale success. Any other wrap-up failure
        // falls through to the success result below with whatever text we accumulated.
        // BUT once a reply was delivered, even these end as done (the optional wrap-up
        // is the one post-delivery model call outside the retry guard; a retry-later
        // here would re-fire the task and duplicate the send).
        if (!delivered && (err?.status === 402 || err?.status === 429 || isContextFullError(err))) throw err;
      }
    }
    emit({ t: "result", subtype: "success", text: finalText, out_of_tokens: false, resets_at: null });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // A context-full error that survived the trim-retry above won't fix on a later
    // retry (the same oversized prompt re-overflows), so end the run GRACEFULLY --
    // exit 0, so heartbeat treats it as done (no futile retry) and discord/poll
    // don't count it a hard failure. Checked before out-of-tokens because a
    // context overflow often carries a 400 status that the regex below ignores.
    const contextFull = isContextFullError(err);
    // When the error carries an HTTP status, TRUST it: 402/429 is the out-of-tokens
    // analog (exit 0, "couldn't get to this"); everything else is a HARD error
    // (nonzero exit -> runAgent failed -> heartbeat retries). Only non-HTTP errors
    // (timeout / fetch failed / no choices -- which won't match) fall back to the
    // shared OUT_OF_TOKENS_RE, so a 500 whose body happens to say "quota"/"429" isn't
    // misread (it has a status, so it never reaches the regex). Same regex as
    // isContextFullError uses, so the two classifications can't disagree.
    const outOfTokens =
      !contextFull &&
      (err?.status != null ? err.status === 402 || err.status === 429 : OUT_OF_TOKENS_RE.test(msg));
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
