#!/usr/bin/env node
// Resend-backed mail surface daemon. Holds one SigV4-signed /mail-link socket,
// reconstructs the byte-exact Resend webhook request, and lets the Chat SDK
// resolve inbound messages/threads before dispatching a scoped agent run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import { Chat } from "chat";
import { HomeLink, type WebSocketLike } from "./home-link.ts";
import { ChannelDispatcher } from "./dispatcher.ts";
import type { LightLifecycle } from "./light-lifecycle.ts";
import { buildChat, dispatchInboundMail, mintAttachmentDownload, mintAttachmentById, attachmentDownloadUrl, replayPreparedMailDelivery as reconcileMailDelivery } from "./mail-cli.ts";
import { isModelFetchableUrl, type MediaItem } from "./harnesses/runner-common.ts";
import { appendMailTranscript } from "./mail-transcript.ts";
import { deadLetter as recordDeadLetter } from "./dead-letter.ts";
import { moderate } from "./moderation.ts";
import { extractEmailAddress, canonicalMail, cleanForPrompt, cleanForPromptLine } from "./transcript.ts";
import { recordSignal } from "./signal-store.ts";
import { runAgent, ensureSkills, ensurePlaywrightConfig, logErr, flushLogs, loggerFor } from "./runtime.ts";
import { collectionsPreamble } from "./collections-cli.ts";
import { householdPreamble } from "./household.ts";
import { admitEmail, loadAllowlist, nameForAddress } from "./allowlist.ts";
import { householdTz } from "./household-tz.ts";
import { resolveRecipients } from "./recipients.ts";
import { canonicalMorningOccurrence, decideInboundIdentity, handoffPromptBlock, makeMorningClaim, retainEarliestClaim, type MorningHandoffClaim } from "./morning-handoff.ts";
import { directConsume } from "./morning-handoff-store.ts";
import { morningCheckInDefinition, prepareMorningHandoff } from "./morning-check-in.ts";
import { readTasksForMorningHandoff } from "./schedule-store.ts";
import { loadHomeKeys, type HomeKeys } from "./home-mirror.ts";
import { introDecision, introNote, markExplained, markFeaturesIntroduced, type IntroDecision } from "./intro-state.ts";
import { concludeDiscovery, discoveryDecision, discoveryNote, type DiscoveryDecision } from "./feature-discovery.ts";
import { RunObserver } from "./run-observer.ts";
import { MAIL_KEYS_PATH, MAIL_LINK_STATE_PATH, MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR, QUEUE_ADMISSION_OUTBOX_PATH } from "./paths.ts";
import { MAIL_CLI, MAIL_TOOLS, MAIL_SKILL_SRCS } from "./grants.ts";
import { QueueAdmissionOutbox, admissionWorkId, type AgentDispatchRecord, type AgentRetryReason } from "./queue-admission-outbox.ts";
import { mailProviderReceiptsForWork, readMailDeliveryReceipt } from "./mail-delivery-receipts.ts";
import { loadDurableCursor, storeDurableCursor } from "./durable-cursor.ts";
import { mailSourceDeadLetterRecord, replayQueueBeforeAgents } from "./queue-non-agent-replay.ts";
import { noReplyOutcomeForWork, requireNoReplyOutcome } from "./runner-resolution-receipts.ts";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const MAIL_RUNS_DIR = join(APP_DIR, ".claude", "mail-runs");
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");
const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter";

export interface MailPayload {
  kind: "mail";
  id: number;
  raw: string;
  svixHeaders: Record<string, string>;
  at: string;
}

export function isMailPayload(p: unknown): p is MailPayload {
  const o = p as any;
  return !!o && typeof o === "object" && o.kind === "mail"
    && Number.isSafeInteger(o.id) && o.id >= 0 && typeof o.raw === "string"
    && !!o.svixHeaders && typeof o.svixHeaders === "object" && !Array.isArray(o.svixHeaders)
    && typeof o.at === "string";
}

