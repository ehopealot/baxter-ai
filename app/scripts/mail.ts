#!/usr/bin/env node
// Thin CLI wrapper around the AgentMail API -- the credential boundary for the
// mail surface, replacing gmail.ts. poll.ts and the spawned `claude -p` run
// both go through this as a subprocess (by absolute path, MAIL_CLI). The
// AgentMail SDK is imported LAZILY (inside getClient) so the pure, tested cores
// below load without the `agentmail` package present -- unit tests exercise them
// with an injected fake client. See
// docs/superpowers/specs/2026-07-22-agentmail-migration-design.md.
//
// Subcommands (same surface as the old gmail.ts, so poll.ts/prompts are ~unchanged):
//   list-new                                Received, allowlisted, not-yet-handled messages
//   get-thread <threadId> <candidateId...>  Full thread transcript, newest candidate marked
//   reply <messageId>                       Reply in-thread; body from stdin
//   send <to> <subject>                     New message to <to> (must be in ALLOWED_RECIPIENTS or OPERATOR_EMAIL); body from stdin
//   send-calendar                           Email OPERATOR_EMAIL the calendar subscribe link (NO args -- recipient + content are fixed/trusted)
//   label <messageId> <name>                Add a label
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMailClient, AgentMail } from "agentmail";
import { loadSendState, recordSend, MAX_SENDS_PER_DAY } from "./send-state.ts";
import { AGENTMAIL_KEY_PATH, MAIL_POLL_CURSOR_PATH, CALENDAR_KEYS_PATH, ALLOWLIST_PATH } from "./paths.ts";
import { extractEmailAddress, formatThreadMessage, MESSAGE_SEPARATOR, normalizeTranscriptText, neutralizeStructuralMarkers } from "./transcript.ts";
import { moderate, outboundBlockNotice } from "./moderation.ts";
import { loadAllowlist } from "./allowlist.ts";

// Outbound content moderation (opt-in, MODERATION_ENABLED). moderate() self-short-circuits to
// allowed when disabled -> a cheap no-op by default. `_moderate` is injectable for tests.
type ModerateFn = typeof moderate;
async function gateOutbound(body: string, env: NodeJS.ProcessEnv, _moderate: ModerateFn): Promise<void> {
  const v = await _moderate(body, "out", { env });
  if (!v.allowed) throw new Error(`message not sent -- ${outboundBlockNotice(v.reason)}`);
}

// Baxter's own outgoing marker. Applied on every send/reply so the agent's own
// messages are identifiable in a thread WITHOUT trusting the (spoofable) From --
// the unforgeable analog of Gmail's SENT label. Inbound mail can't cause our
// label to be applied to itself (labels are inbox-side metadata set via our API
// key, not message content), so a message counts as "own" for the
// redaction-exemption ONLY if it carries this label (never by From alone).
export const SENT_LABEL = "baxter-sent";
// Idempotency marker: poll.ts labels every message of a handled (or skipped)
// thread with this, and list-new excludes it. The correctness source of truth
// for exactly-once; the poll cursor is only an efficiency bound.
export const PROCESSED_LABEL = "agent-processed";

// One safety margin (ms) subtracted from the stored cursor unconditionally, so a
// strictly-exclusive `after` still re-lists the boundary message and same-tick
// arrivals; the PROCESSED_LABEL dedupes the harmless re-list. >= the timestamp
// resolution (AgentMail timestamps are second-or-finer; 1s is safe).
const CURSOR_MARGIN_MS = 1000;
const LIST_PAGE_LIMIT = 100;

// -------------------------------------------------------------------------
// Shared shapes. Timestamps are epoch-ms numbers throughout the pure cores;
// the I/O layer converts AgentMail's ISO `timestamp` <-> ms and back for the
// `after` query + cursor file.
// -------------------------------------------------------------------------

