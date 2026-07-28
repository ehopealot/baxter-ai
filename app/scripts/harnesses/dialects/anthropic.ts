// Anthropic Messages API dialect for the custom-API harness (custom-runner.ts).
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
import { toJsonSchema, isContextFullError, OUT_OF_TOKENS_RE } from "../runner-common.ts";
import type { BuildRequestParams, DialectClassifiedError, DialectRequest, DialectResponse, JsonSchema, TranscriptItem } from "../runner-common.ts";

export const name = "anthropic";
export const defaultBaseUrl = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// Anthropic Messages content blocks -- one loose interface (wire-format union)
// rather than a discriminated type per block kind, since a single array mixes them.
interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}
interface AnthropicMessage {
  role: string;
  content: AnthropicContentBlock[];
}
interface AnthropicBody {
  model: string;
  max_tokens: number;
  system: { type: string; text: string; cache_control: { type: string } }[];
  messages: AnthropicMessage[];
  tools?: { name: string; description: string; input_schema: JsonSchema }[];
  tool_choice?: { type: string };
}

// Render the normalized transcript into Anthropic `messages` content blocks.
//   user      -> { role:"user",      content:[{type:"text", text}] }
//   assistant -> { role:"assistant", content:[ {type:"text",text}?, {type:"tool_use", id, name, input} ... ] }
//   tool      -> { role:"user",      content:[ {type:"tool_result", tool_use_id, content} ... ] }
function toMessages(transcript: TranscriptItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  for (const m of transcript) {
    if (m.role === "user") {
      messages.push({ role: "user", content: [{ type: "text", text: String(m.text ?? "") }] });
    } else if (m.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
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
export function buildRequest({ baseUrl, model, apiKey, system, transcript, specs, maxOutputTokens, toolChoice = "auto" }: BuildRequestParams): DialectRequest {
  const base = String(baseUrl || defaultBaseUrl).replace(/\/+$/, "");
  const body: AnthropicBody = {
    model,
    max_tokens: maxOutputTokens,
    // system as a content-block array with ONE cache breakpoint. Anthropic caches in the
    // order tools -> system -> messages, so a breakpoint on the system block caches
    // tools+system: the whole static prefix is reused across the tool loop AND across runs
    // (5-min ephemeral TTL). Requires system to be byte-stable -- the runner keeps the
    // per-run timestamp in the USER turn (withNow), not here. No caching without this.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
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

export function parseResponse(json: unknown): DialectResponse {
  const j = json as { content?: unknown; stop_reason?: unknown } | null | undefined;
  const content: AnthropicContentBlock[] = Array.isArray(j?.content) ? j.content : [];
  const text = content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  const toolCalls = content
    .filter((b) => b?.type === "tool_use")
    .map((b) => ({ id: b.id as string, name: b.name as string, args: (b.input as Record<string, unknown>) ?? {} }));
  return { text, toolCalls, stopReason: (j?.stop_reason as string | null | undefined) ?? null };
}

// Map an HTTP error into the shared buckets the runner acts on. Anthropic error
// body: { type:"error", error:{ type, message } }. 529 = "overloaded" (transient,
// retry-later -> out_of_tokens class, NOT a hard fail).
export function classifyError({ status, body }: { status: number; body: unknown }): DialectClassifiedError {
  const b = body as { error?: { message?: unknown } } | string | null | undefined;
  const message =
    (b && typeof b === "object" && b.error && typeof b.error.message === "string" && b.error.message) ||
    (typeof b === "string" && b) ||
    `HTTP ${status}`;
  if (status === 401 || status === 403) return { kind: "auth", message };
  if (status === 429 || status === 529) return { kind: "out_of_tokens", message };
  // Anthropic returns 400 "prompt is too long: N tokens > M maximum" for overflow.
  if (isContextFullError(message)) return { kind: "context_full", message };
  if (OUT_OF_TOKENS_RE.test(message)) return { kind: "out_of_tokens", message };
  return { kind: "error", message };
}
