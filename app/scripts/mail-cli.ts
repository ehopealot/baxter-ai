#!/usr/bin/env node
import { reportSkip } from "./cli-flags.ts";
// The credential boundary for the Resend-backed mail surface (replaces mail.ts /
// AgentMail replacement; the migration
// design doc lives in the OUTER repo, not this one, at
// docs/superpowers/specs/2026-08-06-agentmail-to-resend-design.md). Mirrors
// The env-first-then-file credential, allowlist-gated send,
// moderation gate, daily send-cap counter, outbound transcript append).
//
// reply rides the Chat SDK's thread.post() (HTML/markdown rendering,
// operator's call over the raw-SDK path an earlier round used) -- but its
// adapter's ThreadResolver (subject/In-Reply-To/References history) is an
// IN-MEMORY Map, fresh on every CLI invocation (this file is spawned as a new
// subprocess per send), so it never has any history on its own. sendReply
// SEEDS the resolver from mail-transcript.ts's durable store immediately
// before posting -- see its own comment for exactly what it seeds and why.
//
// sendNew/send-calendar/get-attachment stay on the raw `resend` SDK.
// send-calendar/get-attachment have no Chat SDK route at all: postMessage()
// has no attachments parameter (see @resend/chat-sdk-adapter's adapter.d.ts)
// and no path for minting an inbound attachment's download URL. sendNew's is
// subtler and verified, not guessed -- see its own comment: the installed
// adapter's postMessage() unconditionally sends `storedSubject ? "Re:
// <subject>" : "New message"`, with no way to get a plain, un-prefixed,
// caller-chosen subject through thread.post() at all, so a brand-new email
// sent that way would carry a wrong "Re: " prefix forever.
//
// SECURITY INVARIANT (the point of this file): `from` is set exactly once --
// via createResendAdapter({fromAddress: OWN_EMAIL}) for reply (the Chat SDK
// path), or the hard-coded `${FROM_NAME} <${OWN_EMAIL}>` in sendNew's/
// send-calendar's raw-SDK calls -- never a CLI argument, so the model can
// never choose the sender. Every send verb re-validates its recipient against
// the shared allowlist (resolveRecipient) immediately before dispatch: send/
// send-calendar validate the `to` argument; reply recovers the correspondent
// from the thread index (mail-transcript.ts's threadEntry) and validates THAT
// -- the model-supplied threadId also encodes an address (Resend's own
// `resend:{toAddress}:{hash}` scheme), but it's the CORRESPONDENT's, and it
// must be cross-checked against the index rather than trusted alone (see
// sendReply). Then outbound moderation (gateOutbound) + the daily send cap
// (assertUnderSendCap), then the outbound transcript append -- AFTER a
// successful post (the Chat SDK adapter throws on a Resend send failure for
// reply, same as sendNew's/send-calendar's explicit {data,error} check, so a
// failed send never reaches the append either way).
//
// Subcommands:
//   send <to> <subject>                New message; body from stdin.
//   reply <threadId>                   Reply in-thread; body from stdin.
//   send-calendar <to> <subject> --ics <path>   New message with an .ics attachment; body from stdin.
//   get-attachment <emailId> <filename>         Mint a short-lived download URL for one inbound attachment.
//   skip [reason...]                      Intentional no-response; reason from positionals or stdin.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createResendAdapter } from "@resend/chat-sdk-adapter";
import { Chat } from "chat";
import { Resend } from "resend";
import { createMailState } from "./mail-state-sqlite.ts";
import { MAIL_KEYS_PATH, MAIL_STATE_DB_PATH, MAIL_SEND_STATE_PATH } from "./paths.ts";
import { appendMailTranscript, threadEntry, readMailTranscript } from "./mail-transcript.ts";
import type { MailTranscriptEntry, ThreadIndexEntry } from "./mail-transcript.ts";
import { loadAllowlist } from "./allowlist.ts";
import { moderate, outboundBlockNotice } from "./moderation.ts";
import { createCounter } from "./send-state.ts";
import { parseFlags } from "./cli-flags.ts";

const OWN_EMAIL = process.env.BAXTER_EMAIL || "";
const FROM_NAME = process.env.MAIL_FROM_NAME || "Baxter";

// -------------------------------------------------------------------------
// Credential (env-first-then-file, mirroring sms-cli.ts's
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

