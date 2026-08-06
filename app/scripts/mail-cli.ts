#!/usr/bin/env node
// The credential boundary for the Resend-backed mail surface (replaces mail.ts /
// AgentMail -- see mail.ts's header for the shape this mirrors; the migration
// design doc lives in the OUTER repo, not this one, at
// docs/superpowers/specs/2026-08-06-agentmail-to-resend-design.md). Mirrors
// mail.ts's shape (env-first-then-file credential, allowlist-gated send,
// moderation gate, daily send-cap counter, outbound transcript append) but
// every outbound verb here (send/reply/send-calendar/get-attachment) rides the
// raw `resend` SDK directly, NOT the Chat SDK's post() path: post() only
// renders text/markdown/cards (no custom subject/headers/attachments), and its
// adapter's ThreadResolver (subject/In-Reply-To history) is an IN-MEMORY Map,
// fresh on every CLI invocation (this file is spawned as a new subprocess per
// send) -- so it can never carry the real subject or threading headers across
// calls. `buildMailAdapter`/`buildChat` (the Chat SDK wiring) stay exported
// even though no verb in this file uses them anymore: they're for the INBOUND
// side (mail-bot, task 9), which does live long enough for the Chat SDK's
// webhook/ThreadResolver machinery to matter.
//
// SECURITY INVARIANT (the point of this file): `from` is set exactly once, via
// the hard-coded `${FROM_NAME} <${OWN_EMAIL}>` in every raw-SDK send call below
// -- never a CLI argument, so the model can never choose the sender. Every send
// verb re-validates its recipient against the shared allowlist (resolveRecipient)
// immediately before dispatch: send/send-calendar validate the `to` argument;
// reply recovers the correspondent from the thread index (mail-transcript.ts's
// threadEntry) and validates THAT -- the model-supplied threadId also encodes
// an address (Resend's own `resend:{toAddress}:{hash}` scheme), but it's the
// CORRESPONDENT's, and it must be cross-checked against the index rather than
// trusted alone (see sendReply). Then outbound moderation (gateOutbound) +
// the daily send cap (assertUnderSendCap), then the outbound transcript append.
//
// Subcommands:
//   send <to> <subject>                New message; body from stdin.
//   reply <threadId>                   Reply in-thread; body from stdin.
//   send-calendar <to> <subject> --ics <path>   New message with an .ics attachment; body from stdin.
//   get-attachment <emailId> <filename>         Mint a short-lived download URL for one inbound attachment.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createResendAdapter } from "@resend/chat-sdk-adapter";
import { Chat } from "chat";
import { Resend } from "resend";
import { createMailState } from "./mail-state-sqlite.ts";
import { MAIL_KEYS_PATH, MAIL_STATE_DB_PATH, MAIL_SEND_STATE_PATH } from "./paths.ts";
import { appendMailTranscript, threadEntry } from "./mail-transcript.ts";
import type { MailTranscriptEntry, ThreadIndexEntry } from "./mail-transcript.ts";
import { loadAllowlist } from "./allowlist.ts";
import { moderate, outboundBlockNotice } from "./moderation.ts";
import { createCounter } from "./send-state.ts";
import { parseFlags } from "./cli-flags.ts";

const OWN_EMAIL = process.env.BAXTER_EMAIL || "";
const FROM_NAME = process.env.MAIL_FROM_NAME || "Baxter";

// -------------------------------------------------------------------------
// Credential (env-first-then-file, mirroring mail.ts's loadApiKey / sms-cli.ts's
// creds()). The spawned run's env has RESEND_API_KEY stripped (runtime.ts's
// stripRunSecrets), so a run reaches Resend only through this file-backed CLI.
// -------------------------------------------------------------------------
function resendApiKey(): string {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  try {
    const key = JSON.parse(readFileSync(MAIL_KEYS_PATH, "utf8")).apiKey;
    if (key) return key;
  } catch {
    /* fall through to the error below */
  }
  throw new Error("RESEND_API_KEY is not set (no env var and no key file)");
}