// The shape of one entry from messages.list, mapped to ms (see cmdListNew).
export interface ListMessage {
  messageId: string;
  threadId: string;
  from: string;
  timestamp: number;
  labels?: string[];
}

// One attachment's metadata (bytes are fetched separately via get-attachment). Mirrors
// the AgentMail Attachment shape, minus the fields we don't use.
export interface MailAttachment {
  attachmentId: string;
  filename?: string;
  contentType?: string;
  size: number;
}

// Map the AgentMail message's `attachments` (an untyped I/O boundary) to MailAttachment[],
// defensively: a non-array, or an entry missing an attachmentId, is dropped rather than
// trusted. Size defaults to 0 when absent/NaN.
export function mapAttachments(raw: unknown): MailAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MailAttachment[] = [];
  for (const a of raw) {
    const id = (a as { attachmentId?: unknown })?.attachmentId;
    if (typeof id !== "string" || !id) continue;
    const size = Number((a as { size?: unknown })?.size);
    const filename = (a as { filename?: unknown })?.filename;
    const contentType = (a as { contentType?: unknown })?.contentType;
    out.push({
      attachmentId: id,
      ...(typeof filename === "string" ? { filename } : {}),
      ...(typeof contentType === "string" ? { contentType } : {}),
      size: Number.isFinite(size) ? size : 0,
    });
  }
  return out;
}

// The shape of one full message (messages.get / a thread's messages), mapped to ms.
export interface FullMessage {
  messageId: string;
  threadId: string;
  from: string;
  subject?: string;
  text?: string;
  timestamp: number;
  labels?: string[];
  headers?: Record<string, string>;
  attachments?: MailAttachment[];
}

export interface Survivor {
  id: string;
  threadId: string;
}

export interface ClassifyListingArgs {
  messages: ListMessage[];
  prevCursor: number;
  allowedSenders: string[];
  ownEmail?: string;
  margin: number;
}

export interface ClassifyListingResult {
  survivors: Survivor[];
  nextCursor: number;
}

export interface ThreadOutput {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  receivedAt: string;
  isAutomated: boolean;
  isAllowedSender: boolean;
  body: string;
  triggerText: string; // the trigger message's own text (inbound moderation checks THIS, not the full `body`)
  attachments: MailAttachment[]; // the TRIGGER message's attachments (metadata only; [] if none)
}

export interface BuildThreadOutputArgs {
  messages: FullMessage[];
  candidateIds: string[];
  allowedSenders: string[];
  ownEmail?: string;
}

// -------------------------------------------------------------------------
// Credential (env-first-then-file, mirroring discord-cli.ts's token()).
// -------------------------------------------------------------------------
export function loadApiKey(env: NodeJS.ProcessEnv, keyPath: string): string {
  if (env.AGENTMAIL_API_KEY) return env.AGENTMAIL_API_KEY;
  try {
    const key = JSON.parse(readFileSync(keyPath, "utf8")).apiKey;
    if (key) return key;
  } catch {
    /* fall through to the error below */
  }
  throw new Error("AGENTMAIL_API_KEY is not set (no env var and no key file)");
}

// -------------------------------------------------------------------------
// Pure cores (unit-tested via an injected fake client / plain inputs).
// Timestamps here are epoch-ms numbers; the I/O layer converts AgentMail's ISO
// `timestamp` <-> ms and back for the `after` query + cursor file.
// -------------------------------------------------------------------------

export interface ListOpts {
  after: Date;
  ascending: boolean;
  limit: number;
  pageToken?: string;
}

// Build the messages.list options. The AgentMail SDK type-checks `after` as a Date
// OBJECT -- a `.toISOString()` string is rejected at runtime ("Expected Date object")
// -- confirmed live. pageToken is omitted when empty so the SDK doesn't validate an
// `undefined` against its string field on the first (unpaged) call.
export function listOpts(cursorMs: number, pageToken?: string, limit: number = LIST_PAGE_LIMIT): ListOpts {
  const opts: ListOpts = { after: new Date(cursorMs), ascending: true, limit };
  if (pageToken) opts.pageToken = pageToken;
  return opts;
}

