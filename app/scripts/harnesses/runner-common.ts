// Shared, provider-agnostic pieces for the harness runners (openrouter-runner.ts
// drives @openrouter/agent; local-runner.ts drives any OpenAI chat/completions
// endpoint incl. Ollama/LM Studio). Kept here so the security-relevant system
// preamble and the tool set (names/descriptions/executors) live in ONE place and
// can't drift between the two runners; each runner only renders the tool specs
// into its provider's format (zod for the Agent SDK, JSON Schema for chat/
// completions). The security-critical executors themselves live in
// openrouter-tools.ts.
import { runCli, readFile, writeFile, editFile, loadSkill } from "./openrouter-tools.ts";

// The CLI-allowlist map parseAllowedTools (openrouter-tools.ts, a different
// migration cluster -- still untyped, so its own export is inferred `any`) hands
// back: friendly CLI name -> the real command + prefix args. Declared here (the
// upstream file of this cluster) so downstream files share one shape instead of
// redefining it.
export interface CliEntry {
  command: string;
  prefixArgs: string[];
}
export type CliMap = Record<string, CliEntry>;

// One tool's param declaration -- what toolSpecs describes and each runner
// converts to its provider's schema form (zod / JSON Schema).
export interface ToolParamSpec {
  name: string;
  type: "string" | "string[]";
  required?: boolean;
  description?: string;
}

// An executor's return value: always {ok}, plus whatever provider-specific
// fields that tool reports (content/path/stdout/stderr/exitCode/truncated/...).
// Left loose deliberately -- each openrouter-tools.ts executor has its own shape
// and this is a cross-cluster boundary this task doesn't own.
export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}

// What an executor (openrouter-tools.ts) receives as its second argument.
export interface ToolExecutorCtx {
  cwd: string;
  cliMap: CliMap;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
}

// params/return are executor-specific (run_cli vs read_file vs write_file, ...) and
// the executors themselves live in an untyped sibling cluster (openrouter-tools.ts),
// so both stay loose here -- the genuine external-boundary case the migration plan
// calls out. runTool casts the awaited result to ToolResult at the point of use.
export interface ToolSpec {
  name: string;
  description: string;
  params: ToolParamSpec[];
  executor(params: unknown, ctx: ToolExecutorCtx): unknown;
}

// --- the dialect-neutral transcript (shared with custom-runner.ts + dialects/*.ts) ---

export interface ToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}
export interface ToolResultEntry {
  id: string;
  name: string;
  content: string;
}
// role stays plain `string` (like runtime.ts's NormalizedEvent.kind): a transcript
// literal built inline (as the tests do) infers widened `string` role values, not
// a narrowed literal union, so a discriminated union here would reject valid
// fixtures. Every field beyond `role` is optional and read defensively at the
// point of use (m.text ?? "", m.toolCalls ?? [], m.results ?? []) in both dialects.
export interface TranscriptItem {
  role: string;
  text?: string;
  toolCalls?: ToolCall[];
  results?: ToolResultEntry[];
}

// --- the dialect contract (custom-runner.ts + dialects/{anthropic,gemini}.ts) ---

// A narrower view of ToolSpec for dialect request-building -- deliberately WITHOUT
// `executor` (the dialects never call it, only render name/description/params to
// wire tool declarations), so a plain fixture object (as the dialect tests use,
// with no executor) is still assignable. Real ToolSpec[] values satisfy this too
// (a superset), so custom-runner.ts can pass its real specs unchanged.
export interface DialectToolSpec {
  name: string;
  description: string;
  params: ToolParamSpec[];
}

export interface DialectRequest {
  url: string;
  headers: Record<string, string>;
  // The dialect's own wire-shaped request body (e.g. AnthropicBody/GeminiBody in
  // each dialect module) -- the runner only ever JSON.stringify()s it, so it stays
  // `unknown` here rather than a shared shape (a Record<string,unknown> index
  // signature isn't compatible with a plain named interface without one).
  body: unknown;
}
export interface DialectResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string | null;
}
export type DialectErrorKind = "out_of_tokens" | "context_full" | "auth" | "error";
export interface DialectClassifiedError {
  kind: DialectErrorKind;
  message: string;
}
export interface BuildRequestParams {
  baseUrl?: string;
  model: string;
  apiKey: string;
  system: string;
  transcript: TranscriptItem[];
  specs: DialectToolSpec[];
  maxOutputTokens: number;
  toolChoice?: "auto" | "none";
}
// The 4-piece contract every dialects/<name>.ts module implements (see the big
// comment at the top of dialects/anthropic.ts). getDialect (dialects/index.ts)
// returns this; custom-runner.ts drives it.
export interface Dialect {
  name: string;
  defaultBaseUrl: string;
  buildRequest(params: BuildRequestParams): DialectRequest;
  parseResponse(json: unknown): DialectResponse;
  classifyError(params: { status: number; body: unknown }): DialectClassifiedError;
}

