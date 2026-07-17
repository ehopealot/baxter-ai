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
import { emit, argOf, readStdin, systemPreamble, toolSpecs, toJsonSchema, runTool } from "./runner-common.mjs";
import { envInt } from "../schedule-store.mjs";

const BASE_URL = (process.env.OPENAI_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.OPENAI_MODEL || "";
const API_KEY = process.env.OPENAI_API_KEY || "local"; // local servers ignore it but often want a non-empty header
const CLI_OUT_MAX_BYTES = envInt("OPENAI_CLI_OUTPUT_MAX_BYTES", 256 * 1024);
const CLI_TIMEOUT_MS = envInt("OPENAI_CLI_TIMEOUT_MS", 120000);
const MAX_STEPS = envInt("OPENAI_MAX_STEPS", 40);
const REQUEST_TIMEOUT_MS = envInt("OPENAI_REQUEST_TIMEOUT_MS", 300000); // generous -- local gen can be slow
const TOOL_RESULT_MAX = 128 * 1024; // cap a tool result fed back to the model

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
    throw new Error(err.name === "AbortError" ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : `request to ${BASE_URL} failed: ${err.message}`);
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
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await chat(messages, tools);
      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error("no choices in chat/completions response");
      messages.push(msg);
      if (msg.content && String(msg.content).trim()) {
        finalText = String(msg.content);
        emit({ t: "text", text: finalText });
      }
      const calls = msg.tool_calls || [];
      if (!calls.length) break; // the model produced its final answer
      for (const call of calls) {
        const name = call.function?.name;
        let params = {};
        try {
          params = JSON.parse(call.function?.arguments || "{}");
        } catch {
          params = {};
        }
        const spec = specByName[name];
        let result;
        if (!spec) {
          emit({ t: "tool_use", name: name || "?", input: params });
          result = { ok: false, error: `unknown tool: ${name}` };
          emit({ t: "tool_result", is_error: true, content: result });
        } else {
          result = await runTool(spec, params, ctx);
        }
        const content = JSON.stringify(result);
        messages.push({ role: "tool", tool_call_id: call.id, content: content.length > TOOL_RESULT_MAX ? content.slice(0, TOOL_RESULT_MAX) + "…[truncated]" : content });
      }
    }
    emit({ t: "result", subtype: "success", text: finalText, out_of_tokens: false, resets_at: null });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // 402/429 (or a rate/quota message) is the out-of-tokens analog; a connection
    // refusal (local server down), timeout, or any other error is a HARD error ->
    // nonzero exit so runAgent's failed path fires (heartbeat retries).
    const outOfTokens = err?.status === 402 || err?.status === 429 || /\b402\b|\b429\b|insufficient|rate.?limit|quota|too many requests/i.test(msg);
    emit({ t: "result", subtype: "error", text: msg, out_of_tokens: outOfTokens, resets_at: null });
    if (!outOfTokens) process.exitCode = 1;
  }
}

main().catch((err) => {
  emit({ t: "result", subtype: "error", text: `runner crashed: ${err?.message ?? err}`, out_of_tokens: false, resets_at: null });
  process.exit(1);
});
