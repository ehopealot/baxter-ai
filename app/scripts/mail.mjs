#!/usr/bin/env node
// Thin CLI wrapper around the AgentMail API -- the credential boundary for the
// mail surface, replacing gmail.mjs. poll.mjs and the spawned `claude -p` run
// both go through this as a subprocess (by absolute path, MAIL_CLI). The
// AgentMail SDK is imported LAZILY (inside getClient) so the pure, tested cores
// below load without the `agentmail` package present -- unit tests exercise them
// with an injected fake client. See
// docs/superpowers/specs/2026-07-22-agentmail-migration-design.md.
//
// Subcommands (same surface as the old gmail.mjs, so poll.mjs/prompts are ~unchanged):
//   list-new                                Received, allowlisted, not-yet-handled messages
//   get-thread <threadId> <candidateId...>  Full thread transcript, newest candidate marked
//   reply <messageId>                       Reply in-thread; body from stdin
//   send <subject>                          New message to OPERATOR_EMAIL only; body from stdin
//   label <messageId> <name>                Add a label
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSendState, recordSend, MAX_SENDS_PER_DAY } from "./send-state.mjs";
import { AGENTMAIL_KEY_PATH, MAIL_POLL_CURSOR_PATH } from "./paths.mjs";
import { extractEmailAddress, formatThreadMessage, MESSAGE_SEPARATOR } from "./transcript.mjs";