export function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// A diagnostic breadcrumb rendered into the daemon log (`[id] note: ...`). Unlike
// console.error (which runAgent only surfaces on a NON-zero exit), a note is a
// normal stdout event, so it's visible on successful runs too -- used to show
// when a nudge/poke fires and whether an openrouter resume failed.
export function note(text: string): void {
  emit({ t: "note", text });
}

// Sent once when the model ends a turn with NO text and NO tool call -- a
// degenerate non-answer some models emit after a tool error, then give up.
// Because Baxter's own reply is itself a tool call (discord-cli/mail reply), an
// empty turn means it stops without ever replying. Nudging once turns that into
// a real finish (or a retry) instead of a silent empty "success". Shared by both
// runners so the wording can't drift.
export const EMPTY_TURN_NUDGE =
  "You ended your turn with no message and no tool call. If a tool just failed, correct it and try again (or use a different approach); otherwise send your reply to the user now using the appropriate tool. Do not stop with an empty response.";

// Sent once when a reply-expecting run ends with a composed answer as TEXT but
// never actually sent it (no discord-cli/mail reply|send). The user only sees
// what's posted via a tool -- a final message is invisible to them -- so weak
// models that "present" the answer instead of sending it leave the user in
// silence. This pokes the model to reformat that text into the send tool call.
export const UNSENT_REPLY_NUDGE =
  "You wrote a reply but never sent it -- the user only receives messages you post with a tool, NOT your final message text. Send it now: reformat that reply into the appropriate tool call (e.g. run_cli discord-cli reply <channelId> <messageId> with the text as stdin) and post it. Respond with only that tool call.";

// The single source of truth both runners share for "should this ended turn be
// nudged, and how?" -- pulled out because the two loops each reimplemented it and
// drifted (the openrouter loop once gated the unsent poke on the loop index, so an
// empty nudge permanently blocked it and a genuinely-owed reply was silently lost).
// Two INDEPENDENT recovery shapes, each with its own cap:
//   "empty"  -- the turn produced no text and delivered nothing: nudge with
//               EMPTY_TURN_NUDGE, up to emptyNudgeMax times (>1 only when a reply
//               is truly owed; otherwise once, then the silence stands).
//   "unsent" -- text present but never SENT via a delivery tool call while a reply
//               is expected: poke ONCE (unsentPoked) with UNSENT_REPLY_NUDGE. This
//               can follow an empty nudge (model finally answers as text but still
//               doesn't send), so it's gated on its own flag, not the empty count.
// `delivered` short-circuits both: an empty/textless turn AFTER a reply already
// went out is the model signing off -- re-nudging would duplicate the send.
// Returns "empty" | "unsent" | null (nothing to do -> finish).
export function nudgeDecision({
  empty,
  delivered,
  expectReply,
  emptyNudges,
  emptyNudgeMax,
  unsentPoked,
}: {
  empty: boolean;
  delivered: boolean;
  expectReply: boolean;
  emptyNudges: number;
  emptyNudgeMax: number;
  unsentPoked: boolean;
}): "empty" | "unsent" | null {
  if (empty && !delivered && emptyNudges < emptyNudgeMax) return "empty";
  if (!empty && expectReply && !delivered && !unsentPoked) return "unsent";
  return null;
}

// --- multimodal input (Discord media -> @openrouter/agent content parts) ---