// Exported for the INBOUND side (mail-bot / task 9's webhook handler), which
// needs a live Chat instance + adapter (handleWebhook/processMessage) for the
// surfaces this file's own outbound verbs don't touch anymore -- see the file
// header. `reply`'s CLI branch still uses buildMailAdapter() alone (for its
// decodeThreadId cross-check), but nothing here calls buildChat().
export function buildMailAdapter() {
  if (!OWN_EMAIL) throw new Error("BAXTER_EMAIL is required to send mail");
  return createResendAdapter({ fromAddress: OWN_EMAIL, fromName: FROM_NAME, apiKey: resendApiKey() });
}
export function buildChat(adapter = buildMailAdapter()) {
  const chat = new Chat({ adapters: { resend: adapter }, state: createMailState(MAIL_STATE_DB_PATH), userName: OWN_EMAIL });
  return { adapter, chat };
}

// -------------------------------------------------------------------------
// Outbound recipient allow-list. resolveRecipient/allowedRecipients don't live
// in allowlist.ts itself (that module owns only load/write of the shared
// allowlist.json) -- they're copied here from mail.ts's own resolveRecipient
// (which is NOT imported: mail.ts is deleted in Task 10, and this Resend surface
// must not depend on the file it's replacing). Logic is unchanged: the shared
// allowlist.json recipients (file -> ALLOWED_RECIPIENTS env seed -> [] fail-
// closed) UNION OPERATOR_EMAIL (the operator is always reachable). Empty list +
// no operator => nobody reachable (fail closed).
// -------------------------------------------------------------------------
function allowedRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = loadAllowlist(env).recipients.slice(); // fresh each call, no write
  const op = (env.OPERATOR_EMAIL || "").trim();
  if (op && !list.some((a) => a.toLowerCase() === op.toLowerCase())) list.push(op);
  return list;
}

// Authorize a recipient against allowedRecipients. Returns the canonical
// spelling (not the caller's casing). Throws if not allowed -- the CALLER
// (sendNew/sendReply below) is responsible for calling this BEFORE any network
// call/send-cap increment, on every verb, with no exceptions.
function resolveRecipientReal(env: NodeJS.ProcessEnv, to: string): string {
  const requested = (to || "").trim();
  if (!requested) throw new Error("a recipient address is required");
  const allowed = allowedRecipients(env);
  if (allowed.length === 0) throw new Error("No recipients are configured; set the allow-list (allowlist.json / ALLOWED_RECIPIENTS or OPERATOR_EMAIL). Refusing to send.");
  const match = allowed.find((a) => a.toLowerCase() === requested.toLowerCase());
  if (!match) throw new Error(`Recipient ${requested} is not on the allow-list (allowlist.json / ALLOWED_RECIPIENTS ∪ OPERATOR_EMAIL); refusing to send.`);
  return match;
}

// -------------------------------------------------------------------------
// Outbound content moderation (opt-in, MODERATION_ENABLED). moderate() self-
// short-circuits to allowed when disabled. Copied from mail.ts's local
// gateOutbound -- moderation.ts exports moderate/outboundBlockNotice, not a
// gateOutbound wrapper itself.
// -------------------------------------------------------------------------
async function gateOutbound(body: string): Promise<void> {
  const v = await moderate(body, "out", { env: process.env });
  if (!v.allowed) throw new Error(`message not sent -- ${outboundBlockNotice(v.reason)}`);
}

// -------------------------------------------------------------------------
// Daily send-cap counter. A DEDICATED counter for the Resend surface
// (MAIL_SEND_STATE_PATH/MAIL_MAX_SENDS_PER_DAY), separate from the AgentMail-era
// SEND_STATE_PATH/MAX_SENDS_PER_DAY counter in send-state.ts (mirrors how the SMS
// surface gets its own createCounter call in sms-cli.ts). paths.ts already
// provisions MAIL_SEND_STATE_PATH for exactly this ("flat name to avoid basename
// collision with SEND_STATE_PATH").
// -------------------------------------------------------------------------
const counter = createCounter(MAIL_SEND_STATE_PATH, "MAIL_MAX_SENDS_PER_DAY", 500);