export function signedMailLinkConnect(
  keys: HomeKeys,
  makeSocket: (url: string, headers: Record<string, string>) => WebSocketLike =
    (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike,
): () => Promise<WebSocketLike> {
  const aws = new AwsClient({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: "auto", service: "home" });
  const linkUrl = `${keys.endpoint.replace(/\/+$/, "")}/mail-link`;
  const wssUrl = linkUrl.replace(/^http/, "ws");
  return async () => {
    const signed = await aws.sign(linkUrl, { method: "GET" });
    return makeSocket(wssUrl, {
      authorization: signed.headers.get("authorization") ?? "",
      "x-amz-date": signed.headers.get("x-amz-date") ?? "",
    });
  };
}

export function loadCursor(path = MAIL_LINK_STATE_PATH): number { return loadDurableCursor(path); }
export function storeCursor(n: number, path = MAIL_LINK_STATE_PATH): void { storeDurableCursor(path, n); }

export interface InboundDeps {
  cursorLoad: () => number;
  cursorStore: (n: number) => void;
  sendAck: (appliedThrough: number) => void;
  handleWebhook: (request: Request, payload: MailPayload) => Promise<void>;
  deadLetter: (payload: MailPayload, err: unknown) => void;
  logErr: (message: string) => void;
  /** Only explicitly permanent failures may consume the queue item through the DLQ. */
  isPermanentFailure?: (error: unknown) => boolean;
}

/** Admit the exact mail source-DLQ append input before publishing it. */
export function persistMailSourceDeadLetter(
  admissions: QueueAdmissionOutbox,
  tenantId: string,
  payload: MailPayload,
  error: unknown,
  append: typeof recordDeadLetter = recordDeadLetter,
  now: () => Date = () => new Date(),
): void {
  const workId = admissionWorkId("mail", payload.id, tenantId);
  let record = admissions.records().find(candidate => candidate.workId === workId);
  if (!record) {
    // The round trip rejects/normalizes anything that could change when the
    // outbox itself serializes it, and detaches headers from the live payload.
    const outcome = JSON.parse(JSON.stringify({
      id: payload.id,
      workId,
      at: payload.at,
      error: String((error as Error)?.stack ?? error),
      payload: {
        kind: payload.kind,
        id: payload.id,
        raw: payload.raw,
        svixHeaders: { ...payload.svixHeaders },
        at: payload.at,
      },
    })) as Record<string, unknown>;
    record = admissions.admit({
      tenantId, queue: "mail", sequence: payload.id, workId, admittedAt: payload.at,
      variant: "non-agent-terminal", outcomeType: "mail-source-dead-letter", outcomeVersion: 2,
      outcome, idempotencyKey: `mail-source-dlq:${workId}`, state: "pending-side-effects",
    });
  }
  if (record.variant !== "non-agent-terminal" || record.queue !== "mail"
    || record.outcomeType !== "mail-source-dead-letter") {
    throw new Error("mail source DLQ conflicts with existing admission");
  }
  if (record.state === "terminal") return;
  append("mail", mailSourceDeadLetterRecord(record));
  const recordedAt = now().toISOString();
  admissions.completeNonAgent(workId, { kind: "source-dead-letter", surface: "mail", recordedAt }, recordedAt);
}

export async function handleInbound(payload: MailPayload, deps: InboundDeps): Promise<void> {
  const cursor = deps.cursorLoad();
  if (payload.id <= cursor) { deps.sendAck(cursor); return; }
  try {
    const request = new Request("https://mail.local/mail/inbound", {
      method: "POST",
      body: payload.raw,
      headers: payload.svixHeaders,
    });
    await deps.handleWebhook(request, payload);
  } catch (err) {
    const permanent = deps.isPermanentFailure?.(err) ?? (err as { permanent?: unknown })?.permanent === true;
    if (!permanent) throw err;
    // deadLetter is synchronous and fsync-backed. If it throws, the cursor/ACK
    // below remain unreachable and the link drain forces provider redelivery.
    deps.deadLetter(payload, err);
    deps.logErr(`mail handleInbound: dead-lettered inbound ${payload.id} (${(err as Error)?.message ?? err})`);
  }
  deps.cursorStore(payload.id);
  deps.sendAck(payload.id);
}

export interface MailDrainLink {
  onCommand(cb: (payload: unknown) => void): void;
  onOpen(cb: () => void): void;
  start(): void;
  restart?(): void;
}

/** Serialize mail commands and force replay before any higher cumulative ACK. */
export function wireMailDrain(
  link: MailDrainLink,
  handle: (payload: MailPayload) => Promise<void>,
  logErr: (message: string) => void,
  lifecycle?: LightLifecycle,
): { flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  let failedFloor = Infinity;
  link.onOpen(() => {
    const release = lifecycle?.admit("mail:socket-open");
    if (lifecycle && !release) return;
    chain = chain.then(() => { failedFloor = Infinity; }).finally(() => release?.());
  });
  link.onCommand((payload) => {
    // Admission occurs in the socket callback's own stack, before shutdown can
    // close intake and observe an otherwise-empty promise chain.
    const release = lifecycle?.admit("mail:socket-command");
    if (lifecycle && !release) return;
    let sequence = -Infinity;
    chain = chain
      .then(async () => {
        const candidateId = (payload as { id?: unknown } | null)?.id;
        sequence = Number.isSafeInteger(candidateId) && (candidateId as number) >= 0 ? candidateId as number : -Infinity;
        if (sequence > failedFloor) return;
        if (!isMailPayload(payload)) throw new Error("mail: bad inbound payload");
        await handle(payload);
      })
      .catch((error) => {
        failedFloor = Math.min(failedFloor, sequence);
        logErr(`mail drain: inbound not fully recorded -- forcing replay before any higher ACK: ${error}`);
        if (link.restart) link.restart(); else link.start();
      })
      .finally(() => release?.());
  });
  return { flush: () => chain };
}

export function finalizeMailSequence(
  admissions: QueueAdmissionOutbox,
  tenantId: string,
  payload: MailPayload,
): void {
  const workId = admissionWorkId("mail", payload.id, tenantId);
  const existing = admissions.records().find((record) => record.workId === workId);
  if (existing?.variant === "agent-dispatch" || existing?.state === "terminal") return;
  if (existing?.variant === "non-agent-terminal") {
    admissions.completeNonAgent(workId, { kind: "source-applied", surface: "mail", detail: "handled-without-agent-dispatch" });
    return;
  }
  admissions.admit({
    tenantId,
    queue: "mail",
    sequence: payload.id,
    workId,
    admittedAt: payload.at,
    variant: "non-agent-terminal",
    outcomeType: "mail-no-agent-dispatch",
    outcomeVersion: 1,
    outcome: { reason: "handled-without-agent-dispatch" },
    idempotencyKey: `mail-terminal:${workId}`,
    state: "pending-side-effects",
  });
  admissions.completeNonAgent(workId, { kind: "source-applied", surface: "mail", detail: "handled-without-agent-dispatch" });
}

export interface MailDispatchItem {
  threadId: string;
  from: string;
  subject: string;
  content: string;
  messageId: string;
  emailId: string;
  attachments: Array<{ id: string; filename: string; contentType: string }>;
  at: string;
}

export function allowedSender(address: string, env: NodeJS.ProcessEnv, allowlistPath?: string): boolean {
  const normalized = extractEmailAddress(address).toLowerCase();
  const own = (env.BAXTER_EMAIL || "").trim().toLowerCase();
  if (!normalized || normalized === own) return false;
  const allow = loadAllowlist(env, allowlistPath);
  // Preserve the established provider authorization semantics: sender rows are
  // canonicalizable, so surrounding whitespace and casing do not revoke access.
  // Canonical email admission remains a distinct boundary in makeHandleMessage.
  const operator = (env.OPERATOR_EMAIL || "").trim().toLowerCase();
  return allow.senders.some((entry) => entry.trim().toLowerCase() === normalized)
    || operator === normalized;
}

export function messageItem(thread: any, message: any): MailDispatchItem {
  const raw = (message?.raw && typeof message.raw === "object") ? message.raw : {};
  const from = String(message?.author?.userId || message?.author?.email || "");
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map((attachment: any) => ({
      id: String(attachment?.id || ""),
      filename: String(attachment?.filename || ""),
      contentType: String(attachment?.contentType || ""),
    })).filter((attachment: { filename: string }) => attachment.filename)
    : [];
  return {
    threadId: String(thread?.id || message?.threadId || ""),
    from,
    subject: typeof raw.subject === "string" ? raw.subject : "",
    content: String(message?.text || raw.text || ""),
    messageId: typeof raw.messageId === "string" ? raw.messageId : String(message?.id || ""),
    emailId: String(raw.id || ""),
    attachments,
    at: raw.createdAt instanceof Date ? raw.createdAt.toISOString() : (typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()),
  };
}

// The schedule-cli guidance line, mirrored from the eval template's bullet in
// prompt.md (spec 2026-08-18-scheduled-sms-group-delivery §Agent-facing: EVERY
// scheduling-capable prompt documents `schedule-cli groups` + `--sms-group <groupId>`
// + ask-when-ambiguous). prompt.md is only the mail EVAL template (per app/CLAUDE.md) --
// production mail runs build their prompt here, so the guidance must live in this array
// too. Exported so mail-bot.test.ts's byte-identity reconstruction and the spec-test-10
// coverage assertions read the exact same string instead of drifting.
// DELIBERATE DIVERGENCE (2026-08-20 system scheduled tasks): the final sentence --
// the `schedule-cli system list|enable|disable` subcommands for runtime-owned system
// tasks -- is production-only guidance that lives HERE, not in prompt.md's eval bullet
// (the eval template is intentionally not edited for it). Do NOT re-sync the template
// with this sentence; doing so would leak production-only guidance into the eval.
export const SCHEDULE_GUIDANCE = "Schedule something to run later or on a repeat with `schedule-cli` (see the schedule skill): `schedule-cli add \"<what a future you should do>\" --desc \"<label>\" (--cron \"<expr>\" | --at \"<ISO>\") [--tz <zone>] [--discord <channelId> | --email <address> | --sms <phone> | --sms-group <groupId>]`, plus `cancel <id>`, `list`, and `groups`. Recurring tasks fire at most hourly; one-shots any time. Set `--tz` to the requester's timezone (ask them if a clock-time task needs it and you don't know). A dedicated driver runs the task when due and delivers where you said. To deliver into an SMS group (a group text Baxter has received before), run `schedule-cli groups` first and match the requester's description against each listed group's name, participants, speakers, and last activity — then schedule with the exact `id` it printed (`--sms-group <groupId>`) only when the match is clear; if several groups are plausible, ask the requester which one they mean rather than guessing. Runtime-owned system tasks are never added or cancelled. The sole key is `morning-check-in`: it persists one random 08:00–08:59 local occurrence, catches up only before noon, and is calendar-first (then Friday title-only hint, Monday check-in, or nothing). Use `schedule-cli system list` to view it; toggle it with `schedule-cli system enable morning-check-in` or `schedule-cli system disable morning-check-in`; `schedule-cli system trigger morning-check-in` is an independent immediate one-shot. It replaced the retired daily, Friday, and Monday records.";

// buildPrompt's optional note inputs: PRE-CAPTURED decisions (from makeMailRunFn's
// dispatch-time capture), defaulting to a fresh per-render derivation so the bare
// buildPrompt(item) call sites (and the tests) are unchanged.
export interface MailPromptNotes {
  intro?: IntroDecision;
  discovery?: DiscoveryDecision;
  morningHandoff?: string;
}

export function buildPrompt(item: MailDispatchItem, opts: MailPromptNotes = {}): string {
  const attachmentBlock = item.attachments.length === 0 ? "" : [
    "Inbound attachments:",
    ...item.attachments.map(({ filename, contentType }) => `- ${cleanForPromptLine(filename)} (${cleanForPromptLine(contentType)})`),
    `To fetch an inbound attachment, run: node ${MAIL_CLI} get-attachment ${cleanForPromptLine(item.emailId)} <filename>`,
  ].join("\n");
  // The sender's family name, if the DO taught us one (deriveSnapshot -> allowlist names).
  // Lets Baxter address a known family member by name rather than guessing from the address.
  // cleanForPromptLine collapses newlines in the correct pipeline order (a name could carry
  // one and forge a column-0 prompt line); gate on the cleaned value so an all-format-char
  // name (which sanitizes to "") falls back to no-name, not a dangling " (addr)".
  const rawSenderName = nameForAddress(extractEmailAddress(item.from));
  const senderName = rawSenderName ? cleanForPromptLine(rawSenderName) : "";
  // First-contact intro (spec 2026-08-15-first-contact-intro-design §3): mail never
  // offers the contact card (that's the SMS-only line), only the shared "first
  // exchange" block, rendered when the flag is ON and explainedAt is unset. The
  // feature-discovery note (spec 2026-08-19-cross-surface-home-link-discovery §2)
  // rides the SAME slot: [introNote, discoveryNote] filtered and joined with "\n\n",
  // appended as the same single final array element only when non-empty -- so a
  // flag-OFF, none-pending, or invalid-origin build (discoveryNote returns "" in
  // exactly those cases) stays byte-identical to the pre-feature build.
  const note = [introNote(opts.intro ?? introDecision(process.env)), discoveryNote(opts.discovery ?? discoveryDecision(process.env))]
    .filter((s) => s !== "")
    .join("\n\n");
  return [
    `You are ${PERSONA_NAME}, operating the email account ${cleanForPromptLine(process.env.BAXTER_EMAIL || "")}.`,
    "Read the inbound email below and respond when a reply is appropriate. Use the mail CLI reply command with the exact thread id; do not call thread.post or invent a sender.",
    // Single-line header slots use cleanForPromptLine (collapse newlines BEFORE neutralize)
    // so an attacker-influenced value carrying an exotic terminator (e.g. U+2028 in an RFC
    // 2047 encoded-word subject, folded to \n by normalize) can't forge a column-0 prompt
    // line. Only the multi-line body below stays cleanForPrompt.
    `From: ${cleanForPromptLine(item.from)}${senderName ? ` (${senderName}, a known family member)` : ""}`,
    `Subject: ${cleanForPromptLine(item.subject)}`,
    `Thread ID: ${cleanForPromptLine(item.threadId)}`,
    "",
    cleanForPrompt(item.content),
    attachmentBlock,
    "",
    `Shared memory: ${MEMORY_PATH}`,
    `Credentials: ${CREDENTIALS_PATH}`,
    // Household roster (spec 2026-08-17): mail's prompt is a flat inline line array,
    // so this block deliberately gets NO "## Your household" markdown header -- just
    // the blank line, the lead-in, and the preamble body, immediately before Collections.
    "",
    "The people in this household, and how to reach them:",
    householdPreamble(),
    `Collections: ${collectionsPreamble()}`,
    SCHEDULE_GUIDANCE,
    ...(opts.morningHandoff ? [opts.morningHandoff] : []),
    ...(note ? [note] : []),
  ].join("\n");
}

function mailModel(env: NodeJS.ProcessEnv): string { return env.MAIL_MODEL || env.BAXTER_MODEL || "sonnet"; }

export function makeRunEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.RESEND_API_KEY;
  delete env.RESEND_WEBHOOK_SECRET;
  return env;
}