// RFC 5322 Message-IDs are `<local@domain>`, and AgentMail returns AND expects them
// WITH the angle brackets. But a model composing a `reply <id>` tool call tends to
// STRIP them (they read as a placeholder or a shell redirect), which 404s ("Message
// not found"). Normalize any argv-supplied id back to the canonical bracketed form;
// leave already-bracketed or non-addr-spec (e.g. UUID) ids untouched. Idempotent.
export function canonicalMessageId(id: string): string {
  const t = String(id).trim();
  if (!t.includes("@")) return t; // UUID-style id (no addr-spec) -- leave as-is
  // Strip any surviving partial bracket, then re-wrap: handles all four combos
  // (intact, fully-stripped, and the two HALF-stripped forms `<a@b` / `a@b>`,
  // which a naive add-brackets would turn into `<<a@b>` / `<a@b>>` -- still 404).
  return `<${t.replace(/^</, "").replace(/>$/, "")}>`;
}

// Classify one listing into { survivors, nextCursor }. A message is a SURVIVOR
// unless it is already handled (PROCESSED_LABEL), own (SENT_LABEL, or From ==
// the inbox address -- an extra list-new-only exclusion), or off-allowlist.
// Fails CLOSED: an empty allowedSenders makes every message off-allowlist.
export function classifyListing({ messages, prevCursor, allowedSenders, ownEmail, margin }: ClassifyListingArgs): ClassifyListingResult {
  const allow = allowedSenders.map((s) => s.toLowerCase());
  const own = (ownEmail || "").toLowerCase();
  const isSurvivor = (m: ListMessage): boolean => {
    const labels = m.labels || [];
    if (labels.includes(PROCESSED_LABEL)) return false; // already handled
    const email = extractEmailAddress(m.from);
    if (labels.includes(SENT_LABEL) || email === own) return false; // own
    return allow.includes(email); // off-allowlist -> excluded (empty allow -> none)
  };
  const survivorMsgs = messages.filter(isSurvivor);
  const survivors: Survivor[] = survivorMsgs.map((m) => ({ id: m.messageId, threadId: m.threadId }));

  let nextCursor: number;
  if (messages.length === 0) {
    nextCursor = prevCursor; // empty listing -> unchanged (nothing seen; no Math.max([]))
  } else {
    // Boundary = the oldest survivor if any (never advance past an unhandled one),
    // else the max listed timestamp (all excluded -> safe to skip). Minus the margin
    // unconditionally so an exclusive `after` can't skip the boundary message.
    const boundary = survivorMsgs.length
      ? Math.min(...survivorMsgs.map((m) => m.timestamp))
      : Math.max(...messages.map((m) => m.timestamp));
    nextCursor = boundary - margin;
  }
  return { survivors, nextCursor };
}

// Case-insensitive header name AND value: header names are case-insensitive on
// the wire (and providers often lowercase them), and RFC 3834's not-automated
// value "no" is compared case-folded.
export function detectAutomated(headers: Record<string, string> | undefined): boolean {
  const h = headers ?? {};
  const get = (name: string): string => {
    const target = name.toLowerCase();
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === target) return String(h[k]);
    }
    return "";
  };
  const autoSubmitted = get("Auto-Submitted").toLowerCase();
  const precedence = get("Precedence").toLowerCase();
  return (autoSubmitted !== "" && autoSubmitted !== "no") || ["bulk", "list", "junk"].includes(precedence);
}