// Used by reply's CLI dispatch below (a fresh adapter/Chat instance per
// invocation -- the per-process sqlite open via createMailState is cheap and
// acceptable at this call volume) AND exported for the INBOUND side (mail-bot
// / task 9's webhook handler), which needs the same live Chat instance +
// adapter (handleWebhook/processMessage) for a longer-lived process.
export function buildMailAdapter() {
  if (!OWN_EMAIL) throw new Error("BAXTER_EMAIL is required to send mail");
  return createResendAdapter({ fromAddress: OWN_EMAIL, fromName: FROM_NAME, apiKey: resendApiKey(), webhookSecret: process.env.RESEND_WEBHOOK_SECRET });
}
export function buildChat(adapter = buildMailAdapter()) {
  const chat = new Chat({ adapters: { resend: adapter }, state: createMailState(MAIL_STATE_DB_PATH), userName: OWN_EMAIL });
  return { adapter, chat };
}

// -------------------------------------------------------------------------
// Outbound recipient allow-list. resolveRecipient/allowedRecipients don't live
// in allowlist.ts itself (that module owns only load/write of the shared
// allowlist.json) -- they're copied here from the deleted mail surface's resolveRecipient
// (which is NOT imported: the former AgentMail surface was deleted, and this Resend surface
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
// short-circuits to allowed when disabled. Copied from the former mail surface's local
// gateOutbound -- moderation.ts exports moderate/outboundBlockNotice, not a
// gateOutbound wrapper itself.
// -------------------------------------------------------------------------
async function gateOutbound(body: string): Promise<void> {
  const v = await moderate(body, "out", { env: process.env });
  if (!v.allowed) throw new Error(`message not sent -- ${outboundBlockNotice(v.reason)}`);
}

// -------------------------------------------------------------------------
// Daily send-cap counter. A DEDICATED counter for the Resend surface
// (MAIL_SEND_STATE_PATH/MAIL_MAX_SENDS_PER_DAY), separate from the former mail surface's
// SEND_STATE_PATH/MAX_SENDS_PER_DAY counter in send-state.ts (mirrors how the SMS
// surface gets its own createCounter call in sms-cli.ts). paths.ts already
// provisions MAIL_SEND_STATE_PATH for exactly this ("flat name to avoid basename
// collision with SEND_STATE_PATH").
// -------------------------------------------------------------------------
const counter = createCounter(MAIL_SEND_STATE_PATH, "MAIL_MAX_SENDS_PER_DAY", 500);

// -------------------------------------------------------------------------
// Shared send guards (recipient allowlist, moderation, send cap, transcript
// append), injectable for tests and defaulted to the real implementations.
// Each verb's own deps type adds whatever else IT needs (sendNew/sendReply:
// adapter+chat; sendCalendar/getAttachment: an injectable raw `resend`
// factory) below.
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

// The one bit of the installed @resend/chat-sdk-adapter@0.2.2 this file reaches
// past its public .d.ts surface for: `ResendAdapter.threadResolver` is a plain
// (not native-#private) class field -- `threadResolver = new ThreadResolver()`
// in adapter.js -- so it's reachable at runtime even though the .d.ts marks it
// `private` and the package's index.js barrel never exports the ThreadResolver
// type. Verified directly against node_modules (not guessed): `trackMessage`/
// `trackSubject` are real public methods on that object (thread-resolver.js),
// and `chat.thread(threadId)` resolves to a `ThreadImpl` whose `post()` calls
// `this.adapter.postMessage(this.id, ...)` on the SAME adapter instance we seed
// (chat/dist/index.js's `Thread.post`/`Chat.createThread`) -- so seeding
// `adapter.threadResolver` before `thread.post()` really does reach
// `postMessage`'s `getReplyHeaders`/`getSubject` reads. This is an internal
// implementation detail, not a stable contract -- if a future adapter version
// renames/removes it, these seeding calls need to move with it.
interface ThreadResolverLike {
  trackMessage(threadId: string, messageId: string): void;
  trackSubject(threadId: string, subject: string): void;
}
interface AdapterLike {
  decodeThreadId?(threadId: string): { toAddress: string };
  threadResolver: ThreadResolverLike;
}

// `adapter`/`chat` are typed loosely (external SDK boundary -- tsconfig's own
// note permits explicit `any` here) so both the real Chat SDK objects
// (buildChat()) and the tests' minimal fakes satisfy the interface; the
// adapter's shape used internally (AdapterLike, above) is asserted at the call
// site that actually touches threadResolver/decodeThreadId (sendReply, below).
export interface ReplyDeps extends GuardDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat: any;
  threadEntry?: (threadId: string) => ThreadIndexEntry | null;
  readMailTranscript?: (address: string) => MailTranscriptEntry[];
}

// sendNew's deps -- the shared guards plus an injectable raw `resend` factory.
// KEPT ON THE RAW SDK, unlike sendReply -- see sendNew's own comment for why
// (verified against the installed adapter: postMessage()'s subject formula
// makes the Chat SDK path unable to send a plain, un-prefixed subject).
export interface SendDeps extends GuardDeps {
  resend?: () => ResendSendLike;
}

