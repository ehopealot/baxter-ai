#!/usr/bin/env node
// Thin CLI wrapper around the Gmail REST API. This is the only file that
// ever touches the OAuth token -- poll.mjs and the spawned `claude -p` run
// both go through this as a subprocess, invoked by absolute path
// (poll.mjs's GMAIL_CLI_PATH) since the run's cwd differs from poll.mjs's.
//
// Subcommands:
//   list-new                            Inbound messages not yet labeled agent-processed
//   get-thread <threadId> <candidateId...>  Full thread transcript, with
//                                        the newest of the given candidate
//                                        ids (each must be an id list-new
//                                        actually returned for this thread)
//                                        marked as the one to respond to
//   reply <id>                  Send a reply in-thread; body read from stdin
//   send <subject>              Send a new message to OPERATOR_EMAIL only
//                                (nowhere else -- see cmdSend); body read from stdin
//   label <id> <name>           Add a label (creating it if missing)
import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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

// Codepoints, not literal characters or \u escape sequences, in source:
// the two Unicode separator characters here are themselves LineTerminator
// characters at the JS lexical level, so embedding either literally
// inside a regex literal (even via a \u escape -- some text pipeline
// between typing this and the file landing on disk silently expanded it
// to the raw character, confirmed the hard way) breaks the parser.
// String.fromCodePoint sidesteps that entirely: everything typed here is
// plain ASCII digits.
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const NEXT_LINE = String.fromCodePoint(0x0085);

// Every sanitizer in this file (neutralizeStructuralMarkers,
// neutralizeDanglingSeparatorTail) matches literal "\n" only, but a
// claude -p run reading the transcript isn't a byte-exact string
// splitter -- any character that renders or is interpreted as a line
// break reads as a real boundary to it regardless of the exact bytes
// underneath. Beyond "\r\n"/bare "\r" (RFC 5322's conventional line
// ending), this also covers LINE_SEPARATOR/PARAGRAPH_SEPARATOR/NEXT_LINE
// and \v/\f (vertical tab/form feed) -- all of which can visually produce
// a line break just as effectively as "\n". Applied to both extracted
// bodies and the From/Date/Subject header values interpolated into the
// same block (see formatThreadMessage); header() itself is left
// untouched, since it's also used for protocol-critical values
// (Message-ID, References) where silently altering the exact original
// bytes would be its own bug.
//
// Exported: poll.mjs's renderPrompt needs this too, for {{FROM}}/
// {{SUBJECT}} -- see neutralizeStructuralMarkers's own export comment for
// why (same underlying gap, same fix).
// Invisible Unicode format characters (\p{Cf}: zero-width space/joiners, LRM/
// RLM and bidi controls, soft hyphen, etc.). Stripped FIRST in the shared
// normalizer, before any byte-exact matcher downstream (marker/separator
// neutralization) runs -- a model reading the transcript isn't a byte-exact
// splitter, so a name/body could otherwise hide an invisible inside a structural
// token to evade neutralization, or (if stripped only afterward) reconstruct the
// exact bytes the neutralizer was supposed to break. Both transcript surfaces
// (email formatThreadMessage + poll.mjs From/Subject; Discord clean()) reach
// this via normalizeTranscriptText, so this one placement covers both. ASCII
// regex source -- no exotic codepoint typed (see the Unicode sharp-edge note).
const STRIP_INVISIBLE = /\p{Cf}/gu;
export function normalizeTranscriptText(text) {
  return text
    .replace(STRIP_INVISIBLE, "")
    .replace(/\r\n|\r/g, "\n")
    .split(LINE_SEPARATOR)
    .join("\n")
    .split(PARAGRAPH_SEPARATOR)
    .join("\n")
    .split(NEXT_LINE)
    .join("\n")
    .replace(/[\v\f]/g, "\n");
}