// Build the get-thread JSON output. Picks the newest CANDIDATE (by timestamp)
// among the passed ids as the trigger -- never a non-candidate, so the agent's
// own later reply (or an off-allowlist interloper) can't be mistaken for it.
// Each message is redacted unless allowed or own (isOwn = SENT_LABEL only).
export function buildThreadOutput({ messages, candidateIds, allowedSenders, ownEmail }: BuildThreadOutputArgs): ThreadOutput {
  const candidates = messages.filter((m) => candidateIds.includes(m.messageId));
  if (candidates.length === 0) {
    throw new Error("None of the given candidate ids were found in the thread.");
  }
  const trigger = candidates.reduce((newest, m) => (m.timestamp > newest.timestamp ? m : newest));
  const allow = allowedSenders.map((s) => s.toLowerCase());
  const own = (ownEmail || "").toLowerCase();
  // The agent's OWN address is trusted only via the unforgeable SENT_LABEL, never
  // the allowlist: otherwise an operator who (mis)lists the own address in
  // ALLOWED_SENDERS would let a forged `From: <own>` with no baxter-sent label render
  // unredacted as a prior reply (self-impersonation) -- the exact forge the label
  // gate exists to block. So allow-membership never grants trust to the own address;
  // only isOwn does. (Mirrors gmail.ts's isAllowedThreadParticipant precedence.)
  const isAllowedNonOwn = (addr: string): boolean => allow.includes(addr) && addr !== own;

  const normalizedOf = (m: FullMessage) => ({
    from: m.from,
    date: m.timestamp !== undefined ? new Date(m.timestamp).toUTCString() : "",
    subject: m.subject ?? "",
    text: m.text ?? "",
    isOwn: (m.labels || []).includes(SENT_LABEL), // label only -- never From (spoofable)
    isAllowed: isAllowedNonOwn(extractEmailAddress(m.from)),
  });

  const body = messages
    .map((m) => formatThreadMessage(normalizedOf(m), m.messageId === trigger.messageId))
    .join(MESSAGE_SEPARATOR);

  // The trigger's OWN text for inbound moderation -- gated through the SAME sanitize + redact
  // pipeline as `body` (get-thread's JSON is agent-readable, so a raw field would hand a run an
  // un-neutralized copy with forged transcript markers intact, and off-allowlist text `body`
  // would have redacted). Neutralizing doesn't affect content moderation, and a redacted "" just
  // fail-opens to allow -- and poll.ts only moderates after its own isAllowedSender check anyway.
  const trig = normalizedOf(trigger);
  const triggerText = trig.isOwn || trig.isAllowed ? neutralizeStructuralMarkers(normalizeTranscriptText(trig.text)) : "";

  return {
    id: trigger.messageId,
    threadId: trigger.threadId,
    from: trigger.from,
    subject: trigger.subject ?? "",
    receivedAt: new Date(trigger.timestamp).toISOString(),
    isAutomated: detectAutomated(trigger.headers),
    isAllowedSender: isAllowedNonOwn(extractEmailAddress(trigger.from)),
    body,
    triggerText, // JUST the incoming message (for inbound moderation) -- sanitized/redacted like `body`
    attachments: trigger.attachments ?? [], // the trigger's attachments (metadata; poll.ts routes/marks from these)
  };
}

// The args passed to the AgentMail send/reply calls. Both attach SENT_LABEL so
// the message is self-identifiable as Baxter's own next time it's read.
export type SendArgs = { to: string; subject: string; text: string; labels: string[] };
export type ReplyArgs = { text: string; labels: string[] };

export function buildSendArgs({ to, subject, body }: { to: string; subject: string; body: string }): SendArgs {
  return { to, subject, text: body, labels: [SENT_LABEL] };
}
export function buildReplyArgs({ body }: { body: string }): ReplyArgs {
  return { text: body, labels: [SENT_LABEL] };
}