// The multimodal model an image/PDF-bearing email is routed to (parity with discord/sms).
// Empty -> attachments stay metadata-only (the get-attachment fetch path in buildPrompt).
const MULTIMODAL_MODEL = process.env.OPENROUTER_MULTIMODAL_MODEL || "";
// Types buildMediaParts can turn into native content parts (same set as discord's isMultimodalCt).
const isForwardableMailCt = (ct: string): boolean => /^(image|video|audio)\//.test(ct) || ct === "application/pdf";
// Cap the mint ATTEMPTS per email (not successes) so a message with dozens of attachments can't
// fan out into dozens of Resend round-trips before the run even starts -- true even when Resend
// is erroring, where counting only successes would leave the fan-out unbounded.
const MAIL_MEDIA_MAX = 6;

export interface MailMediaDeps {
  // Mint by the provider attachment id (one call, no email GET, collision-free). Injected in tests.
  mintById?: (emailId: string, id: string) => Promise<any>;
  // Fallback for an inbound whose attachments carry no id (mints by filename via one GET).
  mintByFilename?: (emailId: string, filename: string) => Promise<any>;
  logErr?: (msg: string) => void;
}
// Mint a signed download URL per forwardable attachment and hand them to the run as
// BAXTER_MEDIA items (URL-passthrough: OpenRouter fetches the signed URL, so the bytes and
// the API key both stay out of the run env). Minting is by attachment id (one mint call
// each, no per-item email re-fetch, and immune to two attachments sharing a filename);
// an id-less attachment falls back to the filename path. Best-effort -- a mint failure or a
// url the runner would reject drops just that item; the run still fires (buildPrompt's
// get-attachment line remains the fallback the model can use for anything not forwarded).
export async function selectMailMedia(item: MailDispatchItem, deps: MailMediaDeps = {}): Promise<MediaItem[]> {
  if (!item.emailId) return [];
  const mintById = deps.mintById ?? mintAttachmentById;
  const mintByFilename = deps.mintByFilename ?? mintAttachmentDownload;
  const out: MediaItem[] = [];
  let attempts = 0; // cap MINT ATTEMPTS, not successes, so failing mints don't leave the fan-out unbounded
  for (const att of item.attachments) {
    if (attempts >= MAIL_MEDIA_MAX) break;
    if (!isForwardableMailCt(att.contentType)) continue;
    attempts++;
    try {
      const minted = att.id ? await mintById(item.emailId, att.id) : await mintByFilename(item.emailId, att.filename);
      const url = attachmentDownloadUrl(minted);
      if (!isModelFetchableUrl(url)) { deps.logErr?.(`mail media: no fetchable url minted for ${att.filename}`); continue; }
      out.push({ url, content_type: att.contentType, filename: att.filename, source: "resend" });
    } catch (e) {
      deps.logErr?.(`mail media: mint failed for ${att.filename}: ${(e as Error).message}`);
    }
  }
  return out;
}

export interface MailBotDeps {
  loadHomeKeys: () => HomeKeys;
  env: NodeJS.ProcessEnv;
  makeSocket?: (url: string, headers: Record<string, string>) => WebSocketLike;
  log: (message: string) => void;
  logErr: (message: string) => void;
  lifecycle?: LightLifecycle;
  onDurableProgress?: (highWater: number) => void;
  admissions?: QueueAdmissionOutbox;
  cursorLoad?: () => number;
  cursorStore?: (highWater: number) => void;
  /** Drain already-admitted work without opening source intake. */
  replayOnly?: boolean;
}

export function defaultDeps(): MailBotDeps { return { loadHomeKeys, env: process.env, ...loggerFor("mail") }; }

