#!/usr/bin/env node
// Resend-backed mail surface daemon. Holds one SigV4-signed /mail-link socket,
// reconstructs the byte-exact Resend webhook request, and lets the Chat SDK
// resolve inbound messages/threads before dispatching a scoped agent run.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import { Chat } from "chat";
import { HomeLink, type WebSocketLike } from "./home-link.ts";
import { ChannelDispatcher } from "./dispatcher.ts";
import { buildChat, dispatchInboundMail, mintAttachmentDownload, mintAttachmentById, attachmentDownloadUrl } from "./mail-cli.ts";
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
import { MAIL_KEYS_PATH, MAIL_LINK_STATE_PATH, MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR } from "./paths.ts";
import { MAIL_CLI, MAIL_TOOLS, MAIL_SKILL_SRCS } from "./grants.ts";
import { QueueAdmissionOutbox, admissionWorkId, defaultAdmissionOutboxPath, type AgentDispatchRecord, type AgentRetryReason } from "./queue-admission-outbox.ts";
import { mailProviderReceiptsForWork } from "./mail-delivery-receipts.ts";

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
    && Number.isSafeInteger(o.id) && typeof o.raw === "string"
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

function loadCursor(): number {
  try { return JSON.parse(readFileSync(MAIL_LINK_STATE_PATH, "utf8")).appliedThrough ?? -1; }
  catch { return -1; }
}