// The only hosts a Discord attachment url legitimately uses. The url always comes
// from Discord's own API (so it's already one of these); validating hard-stops any
// future path that feeds an arbitrary url into the model or the audio fetch below.
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
export function isDiscordCdnUrl(url: unknown): url is string {
  try {
    // typeof guard makes the predicate SOUND (String() coercion would let a
    // non-string that stringifies to a CDN url -- a URL instance, a [url] array --
    // pass and get narrowed to string) AND hard-stops a non-string url per the
    // design intent above.
    return typeof url === "string" && DISCORD_CDN_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// content_type -> the SDK audio `format`. Only mp3/wav are named by the SDK's
// FormatEnum; the rest are best-effort (OpenEnum accepts them client-side, but
// server-side support is model-dependent). Unknown audio/* falls back to the
// subtype (audio/flac -> "flac"), then "mp3".
const AUDIO_FORMATS: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "mp4", "audio/aac": "aac" };

// A Discord attachment as passed via BAXTER_MEDIA (see discord-bot.ts's
// selectMediaAttachments -- a different migration cluster).
export interface MediaItem {
  id?: string;
  url?: string;
  content_type?: string;
  filename?: string;
  size?: number;
}

// @openrouter/agent Responses-API content part -- shape varies by `type`, so kept
// as one loose interface (SDK boundary) rather than a discriminated union.
export interface MediaPart {
  type: string;
  imageUrl?: string;
  videoUrl?: string;
  fileUrl?: string;
  filename?: string;
  detail?: string;
  inputAudio?: { data: string; format: string };
}

// Build @openrouter/agent (Responses-API) content parts from Discord attachment
// metadata (BAXTER_MEDIA items: {id,url,content_type,filename,size}).
// CAMELCASE by design: callModel serializes `input` through CreateResponsesRequest's
// OUTBOUND zod schema (betaResponsesSend), so the SDK's typed camelCase shape
// (imageUrl/videoUrl/fileUrl/inputAudio) is expected -- it converts to snake_case on
// the wire, and a wrong shape throws "Input validation failed" (loud, not silent).
//   image/*          -> input_image (imageUrl; url passthrough, OpenRouter fetches it)
//   video/*          -> input_video (videoUrl; url passthrough)
//   application/pdf  -> input_file  (fileUrl;  url passthrough)
//   audio/*          -> input_audio (base64 -- audio has NO url field; fetch+encode,
//                       size-capped, since base64 also inflates tokens ~1.33x)
// Best-effort per item: an unrepresentable type, a non-Discord host, or an over-cap
// / failed audio fetch drops just that item (noted) and never throws -- a media post
// must still run. Async only for the audio fetch.
export async function buildMediaParts(
  media: unknown, // expected shape MediaItem[], but the caller (openrouter-runner) is an untyped boundary; the body reads defensively via Array.isArray
  { fetchFn = fetch, maxAudioBytes = 8 * 1024 * 1024, note: noteFn = (_msg: string) => {} }: { fetchFn?: typeof fetch; maxAudioBytes?: number; note?: (msg: string) => void } = {},
): Promise<MediaPart[]> {
  const parts: MediaPart[] = [];
  for (const m of Array.isArray(media) ? (media as MediaItem[]) : []) {
    const url = m?.url;
    const ct = String(m?.content_type || "");
    const name = m?.filename || "attachment";
    if (!isDiscordCdnUrl(url)) { noteFn(`media: skipping ${name} (url not a Discord CDN host)`); continue; }
    if (ct.startsWith("image/")) {
      parts.push({ type: "input_image", imageUrl: url, detail: "auto" });
    } else if (ct.startsWith("video/")) {
      parts.push({ type: "input_video", videoUrl: url });
    } else if (ct === "application/pdf") {
      parts.push({ type: "input_file", fileUrl: url, filename: m?.filename || "file.pdf" });
    } else if (ct.startsWith("audio/")) {
      if (m?.size != null && Number(m.size) > maxAudioBytes) { noteFn(`media: skipping audio ${name} (${m.size} bytes > ${maxAudioBytes} cap)`); continue; }
      try {
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxAudioBytes) { noteFn(`media: skipping audio ${name} (${buf.length} bytes > cap)`); continue; }
        const format = AUDIO_FORMATS[ct] || ct.split("/")[1] || "mp3";
        parts.push({ type: "input_audio", inputAudio: { data: buf.toString("base64"), format } });
      } catch (e) {
        noteFn(`media: audio fetch failed for ${name}: ${(e as Error)?.message ?? e}`);
      }
    } else {
      noteFn(`media: skipping ${name} (unsupported type ${ct || "unknown"})`);
    }
  }
  return parts;
}

// True iff a tool call actually delivers a message to the user (a reply/send),
// as opposed to a reaction/edit/read/etc. Used to tell "answered but never sent"
// (a give-up) from a run that legitimately replied. Covers Discord + email.
// `params` is loose (Record, not a run_cli-specific shape) since a non-run_cli
// call's params (e.g. read_file's {path}) are passed here too -- toolName is
// checked first and those never reach the `.cli`/`.args` reads below.
export function isDeliveryCall(toolName: string, params: Record<string, unknown> | null | undefined): boolean {
  if (toolName !== "run_cli" || !params) return false;
  const sub = Array.isArray(params.args) ? params.args[0] : undefined;
  if (params.cli === "discord-cli") return sub === "reply" || sub === "send" || sub === "send-thread";
  if (params.cli === "mail") return sub === "reply" || sub === "send";
  return false;
}

// Placeholder swapped in for an old tool result's content OR an oversized
// tool-call argument when trimming to fit the context budget (see fitContext).
// Kept short so a stubbed message is cheap; "data" (not "output") since it covers
// both tool results and tool inputs.
export const CONTEXT_STUB = "[older tool data elided to fit the context budget]";

