#!/usr/bin/env node
// Thin CLI wrapper around the Gmail REST API. This is the only file that
// ever touches the OAuth token -- poll.mjs and the spawned `claude -p` run
// both go through this as a subprocess (`node scripts/gmail.mjs <cmd>` from
// poll.mjs itself; the claude-spawned run invokes it by absolute path
// instead, since its cwd is different -- see poll.mjs's GMAIL_CLI_PATH).
//
// Subcommands:
//   list-new           Inbound messages not yet labeled agent-processed
//   get-thread <threadId>  Full thread transcript, ending at the thread's newest message
//   reply <id>                  Send a reply in-thread; body read from stdin
//   send <subject>              Send a new message to OPERATOR_EMAIL only
//                                (nowhere else -- see cmdSend); body read from stdin
//   label <id> <name>           Add a label (creating it if missing)
import { OAuth2Client } from "google-auth-library";
import { readFileSync } from "node:fs";
import { loadSendState, recordSend, MAX_SENDS_PER_DAY } from "./send-state.mjs";
import { TOKEN_PATH } from "./paths.mjs";

const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROCESSED_LABEL = "agent-processed";

function loadToken() {
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    throw new Error(
      `No Gmail token at ${TOKEN_PATH}. Run 'make auth' first.`,
    );
  }
}

// One client for this process's lifetime: OAuth2Client caches the access
// token it gets back from a refresh internally and only refreshes again
// once it's actually expired, but only if the same instance is reused
// across calls -- a fresh client every call defeats that entirely.
let client;
function getClient() {
  if (!client) {
    client = new OAuth2Client(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    );
    client.setCredentials({ refresh_token: loadToken().refresh_token });
  }
  return client;
}

async function getAccessToken() {
  const { token } = await getClient().getAccessToken();
  return token;
}

async function gmailFetch(path, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Gmail API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

function b64urlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function header(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractPlainText(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return b64urlDecode(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  return "";
}

async function findOrCreateLabel(name) {
  const { labels } = await gmailFetch("/labels");
  const existing = labels.find((l) => l.name === name);
  if (existing) return existing.id;
  const created = await gmailFetch("/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      labelListVisibility: "labelHide",
      messageListVisibility: "hide",
    }),
  });
  return created.id;
}