// New (cold-start) outbound message. Recipient authorization happens FIRST
// (fail loud before touching moderation/the send cap/the network), against the
// CALLER-supplied `to` -- this is the one verb where that's the correct source
// of authority, since there's no existing thread to recover a correspondent from.
//
// Deliberately STAYS on the raw Resend SDK (unlike sendReply, below), even
// though the operator's design intent was to move both onto the Chat SDK for
// HTML/markdown rendering. Verified against the installed
// @resend/chat-sdk-adapter@0.2.2 (adapter.js's postMessage): the sent
// subject is UNCONDITIONALLY `storedSubject ? \`Re: ${storedSubject}\` :
// "New message"` -- there is no code path (not `trackSubject`, not `openDM`,
// not `chat.openDM`, which routes through the same `postMessage`) that sends a
// plain, un-prefixed, caller-chosen subject. Tracking a subject for a brand-new
// thread would send "Re: Dinner plans" instead of "Dinner plans" on every
// single cold-start email -- worse than the "New message" bug this whole
// migration already fixed once. sendReply's "Re: " prepend is CORRECT (an
// actual reply should say "Re: "); sendNew's would not be. No adapter API is
// missing here -- this is a design-level mismatch between the adapter's
// always-a-thread-reply subject model and email's "compose fresh" semantics,
// so raw-SDK send (exact caller subject, {data,error} checked explicitly) is
// the only way to get sendNew's subject right.
async function sendRaw(
  { to, subject, body, attachments }: { to: string; subject: string; body: string; attachments?: Array<{ filename: string; content: Buffer }> },
  g: ResolvedGuards,
  deps: SendDeps,
  errorLabel: string,
): Promise<void> {
  const resend = (deps.resend ?? (() => new Resend(resendApiKey())))();
  const res = await resend.emails.send({
    from: `${FROM_NAME} <${OWN_EMAIL}>`,
    to,
    subject,
    text: body,
    ...(attachments ? { attachments } : {}),
  });
  if (res.error || !res.data) throw new Error(`${errorLabel}: ${res.error?.message ?? "unknown error"}`);
  await g.append(to, { direction: "out", at: new Date().toISOString(), subject, content: body });
}

