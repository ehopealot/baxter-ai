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
//   send <subject>                          New message to OPERATOR_EMAIL only; body from stdin
//   label <messageId> <name>                Add a label
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSendState, recordSend, MAX_SENDS_PER_DAY } from "./send-state.ts";
import { AGENTMAIL_KEY_PATH, MAIL_POLL_CURSOR_PATH } from "./paths.ts";
import { extractEmailAddress, formatThreadMessage, MESSAGE_SEPARATOR } from "./transcript.ts";

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

  return {
    id: trigger.messageId,
    threadId: trigger.threadId,
    from: trigger.from,
    subject: trigger.subject ?? "",
    receivedAt: new Date(trigger.timestamp).toISOString(),
    isAutomated: detectAutomated(trigger.headers),
    isAllowedSender: isAllowedNonOwn(extractEmailAddress(trigger.from)),
    body,
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

// The operator is the ONLY recipient `send` can reach -- resolved from the env,
// never a caller/CLI argument, so a prompt-injected run has no recipient surface.
export function operatorRecipient(env: NodeJS.ProcessEnv): string {
  const to = env.OPERATOR_EMAIL;
  if (!to) throw new Error("OPERATOR_EMAIL is not set; refusing to send.");
  return to;
}

// Minimal surfaces of the AgentMail client the two send paths actually call --
// one interface per verb, so an injected test fake need only implement the one
// method it stubs (see mail.test.ts). The real client (getClient() below) is
// typed `any` (the SDK boundary) and satisfies both structurally.
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
  subject: string;
  body: string;
  recordSend: () => Promise<unknown>;
}
export interface PerformReplyArgs {
  client: AgentMailReplyClient;
  inboxId: string;
  messageId: string;
  body: string;
  recordSend: () => Promise<unknown>;
}

// Resolve the recipient FIRST (fail loud before touching the send cap), then
// count the send BEFORE the network call -- over-counting a flood guard is the
// safe direction (mirrors the old gmail.ts / discord-cli ordering).
export async function performSend({ client, inboxId, env, subject, body, recordSend: record }: PerformSendArgs): Promise<{ messageId: string; threadId: string }> {
  const to = operatorRecipient(env);
  await record();
  return client.inboxes.messages.send(inboxId, buildSendArgs({ to, subject, body }));
}
export async function performReply({ client, inboxId, messageId, body, recordSend: record }: PerformReplyArgs): Promise<{ messageId: string; threadId: string }> {
  await record(); // count before the call, as above
  // AgentMail's reply endpoint owns the threading + recipient from the original
  // message -- no hand-built In-Reply-To/References.
  return client.inboxes.messages.reply(inboxId, messageId, buildReplyArgs({ body }));
}

// -------------------------------------------------------------------------
// I/O layer: the live SDK client, cursor persistence, and the CLI verbs.
// Not unit-tested (the SDK is stubbed in tests); the exact SDK method names /
// field shapes below are verified against the installed `agentmail` package at
// the live-smoke step. `any` throughout is the deliberate AgentMail-SDK boundary
// (see the cluster's typing rules) -- the pure cores above carry the real types.
// -------------------------------------------------------------------------

// The inbox Baxter owns (created by `make inbox`). AgentMail addresses on the
// default @agentmail.to domain; the inbox id is what the API calls take.
const INBOX_ID = process.env.AGENTMAIL_INBOX_ID || process.env.BAXTER_EMAIL;
const OWN_EMAIL = process.env.BAXTER_EMAIL || "";

let _client: any;
async function getClient(): Promise<any> {
  if (_client) return _client;
  // Cast the dynamic import to `any`: the real agentmail SDK's Options type is a
  // discriminated union (plain-key vs wrapper-auth) that isn't worth threading
  // through this lazy-load boundary -- see the AgentMail-SDK-boundary rule.
  const { AgentMailClient } = (await import("agentmail")) as any;
  _client = new AgentMailClient({ apiKey: loadApiKey(process.env, AGENTMAIL_KEY_PATH) });
  return _client;
}

function allowedSenders(): string[] {
  return (process.env.ALLOWED_SENDERS || "").split(",").map((s) => s.trim()).filter(Boolean);
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
  const raw: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.inboxes.messages.list(INBOX_ID, listOpts(cursor, pageToken));
    for (const m of res.messages ?? []) raw.push(m);
    pageToken = res.nextPageToken;
  } while (pageToken);

  const messages: ListMessage[] = raw.map((m) => ({
    messageId: m.messageId,
    threadId: m.threadId,
    from: m.from,
    timestamp: Date.parse(m.timestamp),
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
  const thread = await client.inboxes.threads.get(INBOX_ID, threadId);
  const threadMessages = thread.messages ?? [];
  if (threadMessages.length === 0) throw new Error(`Thread ${threadId} has no messages.`);

  // The thread listing may be preview-only, so fetch each message's full body.
  // Concurrently -- the fetches are independent, and Promise.all preserves order
  // (a serial await loop added N x round-trip latency on every get-thread, which
  // sits on the hot path of every dispatched run). Threads are small; if AgentMail
  // rate limits ever bite on a huge thread, bound this with a small pool.
  const messages: FullMessage[] = await Promise.all(threadMessages.map(async (tm: any) => {
    const full = await client.inboxes.messages.get(INBOX_ID, tm.messageId);
    return {
      messageId: full.messageId,
      threadId: full.threadId,
      from: full.from,
      subject: full.subject,
      text: full.text ?? "",
      timestamp: Date.parse(full.timestamp),
      labels: full.labels ?? [],
      headers: full.headers ?? {},
    };
  }));

  console.log(JSON.stringify(buildThreadOutput({
    messages,
    candidateIds: candidateIds.map(canonicalMessageId),
    allowedSenders: allowedSenders(),
    ownEmail: OWN_EMAIL,
  })));
}

async function cmdReply(messageId: string): Promise<void> {
  assertUnderSendCap();
  const body = await readStdin();
  const client = await getClient();
  // INBOX_ID is only undefined if neither AGENTMAIL_INBOX_ID nor BAXTER_EMAIL is
  // set -- an existing config-error latent gap (unchanged), not something this
  // migration fixes; see the cluster report.
  const res = await performReply({ client, inboxId: INBOX_ID as string, messageId: canonicalMessageId(messageId), body, recordSend });
  console.log(JSON.stringify({ sent: true, threadId: res.threadId }));
}

// Deliberately takes no recipient argument (see operatorRecipient): reachable by
// the spawned run, so hardcoding the recipient to OPERATOR_EMAIL leaves no
// argument surface a prompt-injected email could exploit.
async function cmdSend(subject: string): Promise<void> {
  assertUnderSendCap();
  const body = await readStdin();
  const client = await getClient();
  await performSend({ client, inboxId: INBOX_ID as string, env: process.env, subject, body, recordSend });
  console.log(JSON.stringify({ sent: true }));
}

async function cmdLabel(messageId: string, name: string): Promise<void> {
  const id = canonicalMessageId(messageId);
  const client = await getClient();
  await client.inboxes.messages.update(INBOX_ID, id, { addLabels: [name] });
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
      case "reply":
        await cmdReply(args[0]);
        break;
      case "send":
        await cmdSend(args[0]);
        break;
      case "label":
        await cmdLabel(args[0], args[1]);
        break;
      default:
        console.error("Usage: mail.ts <list-new|get-thread|reply|send|label> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