// Options for makeHandleMessage (below): production wiring plus narrow append,
// moderation, post-admission handoff-consumption, and allowlist-path seams that tests
// substitute. This remains the spec-approved chat-event dispatch seam, not a broader refactor.
export interface HandleMessageOpts {
  env: NodeJS.ProcessEnv;
  notify: (from: string, item: MailDispatchEnvelope) => void;
  logErr: (m: string) => void;
  /** Present only while a queue inbound is being applied through the Chat adapter. */
  admissionSequence?: () => number | undefined;
  /** Durable agent-dispatch owner; omitted for resident compatibility and focused unit seams. */
  admissions?: QueueAdmissionOutbox;
  /** Provider-wide identity namespace; required whenever durable admission is active. */
  tenantId?: string;
  append?: typeof appendMailTranscript;
  moderateImpl?: typeof moderate;
  /** Runs only after durable append plus sender and canonical-address admission. */
  consumeMorningHandoff?: (item: MailDispatchItem, admittedAddress: string, receiptToken?: string) => Promise<MorningHandoffClaim | null>;
  /** One fresh allowlist source for authorization and handoff identity. */
  allowlistPath?: string;
}

// The chat-event dispatch closure (chat.onNewMention/onSubscribedMessage), extracted
// from main() so its metering seam is unit-testable. Same behavior as the old inline
// closure EXCEPT one deliberate reorder -- the correctness completion of the
// operator-approved record-at-receipt placement (usage-metrics, round 4):
//   (1) messageItem FIRST -- it is a pure function of (thread, message) (reads only
//       thread?.id and message fields; nothing depends on subscribe() having run), so
//       hoisting it above subscribe changes no other behavior;
//   (2) ONE mail_rx signal BEFORE thread.subscribe(): permanently dead-lettered
//       mail still counts, as do retryable handler/admission passes that leave the
//       cursor unadvanced for DO redelivery. This keeps the record ahead of the
//       allowedSender/moderate gates (a rejected or blocked inbound costs money
//       either way). Inbound counting is therefore AT-LEAST-ONCE under redelivery:
//       each applied pass re-records because the signal schema carries no provider
//       message ID for downstream dedupe. The counterpart is canonicalMail(item.from) -- the
//       ONE definition in transcript.ts, the same form mail-cli's sendRaw/sendReply
//       record as mail_tx, so rx and tx collapse onto one label series. recordSignal
//       never throws, so metering cannot break the dispatch path;
//   (3) await thread.subscribe();
//   (4) resident mode preserves append -> sender authorization -> canonical
//       address -> handoff -> moderation -> notify. Durable queue mode instead
//       authorizes/moderates, admits the immutable work ID, and leaves transcript
//       plus handoff to idempotent dispatcher receipts before model execution.
export function makeHandleMessage(opts: HandleMessageOpts): (thread: any, message: any) => Promise<void> {
  const append = opts.append ?? appendMailTranscript;
  const moderateImpl = opts.moderateImpl ?? moderate;
  return async (thread: any, message: any): Promise<void> => {
    const item = messageItem(thread, message);
    recordSignal({ t: Date.now(), kind: "mail_rx", counterpart: canonicalMail(item.from) });
    await thread.subscribe();
    const sequence = opts.admissionSequence?.();
    const durable = opts.admissions !== undefined && sequence !== undefined;
    if (!durable) {
      await append(item.from, {
        direction: "in", at: item.at, subject: item.subject, content: item.content,
        threadId: item.threadId, messageId: item.messageId,
      });
    }
    if (!allowedSender(item.from, opts.env, opts.allowlistPath)) {
      opts.logErr(`mail: rejected inbound sender ${item.from}`);
      return;
    }
    const admittedAddress = admitEmail(extractEmailAddress(item.from));
    if (admittedAddress === null) {
      opts.logErr("mail: rejected inbound sender");
      return;
    }
    if (opts.admissions && sequence !== undefined) {
      // Moderation precedes classification: a blocked message becomes a typed
      // non-agent outcome, while accepted transcript/handoff side effects wait
      // until after immutable work admission.
      const verdict = await moderateImpl(item.content, "in");
      if (!verdict.allowed) {
        opts.logErr(`mail: moderation blocked inbound from ${item.from}${verdict.category ? ` (${verdict.category})` : ""}`);
        return;
      }
      if (!opts.tenantId) throw new Error("mail admission tenant id is required");
      const candidate = {
        tenantId: opts.tenantId,
        queue: "mail" as const, sequence, workId: admissionWorkId("mail", sequence, opts.tenantId), admittedAt: item.at,
        variant: "agent-dispatch" as const, input: item,
        state: "pending" as const, attempts: 0, nextAttemptAt: 0,
      };
      if (opts.admissions.admit(candidate) !== candidate) return;
      opts.notify(item.from, { ...item, workId: candidate.workId });
      return;
    }
    // Resident compatibility retains the historical append -> handoff -> moderation order.
    const morningClaim = await opts.consumeMorningHandoff?.(item, admittedAddress) ?? null;
    const verdict = await moderateImpl(item.content, "in");
    if (!verdict.allowed) {
      opts.logErr(`mail: moderation blocked inbound from ${item.from}${verdict.category ? ` (${verdict.category})` : ""}`);
      return;
    }
    opts.notify(item.from, morningClaim ? { ...item, morningClaim } : item);
  };
}

// Options for makeMailRunFn (below): production wiring plus injectable runAgent,
// marker, intro/discovery-decision, and morning-handoff-preparation seams. They default
// to the REAL imported implementations, so main()'s factory-built dispatcher closure IS
// the closure the tests drive. markFeaturesIntroduced carries
// intro-state's ENV-AWARE signature -- the factory passes deps.env so the discovery
// read and the mark write resolve the SAME latch file even when deps.env is a
// non-global object (the asymmetry markExplained/markCardSent still carry is out of
// scope, deferred).
export type MailRunOutcome =
  | { kind: "succeeded"; source: "mail"; resolution?: "delivered" | "no-reply"; completedAt: string; providerReceipts: Array<{ idempotencyKey: string; providerId: string }> }
  | { kind: "retry"; source: "mail"; reason: "agent-failed" | "out-of-tokens" }
  | { kind: "permanent-failure"; source: "mail"; message: string };

export interface MailRunDeps {
  env: NodeJS.ProcessEnv;
  runEnv: NodeJS.ProcessEnv;
  model: string;
  logErr: (m: string) => void;
  runAgent?: typeof runAgent;
  markExplained?: typeof markExplained;
  markFeaturesIntroduced?: typeof markFeaturesIntroduced;
  introDecision?: typeof introDecision;
  discoveryDecision?: typeof discoveryDecision;
  prepareMorningHandoff?: typeof prepareMorningHandoff;
  providerReceiptsForWork?: typeof mailProviderReceiptsForWork;
  providerDeliveryForWork?: typeof readMailDeliveryReceipt;
  reconcileProviderDelivery?: typeof reconcileMailDelivery;
  noReplyOutcomeForWork?: typeof noReplyOutcomeForWork;
  requireNoReplyOutcome?: typeof requireNoReplyOutcome;
}