// Baxter's own outgoing marker. Applied on every send/reply so the agent's own
// messages are identifiable in a thread WITHOUT trusting the (spoofable) From --
// the unforgeable analog of Gmail's SENT label. Inbound mail can't cause our
// label to be applied to itself (labels are inbox-side metadata set via our API
// key, not message content), so a message counts as "own" for the
// redaction-exemption ONLY if it carries this label (never by From alone).
export const SENT_LABEL = "baxter-sent";
// Idempotency marker: poll.mjs labels every message of a handled (or skipped)
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
// Credential (env-first-then-file, mirroring discord-cli.mjs's token()).
// -------------------------------------------------------------------------
export function loadApiKey(env, keyPath) {
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

// Classify one listing into { survivors, nextCursor }. A message is a SURVIVOR
// unless it is already handled (PROCESSED_LABEL), own (SENT_LABEL, or From ==
// the inbox address -- an extra list-new-only exclusion), or off-allowlist.
// Fails CLOSED: an empty allowedSenders makes every message off-allowlist.
export function classifyListing({ messages, prevCursor, allowedSenders, ownEmail, margin }) {
  const allow = allowedSenders.map((s) => s.toLowerCase());
  const own = (ownEmail || "").toLowerCase();
  const isSurvivor = (m) => {
    const labels = m.labels || [];
    if (labels.includes(PROCESSED_LABEL)) return false; // already handled
    const email = extractEmailAddress(m.from);
    if (labels.includes(SENT_LABEL) || email === own) return false; // own
    return allow.includes(email); // off-allowlist -> excluded (empty allow -> none)
  };
  const survivorMsgs = messages.filter(isSurvivor);
  const survivors = survivorMsgs.map((m) => ({ id: m.messageId, threadId: m.threadId }));

  let nextCursor;
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
export function detectAutomated(headers) {
  const get = (name) => {
    const target = name.toLowerCase();
    for (const k of Object.keys(headers || {})) {
      if (k.toLowerCase() === target) return String(headers[k]);
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
export function buildThreadOutput({ messages, candidateIds, allowedSenders, ownEmail }) {
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
  // only isOwn does. (Mirrors gmail.mjs's isAllowedThreadParticipant precedence.)
  const isAllowedNonOwn = (addr) => allow.includes(addr) && addr !== own;

  const normalizedOf = (m) => ({
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
export function buildSendArgs({ to, subject, body }) {
  return { to, subject, text: body, labels: [SENT_LABEL] };
}
export function buildReplyArgs({ body }) {
  return { text: body, labels: [SENT_LABEL] };
}

// The operator is the ONLY recipient `send` can reach -- resolved from the env,
// never a caller/CLI argument, so a prompt-injected run has no recipient surface.
export function operatorRecipient(env) {
  const to = env.OPERATOR_EMAIL;
  if (!to) throw new Error("OPERATOR_EMAIL is not set; refusing to send.");
  return to;
}

// Resolve the recipient FIRST (fail loud before touching the send cap), then
// count the send BEFORE the network call -- over-counting a flood guard is the
// safe direction (mirrors the old gmail.mjs / discord-cli ordering).
export async function performSend({ client, inboxId, env, subject, body, recordSend: record }) {
  const to = operatorRecipient(env);
  await record();
  return client.inboxes.messages.send(inboxId, buildSendArgs({ to, subject, body }));
}
export async function performReply({ client, inboxId, messageId, body, recordSend: record }) {
  await record(); // count before the call, as above
  // AgentMail's reply endpoint owns the threading + recipient from the original
  // message -- no hand-built In-Reply-To/References.
  return client.inboxes.messages.reply(inboxId, messageId, buildReplyArgs({ body }));
}

// -------------------------------------------------------------------------
// I/O layer: the live SDK client, cursor persistence, and the CLI verbs.
// Not unit-tested (the SDK is stubbed in tests); the exact SDK method names /
// field shapes below are verified against the installed `agentmail` package at
// the live-smoke step.
// -------------------------------------------------------------------------

// The inbox Baxter owns (created by `make inbox`). AgentMail addresses on the
// default @agentmail.to domain; the inbox id is what the API calls take.
const INBOX_ID = process.env.AGENTMAIL_INBOX_ID || process.env.BAXTER_EMAIL;
const OWN_EMAIL = process.env.BAXTER_EMAIL || "";

let _client;
async function getClient() {
  if (_client) return _client;
  const { AgentMailClient } = await import("agentmail");
  _client = new AgentMailClient({ apiKey: loadApiKey(process.env, AGENTMAIL_KEY_PATH) });
  return _client;
}

function allowedSenders() {
  return (process.env.ALLOWED_SENDERS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function loadCursor() {
  try {
    const v = JSON.parse(readFileSync(MAIL_POLL_CURSOR_PATH, "utf8")).cursorMs;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0; // fresh inbox: list from the epoch
  }
}
function saveCursor(cursorMs) {
  mkdirSync(dirname(MAIL_POLL_CURSOR_PATH), { recursive: true });
  writeFileSync(MAIL_POLL_CURSOR_PATH, JSON.stringify({ cursorMs }));
}

function assertUnderSendCap() {
  if (loadSendState().count >= MAX_SENDS_PER_DAY) {
    throw new Error(`Daily send cap (${MAX_SENDS_PER_DAY}) reached; refusing to send.`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdListNew() {
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
  const raw = [];
  let pageToken;
  do {
    const res = await client.inboxes.messages.list(INBOX_ID, {
      after: new Date(cursor).toISOString(),
      ascending: true,
      limit: LIST_PAGE_LIMIT,
      pageToken,
    });
    for (const m of res.messages ?? []) raw.push(m);
    pageToken = res.nextPageToken;
  } while (pageToken);

  const messages = raw.map((m) => ({
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

async function cmdGetThread(threadId, ...candidateIds) {
  const client = await getClient();
  const thread = await client.inboxes.threads.get(INBOX_ID, threadId);
  const threadMessages = thread.messages ?? [];
  if (threadMessages.length === 0) throw new Error(`Thread ${threadId} has no messages.`);

  // The thread listing may be preview-only, so fetch each message's full body.
  const messages = [];
  for (const tm of threadMessages) {
    const full = await client.inboxes.messages.get(INBOX_ID, tm.messageId);
    messages.push({
      messageId: full.messageId,
      threadId: full.threadId,
      from: full.from,
      subject: full.subject,
      text: full.text ?? "",
      timestamp: Date.parse(full.timestamp),
      labels: full.labels ?? [],
      headers: full.headers ?? {},
    });
  }

  console.log(JSON.stringify(buildThreadOutput({
    messages,
    candidateIds,
    allowedSenders: allowedSenders(),
    ownEmail: OWN_EMAIL,
  })));
}

async function cmdReply(messageId) {
  assertUnderSendCap();
  const body = await readStdin();
  const client = await getClient();
  const res = await performReply({ client, inboxId: INBOX_ID, messageId, body, recordSend });
  console.log(JSON.stringify({ sent: true, threadId: res.threadId }));
}

// Deliberately takes no recipient argument (see operatorRecipient): reachable by
// the spawned run, so hardcoding the recipient to OPERATOR_EMAIL leaves no
// argument surface a prompt-injected email could exploit.
async function cmdSend(subject) {
  assertUnderSendCap();
  const body = await readStdin();
  const client = await getClient();
  await performSend({ client, inboxId: INBOX_ID, env: process.env, subject, body, recordSend });
  console.log(JSON.stringify({ sent: true }));
}

async function cmdLabel(messageId, name) {
  const client = await getClient();
  await client.inboxes.messages.update(INBOX_ID, messageId, { addLabels: [name] });
  console.log(JSON.stringify({ labeled: true, id: messageId, label: name }));
}

// Only run the CLI dispatch when executed directly, not when imported for the
// pure exports above (guard mirrors gmail.mjs's old import.meta.url check).
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
        console.error("Usage: mail.mjs <list-new|get-thread|reply|send|label> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