// The set of addresses `send` may reach: the shared allowlist.json recipients (fresh via
// loadAllowlist, file -> ALLOWED_RECIPIENTS env seed -> [] fail-closed) UNION OPERATOR_EMAIL
// (the operator is always reachable). The trust boundary stays outside the prompt barrier: a
// run may NAME a recipient, but only an operator-configured one is honored. Empty list + no
// operator => nobody reachable (fail closed). Case-insensitive dedupe; canonical spelling
// preserved (the loader's/env's, not the operator's raw casing on the OPERATOR_EMAIL union).
export function allowedRecipients(env: NodeJS.ProcessEnv, path: string = ALLOWLIST_PATH): string[] {
  const list = loadAllowlist(env, path).recipients.slice(); // fresh each call, no write
  const op = (env.OPERATOR_EMAIL || "").trim();
  if (op && !list.some((a) => a.toLowerCase() === op.toLowerCase())) list.push(op);
  return list;
}

// Authorize the caller-supplied recipient of a `send` against allowedRecipients.
// The address comes from the spawned run (a CLI argument), but is only returned if
// it's on the env-sourced allowlist -- so a prompt-injected run can reach an
// operator-approved address, never an arbitrary one. Returns the env's canonical
// spelling (not the caller's casing), so we send to the address the operator wrote.
export function resolveRecipient(env: NodeJS.ProcessEnv, to: string): string {
  const requested = (to || "").trim();
  if (!requested) throw new Error("send requires a recipient address; usage: send <to> <subject>.");
  const allowed = allowedRecipients(env);
  if (allowed.length === 0) throw new Error("No recipients are configured; set ALLOWED_RECIPIENTS (or OPERATOR_EMAIL). Refusing to send.");
  const match = allowed.find((a) => a.toLowerCase() === requested.toLowerCase());
  if (!match) throw new Error(`Recipient ${requested} is not in ALLOWED_RECIPIENTS (or OPERATOR_EMAIL); refusing to send.`);
  return match;
}

// Minimal surfaces of the AgentMail client the two send paths actually call --
// one interface per verb, so an injected test fake need only implement the one
// method it stubs (see mail.test.ts). The real client (getClient() below) is
// typed as the real `AgentMailClient` and satisfies both structurally.
export interface AgentMailSendClient {
  inboxes: {
    messages: {
      send(inboxId: string, args: SendArgs): Promise<{ messageId: string; threadId: string }>;
    };
  };
}
export interface AgentMailReplyClient {
  inboxes: {
    messages: {
      reply(inboxId: string, messageId: string, args: ReplyArgs): Promise<{ messageId: string; threadId: string }>;
    };
  };
}

export interface PerformSendArgs {
  client: AgentMailSendClient;
  inboxId: string;
  env: NodeJS.ProcessEnv;
  to: string;
  subject: string;
  body: string;
  recordSend: () => Promise<unknown>;
}
export interface PerformReplyArgs {
  client: AgentMailReplyClient;
  inboxId: string;
  messageId: string;
  body: string;
  env: NodeJS.ProcessEnv; // for outbound moderation gating (parallels PerformSendArgs.env)
  recordSend: () => Promise<unknown>;
}

// Resolve the recipient FIRST (fail loud before touching the send cap), then
// count the send BEFORE the network call -- over-counting a flood guard is the
// safe direction (mirrors the old gmail.ts / discord-cli ordering).
export async function performSend({ client, inboxId, env, to, subject, body, recordSend: record }: PerformSendArgs, _moderate: ModerateFn = moderate): Promise<{ messageId: string; threadId: string }> {
  const recipient = resolveRecipient(env, to); // authorize against the env allowlist BEFORE counting/sending
  await gateOutbound(body, env, _moderate); // block clearly-objectionable outbound before counting/sending
  await record();
  return client.inboxes.messages.send(inboxId, buildSendArgs({ to: recipient, subject, body }));
}
export async function performReply({ client, inboxId, messageId, body, env, recordSend: record }: PerformReplyArgs, _moderate: ModerateFn = moderate): Promise<{ messageId: string; threadId: string }> {
  await gateOutbound(body, env, _moderate);
  await record(); // count before the call, as above
  // AgentMail's reply endpoint owns the threading + recipient from the original
  // message -- no hand-built In-Reply-To/References.
  return client.inboxes.messages.reply(inboxId, messageId, buildReplyArgs({ body }));
}