// The dispatcher run closure, extracted from main() (the makeHandleMessage
// extraction precedent) so its metering/discovery seams are unit-testable.
// Behavior is the old inline closure's plus morning-handoff preparation/recheck and
// feature discovery (spec §2/§5/§6 Mail):
//   - a pending morning-handoff claim is prepared and rechecked before intro/discovery;
//     a failure retains the ordinary reply;
//   - the intro AND discovery decisions are captured ONCE at dispatch (one state
//     read each, provable via the injectable discoveryDecision seam); the prompt
//     note and the post-run conclusion share that ONE captured decision -- there
//     is never a second read;
//   - an invalid HOME_BASE_URL (decision.origin === null) fails open: the note is
//     omitted, no delivered URL can match, nothing is marked -- logged best-effort,
//     never blocking the reply;
//   - a fresh RunObserver rides the run as runAgent's onEvent (one observer per
//     dispatched run; its tool_use/tool_result FIFO pairing is per-stream);
//   - after a completed run (!failed && !outOfTokens), the pure concludeDiscovery
//     seam decides the mark set and ONE env-aware markFeaturesIntroduced call
//     writes it (a multi-feature set from a multi-link reply is one atomic mark);
//     a mark failure logs and never fails the reply. markExplained behavior is
//     unchanged (same conditions, same best-effort posture).
export function makeMailRunFn(deps: MailRunDeps): (from: string, item: MailDispatchEnvelope) => Promise<MailRunOutcome> {
  const runAgentImpl = deps.runAgent ?? runAgent;
  const markExplainedImpl = deps.markExplained ?? markExplained;
  const markFeaturesIntroducedImpl = deps.markFeaturesIntroduced ?? markFeaturesIntroduced;
  const introDecisionImpl = deps.introDecision ?? introDecision;
  const discoveryDecisionImpl = deps.discoveryDecision ?? discoveryDecision;
  const prepareMorningHandoffImpl = deps.prepareMorningHandoff ?? prepareMorningHandoff;
  const providerReceiptsForWork = deps.providerReceiptsForWork ?? mailProviderReceiptsForWork;
  const providerDeliveryForWork = deps.providerDeliveryForWork ?? readMailDeliveryReceipt;
  const reconcileProviderDelivery = deps.reconcileProviderDelivery ?? reconcileMailDelivery;
  const noReplyForWork = deps.noReplyOutcomeForWork ?? noReplyOutcomeForWork;
  const requireNoReply = deps.requireNoReplyOutcome ?? requireNoReplyOutcome;
  const conflict = (): never => { throw new Error("mail work has conflicting delivery and no-reply receipts"); };
  return async (_from: string, item: MailDispatchEnvelope): Promise<MailRunOutcome> => {
    if (item.workId) {
      // A durable no-reply decision is just as terminal as provider delivery. Read
      // both authorities before replaying a prepared provider operation or rerunning
      // the model; contradictory authorities fail closed instead of choosing one.
      const noReply = noReplyForWork("mail", item.workId);
      const existingDelivery = providerDeliveryForWork(item.workId);
      if (noReply && existingDelivery) conflict();
      if (noReply) return { kind: "succeeded", source: "mail", resolution: "no-reply", completedAt: noReply.completedAt, providerReceipts: [] };

      // A prior process may have died after preparing or sending the output but
      // before the CLI returned. Reconcile it before any prompt/model work.
      const receipt = await reconcileProviderDelivery(item.workId);
      const lateNoReply = noReplyForWork("mail", item.workId);
      if (receipt && lateNoReply) conflict();
      if (lateNoReply) return { kind: "succeeded", source: "mail", resolution: "no-reply", completedAt: lateNoReply.completedAt, providerReceipts: [] };
      if (receipt) {
        if (!receipt.providerId) throw new Error("reconciled mail delivery is missing provider id");
        return {
          kind: "succeeded",
          source: "mail",
          resolution: "delivered",
          completedAt: receipt.completedAt ?? new Date().toISOString(),
          providerReceipts: [{ idempotencyKey: receipt.idempotencyKey, providerId: receipt.providerId }],
        };
      }
    }
    // A transient in-memory claim is rechecked after durable sidecar consumption,
    // then rendered before optional intro/discovery work. Failures deliberately retain
    // ordinary mail behavior and never reopen suppression.
    let morningHandoff = "";
    if (item.morningClaim) {
      try {
        const packet = await prepareMorningHandoffImpl(item.morningClaim, { env: deps.env });
        if (packet) morningHandoff = handoffPromptBlock(packet);
      } catch { /* ordinary reply remains available */ }
    }
    // The first-contact and feature-discovery decisions for THIS run, captured at
    // dispatch time; buildPrompt renders from them below and the post-run
    // conclusion reuses the same captured objects (no re-read).
    const intro = introDecisionImpl(deps.env);
    const discovery = discoveryDecisionImpl(deps.env);
    // A null origin can only arise from a set-but-invalid HOME_BASE_URL (empty
    // means unset -> the default origin): best-effort operator signal; the note
    // is omitted and nothing can match regardless (fail-open, spec §3).
    if (discovery.origin === null && deps.env.HOME_BASE_URL) {
      deps.logErr(`mail: HOME_BASE_URL is set but invalid -- Home feature-discovery note omitted (replies are unaffected)`);
    }
    const observer = new RunObserver();
    // Route an email carrying forwardable attachments to the multimodal model with the
    // images/PDFs attached (minted lazily here, only when the run actually fires after the
    // debounce). A text-only email, or an unconfigured multimodal model, keeps runEnv.
    const media = MULTIMODAL_MODEL ? await selectMailMedia(item, { logErr: deps.logErr }) : [];
    const routedEnv = media.length
      ? { ...deps.runEnv, BAXTER_MODEL_OVERRIDE: MULTIMODAL_MODEL, BAXTER_MEDIA: JSON.stringify(media) }
      : deps.runEnv;
    // Every credential-holding mail CLI subprocess inherits this identity. It
    // binds Resend's Idempotency-Key and durable provider receipt to the exact
    // admitted envelope across agent/process crashes.
    const env = item.workId ? { ...routedEnv, BAXTER_WORK_ID: item.workId } : routedEnv;
    const { failed, outOfTokens, resolution } = await runAgentImpl({
      prompt: buildPrompt(item, { intro, discovery, morningHandoff }),
      logId: item.messageId,
      surface: "mail",
      cwd: MEMORY_DIR,
      model: deps.model,
      allowedTools: MAIL_TOOLS,
      runsDir: MAIL_RUNS_DIR,
      receivedAt: item.at,
      env,
      onEvent: (ev) => observer.observe(ev),
      beforeRun: () => {
        ensurePlaywrightConfig(MEMORY_DIR);
        ensureSkills(MAIL_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
      },
    });
    // First-contact latch write (spec 2026-08-15 §5): the surface process marks
    // explainedAt once the run whose prompt carried the intro block completed with
    // a reply/emit (failed/outOfTokens both mean nothing went out). Best-effort: a
    // latch write failure logs and never fails anything here.
    if (!failed && !outOfTokens) {
      let providerReceipts: Array<{ idempotencyKey: string; providerId: string }> = [];
      if (item.workId) {
        if (resolution === "delivered") {
          providerReceipts = providerReceiptsForWork(item.workId);
          if (noReplyForWork("mail", item.workId)) conflict();
          if (providerReceipts.length === 0) return { kind: "retry", source: "mail", reason: "agent-failed" };
        } else if (resolution === "no-reply") {
          requireNoReply("mail", item.workId);
          if (providerDeliveryForWork(item.workId)) conflict();
        } else {
          return { kind: "retry", source: "mail", reason: "agent-failed" };
        }
      }
      try {
        if (intro.explain) markExplainedImpl();
      } catch (err) { deps.logErr(`mail: intro latch write failed: ${(err as Error).message}`); }
      // Feature-discovery latch write (spec §6/§8): mark all and only verified
      // introductions, as one atomic set, through the env-aware marker so the write
      // lands on the same latch file the captured decision read. Best-effort alike.
      try {
        const toMark = concludeDiscovery(discovery, observer.summary(), item.threadId, { failed, outOfTokens });
        if (toMark.length) markFeaturesIntroducedImpl(toMark, deps.env);
      } catch (err) { deps.logErr(`mail: feature-discovery latch write failed: ${(err as Error).message}`); }
      return {
        kind: "succeeded",
        source: "mail",
        ...(item.workId ? { resolution: resolution as "delivered" | "no-reply" } : {}),
        completedAt: new Date().toISOString(),
        providerReceipts,
      };
    }
    return { kind: "retry", source: "mail", reason: outOfTokens ? "out-of-tokens" : "agent-failed" };
  };
}

export interface MailDispatcherDeps {
  env: NodeJS.ProcessEnv;
  runEnv: NodeJS.ProcessEnv;
  model: string;
  logErr: (message: string) => void;
  /** Sampled per admitted inbound, never while this long-lived factory is made. */
  now?: () => Date;
  append?: typeof appendMailTranscript;
  moderateImpl?: typeof moderate;
  runAgent?: typeof runAgent;
  introDecision?: typeof introDecision;
  discoveryDecision?: typeof discoveryDecision;
  prepareMorningHandoff?: typeof prepareMorningHandoff;
  /** Test seam for the feature-specific fresh allowlist read. */
  loadAllowlistImpl?: typeof loadAllowlist;
  /** Optional test/tenant fixture; production retains ALLOWLIST_PATH. */
  allowlistPath?: string;
  /** Durable queue admission ledger; absent preserves the resident dispatch path. */
  admissions?: QueueAdmissionOutbox;
  /** Provider-wide identity namespace; required whenever durable admission is active. */
  tenantId?: string;
  /** The queue sequence currently being applied through the Chat adapter. */
  admissionSequence?: () => number | undefined;
  /** Test seam: errors tagged permanent skip retry replay. */
  isPermanentFailure?: (error: unknown) => boolean;
  retryDelayMs?: number;
  maxRunsPerWindow?: number;
  windowMs?: number;
  nowMs?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  deadLetter?: typeof recordDeadLetter;
  providerReceiptsForWork?: typeof mailProviderReceiptsForWork;
  providerDeliveryForWork?: typeof readMailDeliveryReceipt;
  reconcileProviderDelivery?: typeof reconcileMailDelivery;
  noReplyOutcomeForWork?: typeof noReplyOutcomeForWork;
  requireNoReplyOutcome?: typeof requireNoReplyOutcome;
  lifecycle?: LightLifecycle;
}

export type MailDispatchEnvelope = MailDispatchItem & {
  morningClaim?: MorningHandoffClaim;
  workId?: string;
  /** Scheduling batch membership; immutable records remain one-per-work-ID. */
  workIds?: string[];
};

type SerializedMailMorningClaim = Omit<MorningHandoffClaim, "consumedAt"> & { consumedAt: string };
type MailLifecycleReceipt = {
  version: 1;
  transcript?: { kind: "appended" };
  handoff?: { kind: "completed"; claim: SerializedMailMorningClaim | null };
};

function mailLifecycleReceipt(record: AgentDispatchRecord): MailLifecycleReceipt {
  if (record.receipt === undefined) return { version: 1 };
  const value = record.receipt as Record<string, unknown>;
  const fail = (): never => { throw Object.assign(new Error("invalid durable mail lifecycle receipt"), { permanent: true }); };
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
    || !Object.keys(value).every(key => key === "version" || key === "transcript" || key === "handoff")) return fail();
  const transcript = value.transcript as Record<string, unknown> | undefined;
  if (transcript !== undefined && (Object.keys(transcript).length !== 1 || transcript.kind !== "appended")) return fail();
  const handoff = value.handoff as Record<string, unknown> | undefined;
  if (handoff !== undefined) {
    if (Object.keys(handoff).length !== 2 || handoff.kind !== "completed") return fail();
    const claim = handoff.claim as Record<string, unknown> | null;
    if (claim !== null && (!claim || typeof claim !== "object" || typeof claim.occurrence !== "string"
      || typeof claim.consumedAt !== "string" || Number.isNaN(Date.parse(claim.consumedAt)))) return fail();
  }
  return value as MailLifecycleReceipt;
}