function storeCursor(n: number): void {
  const next = Math.max(loadCursor(), n);
  mkdirSync(dirname(MAIL_LINK_STATE_PATH), { recursive: true });
  const tmp = `${MAIL_LINK_STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ appliedThrough: next }));
  renameSync(tmp, MAIL_LINK_STATE_PATH);
}

export interface InboundDeps {
  cursorLoad: () => number;
  cursorStore: (n: number) => void;
  sendAck: (appliedThrough: number) => void;
  handleWebhook: (request: Request, payload: MailPayload) => Promise<void>;
  deadLetter: (payload: MailPayload, err: unknown) => void;
  logErr: (message: string) => void;
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
    deps.deadLetter(payload, err);
    deps.logErr(`mail handleInbound: dead-lettered inbound ${payload.id} (${(err as Error)?.message ?? err})`);
  }
  deps.cursorStore(payload.id);
  deps.sendAck(payload.id);
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
  append?: typeof appendMailTranscript;
  moderateImpl?: typeof moderate;
  /** Runs only after durable append plus sender and canonical-address admission. */
  consumeMorningHandoff?: (item: MailDispatchItem, admittedAddress: string) => Promise<MorningHandoffClaim | null>;
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
//   (2) ONE mail_rx signal BEFORE thread.subscribe(): in handleInbound's catch the
//       deadLetter() runs and then cursorStore/sendAck run UNCONDITIONALLY, so with
//       the signal after subscribe, a subscribe() throw whose deadLetter SUCCEEDS
//       would advance the cursor, permanently consume the mail, and record ZERO
//       mail_rx. Recording before subscribe closes that hole -- permanently
//       dead-lettered mail still counts -- and keeps the record ahead of the
//       allowedSender/moderate gates (a rejected or blocked inbound costs money
//       either way). Inbound counting is AT-LEAST-ONCE under DO redelivery (spec
//       round-3 amendment): the closure runs transitively inside handleInbound via
//       deps.handleWebhook, so a deadLetter() that throws leaves the cursor
//       un-advanced and the redelivered inbound re-records -- the bounded, accepted
//       overcount (the schema carries no provider/message id, so dedup is
//       impossible downstream). The counterpart is canonicalMail(item.from) -- the
//       ONE definition in transcript.ts, the same form mail-cli's sendRaw/sendReply
//       record as mail_tx, so rx and tx collapse onto one label series. recordSignal
//       never throws, so metering cannot break the dispatch path;
//   (3) await thread.subscribe();
//   (4) append -> sender authorization -> canonical sender admission/handoff
//       consumption -> moderation -> notify. The claim boundary intentionally
//       precedes moderation so a blocked admitted inbound still suppresses a
//       duplicate automatic morning delivery.
export function makeHandleMessage(opts: HandleMessageOpts): (thread: any, message: any) => Promise<void> {
  const append = opts.append ?? appendMailTranscript;
  const moderateImpl = opts.moderateImpl ?? moderate;
  return async (thread: any, message: any): Promise<void> => {
    const item = messageItem(thread, message);
    recordSignal({ t: Date.now(), kind: "mail_rx", counterpart: canonicalMail(item.from) });
    await thread.subscribe();
    await append(item.from, {
      direction: "in",
      at: item.at,
      subject: item.subject,
      content: item.content,
      threadId: item.threadId,
      messageId: item.messageId,
    });
    if (!allowedSender(item.from, opts.env, opts.allowlistPath)) {
      opts.logErr(`mail: rejected inbound sender ${item.from}`);
      return;
    }
    const admittedAddress = admitEmail(extractEmailAddress(item.from));
    if (admittedAddress === null) {
      opts.logErr("mail: rejected inbound sender");
      return;
    }
    const morningClaim = await opts.consumeMorningHandoff?.(item, admittedAddress) ?? null;
    const verdict = await moderateImpl(item.content, "in");
    if (!verdict.allowed) {
      opts.logErr(`mail: moderation blocked inbound from ${item.from}${verdict.category ? ` (${verdict.category})` : ""}`);
      return;
    }
    const envelope = morningClaim ? { ...item, morningClaim } : item;
    const sequence = opts.admissionSequence?.();
    if (opts.admissions && sequence !== undefined) {
      const candidate = {
        queue: "mail" as const, sequence, workId: admissionWorkId("mail", sequence), admittedAt: item.at,
        variant: "agent-dispatch" as const, input: envelope,
        state: "pending" as const, attempts: 0, nextAttemptAt: 0,
      };
      // The first durable admission alone owns scheduling. A redelivered webhook
      // sees its immutable envelope and cannot queue a second run behind one already
      // replayed or in flight.
      if (opts.admissions.admit(candidate) !== candidate) return;
      opts.notify(item.from, { ...envelope, workId: candidate.workId });
      return;
    }
    opts.notify(item.from, envelope);
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
  | { kind: "succeeded"; source: "mail"; completedAt: string; providerReceipts: Array<{ idempotencyKey: string; providerId: string }> }
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
  return async (_from: string, item: MailDispatchEnvelope): Promise<MailRunOutcome> => {
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
    const { failed, outOfTokens } = await runAgentImpl({
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
        completedAt: new Date().toISOString(),
        providerReceipts: item.workId ? providerReceiptsForWork(item.workId) : [],
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
}

export type MailDispatchEnvelope = MailDispatchItem & {
  morningClaim?: MorningHandoffClaim;
  workId?: string;
  /** Scheduling batch membership; immutable records remain one-per-work-ID. */
  workIds?: string[];
};

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
  const consumeMorningHandoff = async (_item: MailDispatchItem, address: string): Promise<MorningHandoffClaim | null> => {
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
    const decision = await directConsume(occurrence, identity.directConsume.contact, identity.directConsume.address, roster, capturedAt);
    deps.logErr(`mail: morning handoff ${decision}`);
    return decision === "direct-consumed" ? makeMorningClaim(occurrence, capturedAt, identity.audience) : null;
  };
  const run = makeMailRunFn({
    env: deps.env, runEnv: deps.runEnv, model: deps.model, logErr: deps.logErr,
    runAgent: deps.runAgent, introDecision: deps.introDecision,
    discoveryDecision: deps.discoveryDecision, prepareMorningHandoff: deps.prepareMorningHandoff,
    providerReceiptsForWork: deps.providerReceiptsForWork,
  });
  const admissions = deps.admissions;
  const nowMs = deps.nowMs ?? Date.now;
  const setTimer = deps.setTimeoutImpl ?? setTimeout;
  const clearTimer = deps.clearTimeoutImpl ?? clearTimeout;
  const maxRuns = deps.maxRunsPerWindow ?? 60;
  const windowMs = deps.windowMs ?? 3_600_000;
  const starts = new Map<string, number[]>();
  const scheduled = new Set<string>();
  let retryTimer: NodeJS.Timeout | undefined;
  let schedulerActive = false;

  const retryAt = (record: AgentDispatchRecord, reason: AgentRetryReason, message?: string, exactAt?: number): void => {
    if (!admissions) return;
    const base = Math.max(1, deps.retryDelayMs ?? 1_000);
    const boundedBackoff = Math.min(5 * 60_000, base * (2 ** Math.min(record.attempts, 8)));
    admissions.retry(record.workId, exactAt ?? (nowMs() + boundedBackoff), { kind: "retry", reason, ...(message ? { message } : {}) });
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
    admissions.permanentFailure(record.workId, {
      kind: "permanent-failure",
      source: "mail",
      message,
      sourceDlq: { surface: "mail", recordedAt },
    });
  };

  const runRecord = async (record: AgentDispatchRecord): Promise<void> => {
    if (!admissions) return;
    scheduled.delete(record.workId);
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
    admissions.beginAttempt(current.workId);
    recordStart(input.from);
    try {
      const outcome = await run(input.from, { ...input, workId: current.workId });
      if (outcome.kind === "succeeded") {
        admissions.succeed(current.workId, outcome);
      } else if (outcome.kind === "retry") {
        retryAt(current, outcome.reason);
      } else {
        permanent(current, outcome.message);
      }
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      const isPermanent = deps.isPermanentFailure?.(error) ?? (error as { permanent?: unknown })?.permanent === true;
      if (isPermanent) permanent(current, message);
      else retryAt(current, "transient-error", message);
    }
  };

  let dispatcher: MailDispatcher;
  const pumpRetries = (): void => {
    if (!schedulerActive || !admissions) return;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = undefined; }
    const currentTime = nowMs();
    for (const record of admissions.dueAgents(currentTime)) enqueueRecord(record);
    let earliest: number | null = null;
    for (const record of admissions.records()) {
      if (record.variant !== "agent-dispatch" || (record.state !== "pending" && record.state !== "retry-wait") || scheduled.has(record.workId)) continue;
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
    runFn: async (from, item) => {
      if (!admissions) { await run(from, item); return; }
      const workIds = item.workIds ?? (item.workId ? [item.workId] : []);
      const records = workIds
        .map((workId) => admissions.agent(workId))
        .filter((record): record is AgentDispatchRecord => record !== undefined)
        .sort((left, right) => left.sequence - right.sequence);
      for (const record of records) await runRecord(record);
      pumpRetries();
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
    admissionSequence: deps.admissionSequence,
  });
  const replay = () => {
    if (!admissions) return;
    schedulerActive = true;
    admissions.recoverInterrupted(nowMs());
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
    idleForever();
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
  const { adapter, chat, state } = buildChat();
  // Initialize before any inbound arrives: connects the SQLite state adapter AND
  // runs adapter.initialize() (builds the WebhookHandler + binds the chat), which
  // handleWebhook requires. We call adapter.handleWebhook() directly (not through
  // the Chat instance), so the SDK's auto-init on chat methods never fires for the
  // inbound path -- without this, every inbound dead-letters with "Adapter not
  // initialized." The Chat SDK's initialize() is idempotent (guarded by `initialized`).
  await chat.initialize();
  // The production event handlers are built by the exported factory; do not
  // duplicate its admission/claim/coalescing order here. The link drain is
  // serialized, so this single sequence slot binds adapter callbacks to exactly
  // the inbound envelope being applied.
  const admissions = new QueueAdmissionOutbox(defaultAdmissionOutboxPath(dirname(MAIL_LINK_STATE_PATH)));
  let admissionSequence: number | undefined;
  const mailDispatcher = makeMailDispatcher({
    env: deps.env, runEnv: RUN_ENV, model: MODEL, logErr: deps.logErr,
    admissions, admissionSequence: () => admissionSequence,
  });
  chat.onNewMention(mailDispatcher.handleMessage);
  chat.onSubscribedMessage(mailDispatcher.handleMessage);
  mailDispatcher.replay();

  const link = new HomeLink({
    connect: signedMailLinkConnect(keys, deps.makeSocket),
    viewVersion: () => null,
    appliedThrough: () => loadCursor(),
    logErr: deps.logErr,
  });
  let chain: Promise<void> = Promise.resolve();
  link.onCommand((payload) => {
    if (!isMailPayload(payload)) { deps.logErr("mail: bad inbound payload"); return; }
    chain = chain.then(() => handleInbound(payload, {
      cursorLoad: loadCursor,
      cursorStore: storeCursor,
      sendAck: (n) => link.sendAck(n),
      handleWebhook: async (request, payload) => {
        admissionSequence = payload.id;
        try { await dispatchInboundMail(adapter, state, request); }
        finally { admissionSequence = undefined; }
      },
      deadLetter: (p, err) => recordDeadLetter("mail", { id: p.id, at: p.at, error: String((err as Error)?.stack ?? err), payload: p }),
      logErr: deps.logErr,
    })).catch((err) => deps.logErr(`mail drain: inbound not fully recorded -- the DO may redeliver: ${err}`));
  });
  link.start();
  idleForever();
  deps.log(`mail: surface up (tenant ${keys.tenant}) -> ${keys.endpoint}`);
}

function idleForever(): void { setInterval(() => {}, 2 ** 31 - 1); }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(async (err) => { logErr(`mail: fatal: ${(err as Error).message}`); await flushLogs(); process.exit(1); });
}