function extractPlainText(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    // Normalized to LF here, at the source, rather than downstream: this
    // way every downstream consumer, sanitizer included, only ever sees
    // "\n" -- see normalizeTranscriptText.
    return normalizeTranscriptText(b64urlDecode(payload.body.data));
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

const TRIGGER_MARKER = "[^ RESPOND TO THIS MESSAGE]";
const MESSAGE_SEPARATOR = "\n\n---\n\n";

// A random, unpredictable placeholder generated fresh per call (used in
// formatThreadMessage below), not a fixed constant: a fixed string is
// trivially embeddable by an attacker (or present in forwarded/quoted
// content within the trigger message's own body), and the blind
// substitution step that promotes it to the real marker would then also
// promote that pre-existing occurrence -- forging a second marker
// mid-body. A UUID contains no "-" runs of 3+ (its hyphens are isolated
// single characters between hex groups) and no "\n", so it can't form or
// be mistaken for either structural string, and being freshly random each
// call means it can't be predicted or pre-planted.
function makePlaceholder() {
  return ` ${randomUUID()} `;
}

// Message content is otherwise interpolated into the transcript verbatim,
// so a body (or subject) that happens to literally contain the marker or
// separator string -- forwarded/quoted content, or a deliberate attempt --
// would be indistinguishable from the real structural marker/boundary.
// Applied to every message, not just untrusted ones, since even an
// allowed sender could innocently forward/quote something containing
// these strings.
//
// Must run on the fully-composed per-message block, not on individual
// fields before they're interpolated: a body that merely starts with
// "---\n\n" (or ends with "\n\n---") contains no full separator on its
// own and would pass field-level sanitization untouched, but combined
// with the template's own literal "\n\n" immediately before the body it
// forms a genuine "\n\n---\n\n" -- an intact, indistinguishable forged
// message boundary. Sanitizing the composed block catches that seam.
//
// Looped to a fixed point rather than a single split/join pass: adjacent,
// overlapping occurrences of MESSAGE_SEPARATOR share their middle "\n\n",
// so a single pass only consumes the first one -- the replacement's own
// trailing "\n\n" then recombines with the unconsumed leftover "---\n\n"
// to reconstruct an intact separator right back into the output (e.g.
// "\n\n---\n\n---\n\n" -> "\n\n- - -\n\n---\n\n", which still contains the
// real separator). Repeating until nothing changes catches every
// reconstructed instance, however many times it cascades; each pass
// removes at least one, so this always terminates.
//
// Always targets the real TRIGGER_MARKER text, never a placeholder: this
// runs on the trigger message's own per-call placeholder too (see
// formatThreadMessage), and it must NOT treat that placeholder itself as
// something to neutralize -- doing so would destroy it before it can be
// substituted for the real marker afterward. The placeholder is random
// and never equal to TRIGGER_MARKER's literal text, so it always survives
// this pass untouched regardless.
//
// Exported: the transcript body (thread.body) is already fully sanitized
// by the time it leaves cmdGetThread, but thread.from/thread.subject are
// deliberately emitted raw in that same JSON (from stays unsanitized for
// poll.mjs's own RFC-5322 address re-check) and go straight into the
// prompt template's own {{FROM}}/{{SUBJECT}} slots -- a second sink this
// function never used to cover. poll.mjs's renderPrompt sanitizes those
// two specifically at the point of interpolation instead, rather than
// this file mutating a JSON field other logic depends on staying raw.
export function neutralizeStructuralMarkers(text) {
  let result = text;
  for (;;) {
    const next = result
      .split(TRIGGER_MARKER)
      .join("[marker text neutralized]")
      .split(MESSAGE_SEPARATOR)
      .join("\n\n- - -\n\n");
    if (next === result) return next;
    result = next;
  }
}

// A block that itself ends in "\n\n" followed by a run of hyphens (and
// optionally a single trailing newline -- "\n\n---" and "\n\n---\n" are
// the only two suffix decompositions of MESSAGE_SEPARATOR that can appear
// at a block's own end and still be completed by what follows) doesn't
// yet contain a complete MESSAGE_SEPARATOR -- neutralizeStructuralMarkers
// above leaves it alone -- but whatever gets concatenated directly after
// it (cmdGetThread's own MESSAGE_SEPARATOR join, immediately following
// once this function returns) supplies exactly the missing "\n\n" (or
// just the final "\n"), completing a spurious extra boundary right at the
// seam, in addition to the real one the join inserts. Only the body is
// ever attacker-influenced at a block's very end -- every block otherwise
// starts with a fixed "From: " prefix (so the equivalent leading-edge
// risk doesn't exist: a block never begins with raw body content), and
// the trigger marker (when present) is fixed trailing text -- so this
// only ever needs to inspect the tail.
function neutralizeDanglingSeparatorTail(text) {
  return text.replace(
    /\n\n(-+)(\n?)$/,
    (_, dashes, trailingNewline) => `\n\n${dashes.split("").join(" ")}${trailingNewline}`,
  );
}

// isTrigger marks the specific message to respond to explicitly, rather
// than the model having to infer it from transcript position -- position
// (e.g. "last message") isn't reliable: the trigger is chosen from
// list-new's candidates, not by internalDate over the whole thread, so a
// message chronologically after the trigger (typically the agent's own
// reply to an earlier message, composed while this one was in flight) can
// legitimately appear later in the transcript without being what the
// model should act on.
function formatThreadMessage(msg, isTrigger) {
  const headers = msg.payload.headers;
  let block;
  if (!isAllowedThreadParticipant(msg)) {
    // From/Subject/Date are all just as attacker-controlled and unbounded
    // as the body (e.g. a crafted Date header could itself carry an
    // instruction), so redact all of them rather than leaving any open.
    block =
      "From: [redacted -- sender not on the allowlist]\nDate: [redacted]\nSubject: [redacted]\n\n[content omitted -- sender is not on the allowlist]";
  } else {
    // Normalized like the body: header() returns the raw header value,
    // and Gmail unfolds header continuations onto separate lines without
    // guaranteeing those embedded line breaks are bare "\n" -- the same
    // "\r\n\r\n---\r\n\r\n"-style bypass the body normalization closes is
    // just as open here otherwise, through Subject/Date/From instead of
    // the body.
    const from = normalizeTranscriptText(header(headers, "From"));
    const date = normalizeTranscriptText(header(headers, "Date"));
    const subject = normalizeTranscriptText(header(headers, "Subject"));
    block = `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${extractPlainText(msg.payload)}`;
  }
  let final;
  if (!isTrigger) {
    final = neutralizeStructuralMarkers(block);
  } else {
    // A placeholder stands in for the real marker while sanitizing, rather
    // than appending the real marker afterward: appending after
    // sanitization would introduce a fresh, never-sanitized "\n\n"
    // boundary of its own -- a body ending in "\n\n---" would combine
    // with that boundary to form a genuine separator, invisible to a
    // sanitization pass that already ran before the marker existed. Only
    // substituted back to the real marker after sanitization is fully
    // done, and only for this message, the trigger.
    const placeholder = makePlaceholder();
    const withPlaceholder = `${block}\n\n${placeholder}`;
    final = neutralizeStructuralMarkers(withPlaceholder).split(placeholder).join(TRIGGER_MARKER);
  }
  return neutralizeDanglingSeparatorTail(final);
}

async function cmdGetThread(threadId, ...candidateIds) {
  const thread = await gmailFetch(`/threads/${threadId}?format=full`);
  if (!thread.messages || thread.messages.length === 0) {
    throw new Error(`Thread ${threadId} has no messages.`);
  }
  // The "newest message" reduce must be restricted to genuinely pending
  // candidates (ids list-new actually returned for this thread), not run
  // over every message in the thread -- otherwise the agent's own SENT
  // replies, or a message from someone off the allowlist who threads
  // themselves in, can outrank the real unprocessed message by
  // internalDate and get selected as the "trigger" instead. That message
  // then fails isAllowedSender, and the actually-pending message gets
  // labeled agent-processed and silently dropped without ever being
  // handled -- or worse, a non-allowlisted participant could suppress the
  // agent indefinitely just by always having the last word in the thread.
  const candidates = thread.messages.filter((m) => candidateIds.includes(m.id));
  if (candidates.length === 0) {
    throw new Error(`None of the given candidate ids were found in thread ${threadId}.`);
  }
  const msg = candidates.reduce((newest, m) =>
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

  // Full thread, not truncated at the trigger: an earlier version dropped
  // everything after the trigger chronologically to keep the transcript
  // "ending with the newest message," but that silently discarded real
  // context (typically the agent's own reply to an earlier message in the
  // thread) in exactly the race this was meant to handle. formatThreadMessage
  // marks the trigger explicitly instead, so the model doesn't need to
  // infer it from position at all.
  const transcript = thread.messages
    .map((m) => formatThreadMessage(m, m.id === msg.id))
    .join(MESSAGE_SEPARATOR);

  console.log(
    JSON.stringify({
      id: msg.id,
      threadId: thread.id,
      from,
      subject: header(headers, "Subject"),
      messageId: header(headers, "Message-ID"),
      references: header(headers, "References"),
      // Gmail's own receipt timestamp for the trigger message, not the
      // wall-clock time poll.mjs happened to notice it -- the two can
      // differ by up to POLL_INTERVAL_SECONDS.
      receivedAt: new Date(Number(msg.internalDate)).toISOString(),
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
  await recordSend();
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

// Guarded so this only runs when gmail.mjs is executed directly (its
// normal CLI use) and not when poll.mjs imports normalizeTranscriptText/
// neutralizeStructuralMarkers from it as a plain module -- unguarded,
// that import would also run this dispatch against poll.mjs's own argv,
// hit the default case, and exit(1) on poll.mjs's own startup.
// pathToFileURL normalizes argv[1] for comparison regardless of whether
// this file is invoked with a relative or absolute path. All current callers
// (poll.mjs and the claude-spawned run) use the absolute GMAIL_CLI_PATH, but
// the guard shouldn't depend on that -- it just compares the resolved URLs.
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
        console.error("Usage: gmail.mjs <list-new|get-thread|reply|send|label> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