class MailDispatcher extends ChannelDispatcher<MailDispatchEnvelope> {
  override _coalesce(previous: MailDispatchEnvelope, next: MailDispatchEnvelope): MailDispatchEnvelope {
    const claim = retainEarliestClaim(previous.morningClaim ?? null, next.morningClaim ?? null);
    const ids = [...(previous.workIds ?? (previous.workId ? [previous.workId] : [])), ...(next.workIds ?? (next.workId ? [next.workId] : []))];
    const merged = claim ? { ...next, morningClaim: claim } : next;
    return ids.length ? { ...merged, workIds: [...new Set(ids)] } : merged;
  }
}

/**
 * The production mail dispatch seam.  main() uses this exact factory so tests can
 * exercise durable admission, per-inbound time capture, and the real coalescer.
 */
export function makeMailDispatcher(deps: MailDispatcherDeps): {
  dispatcher: ChannelDispatcher<MailDispatchEnvelope>;
  handleMessage: (thread: any, message: any) => Promise<void>;
  replay: () => void;
  close: () => void;
} {
  const now = deps.now ?? (() => new Date());
  const consumeMorningHandoff = async (_item: MailDispatchItem, address: string, receiptToken?: string): Promise<MorningHandoffClaim | null> => {
    // The canonical address was explicitly admitted by makeHandleMessage after
    // authorization. Re-load the household snapshot for this inbound only. This
    // feature-specific read must never use loadAllowlist's legacy raw error log.
    const list = (deps.loadAllowlistImpl ?? loadAllowlist)(deps.env, deps.allowlistPath, () => {
      deps.logErr("mail: morning handoff state-unavailable");
    });
    const roster = resolveRecipients(list, deps.env).contacts;
    const identity = decideInboundIdentity({
      type: "direct", address, allowlist: list, roster, emailAlreadyAuthorized: true,
    });
    if (identity.kind !== "direct") return null;
    const capturedAt = now(); // exactly one sample after append/sender/admission
    const snapshot = readTasksForMorningHandoff();
    // Schedule authority being unavailable is distinct from an available schedule
    // without today's canonical occurrence. Both preserve ordinary mail dispatch.
    if (!snapshot.available) { deps.logErr("mail: morning handoff state-unavailable"); return null; }
    const occurrence = canonicalMorningOccurrence(snapshot.tasks, morningCheckInDefinition({ env: deps.env }), capturedAt, householdTz(deps.env));
    if (!occurrence) { deps.logErr("mail: morning handoff not-eligible"); return null; }
    const decision = await directConsume(occurrence, identity.directConsume.contact, identity.directConsume.address, roster, capturedAt, receiptToken);
    deps.logErr(`mail: morning handoff ${decision}`);
    return decision === "direct-consumed" ? makeMorningClaim(occurrence, capturedAt, identity.audience) : null;
  };
  const run = makeMailRunFn({
    env: deps.env, runEnv: deps.runEnv, model: deps.model, logErr: deps.logErr,
    runAgent: deps.runAgent, introDecision: deps.introDecision,
    discoveryDecision: deps.discoveryDecision, prepareMorningHandoff: deps.prepareMorningHandoff,
    providerReceiptsForWork: deps.providerReceiptsForWork,
    providerDeliveryForWork: deps.providerDeliveryForWork,
    reconcileProviderDelivery: deps.reconcileProviderDelivery,
    noReplyOutcomeForWork: deps.noReplyOutcomeForWork,
    requireNoReplyOutcome: deps.requireNoReplyOutcome,
  });
  const admissions = deps.admissions;
  const nowMs = deps.nowMs ?? Date.now;
  const setTimer = deps.setTimeoutImpl ?? setTimeout;
  const clearTimer = deps.clearTimeoutImpl ?? clearTimeout;
  const maxRuns = deps.maxRunsPerWindow ?? 60;
  const windowMs = deps.windowMs ?? 3_600_000;
  const starts = new Map<string, number[]>();
  const scheduled = new Set<string>();
  type DeferredTransition = {
    description: string;
    failures: number;
    nextAttemptAt: number;
    /** Absent for beginAttempt: replay the still-pending record from the top. */
    apply?: () => void;
  };
  // At most one deferred transition per durable work ID. A persistent disk
  // outage therefore consumes bounded memory and one shared scheduler timer;
  // process restart falls back to the outbox's pending/running recovery path.
  const deferredTransitions = new Map<string, DeferredTransition>();
  let retryTimer: NodeJS.Timeout | undefined;
  let schedulerActive = false;

  const deferTransition = (workId: string, description: string, error: unknown, apply?: () => void): void => {
    const previous = deferredTransitions.get(workId);
    const failures = (previous?.failures ?? 0) + 1;
    const base = Math.max(1, deps.retryDelayMs ?? 1_000);
    const delay = Math.min(5 * 60_000, base * (2 ** Math.min(failures - 1, 8)));
    deferredTransitions.set(workId, { description, failures, nextAttemptAt: nowMs() + delay, ...(apply ? { apply } : {}) });
    deps.logErr(`mail: deferred ${description} persistence for ${workId} (${(error as Error)?.message ?? error})`);
  };

  const persistTransition = (workId: string, description: string, apply: () => void, replayFromTop = false): boolean => {
    try {
      apply();
      deferredTransitions.delete(workId);
      return true;
    } catch (error) {
      deferTransition(workId, description, error, replayFromTop ? undefined : apply);
      return false;
    }
  };

  const retryAt = (record: AgentDispatchRecord, reason: AgentRetryReason, message?: string, exactAt?: number): void => {
    if (!admissions) return;
    const base = Math.max(1, deps.retryDelayMs ?? 1_000);
    const boundedBackoff = Math.min(5 * 60_000, base * (2 ** Math.min(record.attempts, 8)));
    const nextAttemptAt = exactAt ?? (nowMs() + boundedBackoff);
    persistTransition(record.workId, "retry", () => {
      admissions.retry(record.workId, nextAttemptAt, { kind: "retry", reason, ...(message ? { message } : {}) });
    });
  };

  const rateRetryAt = (key: string): number | null => {
    if (!maxRuns) return null;
    const now = nowMs();
    const kept = (starts.get(key) ?? []).filter((started) => started > now - windowMs);
    if (kept.length) starts.set(key, kept); else starts.delete(key);
    return kept.length >= maxRuns ? kept[0] + windowMs : null;
  };

  const recordStart = (key: string): void => {
    if (!maxRuns) return;
    const values = starts.get(key) ?? [];
    values.push(nowMs());
    starts.set(key, values);
  };

  const recordLifecycleReceipt = (workId: string, update: (receipt: MailLifecycleReceipt) => MailLifecycleReceipt): AgentDispatchRecord => {
    if (!admissions) throw new Error("mail lifecycle receipt requires durable admission");
    const current = admissions.agent(workId);
    if (!current) throw new Error("admitted mail work is missing");
    return admissions.recordAgentReceipt(workId, update(mailLifecycleReceipt(current)));
  };

  const prepareLifecycle = async (record: AgentDispatchRecord, input: MailDispatchEnvelope): Promise<MailDispatchEnvelope> => {
    if (!admissions) return input;
    let receipt = mailLifecycleReceipt(admissions.agent(record.workId) ?? record);
    if (!receipt.transcript) {
      await (deps.append ?? appendMailTranscript)(input.from, {
        direction: "in", at: input.at, subject: input.subject, content: input.content,
        threadId: input.threadId, messageId: input.messageId, receiptId: `mail-in:${record.workId}`,
      });
      recordLifecycleReceipt(record.workId, current => ({ ...current, transcript: { kind: "appended" } }));
      receipt = mailLifecycleReceipt(admissions.agent(record.workId)!);
    }
    if (!receipt.handoff) {
      const address = admitEmail(extractEmailAddress(input.from));
      if (address === null) throw Object.assign(new Error("invalid admitted mail address"), { permanent: true });
      const claim = await consumeMorningHandoff(input, address, record.workId);
      const serialized = claim ? { ...claim, consumedAt: claim.consumedAt.toISOString() } : null;
      recordLifecycleReceipt(record.workId, current => ({ ...current, handoff: { kind: "completed", claim: serialized } }));
      receipt = mailLifecycleReceipt(admissions.agent(record.workId)!);
    }
    const serialized = receipt.handoff?.claim;
    return serialized ? { ...input, morningClaim: { ...serialized, consumedAt: new Date(serialized.consumedAt) } } : input;
  };

  const permanent = (record: AgentDispatchRecord, message: string): void => {
    if (!admissions) return;
    const recordedAt = new Date(nowMs()).toISOString();
    try {
      (deps.deadLetter ?? recordDeadLetter)("mail", {
        kind: "agent-permanent-failure",
        workId: record.workId,
        sequence: record.sequence,
        admittedAt: record.admittedAt,
        error: message,
        input: record.input,
      });
    } catch (error) {
      retryAt(record, "dlq-write-failed", (error as Error)?.message ?? String(error));
      return;
    }
    persistTransition(record.workId, "permanent failure", () => {
      admissions.permanentFailure(record.workId, {
        kind: "permanent-failure",
        source: "mail",
        message,
        sourceDlq: { surface: "mail", recordedAt },
      });
    });
  };

  const runRecord = async (record: AgentDispatchRecord): Promise<void> => {
    if (!admissions) return;
    scheduled.delete(record.workId);
    try {
      const current = admissions.agent(record.workId);
      if (!current || (current.state !== "pending" && current.state !== "retry-wait")) return;
      const input = current.input as MailDispatchEnvelope;
      if (!input || typeof input !== "object" || typeof input.from !== "string") {
        permanent(current, "invalid mail dispatch envelope");
        return;
      }
      const retryAtMs = rateRetryAt(input.from);
      if (retryAtMs !== null) {
        retryAt(current, "rate-limit", undefined, retryAtMs);
        return;
      }
      if (!persistTransition(current.workId, "begin attempt", () => {
        admissions.beginAttempt(current.workId);
      }, true)) return;
      recordStart(input.from);

      let outcome: MailRunOutcome;
      try {
        const prepared = await prepareLifecycle(current, input);
        outcome = await run(input.from, { ...prepared, workId: current.workId });
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        const isPermanent = deps.isPermanentFailure?.(error) ?? (error as { permanent?: unknown })?.permanent === true;
        if (isPermanent) permanent(current, message);
        else retryAt(current, "transient-error", message);
        return;
      }
      if (outcome.kind === "succeeded" && !outcome.resolution) {
        retryAt(current, "agent-failed", "runner success omitted a durable resolution");
      } else if (outcome.kind === "succeeded") {
        persistTransition(current.workId, "success", () => { admissions.succeed(current.workId, outcome); });
      } else if (outcome.kind === "retry") {
        retryAt(current, outcome.reason);
      } else {
        permanent(current, outcome.message);
      }
    } finally {
      // Transition failures must never escape to ChannelDispatcher's logging-only
      // catch with no scheduler owner. Re-arm from every return/error path.
      pumpRetries();
    }
  };

  let dispatcher: MailDispatcher;
  const pumpRetries = (): void => {
    if (!schedulerActive || !admissions) return;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = undefined; }
    const currentTime = nowMs();
    for (const [workId, transition] of [...deferredTransitions]) {
      if (transition.nextAttemptAt > currentTime) continue;
      if (!transition.apply) {
        // beginAttempt never became durable, so the unchanged pending record is
        // safe to replay through the complete runRecord path.
        deferredTransitions.delete(workId);
        continue;
      }
      try {
        transition.apply();
        deferredTransitions.delete(workId);
      } catch (error) {
        deferTransition(workId, transition.description, error, transition.apply);
      }
    }
    for (const record of admissions.dueAgents(currentTime, { queue: "mail", tenantId: deps.tenantId })) {
      if (!deferredTransitions.has(record.workId)) enqueueRecord(record);
    }
    let earliest: number | null = null;
    for (const transition of deferredTransitions.values()) {
      if (earliest === null || transition.nextAttemptAt < earliest) earliest = transition.nextAttemptAt;
    }
    for (const record of admissions.records()) {
      if (record.variant !== "agent-dispatch" || record.queue !== "mail" || record.tenantId !== deps.tenantId
        || (record.state !== "pending" && record.state !== "retry-wait")
        || scheduled.has(record.workId) || deferredTransitions.has(record.workId)) continue;
      if (earliest === null || record.nextAttemptAt < earliest) earliest = record.nextAttemptAt;
    }
    if (earliest !== null && earliest > currentTime) {
      retryTimer = setTimer(() => { retryTimer = undefined; pumpRetries(); }, Math.max(0, earliest - currentTime));
      retryTimer.unref?.();
    }
  };

  const enqueueRecord = (record: AgentDispatchRecord): void => {
    if (scheduled.has(record.workId)) return;
    scheduled.add(record.workId);
    const source = record.input && typeof record.input === "object" ? record.input as Partial<MailDispatchEnvelope> : {};
    const key = typeof source.from === "string" ? source.from : "__invalid_mail_envelope__";
    dispatcher.notify(key, { ...source, workId: record.workId, workIds: [record.workId] } as MailDispatchEnvelope);
  };

  dispatcher = new MailDispatcher({
    debounceMs: 1200,
    maxConcurrent: 3,
    // Durable mail owns rate refusal below. ChannelDispatcher's historical
    // rate branch drops items, so it must never see an admitted envelope as
    // over-budget. Resident/no-outbox behavior remains unchanged.
    maxRunsPerWindow: admissions ? 0 : maxRuns,
    windowMs,
    lifecycle: deps.lifecycle,
    runFn: async (from, item) => {
      if (!admissions) { await run(from, item); return; }
      const workIds = item.workIds ?? (item.workId ? [item.workId] : []);
      const records = workIds
        .map((workId) => admissions.agent(workId))
        .filter((record): record is AgentDispatchRecord => record !== undefined)
        .sort((left, right) => left.sequence - right.sequence);
      for (const record of records) await runRecord(record);
    },
  });

  const notify = (from: string, item: MailDispatchEnvelope): void => {
    if (admissions && item.workId) {
      const record = admissions.agent(item.workId);
      if (!record) throw new Error("admitted mail work is missing");
      schedulerActive = true;
      enqueueRecord(record);
      pumpRetries();
      return;
    }
    dispatcher.notify(from, item);
  };

  const handleMessage = makeHandleMessage({
    env: deps.env,
    notify,
    logErr: deps.logErr,
    append: deps.append,
    moderateImpl: deps.moderateImpl,
    consumeMorningHandoff,
    allowlistPath: deps.allowlistPath,
    admissions,
    tenantId: deps.tenantId,
    admissionSequence: deps.admissionSequence,
  });
  const replay = () => {
    if (!admissions) return;
    schedulerActive = true;
    admissions.recoverInterrupted(nowMs(), { queue: "mail", tenantId: deps.tenantId });
    pumpRetries();
  };
  const close = () => {
    schedulerActive = false;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = undefined; }
    dispatcher.closeIntake();
  };
  return { dispatcher, handleMessage, replay, close };
}

