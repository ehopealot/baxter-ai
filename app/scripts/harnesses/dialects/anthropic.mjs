// Anthropic Messages API dialect for the custom-API harness (custom-runner.mjs).
// A dialect is four PURE, I/O-free, unit-testable pieces -- the runner owns fetch,
// the loop, tools, and the security boundary; the dialect owns ONLY this provider's
// wire format:
//   defaultBaseUrl
//   buildRequest({...}) -> { url, headers, body }   (body is a JS object)
//   parseResponse(json) -> { text, toolCalls:[{id,name,args}], stopReason }
//   classifyError({status, body}) -> { kind, message }   kind: out_of_tokens|context_full|auth|error
//
// This is the headline dialect: it lets Baxter run on REAL Claude by API key,
// without the Claude Code binary. Docs: https://docs.anthropic.com/en/api/messages
import { toJsonSchema, isContextFullError, OUT_OF_TOKENS_RE } from "../runner-common.mjs";

export const name = "anthropic";
export const defaultBaseUrl = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// Render the normalized transcript into Anthropic `messages` content blocks.
//   user      -> { role:"user",      content:[{type:"text", text}] }
//   assistant -> { role:"assistant", content:[ {type:"text",text}?, {type:"tool_use", id, name, input} ... ] }
//   tool      -> { role:"user",      content:[ {type:"tool_result", tool_use_id, content} ... ] }
function toMessages(transcript) {
  const messages = [];
  for (const m of transcript) {
    if (m.role === "user") {
      messages.push({ role: "user", content: [{ type: "text", text: String(m.text ?? "") }] });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.text && String(m.text).trim()) content.push({ type: "text", text: String(m.text) });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      }
      // An assistant turn must carry at least one NON-EMPTY block: the Messages API
      // rejects an empty text block ("text content blocks must be non-empty"). A bare
      // text-less/call-less turn is the empty-turn case the runner pushes (to keep
      // user/assistant alternation) before nudging -- render it as a filler string so
      // the NEXT request stays valid.
      messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no response)" }] });
    } else if (m.role === "tool") {
      messages.push({
        role: "user",
        content: (m.results ?? []).map((r) => ({ type: "tool_result", tool_use_id: r.id, content: String(r.content ?? "") })),
      });
    }
  }
  return messages;
}

// toolChoice: "auto" (default) lets the model call tools; "none" forbids it (the
// wrap-up turn). The tools MUST still be sent even on the wrap-up, because the
// Messages API rejects a request whose messages contain tool_use/tool_result blocks
// unless the top-level `tools` param is present -- so suppression is tool_choice,
// never tool omission.
export function buildRequest({ baseUrl, model, apiKey, system, transcript, specs, maxOutputTokens, toolChoice = "auto" }) {
  const base = String(baseUrl || defaultBaseUrl).replace(/\/+$/, "");
  const body = {
    model,
    max_tokens: maxOutputTokens,
    system,
    messages: toMessages(transcript),
  };
  if (specs && specs.length) {
    body.tools = specs.map((spec) => ({ name: spec.name, description: spec.description, input_schema: toJsonSchema(spec) }));
    if (toolChoice === "none") body.tool_choice = { type: "none" }; // tool_choice only valid WITH tools
  }
  return {
    url: `${base}/v1/messages`,
    // Key goes in the x-api-key header -- never a URL param.
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    body,
  };
}

export function parseResponse(json) {
  const content = Array.isArray(json?.content) ? json.content : [];
  const text = content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  const toolCalls = content
    .filter((b) => b?.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
  return { text, toolCalls, stopReason: json?.stop_reason ?? null };
}

// Map an HTTP error into the shared buckets the runner acts on. Anthropic error
// body: { type:"error", error:{ type, message } }. 529 = "overloaded" (transient,
// retry-later -> out_of_tokens class, NOT a hard fail).
export function classifyError({ status, body }) {
  const message =
    (body && typeof body === "object" && body.error && typeof body.error.message === "string" && body.error.message) ||
    (typeof body === "string" && body) ||
    `HTTP ${status}`;
  if (status === 401 || status === 403) return { kind: "auth", message };
  if (status === 429 || status === 529) return { kind: "out_of_tokens", message };
  // Anthropic returns 400 "prompt is too long: N tokens > M maximum" for overflow.
  if (isContextFullError(message)) return { kind: "context_full", message };
  if (OUT_OF_TOKENS_RE.test(message)) return { kind: "out_of_tokens", message };
  return { kind: "error", message };
}