// -------------------------------------------------------------------------
// Shared send guards (recipient allowlist, moderation, send cap, transcript
// append), injectable for tests and defaulted to the real implementations.
// All three send verbs go through the raw Resend SDK now (see the file
// header), so none of them carry Chat SDK state -- just an optional `resend`
// factory (defined per-verb below, since sendReply/sendCalendar need slightly
// different extras: sendReply's adapter/threadEntry, sendCalendar's none).
// -------------------------------------------------------------------------
interface GuardDeps {
  resolveRecipient?: (to: string) => string;
  gateOutbound?: (body: string) => Promise<void>;
  assertUnderSendCap?: () => Promise<void>;
  append?: (to: string, entry: MailTranscriptEntry) => Promise<void>;
}
type ResolvedGuards = Required<GuardDeps>;

function resolveGuards(d: GuardDeps): ResolvedGuards {
  return {
    resolveRecipient: d.resolveRecipient ?? ((to: string) => resolveRecipientReal(process.env, to)),
    gateOutbound: d.gateOutbound ?? gateOutbound,
    assertUnderSendCap:
      d.assertUnderSendCap ??
      (async () => {
        if (counter.load().count >= counter.MAX) throw new Error(`daily send cap (${counter.MAX}) reached; refusing to send.`);
        await counter.record(); // count before the network call -- over-counting a flood guard is the safe direction
      }),
    append: d.append ?? ((to: string, entry: MailTranscriptEntry) => appendMailTranscript(to, entry)),
  };
}

export interface ResendSendLike {
  emails: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(payload: Record<string, unknown>): Promise<any>;
  };
}

// sendNew's deps -- just the shared guards plus an injectable `resend` factory
// (real Resend SDK by default).
export interface SendDeps extends GuardDeps {
  resend?: () => ResendSendLike;
}

// sendReply needs, in addition: optionally the adapter's decodeThreadId (for
// the embedded-address cross-check; falls back to parsing the threadId string
// itself when absent, e.g. in tests), and an injectable single-snapshot
// `threadEntry` lookup (real mail-transcript.ts implementation by default).
export interface ReplyDeps extends GuardDeps {
  adapter?: { decodeThreadId?: (threadId: string) => { toAddress: string } };
  resend?: () => ResendSendLike;
  threadEntry?: (threadId: string) => ThreadIndexEntry | null;
}

// New (cold-start) outbound message. Recipient authorization happens FIRST
// (fail loud before touching moderation/the send cap/the network), against the
// CALLER-supplied `to` -- this is the one verb where that's the correct source
// of authority, since there's no existing thread to recover a correspondent from.
// Sent via the raw Resend SDK (see the file header) with a fresh thread -- no
// In-Reply-To/References, since there's nothing to reply to yet.
export async function sendNew(to: string, subject: string, body: string, deps: SendDeps): Promise<void> {
  if (!OWN_EMAIL) throw new Error("BAXTER_EMAIL is required to send mail");
  const g = resolveGuards(deps);
  const canonical = g.resolveRecipient(to); // throws if not allowed
  await g.gateOutbound(body);
  await g.assertUnderSendCap();
  const resend = (deps.resend ?? (() => new Resend(resendApiKey())))();
  const res = await resend.emails.send({
    from: `${FROM_NAME} <${OWN_EMAIL}>`, // hard-set -- never a CLI/model argument
    to: canonical,
    subject,
    text: body,
  });
  if (res.error || !res.data) throw new Error(`failed to send: ${res.error?.message ?? "unknown error"}`);
  await g.append(canonical, { direction: "out", at: new Date().toISOString(), subject, content: body });
}

