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
import { buildChat, mintAttachmentDownload, mintAttachmentById, attachmentDownloadUrl } from "./mail-cli.ts";
import { isModelFetchableUrl, type MediaItem } from "./harnesses/runner-common.ts";
import { appendMailTranscript } from "./mail-transcript.ts";
import { deadLetter as recordDeadLetter } from "./dead-letter.ts";
import { moderate } from "./moderation.ts";
import { extractEmailAddress, canonicalMail, cleanForPrompt, cleanForPromptLine } from "./transcript.ts";
import { recordSignal } from "./signal-store.ts";
import { runAgent, ensureSkills, ensurePlaywrightConfig, logErr, flushLogs, loggerFor } from "./runtime.ts";
import { projectsPreamble } from "./projects-cli.ts";
import { householdPreamble } from "./household.ts";
import { loadAllowlist, nameForAddress } from "./allowlist.ts";
import { loadHomeKeys, type HomeKeys } from "./home-mirror.ts";
import { introDecision, introNote, markExplained } from "./intro-state.ts";
import { MAIL_KEYS_PATH, MAIL_LINK_STATE_PATH, MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR } from "./paths.ts";
import { MAIL_CLI, MAIL_TOOLS, MAIL_SKILL_SRCS } from "./grants.ts";

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
  handleWebhook: (request: Request) => Promise<void>;
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
    await deps.handleWebhook(request);
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
  const operator = (env.OPERATOR_EMAIL || "").trim();
  return [...allow.senders, operator].some((entry) => entry.trim().toLowerCase() === normalized);
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

export function buildPrompt(item: MailDispatchItem): string {
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
  // element is simply ABSENT otherwise, so a flag-off prompt is byte-identical to the
  // pre-intro build (pinned by a test).
  const intro = introNote(introDecision(process.env));
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
    // the blank line, the lead-in, and the preamble body, immediately before Projects.
    "",
    "The people in this household, and how to reach them:",
    householdPreamble(),
    `Projects: ${projectsPreamble()}`,
    ...(intro ? [intro] : []),
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

// Options for makeHandleMessage (below): the production wiring plus the two
// injectable impls (append/moderate) tests substitute. Dependency surface stays
// MINIMAL by design -- this is the spec-approved testability seam for the
// chat-event dispatch closure, not a broader refactor.
export interface HandleMessageOpts {
  env: NodeJS.ProcessEnv;
  notify: (from: string, item: MailDispatchItem) => void;
  logErr: (m: string) => void;
  append?: typeof appendMailTranscript;
  moderateImpl?: typeof moderate;
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
//   (4) the append -> allowedSender -> moderate -> notify chain, unchanged.
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
    if (!allowedSender(item.from, opts.env)) {
      opts.logErr(`mail: rejected inbound sender ${item.from}`);
      return;
    }
    const verdict = await moderateImpl(item.content, "in");
    if (!verdict.allowed) {
      opts.logErr(`mail: moderation blocked inbound from ${item.from}${verdict.category ? ` (${verdict.category})` : ""}`);
      return;
    }
    opts.notify(item.from, item);
  };
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
  const { adapter, chat } = buildChat();
  // Initialize before any inbound arrives: connects the SQLite state adapter AND
  // runs adapter.initialize() (builds the WebhookHandler + binds the chat), which
  // handleWebhook requires. We call adapter.handleWebhook() directly (not through
  // the Chat instance), so the SDK's auto-init on chat methods never fires for the
  // inbound path -- without this, every inbound dead-letters with "Adapter not
  // initialized." The Chat SDK's initialize() is idempotent (guarded by `initialized`).
  await chat.initialize();
  const dispatcher = new ChannelDispatcher<MailDispatchItem>({
    debounceMs: 1200,
    maxConcurrent: 3,
    maxRunsPerWindow: 60,
    windowMs: 3_600_000,
    runFn: async (_from, item) => {
      // The first-contact decision for THIS run, captured at dispatch time (same
      // inputs buildPrompt renders from); marked below after a completed run. Mail
      // never carries the card block (SMS-only), so only the explain flag applies.
      const intro = introDecision(deps.env);
      // Route an email carrying forwardable attachments to the multimodal model with the
      // images/PDFs attached (minted lazily here, only when the run actually fires after the
      // debounce). A text-only email, or an unconfigured multimodal model, keeps RUN_ENV.
      const media = MULTIMODAL_MODEL ? await selectMailMedia(item, { logErr: deps.logErr }) : [];
      const env = media.length
        ? { ...RUN_ENV, BAXTER_MODEL_OVERRIDE: MULTIMODAL_MODEL, BAXTER_MEDIA: JSON.stringify(media) }
        : RUN_ENV;
      const { failed, outOfTokens } = await runAgent({
        prompt: buildPrompt(item),
        logId: item.messageId,
        surface: "mail",
        cwd: MEMORY_DIR,
        model: MODEL,
        allowedTools: MAIL_TOOLS,
        runsDir: MAIL_RUNS_DIR,
        receivedAt: item.at,
        env,
        beforeRun: () => {
          ensurePlaywrightConfig(MEMORY_DIR);
          ensureSkills(MAIL_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
        },
      });
      // First-contact latch write (spec §5): the surface process marks explainedAt
      // once the run whose prompt carried the intro block completed with a reply/emit
      // (failed/outOfTokens both mean nothing went out, per runAgent's contract).
      // Best-effort: a latch write failure logs and never fails anything here.
      if (!failed && !outOfTokens) {
        try {
          if (intro.explain) markExplained();
        } catch (err) { deps.logErr(`mail: intro latch write failed: ${(err as Error).message}`); }
      }
    },
  });

  const handleMessage = makeHandleMessage({
    env: deps.env,
    notify: (from, item) => dispatcher.notify(from, item),
    logErr: deps.logErr,
  });
  chat.onNewMention(handleMessage);
  chat.onSubscribedMessage(handleMessage);

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
      handleWebhook: async (request) => { await adapter.handleWebhook(request); },
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
