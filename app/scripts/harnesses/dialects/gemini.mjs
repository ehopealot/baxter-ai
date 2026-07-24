// Google Gemini generateContent dialect for the custom-API harness. Same 4-piece
// contract as anthropic.mjs; it exists to PROVE the dialect abstraction generalizes
// -- Gemini differs from OpenAI/Anthropic on every axis that matters: role name is
// "model" not "assistant", tool calls have NO id (matched by name), tools nest under
// function_declarations, and the response is under candidates[].content.parts.
// Docs: https://ai.google.dev/api/generate-content
import { toJsonSchema, isContextFullError, OUT_OF_TOKENS_RE } from "../runner-common.mjs";

export const name = "gemini";
export const defaultBaseUrl = "https://generativelanguage.googleapis.com";

// Render the normalized transcript into Gemini `contents`.
//   user      -> { role:"user",  parts:[{text}] }
//   assistant -> { role:"model", parts:[ {text}?, {functionCall:{name, args}} ... ] }
//   tool      -> { role:"user",  parts:[ {functionResponse:{name, response:{result}}} ... ] }
// Gemini matches a functionResponse to its call by NAME (there is no call id), so we
// key on r.name; the synthesized id in parseResponse is only the runner's bookkeeping.
function toContents(transcript) {
  const contents = [];
  for (const m of transcript) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: String(m.text ?? "") }] });
    } else if (m.role === "assistant") {
      const parts = [];
      if (m.text && String(m.text).trim()) parts.push({ text: String(m.text) });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
    } else if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: (m.results ?? []).map((r) => ({
          functionResponse: { name: r.name, response: { result: String(r.content ?? "") } },
        })),
      });
    }
  }
  return contents;
}

// Canonical camelCase field names (proto3-JSON also accepts snake_case, but camelCase
// is the documented form). toolChoice: "none" (the wrap-up turn) forbids tool calls
// via toolConfig while STILL sending the declarations, so the contents' functionCall/
// functionResponse parts stay valid.
export function buildRequest({ baseUrl, model, apiKey, system, transcript, specs, maxOutputTokens, toolChoice = "auto" }) {
  const base = String(baseUrl || defaultBaseUrl).replace(/\/+$/, "");
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toContents(transcript),
    generationConfig: { maxOutputTokens },
  };
  if (specs && specs.length) {
    body.tools = [
      { functionDeclarations: specs.map((spec) => ({ name: spec.name, description: spec.description, parameters: toJsonSchema(spec) })) },
    ];
    if (toolChoice === "none") body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  }
  return {
    // Model is in the PATH, not the body. Key goes in the x-goog-api-key header,
    // NOT the ?key= query param -- so it never lands in a URL that gets echoed/logged.
    url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body,
  };
}

export function parseResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  const list = Array.isArray(parts) ? parts : [];
  const text = list
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text)
    .join("");
  const toolCalls = list
    .filter((p) => p?.functionCall && typeof p.functionCall.name === "string")
    .map((p, i) => ({ id: `${p.functionCall.name}#${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }));
  return { text, toolCalls, stopReason: json?.candidates?.[0]?.finishReason ?? null };
}

// Gemini's own context-overflow phrasing (a 400 INVALID_ARGUMENT): "The input token
// count (N) exceeds the maximum number of tokens allowed (M)." The shared
// CONTEXT_FULL_RE doesn't anchor on this, and the runner trusts the dialect's `kind`
// first, so detect it here.
const GEMINI_CONTEXT_RE = /input token count|exceeds the maximum number of tokens/i;

// Gemini error body: { error:{ code, message, status } } where status is a symbolic
// code (RESOURCE_EXHAUSTED, INVALID_ARGUMENT, PERMISSION_DENIED, UNAUTHENTICATED).
export function classifyError({ status, body }) {
  const err = body && typeof body === "object" ? body.error : null;
  const message = (err && typeof err.message === "string" && err.message) || (typeof body === "string" && body) || `HTTP ${status}`;
  const sym = (err && typeof err.status === "string" && err.status) || "";
  // An invalid key arrives as 400 INVALID_ARGUMENT "API key not valid ...", NOT
  // 401/403 -- classify it as auth so a fresh-setup operator gets "check your key".
  if (status === 401 || status === 403 || sym === "PERMISSION_DENIED" || sym === "UNAUTHENTICATED" || /API key not valid/i.test(message)) {
    return { kind: "auth", message };
  }
  if (status === 429 || sym === "RESOURCE_EXHAUSTED") return { kind: "out_of_tokens", message };
  if (GEMINI_CONTEXT_RE.test(message) || isContextFullError(message)) return { kind: "context_full", message };
  if (OUT_OF_TOKENS_RE.test(message)) return { kind: "out_of_tokens", message };
  return { kind: "error", message };
}