function allowedSenders() {
  return (process.env.ALLOWED_SENDERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Gmail's `from:` search operator matches against the whole From header,
// display name included -- `From: "erikjhope@gmail.com" <attacker@evil.com>`
// satisfies `from:erikjhope@gmail.com` in the list-new query. This parses
// out just the actual address for a second, real check before a thread is
// ever dispatched to a claude run.
function extractEmailAddress(fromHeader) {
  // Greedy .* forces the match to the LAST <...> group, not the first: a
  // display name can itself contain an angle-bracketed address (e.g.
  // `"erik <allowed@x.com>" <attacker@evil.com>`), and per RFC 5322
  // mailbox syntax the real deliverable addr-spec is always the trailing
  // one, whichever position an attacker crafts the header to make a naive
  // first-match land on.
  const angleBracketMatch = fromHeader.match(/.*<([^>]+)>/);
  return (angleBracketMatch ? angleBracketMatch[1] : fromHeader).trim().toLowerCase();
}

async function cmdListNew() {
  // -from:me and -label:agent-processed cover the common loop-prevention
  // case cheaply via Gmail's own search index; per-message header checks
  // (Auto-Submitted/Precedence) happen in get-thread since Gmail search
  // doesn't index arbitrary headers.
  //
  // Fails closed: an unset/empty ALLOWED_SENDERS means nobody is allowed
  // to trigger the agent, not everybody. `{from:a from:b}` is Gmail
  // search's OR grouping, so this is enforced by the query itself rather
  // than filtering client-side after the fact.
  const senders = allowedSenders();
  if (senders.length === 0) {
    console.error("ALLOWED_SENDERS is not set; no senders are whitelisted, so no mail will be processed.");
    console.log("[]");
    return;
  }
  const senderFilter = `{${senders.map((s) => `from:${s}`).join(" ")}}`;
  const query = `in:inbox -label:${PROCESSED_LABEL} -from:me ${senderFilter}`;
  const data = await gmailFetch(`/messages?q=${encodeURIComponent(query)}`);
  const messages = data.messages ?? [];
  console.log(JSON.stringify(messages.map((m) => ({ id: m.id, threadId: m.threadId }))));
}

// The allowlist gates which message can *trigger* a run, but every
// participant's content still ends up in the transcript unless it's
// filtered here too -- otherwise anyone CC'd, or replying with a leaked
// Message-ID/References, gets their content fed straight into the prompt
// once an allowed sender says anything at all in the same thread, and
// could land as the "newest message" the model is told to act on if their
// message happens to be the most recent one at fetch time.
//
// The agent's own past replies are exempted, but From is spoofable and not
// authenticated on its own -- checking Authentication-Results was tried
// and doesn't work: that header is only added by the MTA processing
// *inbound* mail, so it's simply absent on the account's own sent
// messages (confirmed against a real one), meaning the exemption could
// never actually fire for genuinely self-sent mail. The SENT label is a
// much better signal: it's Gmail's own metadata, assigned only when this
// account's authenticated access actually dispatched the message through
// Gmail's send API -- not part of the message content at all, so an
// inbound message crafted by an attacker cannot cause it to be applied
// regardless of what From claims.
function isAllowedThreadParticipant(msg) {
  const email = extractEmailAddress(header(msg.payload.headers, "From"));
  if (email === (process.env.GMAIL_USER_EMAIL || "").toLowerCase()) {
    return (msg.labelIds || []).includes("SENT");
  }
  return allowedSenders()
    .map((s) => s.toLowerCase())
    .includes(email);
}

function formatThreadMessage(msg) {
  const headers = msg.payload.headers;
  const date = header(headers, "Date");
  if (!isAllowedThreadParticipant(msg)) {
    // From/Subject are just as attacker-controlled and unbounded as the
    // body (e.g. a crafted Subject line impersonating an instruction), so
    // redact them too rather than leaving them to be interpolated verbatim.
    return `From: [redacted -- sender not on the allowlist]\nDate: ${date}\nSubject: [redacted]\n\n[content omitted -- sender is not on the allowlist]`;
  }
  const from = header(headers, "From");
  const subject = header(headers, "Subject");
  return `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${extractPlainText(msg.payload)}`;
}

async function cmdGetThread(threadId) {
  const thread = await gmailFetch(`/threads/${threadId}?format=full`);
  if (!thread.messages || thread.messages.length === 0) {
    throw new Error(`Thread ${threadId} has no messages.`);
  }
  // Determined here, not trusted from the caller: messages.list's ordering
  // (what list-new uses) isn't documented as guaranteed, so a caller-
  // supplied "which message is newest" could be wrong. internalDate is
  // authoritative and always present, regardless of API response order.
  const msg = thread.messages.reduce((newest, m) =>
    Number(m.internalDate) > Number(newest.internalDate) ? m : newest,
  );
  const headers = msg.payload.headers;
  const autoSubmitted = header(headers, "Auto-Submitted");
  const precedence = header(headers, "Precedence");
  // isAutomated/isAllowedSender are checked against this specific
  // triggering message only, never the thread as a whole -- otherwise an
  // attacker could reply into an already-allowed thread from an
  // unallowlisted address and ride along on the earlier trust decision.
  const isAutomated =
    (autoSubmitted && autoSubmitted.toLowerCase() !== "no") ||
    ["bulk", "list", "junk"].includes(precedence.toLowerCase());
  const from = header(headers, "From");
  const isAllowedSender = allowedSenders()
    .map((s) => s.toLowerCase())
    .includes(extractEmailAddress(from));

  // Gmail returns thread messages oldest first, so the transcript ends
  // with the message that triggered this run.
  const transcript = thread.messages.map(formatThreadMessage).join("\n\n---\n\n");

  console.log(
    JSON.stringify({
      id: msg.id,
      threadId: thread.id,
      from,
      subject: header(headers, "Subject"),
      messageId: header(headers, "Message-ID"),
      references: header(headers, "References"),
      isAutomated,
      isAllowedSender,
      body: transcript,
    }),
  );
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

async function sendRaw({ to, subject, body, inReplyTo, references, threadId }) {
  const fromName = process.env.PERSONA_NAME || "Baxter Burgundy";
  const fromEmail = process.env.GMAIL_USER_EMAIL;

  const lines = [`From: ${fromName} <${fromEmail}>`, `To: ${to}`, `Subject: ${subject}`];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("Content-Type: text/plain; charset=utf-8", "", body);

  await gmailFetch("/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64urlEncode(lines.join("\r\n")), ...(threadId ? { threadId } : {}) }),
  });
  recordSend();
}

async function cmdReply(id) {
  assertUnderSendCap();
  const body = await readStdin();

  const msg = await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
  const headers = msg.payload.headers;
  const to = header(headers, "From");
  const subject = header(headers, "Subject");
  const inReplyTo = header(headers, "Message-ID");
  const references = `${header(headers, "References")} ${inReplyTo}`.trim();
  const replySubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;

  await sendRaw({ to, subject: replySubject, body, inReplyTo, references, threadId: msg.threadId });
  console.log(JSON.stringify({ sent: true, threadId: msg.threadId }));
}

// Deliberately takes no `to` argument: this subcommand is reachable by the
// spawned `claude -p` run too (poll.mjs's --allowedTools wildcards its
// gmail.mjs invocation), so a prompt-injected email could otherwise use it
// to send arbitrary mail to arbitrary recipients. Hardcoding the recipient
// here means there's no argument surface to exploit regardless of what's
// allowlisted -- not just a check that could be routed around.
async function cmdSend(subject) {
  const to = process.env.OPERATOR_EMAIL;
  if (!to) {
    throw new Error("OPERATOR_EMAIL is not set; refusing to send.");
  }
  assertUnderSendCap();
  const body = await readStdin();
  await sendRaw({ to, subject, body });
  console.log(JSON.stringify({ sent: true }));
}

async function cmdLabel(id, name) {
  const labelId = await findOrCreateLabel(name);
  await gmailFetch(`/messages/${id}/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
  console.log(JSON.stringify({ labeled: true, id, label: name }));
}

const [, , cmd, ...args] = process.argv;

try {
  switch (cmd) {
    case "list-new":
      await cmdListNew();
      break;
    case "get-thread":
      await cmdGetThread(args[0]);
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
      console.error("Usage: gmail.mjs <list-new|get-thread|reply|send|label> [args]");
      process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