export async function sendNew(to: string, subject: string, body: string, deps: SendDeps): Promise<void> {
  if (!OWN_EMAIL) throw new Error("BAXTER_EMAIL is required to send mail");
  const g = resolveGuards(deps);
  const canonical = g.resolveRecipient(to);
  await g.gateOutbound(body);
  await g.assertUnderSendCap();
  await sendRaw({ to: canonical, subject, body }, g, deps, "failed to send");
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
// Sent via the Chat SDK's thread.post(), after SEEDING the adapter's
// in-memory ThreadResolver from mail-transcript.ts's durable store (a fresh
// CLI process has none of that resolver's history on its own -- see the file
// header): every inbound Message-ID recorded for this threadId, in order (so
// References carries the FULL chain, not just the latest -- getReplyHeaders()
// joins every tracked id, and uses the last one as In-Reply-To), plus the
// original subject. postMessage() unconditionally prepends "Re: " to whatever
// subject is tracked (verified against the installed adapter.js: `subject =
// storedSubject ? \`Re: ${storedSubject}\` : "New message"` -- NOT
// conditional on an existing "Re: "), so we track the ORIGINAL subject with any
// existing "Re: " stripped, not pre-prefixed -- tracking an already-prefixed
// subject would double it up ("Re: Re: ...").
//
// The correspondent, subject, and the inbound Message-ID chain are all read
// from ONE threadEntry() snapshot (correspondent/subject) + ONE
// readMailTranscript() read (the id chain) -- not several independent reads --
// so a concurrent inbound append (mail-bot ingest rewriting this thread) can't
// authorize against one index generation while sending headers built from
// another.
export async function sendReply(threadId: string, body: string, deps: ReplyDeps): Promise<void> {
  if (!OWN_EMAIL) throw new Error("BAXTER_EMAIL is required to send mail");
  const g = resolveGuards(deps);
  const getEntry = deps.threadEntry ?? threadEntry;
  const entry = getEntry(threadId);
  if (!entry) throw new Error(`unknown thread ${threadId}: cannot authorize reply recipient`);
  const correspondent = entry.from;
  const adapter = deps.adapter as AdapterLike;
  const embedded = adapter.decodeThreadId?.(threadId)?.toAddress ?? threadId.split(":")[1] ?? "";
  if (embedded.toLowerCase() !== correspondent.toLowerCase()) {
    throw new Error(`thread ${threadId} does not match its indexed correspondent ${correspondent}; refusing to send`);
  }
  g.resolveRecipient(correspondent); // throws if not (still) allowed
  await g.gateOutbound(body);
  await g.assertUnderSendCap();

  const getTranscript = deps.readMailTranscript ?? readMailTranscript;
  const inboundIds = getTranscript(correspondent)
    .filter((e) => e.direction === "in" && e.threadId === threadId && e.messageId)
    .map((e) => e.messageId as string);
  for (const id of inboundIds) adapter.threadResolver.trackMessage(threadId, id);
  const rawSubject = (entry.subject ?? "").trim();
  const trackedSubject = rawSubject ? rawSubject.replace(/^re:\s*/i, "") : undefined;
  if (trackedSubject) adapter.threadResolver.trackSubject(threadId, trackedSubject);
  // Mirrors postMessage()'s own subject formula exactly, so the transcript
  // records the subject that was actually sent.
  const subject = trackedSubject ? `Re: ${trackedSubject}` : "New message";

  const thread = await deps.chat.thread(threadId);
  await thread.post(body); // throws on a Resend send failure -- append below only runs after a successful post
  await g.append(correspondent, { direction: "out", at: new Date().toISOString(), subject, content: body });
}

// -------------------------------------------------------------------------
// send-calendar also needs an .ics attachment, which the Chat SDK's post()
// path can't carry at all (see @resend/chat-sdk-adapter's adapter.d.ts --
// postMessage has no attachments parameter) -- raw SDK only, like send/reply.
// `from` stays hard-set to OWN_EMAIL here too.
// -------------------------------------------------------------------------
export interface CalendarDeps extends SendDeps {}

export async function sendCalendar(to: string, subject: string, body: string, icsPath: string, deps: CalendarDeps): Promise<void> {
  if (!OWN_EMAIL) throw new Error("BAXTER_EMAIL is required to send mail");
  const g = resolveGuards(deps);
  const canonical = g.resolveRecipient(to);
  await g.gateOutbound(body);
  await g.assertUnderSendCap();
  const ics = readFileSync(icsPath);
  await sendRaw({ to: canonical, subject, body, attachments: [{ filename: "invite.ics", content: ics }] }, g, deps, "failed to send calendar invite");
}

// Real Resend attachment metadata (GetReceivingEmailResponseSuccess.attachments,
// verified against node_modules/resend/dist/index.d.mts) carries `id`, NOT a
// `url` -- unlike the former provider's attachment shape, there's no download link
// on the listing itself. Minting one is a SEPARATE call
// (emails.receiving.attachments.get({emailId, id}) -> download_url/expires_at),
// using the credential-holding get-attachment path (the credential-holding step: the API key
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
// Mint a short-lived signed download for one inbound attachment (the credential-holding
// step -- the API key mints the URL; the URL is then publicly fetchable without it).
// Returns the raw provider data ({ download_url, expires_at, ... }). Shared by the
// get-attachment CLI (model path) and mail-bot's multimodal media selection.
export async function mintAttachmentDownload(emailId: string, filename: string, deps: GetAttachmentDeps = {}): Promise<any> {
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
  return minted.data;
}

// The download URL out of a minted attachment payload, tolerating snake/camel/`url` shapes.
export function attachmentDownloadUrl(data: any): string {
  return String(data?.download_url || data?.downloadUrl || data?.url || "");
}

export async function getAttachment(emailId: string, filename: string, deps: GetAttachmentDeps = {}): Promise<string> {
  return JSON.stringify(await mintAttachmentDownload(emailId, filename, deps));
}

// -------------------------------------------------------------------------
// I/O layer: CLI dispatch. Guarded by the pathToFileURL check (mirrors
// sms-cli.ts) so importing the pure exports above doesn't trigger it.
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
        // Raw Resend SDK -- no Chat SDK involvement (see sendNew's comment for
        // why), so no buildChat()/buildMailAdapter() call here.
        await sendNew(to, subject ?? "", await readStdin(), {});
        console.log(JSON.stringify({ sent: true }));
        break;
      }
      case "reply": {
        const { positionals } = parseFlags(rest);
        const [threadId] = positionals;
        if (!threadId) throw new Error("usage: mail-cli.ts reply <threadId>");
        const { adapter, chat } = buildChat();
        await sendReply(threadId, await readStdin(), { adapter, chat });
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
      case "skip": {
        const { positionals } = parseFlags(rest);
        const stdinText = await readStdin();
        reportSkip("mail", positionals, stdinText);
        break;
      }
      default:
        console.error("Usage: mail-cli.ts <send|reply|send-calendar|get-attachment|skip> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
