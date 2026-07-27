// Google Gemini generateContent dialect for the custom-API harness. Same 4-piece
// contract as anthropic.ts; it exists to PROVE the dialect abstraction generalizes
// -- Gemini differs from OpenAI/Anthropic on every axis that matters: role name is
// "model" not "assistant", tool calls have NO id (matched by name), tools nest under
// function_declarations, and the response is under candidates[].content.parts.
// Docs: https://ai.google.dev/api/generate-content
import { toJsonSchema, isContextFullError, OUT_OF_TOKENS_RE } from "../runner-common.ts";
import type { BuildRequestParams, DialectClassifiedError, DialectRequest, DialectResponse, TranscriptItem } from "../runner-common.ts";

export const name = "gemini";
export const defaultBaseUrl = "https://generativelanguage.googleapis.com";

// Gemini `contents[].parts[]` -- one loose interface (wire-format union) since a
// single parts array mixes text/functionCall/functionResponse entries.
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
}
interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}
interface GeminiBody {
  systemInstruction: { parts: { text: string }[] };
  contents: GeminiContent[];
  generationConfig: { maxOutputTokens: number };
  tools?: { functionDeclarations: { name: string; description: string; parameters: unknown }[] }[];
  toolConfig?: { functionCallingConfig: { mode: string } };
}

// Render the normalized transcript into Gemini `contents`.
//   user      -> { role:"user",  parts:[{text}] }
//   assistant -> { role:"model", parts:[ {text}?, {functionCall:{name, args}} ... ] }
//   tool      -> { role:"user",  parts:[ {functionResponse:{name, response:{result}}} ... ] }
// Gemini matches a functionResponse to its call by NAME (there is no call id), so we
// key on r.name; the synthesized id in parseResponse is only the runner's bookkeeping.
function toContents(transcript: TranscriptItem[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const m of transcript) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: String(m.text ?? "") }] });
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.text && String(m.text).trim()) parts.push({ text: String(m.text) });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
      // A part must be non-empty (an empty text part is invalid); the empty-turn case
      // the runner pushes before nudging gets a filler string so the next request is valid.
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "(no response)" }] });
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
export function buildRequest({ baseUrl, model, apiKey, system, transcript, specs, maxOutputTokens, toolChoice = "auto" }: BuildRequestParams): DialectRequest {
  const base = String(baseUrl || defaultBaseUrl).replace(/\/+$/, "");
  const body: GeminiBody = {
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

export function parseResponse(json: unknown): DialectResponse {
  const j = json as { candidates?: { content?: { parts?: unknown }; finishReason?: unknown }[] } | null | undefined;
  const parts = j?.candidates?.[0]?.content?.parts;
  const list: GeminiPart[] = Array.isArray(parts) ? parts : [];
  const text = list
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text as string)
    .join("");
  const toolCalls = list
    .filter((p) => p?.functionCall && typeof p.functionCall.name === "string")
    .map((p, i) => ({ id: `${p.functionCall!.name}#${i}`, name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
  return { text, toolCalls, stopReason: (j?.candidates?.[0]?.finishReason as string | null | undefined) ?? null };
}

// Gemini's own context-overflow phrasing (a 400 INVALID_ARGUMENT): "The input token
// count (N) exceeds the maximum number of tokens allowed (M)." The shared
// CONTEXT_FULL_RE doesn't anchor on this, and the runner trusts the dialect's `kind`
// first, so detect it here.
const GEMINI_CONTEXT_RE = /input token count|exceeds the maximum number of tokens/i;

// Gemini error body: { error:{ code, message, status } } where status is a symbolic
// code (RESOURCE_EXHAUSTED, INVALID_ARGUMENT, PERMISSION_DENIED, UNAUTHENTICATED).
export function classifyError({ status, body }: { status: number; body: unknown }): DialectClassifiedError {
  const b = body as { error?: { message?: unknown; status?: unknown } } | string | null | undefined;
  const err = b && typeof b === "object" ? b.error : null;
  const message = (err && typeof err.message === "string" && err.message) || (typeof b === "string" && b) || `HTTP ${status}`;
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
