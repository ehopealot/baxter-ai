#!/usr/bin/env node
// Thin CLI wrapper around the Gmail REST API. This is the only file that
// ever touches the OAuth token -- poll.mjs and the spawned `claude -p` run
// both go through this as a subprocess, via `node scripts/gmail.mjs <cmd>`.
//
// Subcommands:
//   list-new                    Inbound messages not yet labeled agent-processed
//   get-thread <id>             Full parsed content of one message
//   reply <id>                  Send a reply in-thread; body read from stdin
//   send <to> <subject>         Send a new (non-reply) message; body read from stdin
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

async function cmdGetThread(id) {
  const msg = await gmailFetch(`/messages/${id}?format=full`);
  const headers = msg.payload.headers;
  const autoSubmitted = header(headers, "Auto-Submitted");
  const precedence = header(headers, "Precedence");
  const isAutomated =
    (autoSubmitted && autoSubmitted.toLowerCase() !== "no") ||
    ["bulk", "list", "junk"].includes(precedence.toLowerCase());
  console.log(
    JSON.stringify({
      id: msg.id,
      threadId: msg.threadId,
      from: header(headers, "From"),
      subject: header(headers, "Subject"),
      messageId: header(headers, "Message-ID"),
      references: header(headers, "References"),
      isAutomated,
      body: extractPlainText(msg.payload),
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

async function cmdSend(to, subject) {
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
      await cmdSend(args[0], args[1]);
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
