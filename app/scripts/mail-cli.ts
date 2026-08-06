#!/usr/bin/env node
// The credential boundary for the Resend-backed mail surface (replaces mail.ts /
// AgentMail -- see mail.ts's header and docs/superpowers/specs/2026-08-06-*
// for the migration design). Mirrors mail.ts's shape (env-first-then-file
// credential, allowlist-gated send, moderation gate, daily send-cap counter,
// outbound transcript append) but rides the Vercel Chat SDK's Resend adapter
// for text (send/reply) and the raw `resend` SDK for attachments (send-calendar,
// get-attachment -- the Chat SDK's post() path is text/cards only).
//
// SECURITY INVARIANT (the point of this file): `from` is set exactly once, via
// createResendAdapter({ fromAddress: OWN_EMAIL }) / the raw-SDK send calls below
// -- never a CLI argument, so the model can never choose the sender. Every send
// verb re-validates its recipient against the shared allowlist (resolveRecipient)
// immediately before dispatch: send/send-calendar validate the `to` argument;
// reply recovers the correspondent from the thread index (correspondentForThread,
// mail-transcript.ts) and validates THAT, since the model-supplied threadId
// encodes OUR address, not the correspondent's, and must not be a hole around
// the allowlist. Then outbound moderation (gateOutbound) + the daily send cap
// (assertUnderSendCap), then the outbound transcript append.
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
import { appendMailTranscript, correspondentForThread } from "./mail-transcript.ts";
import type { MailTranscriptEntry } from "./mail-transcript.ts";
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
// Send/reply cores. `adapter`/`chat` are typed loosely (external SDK boundary --
// tsconfig's own note permits explicit `any` here) so both the real Chat SDK
// objects (buildChat()) and the tests' minimal fakes satisfy the interface.
// -------------------------------------------------------------------------
export interface SendDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat: any;
  resolveRecipient?: (to: string) => string;
  correspondentForThread?: (threadId: string) => string | null;
  gateOutbound?: (body: string) => Promise<void>;
  assertUnderSendCap?: () => Promise<void>;
  append?: (to: string, entry: MailTranscriptEntry) => Promise<void>;
}

interface ResolvedDeps extends Required<Omit<SendDeps, "adapter" | "chat">> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat: any;
}

function defaults(d: SendDeps): ResolvedDeps {
  return {
    adapter: d.adapter,
    chat: d.chat,
    resolveRecipient: d.resolveRecipient ?? ((to: string) => resolveRecipientReal(process.env, to)),
    correspondentForThread: d.correspondentForThread ?? correspondentForThread,
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

// New (cold-start) outbound message. Recipient authorization happens FIRST
// (fail loud before touching moderation/the send cap/the network), against the
// CALLER-supplied `to` -- this is the one verb where that's the correct source
// of authority, since there's no existing thread to recover a correspondent from.
export async function sendNew(to: string, subject: string, body: string, deps: SendDeps): Promise<void> {
  const d = defaults(deps);
  const canonical = d.resolveRecipient(to); // throws if not allowed
  await d.gateOutbound(body);
  await d.assertUnderSendCap();
  const threadId = await d.adapter.openDM(canonical);
  const thread = await d.chat.thread(threadId); // chat.thread() infers the adapter from the threadId's "resend:" prefix -- one arg, not (adapterName, threadId)
  await thread.post(body); // `from` is whatever buildMailAdapter() locked in (OWN_EMAIL) -- never a param here
  await d.append(canonical, { direction: "out", at: new Date().toISOString(), subject, content: body });
}

// Reply on an existing thread. threadId is MODEL-supplied (a tool-call argument)
// and encodes OUR address, not the correspondent's (see mail-transcript.ts's
// header) -- so it must NOT be trusted as an authorization token by itself. We
// recover the correspondent from the thread index and re-validate THAT against
// the allowlist, exactly like sendNew does for its `to` argument. This is the
// task-5 invariant: a reply verb must not be a hole around resolveRecipient,
// even though the correspondent was already allowlist-checked once at inbound
// ingest (defense in depth -- the allowlist can change between then and now).
export async function sendReply(threadId: string, body: string, deps: SendDeps): Promise<void> {
  const d = defaults(deps);
  const correspondent = d.correspondentForThread(threadId);
  if (!correspondent) throw new Error(`unknown thread ${threadId}: cannot authorize reply recipient`);
  d.resolveRecipient(correspondent); // throws if not (still) allowed
  await d.gateOutbound(body);
  await d.assertUnderSendCap();
  const thread = await d.chat.thread(threadId);
  await thread.post(body);
  await d.append(correspondent, { direction: "out", at: new Date().toISOString(), subject: "", content: body });
}

// -------------------------------------------------------------------------
// Attachments go AROUND the Chat SDK: postMessage()/thread.post() only render
// text/markdown/cards, and Resend's own .ics/inbound-attachment surfaces are
// raw-SDK-only (see @resend/chat-sdk-adapter's adapter.d.ts -- postMessage has
// no attachments parameter). `from` stays hard-set to OWN_EMAIL here too.
// -------------------------------------------------------------------------
export interface ResendSendLike {
  emails: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(payload: Record<string, unknown>): Promise<any>;
  };
}
export interface CalendarDeps extends SendDeps {
  resend?: () => ResendSendLike;
}

export async function sendCalendar(to: string, subject: string, body: string, icsPath: string, deps: CalendarDeps): Promise<void> {
  const d = defaults(deps);
  const canonical = d.resolveRecipient(to); // throws if not allowed
  await d.gateOutbound(body);
  await d.assertUnderSendCap();
  const resend = (deps.resend ?? (() => new Resend(resendApiKey())))();
  const ics = readFileSync(icsPath);
  await resend.emails.send({
    from: `${FROM_NAME} <${OWN_EMAIL}>`, // hard-set -- never a CLI/model argument
    to: canonical,
    subject,
    text: body,
    attachments: [{ filename: "invite.ics", content: ics }],
  });
  await d.append(canonical, { direction: "out", at: new Date().toISOString(), subject, content: body });
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
  const attachments: Array<{ id: string; filename?: string | null }> = email.data?.attachments ?? [];
  const att = attachments.find((a) => a.filename === filename);
  if (!att) throw new Error(`no attachment named ${filename} on ${emailId}`);
  const minted = await resend.emails.receiving.attachments.get({ emailId, id: att.id });
  return JSON.stringify(minted.data ?? minted);
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
        const { adapter, chat } = buildChat();
        await sendNew(to, subject ?? "", await readStdin(), { adapter, chat });
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
        const { adapter, chat } = buildChat();
        await sendCalendar(to, subject ?? "", await readStdin(), ics, { adapter, chat });
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