export async function main(deps: MailBotDeps = defaultDeps()): Promise<void> {
  let keys: HomeKeys;
  try {
    keys = deps.loadHomeKeys();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") deps.log("mail: no home-keys.json -- mail surface idle (provision with `baxctl home <id>`)");
    else deps.logErr(`mail: home-keys.json unreadable (${e.message}) -- mail surface idle until it's fixed`);
    idleForever(deps.lifecycle, "mail:idle-timer");
    return;
  }

  if (!deps.env.BAXTER_EMAIL) throw new Error("BAXTER_EMAIL is not set.");
  if (deps.env.RESEND_API_KEY) {
    mkdirSync(dirname(MAIL_KEYS_PATH), { recursive: true });
    writeFileSync(MAIL_KEYS_PATH, JSON.stringify({ apiKey: deps.env.RESEND_API_KEY }), { mode: 0o600 });
  }

  const MODEL = mailModel(deps.env);
  const RUN_ENV = makeRunEnv();
  RUN_ENV.BAXTER_EXPECT_REPLY = "1";
  // The production event handlers are built by the exported factory; do not
  // duplicate its admission/claim/coalescing order here. The link drain is
  // serialized, so this single sequence slot binds adapter callbacks to exactly
  // the inbound envelope being applied.
  const admissions = deps.admissions ?? new QueueAdmissionOutbox(QUEUE_ADMISSION_OUTBOX_PATH);
  if (deps.lifecycle) admissions.bindLifecycle(deps.lifecycle);
  const cursorLoad = deps.cursorLoad ?? loadCursor;
  const cursorStore = deps.cursorStore ?? storeCursor;
  const durableProgress = (highWater: number): void => {
    // Cursor storage completed before this callback. Submit runner coverage first;
    // only then let the shared ledger reclaim terminal rows in this exact scope.
    deps.onDurableProgress?.(highWater);
    if (highWater >= 0) admissions.noteDurableCursor("mail", highWater, keys.tenant);
  };
  let admissionSequence: number | undefined;
  const mailDispatcher = makeMailDispatcher({
    env: deps.env, runEnv: RUN_ENV, model: MODEL, logErr: deps.logErr,
    admissions, tenantId: keys.tenant, admissionSequence: () => admissionSequence,
    lifecycle: deps.lifecycle,
  });
  const replayHighWater = await replayQueueBeforeAgents({ admissions, queue: "mail", tenantId: keys.tenant, cursorLoad, cursorStore });
  durableProgress(replayHighWater);
  mailDispatcher.replay();
  deps.lifecycle?.resource("mail:dispatcher-retries", () => mailDispatcher.close());
  if (deps.replayOnly) {
    deps.log(`mail: replay-only dispatcher started (tenant ${keys.tenant})`);
    return;
  }

  const { adapter, chat, state } = buildChat();
  // Initialize before any inbound arrives: connects the SQLite state adapter AND
  // runs adapter.initialize() (builds the WebhookHandler + binds the chat), which
  // handleWebhook requires. We call adapter.handleWebhook() directly (not through
  // the Chat instance), so the SDK's auto-init on chat methods never fires for the
  // inbound path -- without this, every inbound dead-letters with "Adapter not
  // initialized." The Chat SDK's initialize() is idempotent (guarded by `initialized`).
  await chat.initialize();
  chat.onNewMention(mailDispatcher.handleMessage);
  chat.onSubscribedMessage(mailDispatcher.handleMessage);

  const link = new HomeLink({
    connect: signedMailLinkConnect(keys, deps.makeSocket),
    viewVersion: () => null,
    appliedThrough: () => loadCursor(),
    logErr: deps.logErr,
  });
  wireMailDrain(link, async (payload) => {
    await handleInbound(payload, {
    cursorLoad,
    cursorStore,
    sendAck: (n) => link.sendAck(n),
    handleWebhook: async (request, inbound) => {
      admissionSequence = inbound.id;
      try {
        await dispatchInboundMail(adapter, state, request);
        // Chat can intentionally emit no agent event (own/automated/ignored), and
        // handlers can reject or moderate an event. Close every such sequence in
        // the same durable ledger before handleInbound can persist its cursor/ACK.
        finalizeMailSequence(admissions, keys.tenant, inbound);
      } finally { admissionSequence = undefined; }
    },
    deadLetter: (p, err) => persistMailSourceDeadLetter(admissions, keys.tenant, p, err),
    logErr: deps.logErr,
    }); durableProgress(payload.id);
  }, deps.logErr, deps.lifecycle);
  durableProgress(cursorLoad());
  link.start();
  deps.lifecycle?.source("mail:link", () => link.stop(), () => link.start());
  idleForever(deps.lifecycle, "mail:idle-timer");
  deps.log(`mail: surface up (tenant ${keys.tenant}) -> ${keys.endpoint}`);
}

function idleForever(lifecycle?: LightLifecycle, name = "mail:idle-timer"): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const open = () => { timer = setInterval(() => {}, 2 ** 31 - 1); };
  const close = () => { if (timer) clearInterval(timer); timer = undefined; };
  open(); lifecycle?.source(name, close, open);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(async (err) => { logErr(`mail: fatal: ${(err as Error).message}`); await flushLogs(); process.exit(1); });
}