// -------------------------------------------------------------------------
// I/O layer: the live SDK client, cursor persistence, and the CLI verbs.
// Not unit-tested (the SDK is stubbed in tests); the exact SDK method names /
// field shapes below are verified against the installed `agentmail` package at
// the live-smoke step. Typed against the real `agentmail` SDK types
// (`AgentMailClient` + the `AgentMail` namespace) -- the pure cores above carry
// the hand-rolled provider-neutral types.
// -------------------------------------------------------------------------

// The inbox Baxter owns (created by `make inbox`). AgentMail addresses on the
// default @agentmail.to domain; the inbox id is what the API calls take.
const INBOX_ID = process.env.AGENTMAIL_INBOX_ID || process.env.BAXTER_EMAIL;
const OWN_EMAIL = process.env.BAXTER_EMAIL || "";

let _client: AgentMailClient | undefined;
async function getClient(): Promise<AgentMailClient> {
  if (_client) return _client;
  const { AgentMailClient: Client } = await import("agentmail");
  _client = new Client({ apiKey: loadApiKey(process.env, AGENTMAIL_KEY_PATH) });
  return _client;
}

// Exported for hermetic tests / indirect verification -- otherwise a private send-gate helper.
export function allowedSenders(path: string = ALLOWLIST_PATH): string[] {
  return loadAllowlist(process.env, path).senders; // file -> env seed -> [] (fail-closed); fresh, no write
}

function loadCursor(): number {
  try {
    const v = JSON.parse(readFileSync(MAIL_POLL_CURSOR_PATH, "utf8")).cursorMs;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0; // fresh inbox: list from the epoch
  }
}
function saveCursor(cursorMs: number): void {
  mkdirSync(dirname(MAIL_POLL_CURSOR_PATH), { recursive: true });
  writeFileSync(MAIL_POLL_CURSOR_PATH, JSON.stringify({ cursorMs }));
}