// Rough char/4 token estimate over a whole chat message (content + any tool_calls
// + ids). Deliberately approximate -- a safety budget only needs a ballpark, and
// the real tokenizer varies per (local) model anyway.
export function estTokens(msg: ChatMessage | TranscriptItem): number {
  try {
    return Math.ceil(JSON.stringify(msg).length / 4);
  } catch {
    return 0;
  }
}

// Keep a chat/completions message array under a rough token budget so a long,
// tool-heavy loop can't grow it past the model's context window (common on small
// local models). The SDK-less local runner owns its `messages` array, so this
// trims-and-CONTINUES rather than just stopping. Two oldest-first passes, each
// stopping once under budget so recent context survives:
//   1. stub the oldest tool-RESULT contents (the usual bulk);
//   2. if still over, stub the oldest oversized assistant tool_call ARGUMENTS --
//      a write_file/edit_file carries its whole payload there, not in the (tiny)
//      tool result, so pass 1 can't reclaim it.
// It never drops a message and never touches a tool_call *id*, so the system(0) +
// original user-prompt(1) must-keeps AND the assistant/tool_result pairing the
// chat API requires (an orphaned `tool` message 400s) stay intact. A 0 budget
// disables it. Returns true iff it stubbed anything, so the caller can log it
// once. NOTE: it can't shrink the system message or the one-shot user prompt, so
// a prompt that alone exceeds the window isn't helped here (the daemons bound
// history sizes upstream).
// The OpenAI chat/completions message shape (local-runner.ts's own array, a
// different migration cluster) -- left loose (`content` unknown) since fitContext
// only ever touches STRING content, and a chat message's content can otherwise be
// a multi-part array this function doesn't need to model.
export interface ChatToolCall {
  function?: { arguments?: string };
}
export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: ChatToolCall[];
}

export function fitContext(messages: ChatMessage[], maxTokens: number): boolean {
  if (!maxTokens) return false;
  let total = messages.reduce((n, m) => n + estTokens(m), 0);
  if (total <= maxTokens) return false;
  let trimmed = false;
  const STUB_ARGS = JSON.stringify({ elided: CONTEXT_STUB });
  // Pass 1: oldest tool-result contents. Skip ones no larger than the stub --
  // replacing a tiny result would GROW it (the stub isn't free).
  for (let i = 2; i < messages.length && total > maxTokens; i++) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= CONTEXT_STUB.length) continue;
    const before = estTokens(m);
    m.content = CONTEXT_STUB;
    total -= before - estTokens(m);
    trimmed = true;
  }
  // Pass 2: oldest oversized assistant tool_call arguments (id preserved).
  for (let i = 2; i < messages.length && total > maxTokens; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      const args = c.function?.arguments;
      if (typeof args !== "string" || args.length <= STUB_ARGS.length) continue;
      const before = estTokens(m);
      c.function!.arguments = STUB_ARGS;
      total -= before - estTokens(m);
      trimmed = true;
      if (total <= maxTokens) break;
    }
  }
  return trimmed;
}

// The normalized-transcript analog of fitContext, for the custom-API harness
// (custom-runner.ts). That runner keeps a dialect-NEUTRAL transcript (so a dialect
// can render it to Anthropic/Gemini/OpenAI wire shapes per call) instead of a fixed
// OpenAI message array, so it can't reuse fitContext (which is hardcoded to
// {role:"tool"} / tool_calls[].function.arguments). Same strategy: two oldest-first
// passes, each stopping once under budget so recent context survives.
//   item shapes: {role:"user", text} | {role:"assistant", text, toolCalls:[{id,name,args}]}
//                | {role:"tool", results:[{id,name,content}]}
//   1. stub the oldest tool-RESULT contents (strings; the usual bulk);
//   2. if still over, stub the oldest oversized assistant tool_call ARGUMENTS
//      (objects here, unlike the OpenAI runner's JSON-string args).
// Item 0 (the original user prompt) is a must-keep and never trimmed; the system
// preamble isn't in the transcript at all (the dialect places it separately), so
// there's no index-1 must-keep as in fitContext. Never drops an item, never touches
// an id -> the dialect's call/result pairing survives. 0 budget disables it. Returns
// true iff it stubbed anything, so the caller logs it once.
export function fitTranscript(transcript: TranscriptItem[], maxTokens: number): boolean {
  if (!maxTokens) return false;
  let total = transcript.reduce((n, m) => n + estTokens(m), 0);
  if (total <= maxTokens) return false;
  let trimmed = false;
  const STUB_ARGS = { elided: CONTEXT_STUB };
  const STUB_ARGS_LEN = JSON.stringify(STUB_ARGS).length;
  // Pass 1: oldest tool-result contents. Skip any no larger than the stub --
  // replacing a tiny result would GROW it.
  for (let i = 1; i < transcript.length && total > maxTokens; i++) {
    const m = transcript[i];
    if (m.role !== "tool" || !Array.isArray(m.results)) continue;
    for (const r of m.results) {
      if (typeof r.content !== "string" || r.content.length <= CONTEXT_STUB.length) continue;
      const before = estTokens(m);
      r.content = CONTEXT_STUB;
      total -= before - estTokens(m);
      trimmed = true;
      if (total <= maxTokens) break;
    }
  }
  // Pass 2: oldest oversized assistant tool_call arguments (id preserved).
  for (let i = 1; i < transcript.length && total > maxTokens; i++) {
    const m = transcript[i];
    if (m.role !== "assistant" || !Array.isArray(m.toolCalls)) continue;
    for (const c of m.toolCalls) {
      if (JSON.stringify(c.args ?? {}).length <= STUB_ARGS_LEN) continue;
      const before = estTokens(m);
      c.args = { ...STUB_ARGS };
      total -= before - estTokens(m);
      trimmed = true;
      if (total <= maxTokens) break;
    }
  }
  return trimmed;
}