// Reply on an existing thread. threadId is MODEL-supplied (a tool-call
// argument). It DOES encode an address -- Resend's own `resend:{toAddress}:
// {hash}` scheme (@resend/chat-sdk-adapter's ThreadResolver.encodeThreadId/
// decodeThreadId) -- but that's the CORRESPONDENT's address, not ours, and it
// must not be trusted by itself: the thread index (mail-transcript.ts,
// keyed by threadId) is what actually gets consulted for authorization, and if
// its recorded `from` ever diverges from the address embedded in threadId --
// e.g. a spoofed In-Reply-To/References that makes Resend's own thread-
// matching fold a NEW inbound from a DIFFERENT sender into an EXISTING thread,
// silently overwriting the index's `from` while the threadId string (and what
// the Chat SDK adapter would actually dispatch to, via decodeThreadId) still
// carries the original address -- that's a check-one-thing/dispatch-to-another
// hole. Refuse outright on any mismatch rather than picking a side.
//
// Sent via the RAW Resend SDK, not the Chat SDK's thread.post(): the adapter's
// ThreadResolver (subject history, In-Reply-To chaining) lives in an in-memory
// Map, so a fresh CLI process -- every invocation -- has none of it, and
// thread.post() would silently send subject "New message" with no threading
// headers on every single reply. mail-transcript.ts's thread index (populated
// at inbound ingest, durable across processes) is the real source for the
// original subject + last inbound Message-ID.
//
// The correspondent, subject, and last-inbound-Message-ID are all read from
// ONE threadEntry() snapshot, not three separate getter calls -- a concurrent
// inbound append (mail-bot ingest rewriting this thread's entry) between
// separate reads could otherwise authorize against one index generation while
// sending headers built from another.
export async function sendReply(threadId: string, body: string, deps: ReplyDeps): Promise<void> {
  if (!OWN_EMAIL) throw new Error("BAXTER_EMAIL is required to send mail");
  const g = resolveGuards(deps);
  const getEntry = deps.threadEntry ?? threadEntry;
  const entry = getEntry(threadId);
  if (!entry) throw new Error(`unknown thread ${threadId}: cannot authorize reply recipient`);
  const correspondent = entry.from;
  const embedded = deps.adapter?.decodeThreadId?.(threadId)?.toAddress ?? threadId.split(":")[1] ?? "";
  if (embedded.toLowerCase() !== correspondent.toLowerCase()) {
    throw new Error(`thread ${threadId} does not match its indexed correspondent ${correspondent}; refusing to send`);
  }
  g.resolveRecipient(correspondent); // throws if not (still) allowed
  await g.gateOutbound(body);
  await g.assertUnderSendCap();

  const resend = (deps.resend ?? (() => new Resend(resendApiKey())))();
  const storedSubject = entry.subject;
  const subject = storedSubject ? (/^re:/i.test(storedSubject.trim()) ? storedSubject : `Re: ${storedSubject}`) : "Re:";
  const inReplyTo = entry.messageId;
  const res = await resend.emails.send({
    from: `${FROM_NAME} <${OWN_EMAIL}>`, // hard-set -- never a CLI/model argument
    to: correspondent,
    subject,
    text: body,
    ...(inReplyTo ? { headers: { "In-Reply-To": inReplyTo, References: inReplyTo } } : {}),
  });
  if (res.error || !res.data) throw new Error(`failed to send reply: ${res.error?.message ?? "unknown error"}`);
  await g.append(correspondent, { direction: "out", at: new Date().toISOString(), subject, content: body });
}

// -------------------------------------------------------------------------
// send-calendar also needs an .ics attachment, which the Chat SDK's post()
// path can't carry at all (see @resend/chat-sdk-adapter's adapter.d.ts --
// postMessage has no attachments parameter) -- raw SDK only, like send/reply.
// `from` stays hard-set to OWN_EMAIL here too.
// -------------------------------------------------------------------------
export interface CalendarDeps extends GuardDeps {
  resend?: () => ResendSendLike;
}

export async function sendCalendar(to: string, subject: string, body: string, icsPath: string, deps: CalendarDeps): Promise<void> {
  if (!OWN_EMAIL) throw new Error("BAXTER_EMAIL is required to send mail");
  const g = resolveGuards(deps);
  const canonical = g.resolveRecipient(to); // throws if not allowed
  await g.gateOutbound(body);
  await g.assertUnderSendCap();
  const resend = (deps.resend ?? (() => new Resend(resendApiKey())))();
  const ics = readFileSync(icsPath);
  const res = await resend.emails.send({
    from: `${FROM_NAME} <${OWN_EMAIL}>`, // hard-set -- never a CLI/model argument
    to: canonical,
    subject,
    text: body,
    attachments: [{ filename: "invite.ics", content: ics }],
  });
  // The Resend SDK never throws on a send failure -- it returns {data:null,
  // error:{...}} (see resend/dist/index.d.mts's Response<T> union). Without
  // this check a failed send would still append the transcript and report
  // success.
  if (res.error || !res.data) throw new Error(`failed to send calendar invite: ${res.error?.message ?? "unknown error"}`);
  await g.append(canonical, { direction: "out", at: new Date().toISOString(), subject, content: body });
}

