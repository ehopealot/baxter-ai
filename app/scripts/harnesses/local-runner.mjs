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
import { emit, note, argOf, readStdin, systemPreamble, toolSpecs, toJsonSchema, runTool, fitContext, EMPTY_TURN_NUDGE, UNSENT_REPLY_NUDGE, isDeliveryCall } from "./runner-common.mjs";

// Set by the daemon (BAXTER_EXPECT_REPLY=1) for runs where the user is waiting
// on a reply -- a Discord @mention/DM/reply, an email thread. When true, a run
// that ends having composed an answer but never SENT it (see isDeliveryCall) is
// a give-up worth one poke. Left unset for reaction/no-op and heartbeat runs.
const EXPECT_REPLY = process.env.BAXTER_EXPECT_REPLY === "1";
import { envInt } from "../schedule-store.mjs";

const BASE_URL = (process.env.OPENAI_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.OPENAI_MODEL || "";
const API_KEY = process.env.OPENAI_API_KEY || "local"; // local servers ignore it but often want a non-empty header
const CLI_OUT_MAX_BYTES = envInt("OPENAI_CLI_OUTPUT_MAX_BYTES", 256 * 1024);
const CLI_TIMEOUT_MS = envInt("OPENAI_CLI_TIMEOUT_MS", 120000);
const MAX_STEPS = envInt("OPENAI_MAX_STEPS", 40);
const REQUEST_TIMEOUT_MS = envInt("OPENAI_REQUEST_TIMEOUT_MS", 300000); // generous -- local gen can be slow
const TOOL_RESULT_MAX = 128 * 1024; // cap a SINGLE tool result fed back to the model
// Rough cumulative-context budget (tokens). Before each model call, oldest tool
// results are stubbed in place (see fitContext) to keep the whole message array
// under this, so a long tool-heavy loop can't grow past the model's context
// window -- the common blow-up on small local models. Set it to ~your model's
// context size (num_ctx); default suits a ~32k window, lower it for smaller
// local models, 0 disables. Distinct from TOOL_RESULT_MAX (per-result) and
// MAX_STEPS (iteration count) -- this is the only bound on the TOTAL.
const CONTEXT_MAX_TOKENS = envInt("OPENAI_CONTEXT_MAX_TOKENS", 24000);

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
  let nudged = false;
  let delivered = false; // set once a discord-cli/gmail reply|send actually goes out (isDeliveryCall)
  let contextTrimNoted = false; // log the first trim once, not every step
  const fitToBudget = () => {
    if (fitContext(messages, CONTEXT_MAX_TOKENS) && !contextTrimNoted) {
      contextTrimNoted = true;
      note(`context over ~${CONTEXT_MAX_TOKENS} tokens -> stubbing oldest tool results (raise OPENAI_CONTEXT_MAX_TOKENS toward your model's window if this loses needed context)`);
    }
  };
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      fitToBudget(); // keep the growing history under the context budget
      const data = await chat(messages, tools);
      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error("no choices in chat/completions response");
      messages.push(msg);
      const turnText = msg.content && String(msg.content).trim() ? String(msg.content) : "";
      if (turnText) {
        finalText = turnText;
        emit({ t: "text", text: finalText });
      }
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        // A turn with no tool calls normally ends the run. Two give-up shapes get
        // ONE nudge (never more -- `nudged` caps it): (a) an EMPTY turn (no text,
        // no call) some models emit after a tool error; (b) a reply-expecting run
        // that composed an answer as TEXT but never SENT it (answered-but-unsent
        // -- the user only sees tool-posted messages). But once ANY message was
        // DELIVERED, an empty turn is treated as a real finish, NOT an empty-turn
        // nudge (which would prompt a duplicate send). Tradeoff: this also skips
        // the after-a-tool-error recovery nudge once something was sent (e.g. an
        // interim "on it 👍") -- accepted, since a duplicate user-visible send is
        // worse than a possibly-truncated run.
        const answeredButUnsent = turnText && EXPECT_REPLY && !delivered;
        if (nudged || delivered || (turnText && !answeredButUnsent)) { finished = true; break; }
        nudged = true;
        note(turnText ? "answered but never sent the reply -> poking once to post it" : "empty turn -> nudging once");
        // An assistant message with null content + no tool_calls trips some
        // chat APIs; normalize before appending the nudge.
        if (messages[messages.length - 1].content == null) messages[messages.length - 1].content = "";
        messages.push({ role: "user", content: turnText ? UNSENT_REPLY_NUDGE : EMPTY_TURN_NUDGE });
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
        const wrap = (await chat(messages, []))?.choices?.[0]?.message?.content;
        if (wrap && String(wrap).trim()) {
          finalText = String(wrap);
          emit({ t: "text", text: finalText });
        }
      } catch (err) {
        // A 402/429 on the wrap-up turn is still out-of-tokens (and likely, having
        // just made MAX_STEPS calls) -- let the outer catch classify it. Any other
        // wrap-up failure falls through to the success result below with whatever
        // text we accumulated.
        if (err?.status === 402 || err?.status === 429) throw err;
      }
    }
    emit({ t: "result", subtype: "success", text: finalText, out_of_tokens: false, resets_at: null });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // When the error carries an HTTP status, TRUST it: 402/429 is the out-of-tokens
    // analog (exit 0, "couldn't get to this"); everything else is a HARD error
    // (nonzero exit -> runAgent failed -> heartbeat retries). Only non-HTTP errors
    // (timeout / fetch failed / no choices -- which won't match) fall back to the
    // message regex, so a 500 whose body happens to say "quota"/"429" isn't misread
    // as out-of-tokens.
    const outOfTokens =
      err?.status != null ? err.status === 402 || err.status === 429 : /insufficient|rate.?limit|quota|too many requests/i.test(msg);
    emit({ t: "result", subtype: "error", text: msg, out_of_tokens: outOfTokens, resets_at: null });
    if (!outOfTokens) process.exitCode = 1;
  }
}

main().catch((err) => {
  emit({ t: "result", subtype: "error", text: `runner crashed: ${err?.message ?? err}`, out_of_tokens: false, resets_at: null });
  process.exit(1);
});