function assertUnderSendCap(): void {
  if (loadSendState().count >= MAX_SENDS_PER_DAY) {
    throw new Error(`Daily send cap (${MAX_SENDS_PER_DAY}) reached; refusing to send.`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdListNew(): Promise<void> {
  const senders = allowedSenders();
  if (senders.length === 0) {
    // Fail closed: nobody allowed -> nothing processed (not everybody).
    console.error("ALLOWED_SENDERS is not set; no senders are whitelisted, so no mail will be processed.");
    console.log("[]");
    return;
  }
  const client = await getClient();
  const cursor = loadCursor();

  // Page through the listing from the cursor, oldest-first.
  const raw: AgentMail.MessageItem[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.inboxes.messages.list(INBOX_ID as string, listOpts(cursor, pageToken));
    for (const m of res.messages ?? []) raw.push(m);
    pageToken = res.nextPageToken;
  } while (pageToken);

  const messages: ListMessage[] = raw.map((m) => ({
    messageId: m.messageId,
    threadId: m.threadId,
    from: m.from,
    // POSSIBLE LATENT BUG (flagged, not fixed): the SDK's static type for
    // `timestamp` is `Date`, but the client parses responses with skipValidation:
    // true, so at runtime it's a `Date` on the happy path yet can pass through as
    // the raw ISO string (or undefined) when validation is skipped/fails.
    // `Date.parse(String(...))` is robust to BOTH: for a Date it reproduces the old
    // `Date.parse(m.timestamp)` toString-coercion (whole-second, dropping sub-second
    // precision -- masked by CURSOR_MARGIN_MS); for a string it parses the ISO fully.
    // Any precision fix MUST stay shape-tolerant, e.g. `m.timestamp instanceof Date
    // ? m.timestamp.getTime() : Date.parse(String(m.timestamp))` -- NOT bare
    // `.getTime()` (TypeErrors on the string path). Deferred (see cluster report).
    timestamp: Date.parse(String(m.timestamp)),
    labels: m.labels ?? [],
  }));

  const { survivors, nextCursor } = classifyListing({
    messages,
    prevCursor: cursor,
    allowedSenders: senders,
    ownEmail: OWN_EMAIL,
    margin: CURSOR_MARGIN_MS,
  });
  saveCursor(nextCursor);
  console.log(JSON.stringify(survivors));
}

async function cmdGetThread(threadId: string, ...candidateIds: string[]): Promise<void> {
  const client = await getClient();
  const thread = await client.inboxes.threads.get(INBOX_ID as string, threadId);
  const threadMessages = thread.messages ?? [];
  if (threadMessages.length === 0) throw new Error(`Thread ${threadId} has no messages.`);

  // The thread listing may be preview-only, so fetch each message's full body.
  // Concurrently -- the fetches are independent, and Promise.all preserves order
  // (a serial await loop added N x round-trip latency on every get-thread, which
  // sits on the hot path of every dispatched run). Threads are small; if AgentMail
  // rate limits ever bite on a huge thread, bound this with a small pool.
  const messages: FullMessage[] = await Promise.all(threadMessages.map(async (tm) => {
    const full = await client.inboxes.messages.get(INBOX_ID as string, tm.messageId);
    return {
      messageId: full.messageId,
      threadId: full.threadId,
      from: full.from,
      subject: full.subject,
      text: full.text ?? "",
      // Same latent precision-loss (Date coerced via String()) as cmdListNew -- see there.
      timestamp: Date.parse(String(full.timestamp)),
      labels: full.labels ?? [],
      headers: full.headers ?? {},
      attachments: mapAttachments((full as { attachments?: unknown }).attachments),
    };
  }));

  console.log(JSON.stringify(buildThreadOutput({
    messages,
    candidateIds: candidateIds.map(canonicalMessageId),
    allowedSenders: allowedSenders(),
    ownEmail: OWN_EMAIL,
  })));
}

// Mint a short-lived presigned download URL for one attachment on a message. This is the
// credential-holding step (the API key is needed to get the URL; the URL itself is then
// publicly fetchable, so the run's runner can fetch it without the key). poll.ts calls this
// only when it's about to route a media email to the multimodal model.
async function cmdGetAttachment(messageId: string, attachmentId: string): Promise<void> {
  if (!messageId || !attachmentId) throw new Error("usage: mail.ts get-attachment <messageId> <attachmentId>");
  const client = await getClient();
  const res = await client.inboxes.messages.getAttachment(INBOX_ID as string, canonicalMessageId(messageId), attachmentId);
  console.log(JSON.stringify({
    attachmentId: res.attachmentId,
    filename: res.filename,
    contentType: res.contentType,
    size: res.size,
    downloadUrl: res.downloadUrl,
    expiresAt: res.expiresAt instanceof Date ? res.expiresAt.toISOString() : res.expiresAt,
  }));
}

async function cmdReply(messageId: string): Promise<void> {
  assertUnderSendCap();
  const body = await readStdin();
  const client = await getClient();
  // INBOX_ID is only undefined if neither AGENTMAIL_INBOX_ID nor BAXTER_EMAIL is
  // set -- an existing config-error latent gap (unchanged), not something this
  // migration fixes; see the cluster report.
  const res = await performReply({ client, inboxId: INBOX_ID as string, messageId: canonicalMessageId(messageId), body, env: process.env, recordSend });
  console.log(JSON.stringify({ sent: true, threadId: res.threadId }));
}

// Takes the recipient as an argument, but performSend re-authorizes it against the
// env-sourced allowlist (resolveRecipient: ALLOWED_RECIPIENTS ∪ OPERATOR_EMAIL)
// before sending -- so the run may pick among operator-approved recipients, and a
// prompt-injected email still can't reach an arbitrary address (the trust boundary
// is the environment, not this argument).
async function cmdSend(to: string, subject: string): Promise<void> {
  assertUnderSendCap();
  const body = await readStdin();
  const client = await getClient();
  await performSend({ client, inboxId: INBOX_ID as string, env: process.env, to, subject, body, recordSend });
  console.log(JSON.stringify({ sent: true }));
}

// The calendar subscribe link, written into calendar-keys.json by baxter-control at
// provisioning (core never knows the public hostname). Throws a clear "not set up yet"
// if the calendar feed isn't provisioned. Exported + path-injectable for tests.
export function calendarSubscribeUrl(keysPath: string = CALENDAR_KEYS_PATH): string {
  let raw: string;
  try {
    raw = readFileSync(keysPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("no calendar feed is set up yet -- there's no calendar subscribe URL to send");
    throw err;
  }
  let parsed: { subscribeUrl?: unknown } | null;
  try { parsed = JSON.parse(raw) as { subscribeUrl?: unknown } | null; }
  catch { throw new Error("calendar-keys.json is not valid JSON -- re-provision the calendar feed"); }
  const url = parsed?.subscribeUrl; // `null`/non-object falls into the "not provisioned" branch below
  if (typeof url !== "string" || !url.trim()) throw new Error("the calendar feed isn't fully provisioned yet (calendar-keys.json has no subscribeUrl)");
  return url.trim();
}

// The FIXED body of the calendar-share email. Pure/exported for tests. Deliberately
// takes only the trusted URL -- the model supplies nothing here.
export function calendarShareBody(url: string): string {
  return [
    "Here's your family calendar subscription link -- everything I add to the calendar shows up automatically once you subscribe:",
    "",
    url,
    "",
    "On iPhone/Mac, tap the link (or Calendar > Add Subscription Calendar and paste it). It refreshes every few hours.",
  ].join("\n");
}

// `send-calendar`: a BARE, fully-trusted send. The model can only TRIGGER it -- the
// recipient (OPERATOR_EMAIL) and the entire content (a fixed template + the
// operator-provisioned subscribe URL) are on the trusted side; nothing is a caller
// argument. Errors if the calendar feed or OPERATOR_EMAIL isn't set up.
async function cmdSendCalendar(): Promise<void> {
  const url = calendarSubscribeUrl(); // throws if not provisioned yet
  const to = (process.env.OPERATOR_EMAIL || "").trim();
  if (!to) throw new Error("OPERATOR_EMAIL is not set; nowhere to send the calendar link.");
  assertUnderSendCap();
  const client = await getClient();
  await performSend({ client, inboxId: INBOX_ID as string, env: process.env, to, subject: "Your family calendar subscription", body: calendarShareBody(url), recordSend });
  console.log(JSON.stringify({ sent: true, to }));
}

async function cmdLabel(messageId: string, name: string): Promise<void> {
  const id = canonicalMessageId(messageId);
  const client = await getClient();
  await client.inboxes.messages.update(INBOX_ID as string, id, { addLabels: [name] });
  console.log(JSON.stringify({ labeled: true, id, label: name }));
}

// Only run the CLI dispatch when executed directly, not when imported for the
// pure exports above (guard mirrors gmail.ts's old import.meta.url check).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...args] = process.argv;
  try {
    switch (cmd) {
      case "list-new":
        await cmdListNew();
        break;
      case "get-thread":
        await cmdGetThread(args[0], ...args.slice(1));
        break;
      case "get-attachment":
        await cmdGetAttachment(args[0], args[1]);
        break;
      case "reply":
        await cmdReply(args[0]);
        break;
      case "send":
        await cmdSend(args[0], args[1]);
        break;
      case "send-calendar":
        await cmdSendCalendar();
        break;
      case "label":
        await cmdLabel(args[0], args[1]);
        break;
      default:
        console.error("Usage: mail.ts <list-new|get-thread|get-attachment|reply|send|send-calendar|label> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