// Real Resend attachment metadata (GetReceivingEmailResponseSuccess.attachments,
// verified against node_modules/resend/dist/index.d.mts) carries `id`, NOT a
// `url` -- unlike the AgentMail SDK's attachment shape, there's no download link
// on the listing itself. Minting one is a SEPARATE call
// (emails.receiving.attachments.get({emailId, id}) -> download_url/expires_at),
// mirroring mail.ts's cmdGetAttachment (the credential-holding step: the API key
// is needed to mint the URL, the URL itself is then publicly fetchable so the
// run's runner can fetch it without the key).
export interface ReceivingLike {
  emails: {
    receiving: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(id: string): Promise<any>;
      attachments: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get(opts: { emailId: string; id: string }): Promise<any>;
      };
    };
  };
}
export interface GetAttachmentDeps {
  resend?: () => ReceivingLike;
}
export async function getAttachment(emailId: string, filename: string, deps: GetAttachmentDeps = {}): Promise<string> {
  const resend = (deps.resend ?? (() => new Resend(resendApiKey())))();
  const email = await resend.emails.receiving.get(emailId);
  // Same {data,error} envelope as sendCalendar's resend.emails.send -- the SDK
  // never throws on a failed/not-found lookup.
  if (email.error || !email.data) throw new Error(`failed to fetch ${emailId}: ${email.error?.message ?? "unknown error"}`);
  const attachments: Array<{ id: string; filename?: string | null }> = email.data.attachments ?? [];
  const att = attachments.find((a) => a.filename === filename);
  if (!att) throw new Error(`no attachment named ${filename} on ${emailId}`);
  const minted = await resend.emails.receiving.attachments.get({ emailId, id: att.id });
  if (minted.error || !minted.data) throw new Error(`failed to mint download URL for ${att.id}: ${minted.error?.message ?? "unknown error"}`);
  return JSON.stringify(minted.data);
}

// -------------------------------------------------------------------------
// I/O layer: CLI dispatch. Guarded by the pathToFileURL check (mirrors
// mail.ts/sms-cli.ts) so importing the pure exports above doesn't trigger it.
// -------------------------------------------------------------------------
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case "send": {
        const { positionals } = parseFlags(rest);
        const [to, subject] = positionals;
        if (!to) throw new Error("usage: mail-cli.ts send <to> <subject>");
        // Sent via the raw Resend SDK -- no Chat SDK involvement, so no
        // buildChat()/buildMailAdapter() call here either.
        await sendNew(to, subject ?? "", await readStdin(), {});
        console.log(JSON.stringify({ sent: true }));
        break;
      }
      case "reply": {
        const { positionals } = parseFlags(rest);
        const [threadId] = positionals;
        if (!threadId) throw new Error("usage: mail-cli.ts reply <threadId>");
        // Sent via the raw Resend SDK (see sendReply's comment) -- only the
        // adapter is needed (for the embedded-address cross-check), not a live
        // Chat instance, so no buildChat()/sqlite state DB open here.
        const adapter = buildMailAdapter();
        await sendReply(threadId, await readStdin(), { adapter });
        console.log(JSON.stringify({ sent: true }));
        break;
      }
      case "send-calendar": {
        const { flags, positionals } = parseFlags(rest);
        const [to, subject] = positionals;
        const ics = flags.ics;
        if (!to || typeof ics !== "string") throw new Error("usage: mail-cli.ts send-calendar <to> <subject> --ics <path>");
        // Sent via the raw Resend SDK -- no Chat SDK involvement at all, so no
        // buildChat()/buildMailAdapter() call here either.
        await sendCalendar(to, subject ?? "", await readStdin(), ics, {});
        console.log(JSON.stringify({ sent: true }));
        break;
      }
      case "get-attachment": {
        const { positionals } = parseFlags(rest);
        const [emailId, filename] = positionals;
        if (!emailId || !filename) throw new Error("usage: mail-cli.ts get-attachment <emailId> <filename>");
        console.log(await getAttachment(emailId, filename));
        break;
      }
      default:
        console.error("Usage: mail-cli.ts <send|reply|send-calendar|get-attachment> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