// Match a "context window exceeded" error across providers (OpenAI-style, and the
// various phrasings OpenRouter passes through from upstream models). Distinct from
// out-of-tokens (402/429): a context overflow won't fix on a later retry (the same
// oversized history re-overflows), so the daemons must end the run cleanly rather
// than retry into the same wall. Deliberately broad but anchored on context/token
// length wording so an unrelated error isn't misread.
const CONTEXT_FULL_RE = /context[_ ](length|window)|maximum context|context_length_exceeded|too many tokens|reduce the (length|size|number)|prompt is too long|exceeds? the (maximum |model'?s )?(context|token)/i;
// Rate-limit / out-of-credit signals (the out-of-tokens class). A run hitting
// these must NEVER be classified as context-full: trimming/retrying won't help,
// and it needs the daemons' "couldn't get to this, retry later" path, not a
// done/graceful finish. The ONE definition, shared by isContextFullError below
// AND both runners' out-of-tokens classification -- they must agree byte-for-byte
// (isContextFullError returning false for a message is only correct if the
// runner's own check then matches the same message), so it lives here once.
export const OUT_OF_TOKENS_RE = /\b402\b|\b429\b|insufficient|rate.?limit|quota|too many requests/i;
export function isContextFullError(errOrMsg: unknown): boolean {
  const obj = errOrMsg && typeof errOrMsg === "object" ? (errOrMsg as Record<string, unknown>) : null;
  // Trust a definitive HTTP status first: 402/429 is rate/credit, never overflow.
  const status = obj ? obj.status : null;
  if (status === 402 || status === 429) return false;
  const msg = typeof errOrMsg === "string" ? errOrMsg : String(obj?.message ?? errOrMsg ?? "");
  // ...and by message, so a rate-limit note that happens to mention "too many
  // tokens" / "reduce the number of ..." isn't misread as a context overflow
  // (which would trim+retry against a limited endpoint and mark the task done
  // rather than take the retry-later path).
  if (OUT_OF_TOKENS_RE.test(msg)) return false;
  return CONTEXT_FULL_RE.test(msg);
}

// A flaky, retriable "the model produced no usable final answer" failure. The
// @openrouter/agent SDK THROWS this (rather than returning empty text), so the
// empty-turn nudge -- which only sees a clean empty RETURN -- never catches it,
// and the run hard-fails (a ping left unanswered). Narrow to the observed
// phrasings so a real error isn't swallowed as recoverable.
const INVALID_RESPONSE_RE = /invalid final response|empty or invalid output/i;
export function isInvalidResponseError(errOrMsg: unknown): boolean {
  const obj = errOrMsg && typeof errOrMsg === "object" ? (errOrMsg as Record<string, unknown>) : null;
  const msg = typeof errOrMsg === "string" ? errOrMsg : String(obj?.message ?? errOrMsg ?? "");
  return INVALID_RESPONSE_RE.test(msg);
}

// Last-resort model escalation: on ANY request failure that isn't an out-of-tokens
// (credit/rate) error, retry the run ONCE on a larger-context fallback model before
// giving up. Deliberately BROAD -- it does NOT try to match a provider's exact
// error wording, because minimax returns a generic "invalid_prompt"/"invalid
// request" for an over-long request that slips past isContextFullError (that miss
// is what turned a 1 MB tool payload into a hard fail with the reply dropped). By
// escalating to a bigger window (e.g. minimax-m3's ~1M vs m2.7's ~205k), a large
// payload becomes survivable instead of fatal, with no data trimmed. Guards: a
// fallback must be configured, we must not already be on it, we escalate at most
// once per run, and an out-of-tokens error is excluded (a bigger, pricier model
// fails the same way and just burns credit). This is the reactive backstop; it
// pairs with keeping responses small at the source (scoped queries).
export function shouldEscalateModel({
  err,
  model,
  fallbackModel,
  alreadyEscalated,
}: {
  err: unknown;
  model?: string;
  fallbackModel?: string;
  alreadyEscalated: boolean;
}): boolean {
  if (!fallbackModel || alreadyEscalated || model === fallbackModel) return false;
  const obj = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  // Trust a definitive HTTP status first (same rule as isContextFullError): a
  // 402/429 is out-of-credits/rate-limit even when the message body is opaque
  // (an HTML page, a bare status) and carries none of the OUT_OF_TOKENS_RE words.
  const status = obj ? obj.status : null;
  if (status === 402 || status === 429) return false;
  return !OUT_OF_TOKENS_RE.test(String(obj?.message ?? err ?? ""));
}

// Best-effort recovery for the OpenRouter runner after a context-full error: the
// SDK owns the message array, but we hold its ConversationState via our own
// stateStore, so truncate the largest/oldest tool-call OUTPUTS in that saved state
// so a resumed callModel fits. Only mutates a tool output's string content, never
// a call/output id, so the SDK's call/result pairing survives the resume. Keeps
// the most recent `keepRecent` outputs intact. Returns the count trimmed (0 if the
// state isn't an item array or nothing was large enough) -- the caller falls back
// to a clean stop when nothing could be trimmed. Deliberately lenient about the
// item shape (matches any item carrying a long string `output`), and fully
// guarded, since it operates on SDK-internal types that could shift. keepRecent
// defaults to 1 (aggressive): this only runs to recover from an overflow, where
// getting back under the window matters more than retaining old tool context.
export function trimStateToolOutputs(state: unknown, { keepRecent = 1 }: { keepRecent?: number } = {}): number {
  try {
    const msgs = (state as { messages?: unknown } | null | undefined)?.messages;
    if (!Array.isArray(msgs)) return 0;
    const big: { output: string }[] = msgs.filter(
      (it): it is { output: string } => !!it && typeof (it as { output?: unknown }).output === "string" && (it as { output: string }).output.length > CONTEXT_STUB.length,
    );
    let trimmed = 0;
    for (let k = 0; k < big.length - keepRecent; k++) {
      big[k].output = CONTEXT_STUB;
      trimmed++;
    }
    return trimmed;
  } catch {
    return 0;
  }
}

export function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// docker `--env-file` does NOT strip an inline `# comment` after a value, so a hand-edited
// `OPENAI_API_KEY=sk-... # optional` sends the whole "sk-...   # optional" string -- a 401 /
// bad-model that's baffling to debug. A key/model/url never contains whitespace or '#', so a
// value that does is almost certainly that footgun. Returns the FIRST offending { name }
// (never the value -- it may be a secret) or null; runners failHard on it with a clear hint.
export function malformedEnvValue(names: string[]): { name: string } | null {
  for (const name of names) {
    const v = process.env[name];
    if (v && /[\s#]/.test(v)) return { name };
  }
  return null;
}

// True when this run is the operator's TERMINAL (the TUI sets BAXTER_TERMINAL=1). Runners
// pass it to systemPreamble so a reply is the run's final TEXT, not a discord-cli/mail call.
export const isTerminalRun = () => process.env.BAXTER_TERMINAL === "1";

// True when this run must be TEXT-ONLY -- no tools at all (the TUI's onboarding turns set
// BAXTER_CHAT_ONLY=1: a keyless local model walking a fresh user through setup, dispatched
// with an empty tool set). It only makes systemPreamble stop describing tools the model
// doesn't have; the empty allowedTools is what actually removes them. Dormant for every
// daemon (they all grant tools).
export const isChatOnly = () => process.env.BAXTER_CHAT_ONLY === "1";

// The current date/time line -- injected into the USER turn (see withNow), NOT the
// system preamble. Keeping the one per-run dynamic line out of the system is what lets
// the system+tools prefix stay byte-stable and be prompt-cached across runs. These
// harnesses give the model no other clock (unlike Claude Code), so a time-relative task
// ("today", a scheduled job) would else use stale training data. tz is BAXTER_TZ ||
// HEARTBEAT_TZ || Pacific; a bad tz degrades to UTC-only rather than throwing.
export function nowLine(): string {
  const now = new Date();
  const tz = process.env.BAXTER_TZ || process.env.HEARTBEAT_TZ || "America/Los_Angeles";
  let localNow = null;
  try {
    localNow = now.toLocaleString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  } catch { /* invalid tz -> UTC only */ }
  return `The current date and time is ${localNow ? `${localNow} ` : ""}(${now.toISOString()} UTC). Use THIS as "now" for anything time-relative ("today", "this week", a due date) -- do NOT rely on training data for the current date.`;
}

// Prepend the fresh time line to a run's user prompt. Clock lives in the USER turn so
// the system+tools prefix stays cacheable; every runner builds its user message via this.
// `prompt` stays `unknown`: the `String(prompt ?? "")` coercion is a live runtime guard
// (Node runs this via type-stripping, so a non-string caller isn't compile-blocked), not
// dead belt-and-suspenders — narrowing to `string` would make that guard misrepresent the
// contract without removing it. A boundary the types-only pass deliberately leaves loose.
export function withNow(prompt: unknown): string {
  return `${nowLine()}\n\n${String(prompt ?? "")}`;
}

// Bridge the Claude-oriented prompt (which names "the Bash tool", "the Skill
// tool", a "restricted shell", heredocs/pipes) onto our structured tools. Shared
// verbatim by all runners -- a second copy would silently drift on edits. STATIC per
// surface (the CLI list is per-surface-fixed), so it's a prompt-cacheable prefix.
export function systemPreamble(cliMap: CliMap, { terminal = false }: { terminal?: boolean } = {}): string {
  // Text-only mode (BAXTER_CHAT_ONLY=1): the run has no tools, so the preamble must NOT
  // describe any -- describing (or even dwelling on the ABSENCE of) CLIs the model can't
  // call just confuses it. A minimal conversational frame; the user prompt carries the
  // job and the "if they ask for an action you can't do yet" contingency. Used by the
  // TUI's onboarding turns; every daemon grants tools, so this never fires for them.
  if (isChatOnly()) {
    return "You are having a direct terminal conversation with the operator. Reply in plain text -- your message is shown straight to them. Just answer them and follow the instructions below.";
  }
  const clis = Object.keys(cliMap).join(", ") || "(none)";
  // The reply-channel instruction is SURFACE-DEPENDENT. On Discord/mail/heartbeat the run's
  // only way to reach the user is a tool call, so its reply MUST be one. In the TUI the
  // operator reads the run's final TEXT directly, so a reply is just text -- and discord/mail
  // are only for when they EXPLICITLY ask to reach a channel/person. Getting this wrong made
  // a TUI run post its answer to Discord instead of replying in the terminal.
  const replyLine = terminal
    ? "You are in a DIRECT TERMINAL with the operator: your reply is your final message TEXT -- it's shown straight to them, so just write it. Do NOT use discord-cli or mail to reply -- those post to a public channel / send an email, and are ONLY for when the operator EXPLICITLY asks you to reach a channel or person. Still ACT (run whatever tool a real task needs), but a conversational answer is just text."
    : "ACT, don't describe: sending a message to the user (a Discord reply, an email) is itself a tool call (run_cli discord-cli / mail ...), never just text in your final message. Do NOT end your turn by describing an action you have not performed -- if your final message says you are replying, sending, or about to do something, you MUST have already made that tool call in this same run. A message that only narrates intent (e.g. \"now I'll send the reply\") leaves the task UNDONE.";
  const closingLine = terminal
    ? "Answer the operator directly in text, doing whatever task they ask (running the tools it needs), then stop with a short final message."
    : "Do the task the instructions describe -- including actually sending any reply it calls for -- then stop with a short final message.";
  return [
    "You are an autonomous agent. You can ACT ONLY by calling the tools provided -- there is no shell and no other way to run commands.",
    "",
    "Tool mapping (the task instructions below were written for a different tool naming; translate as follows):",
    `- Any command the instructions show as \`discord-cli …\`, \`code-cli …\`, \`schedule-cli …\`, \`playwright-cli …\`, \`invisible-cli …\` (or \`node <mail> …\`) is a **run_cli** call: run_cli({cli, args:[…], stdin}). Available CLIs: ${clis}. Put any message/program body in \`stdin\` (never a heredoc or pipe -- there is no shell).`,
    "- Web research the instructions call `WebSearch`/`WebFetch` (or \"read a page's content\") is the **web-cli** CLI via run_cli: to SEARCH, run_cli({cli:\"web-cli\", args:[\"search\", \"<query>\"]}) -- it returns ranked title/url/snippet from a self-hosted SearXNG; to read a page, run_cli({cli:\"web-cli\", args:[\"fetch\", \"<url>\"]}). If search reports the backend is down, fall back to opening Bing with playwright-cli: run_cli({cli:\"playwright-cli\", args:[\"open\", \"https://www.bing.com/search?q=<query>\"]}) then run_cli({cli:\"playwright-cli\", args:[\"snapshot\"]}). Use **playwright-cli** (NOT invisible-cli) for that Bing fallback and for JavaScript-heavy pages.",
    "- If **playwright-cli is blocked** on a specific page you need -- a Cloudflare \"Just a moment…\"/\"Checking your browser\" interstitial, an \"Access denied\"/HTTP 403 bot page, or a snapshot stuck on such a challenge -- retry that EXACT url ONCE with **invisible-cli** (the stealth browser): run_cli({cli:\"invisible-cli\", args:[\"open\", \"<url>\"]}) then run_cli({cli:\"invisible-cli\", args:[\"snapshot\"]}). That is what it's for. It's slower to start and self-recovers from a stuck command in ~30s, so use it only as this one-shot escalation for a walled page, never for search. If it's also blocked, move on.",
    "- \"Use/open/see the X skill\" or \"the Skill tool\" means **load_skill({name:\"X\"})** to read that skill's reference, then act with run_cli.",
    "- Reading or writing files means **read_file / write_file / edit_file**; you can only touch files in your working directory.",
    "- Ignore guidance about a \"restricted shell\", allowed/denied Bash, compound commands, or heredocs -- those describe the other harness; here you just call the structured tools above.",
    "",
    replyLine,
    "",
    closingLine,
  ].join("\n");
}

// The tools applicable to a run, given its cli allowlist + native-tool grants.
// Each spec: { name, description, params, executor }, where params is a list of
// { name, type: "string" | "string[]", required, description } that each runner
// converts to its provider's schema form. run_cli's text depends on the cli list.
export function toolSpecs(cliMap: CliMap, native: Set<string>): ToolSpec[] {
  const clis = Object.keys(cliMap).join(", ");
  const specs: ToolSpec[] = [];
  if (Object.keys(cliMap).length) {
    specs.push({
      name: "run_cli",
      description: `Run one of Baxter's command-line tools (${clis}). No shell -- pass the CLI name, its arguments as a string array, and an optional stdin body (for tools that read a message/program on stdin, e.g. discord-cli/code-cli). Example: run_cli({cli:"discord-cli", args:["reply","<channelId>","<messageId>"], stdin:"your reply text"}).`,
      params: [
        { name: "cli", type: "string", required: true, description: `the CLI to run; one of: ${clis}` },
        { name: "args", type: "string[]", required: false, description: "arguments, as a list of strings" },
        { name: "stdin", type: "string", required: false, description: "text piped to the CLI's stdin (message body, program source, etc.)" },
      ],
      executor: runCli,
    });
  }
  if (native.has("Read")) {
    specs.push({ name: "read_file", description: "Read a file in your working directory.", params: [{ name: "path", type: "string", required: true }], executor: readFile });
  }
  if (native.has("Write")) {
    specs.push({ name: "write_file", description: "Create or overwrite a file in your working directory.", params: [{ name: "path", type: "string", required: true }, { name: "content", type: "string", required: true }], executor: writeFile });
  }
  if (native.has("Edit")) {
    specs.push({ name: "edit_file", description: "Replace an exact, unique substring in a file in your working directory.", params: [{ name: "path", type: "string", required: true }, { name: "old_string", type: "string", required: true }, { name: "new_string", type: "string", required: true }], executor: editFile });
  }
  if (native.has("Skill")) {
    specs.push({ name: "load_skill", description: "Read a skill's SKILL.md for its full command reference.", params: [{ name: "name", type: "string", required: true }], executor: loadSkill });
  }
  return specs;
}

// Render a spec's params as an OpenAI-style JSON Schema (for chat/completions).
export interface JsonSchemaProperty {
  type: string;
  items?: { type: string };
  description?: string;
}
export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}
export function toJsonSchema(spec: { params: ToolParamSpec[] }): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const p of spec.params) {
    properties[p.name] = p.type === "string[]" ? { type: "array", items: { type: "string" } } : { type: "string" };
    if (p.description) properties[p.name].description = p.description;
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required };
}

// Execute one tool call: emit tool_use, run the executor (never throws), emit
// tool_result, and return the result to the model. Shared by both runners so the
// event shape + error handling stay identical.
export async function runTool(spec: ToolSpec, params: unknown, ctx: ToolExecutorCtx): Promise<ToolResult> {
  emit({ t: "tool_use", name: spec.name, input: params });
  let result: ToolResult;
  try {
    result = (await spec.executor(params, ctx)) as ToolResult;
  } catch (e) {
    result = { ok: false, error: (e as Error).message };
  }
  emit({ t: "tool_result", is_error: result?.ok === false, content: result });
  return result;
}
