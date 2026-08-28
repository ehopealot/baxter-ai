#!/usr/bin/env node
// Home Chats surface daemon (spec: docs/superpowers/plans/2026-08-05-home-chats.md,
// Phase 3). A long-running process, gated by the `chat` token in BAXTER_SURFACES
// (compose profile, wired in Task 3.4). Holds one persistent SigV4-signed link to the
// control-plane Durable Object (dialing /chat-link, a SEPARATE socket from the
// checklist /link and the sms-link -- see chat-link.ts's own header on the worker
// side), drains create-chat/send-message INTENTS the DO relays from the browser
// (not commands, unlike sms-bot -- see home-link.ts's injectable `isIntent`, added by
// this task so ONE HomeLink transport class can back both domains), appends each
// human message to the locked container-side transcript (chat-transcript.ts), and
// wakes a SCOPED agent run per human message. Baxter's own replies go out via
// `chat-cli send` (a DIFFERENT write path -- straight to chat-transcript.ts, never
// through the link), so this file's own fs.watch on CHATS_DIR is what turns EITHER
// kind of append (or a title being set) into a `changed` ping up the link.
//
// Mirrors sms-bot.ts closely -- same link lifecycle, same cursor/ack discipline, same
// chained-serialization-of-inbound pattern, same scoped-run dispatch via
// ChannelDispatcher -- with three real differences: (1) chat drains INTENTS (browser-
// authored, DO-validated) rather than an inbound SMS payload; (2) chat is a shared,
// multi-author thread, so renderHistory labels by the message's own authorName rather
// than a fixed "The person"; (3) chat also owns an fs.watch -> `changed` push (folded
// in here rather than a separate home-mirror.ts-style module, since -- unlike the
// checklist link -- there is no separate "apply a tap through the shared store lock"
// concern: chat-transcript.ts's own proper-lockfile IS that gate).
import { mkdirSync, readFileSync, writeFileSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import { HomeLink, type WebSocketLike } from "./home-link.ts";
import { ChannelDispatcher } from "./dispatcher.ts";
import type { LightLifecycle } from "./light-lifecycle.ts";
import { deadLetter as recordDeadLetter } from "./dead-letter.ts";
import {
  createChat, deleteChat, appendMessage, listChats, readMessages, setTitle,
  setTitleIfUntitled, isPermanentChatTranscriptError,
  type ChatMessage, type ChatMeta, type ChatAuthor,
} from "./chat-transcript.ts";
import { replayChatOutputs, sendReply as sendChatReply } from "./chat-cli.ts";
import { titleFor } from "./chat-title.ts";
import { runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, skillsPreamble, log, logErr, flushLogs, FALLBACK_NOTICE, loggerFor } from "./runtime.ts";
import { cleanForPrompt } from "./transcript.ts";
import { collectionsPreamble } from "./collections-cli.ts";
import { householdPreamble } from "./household.ts";
import { loadHomeKeys, type HomeKeys } from "./home-mirror.ts"; // key loader lives here, same as sms-bot's import
import { introDecision, introNote, markExplained, type IntroDecision } from "./intro-state.ts";
import { householdTz } from "./household-tz.ts";
import { loadAllowlist, type Allowlist, type LoaderDiagnosticSink } from "./allowlist.ts";
import { resolveRecipients } from "./recipients.ts";
import { canonicalMorningOccurrence, handoffPromptBlock, householdAudience, makeMorningClaim, retainEarliestClaim, type MorningHandoffClaim } from "./morning-handoff.ts";
import { sharedClose, type SharedResult } from "./morning-handoff-store.ts";
import { morningCheckInDefinition, prepareMorningHandoff } from "./morning-check-in.ts";
import { readTasksForMorningHandoff } from "./schedule-store.ts";
import { CHAT_STATE_PATH, CHATS_DIR, MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR, QUEUE_ADMISSION_OUTBOX_PATH } from "./paths.ts";
import { QueueAdmissionOutbox, admissionWorkId, type AgentDispatchRecord, type AgentRetryReason } from "./queue-admission-outbox.ts";
import { loadDurableCursor, storeDurableCursor } from "./durable-cursor.ts";
import { CHAT_TOOLS, CHAT_SKILL_SRCS, CHAT_SKILL_NAMES, loadedSkillsList } from "./grants.ts";
import { summary, creditBudgetUsd } from "./usage-store.ts";

// APP_DIR computed the same way grants.ts/sms-bot.ts do (it is NOT exported from paths.ts).
const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// Chat's own run-log dir -- NOT sms's SMS_RUNS_DIR or discord's RUNS_DIR, so the three
// surfaces' run logs never co-mingle.
const CHAT_RUNS_DIR = join(APP_DIR, ".claude", "chat-runs");
// The rich chat persona/briefing template, shipped alongside sms-prompt.md/discord-
// prompt.md at APP_DIR (COPY . . in the Dockerfile picks up app/*.md).
const PROMPT_PATH = join(APP_DIR, "chat-prompt.md");
const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter";
// The run's cwd .claude/skills dir the baked/learned skills stage into (same as every
// other surface -- runs across all surfaces share MEMORY_DIR as cwd).
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");

// ---------- chat intents (down-direction, DO -> container) ----------

// Mirrors workers/home/src/chat-link.ts's `ChatIntent` union field-for-field (separate
// repos, no shared import -- same discipline home-link.ts's own checklist `Intent`
// mirror follows). `at` is REQUIRED (not optional, unlike the checklist Intent's `at?`):
// the checklist's applyIntent has a `new Date().toISOString()` fallback for a missing
// `at`; chat-transcript.ts's createChat/appendMessage take `at`/`now` as a plain
// required string with no such fallback, so an intent without one has nothing safe to
// fall back to here.
export type ChatIntent =
  | { id: number; kind: "create-chat"; at: string }
  | { id: number; kind: "send-message"; chatId: string; text: string; authorId: string; authorName: string; at: string }
  | { id: number; kind: "delete-chat"; chatId: string; at: string };

// Cap on a single chat message's `text`. No worker-side cap exists yet (chat-link.ts's
// ChatIntent carries `text` unbounded on the wire) -- this is a container-side
// defensive bound, mirroring home-link.ts's own MAX_LIST_NAME (defined locally when no
// store constant exists to borrow). Generous relative to checklist-store's
// MAX_ITEM_TEXT (1000 -- a checklist item is short by nature): a chat message is
// closer in kind to an email/SMS body. Exported so a worker-side mirror can match it
// if one is ever added.
export const MAX_CHAT_TEXT = 4000;

// Cap on `authorName`/`authorId`. Review finding (round 1 on c61d433): these were
// previously only `typeof === "string"`-checked, unbounded -- but authorName is
// attacker-reachable (this file's own header: a household member's display name, or
// a compromised session) and gets interpolated as the column-0 speaker label on
// EVERY rendered line, and buildPrompt/renderHistory re-render it across up to 50
// messages on every future run in that conversation. An oversized authorName would
// silently bloat every later prompt in the thread -- the same cost/context-bloat risk
// MAX_CHAT_TEXT (and, on the checklist side, MAX_LIST_NAME) exist to close. This is
// defense-in-depth even though the DO stamps the author (see handleIntent's own
// "trusted" comment) -- validated here anyway, like every other bounded field, rather
// than assuming the DO-side length is itself bounded. authorId shares the same cap AND
// (in the send-message arm below) a `member:` prefix requirement: the down direction
// only ever legitimately carries `member:<address>`, and authorId is NOT
// prompt-inert -- renderHistory (below) trust-branches on `authorId === "baxter"` to
// render a row as the persona's own turn and instruct the model to skip it, so a
// link-delivered send-message with `authorId: "baxter"` would be silently attributed
// to Baxter and never answered. The DO does stamp `member:${self.address}` today
// (object.ts never reads the client's authorId), so this is defense-in-depth like
// authorName's bound -- it proves the `intent.authorId as ChatAuthor` cast in
// handleIntent rather than assuming the DO-side shape.
export const MAX_AUTHOR_NAME = 200;

const CHAT_ID_RE = /^wc-\d+$/;

// Validator for an inbound chat intent frame, mirroring home-link.ts's checklist
// `isIntentLike` in shape and discipline (reject a drifted/malformed peer BEFORE it
// reaches handleIntent, not after) but scoped to chat's own two kinds. Registered as
// HomeLink's injectable `isIntent` dep (Task 3.2's addition to home-link.ts) so the
// SAME transport class the checklist link uses can also validate this structurally
// different intent shape.
export function isChatIntentLike(v: unknown): v is ChatIntent {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as { id?: unknown; kind?: unknown; chatId?: unknown; text?: unknown; authorId?: unknown; authorName?: unknown; at?: unknown };
  if (!Number.isSafeInteger(o.id)) return false;
  if (typeof o.at !== "string") return false;
  switch (o.kind) {
    case "create-chat":
      return true; // just the id (+ the id/at already checked above)
    case "send-message":
      return typeof o.chatId === "string" && CHAT_ID_RE.test(o.chatId)
        && typeof o.text === "string" && o.text.trim().length > 0 && o.text.length <= MAX_CHAT_TEXT
        && typeof o.authorId === "string" && o.authorId.startsWith("member:") && o.authorId.length <= MAX_AUTHOR_NAME
        && typeof o.authorName === "string" && o.authorName.length <= MAX_AUTHOR_NAME;
    case "delete-chat":
      return typeof o.chatId === "string" && CHAT_ID_RE.test(o.chatId);
    default:
      return false;
  }
}

// ---------- SigV4-signed chat-link connect (folds in Task 2.5) ----------

// Mirrors sms-bot.ts's signedSmsLinkConnect (itself mirroring home-bot.ts's
// signedLinkConnect) but dials /chat-link -- the DEDICATED chat socket
// (chatLinkUpgrade/acceptChatLink on the worker side), separate from both the
// checklist /link and sms's /sms-link. Signed fresh on every dial (x-amz-date skew
// window; see signedLinkConnect's header comment for why this must be a per-call
// closure, not a construction-time signature). Same credential + service ("home") the
// other two links use.
export function signedChatLinkConnect(
  keys: HomeKeys,
  makeSocket: (url: string, headers: Record<string, string>) => WebSocketLike =
    (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike,
): () => Promise<WebSocketLike> {
  const aws = new AwsClient({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: "auto", service: "home" });
  const linkUrl = `${keys.endpoint.replace(/\/+$/, "")}/chat-link`;
  const wssUrl = linkUrl.replace(/^http/, "ws");
  return async () => {
    const signed = await aws.sign(linkUrl, { method: "GET" });
    return makeSocket(wssUrl, {
      authorization: signed.headers.get("authorization") ?? "",
      "x-amz-date": signed.headers.get("x-amz-date") ?? "",
    });
  };
}

// ---------- chat index digest (this link's own "viewVersion") ----------

// Deterministic serialization: sort object keys recursively, preserve array order --
// a LOCAL copy of home-mirror.ts's own `canonicalize`/`viewVersion` (not imported: that
// pair is typed over the checklist `View`, and chat's index has a structurally
// different shape -- same "define locally, don't cross domains" discipline
// chat-link.ts's own header comment describes for the worker side of this exact
// mirror). Any content change (a chat created, a message appended -- which bumps the
// chat's `lastAt` in the index, see chat-transcript.ts's appendMessage -- or a title
// set) changes the digest, which is exactly what chat-link.ts's reduceHello/
// reduceChanged compare against their own stored `chatIndexVersion` to decide
// staleness.
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}
export function chatIndexVersion(chats: ChatMeta[] = listChats()): string {
  return createHash("sha256").update(canonicalize(chats)).digest("hex");
}

// ---------- container-side appliedThrough cursor (persisted for restart safety) ----------

function loadCursor(): number { return loadDurableCursor(CHAT_STATE_PATH); }
function storeCursor(n: number): void { storeDurableCursor(CHAT_STATE_PATH, n); }

// ---------- applying one drained intent ----------

export type ChatDispatchIntent = ChatIntent & {
  /** Durable queue/output identity, absent on the resident compatibility path. */
  workId?: string;
  /** Legacy resident scheduling path; durable dispatch persists the rendered block. */
  morningClaim?: MorningHandoffClaim;
  /** Dispatcher-prepared, durable prompt input for an admitted attempt. */
  morningHandoff?: string;
};

export type ChatRunOutcome =
  | { kind: "succeeded"; source: "chat"; completedAt: string; providerReceipts: Array<{ idempotencyKey: string; providerId: string }> }
  | { kind: "retry"; source: "chat"; reason: "agent-failed" | "out-of-tokens" }
  | { kind: "permanent-failure"; source: "chat"; message: string };

export interface ChatIntentDrainLink {
  onIntent(callback: (intent: ChatIntent) => void): void;
  onOpen(callback: () => void): void;
  start(): void;
  restart?(): void;
}

/**
 * Serialize the cumulative-ACK drain. Once a lower sequence fails, already
 * queued higher work is held back and a reconnect requests ascending replay
 * from the DO's durable cursor. The open barrier is chained ahead of that new
 * replay so no higher ACK can pass an unresolved lower sequence.
 */
export function wireChatIntentDrain(
  link: ChatIntentDrainLink,
  handle: (intent: ChatIntent) => Promise<void>,
  logErrFn: (message: string) => void,
  lifecycle?: LightLifecycle,
): { flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  let failedFloor = Infinity;
  link.onOpen(() => {
    const release = lifecycle?.admit("chat:socket-open");
    if (lifecycle && !release) return;
    chain = chain.then(() => { failedFloor = Infinity; }).finally(() => release?.());
  });
  link.onIntent(intent => {
    const release = lifecycle?.admit("chat:socket-intent");
    if (lifecycle && !release) return;
    chain = chain.then(async () => {
      if (intent.id > failedFloor) return;
      await handle(intent);
    }).catch(error => {
      failedFloor = Math.min(failedFloor, intent.id);
      logErrFn(`chat drain: intent ${intent.id} not fully recorded -- forcing ordered replay before any higher ACK: ${error}`);
      if (link.restart) link.restart(); else link.start();
    }).finally(() => release?.());
  });
  return { flush: () => chain };
}

export interface ChatIntentDeps {
  cursorLoad: () => number;
  cursorStore: (n: number) => void;
  sendAck: (appliedThrough: number) => void;
  dispatch: (chatId: string, intent: ChatDispatchIntent) => void;
  /**
   * Persists agent ownership after the transcript append and before every
   * post-append side effect, cursor write, or ACK. False means a redelivery
   * found the immutable envelope and must not queue another run.
   */
  admit?: (intent: Extract<ChatIntent, { kind: "send-message" }>) => boolean;
  /** Classifies every sequence that intentionally owns no agent run. */
  classifyNonAgent?: (intent: ChatIntent, outcomeType: string) => void;
  /** Durable factories move every post-admission effect under dispatcher ownership. */
  deferPostAdmission?: boolean;
  /** Called only after a send-message append has completed successfully. */
  consumeMorningHandoff?: (intent: Extract<ChatIntent, { kind: "send-message" }>) => Promise<MorningHandoffClaim | null>;
  titleFor?: (firstMessage: string) => Promise<string>;
  // Record a poison intent (preserve it) when applying it fails non-retryably. MAY throw
  // (if the DLQ write itself fails) -- handleIntent lets that propagate so the cursor is
  // NOT advanced and the DO redelivers. See dead-letter.ts.
  deadLetter: (intent: ChatIntent, err: unknown) => void;
  logErr: (m: string) => void;
  /** Only deterministic semantic transcript conflicts may consume through the DLQ. */
  isPermanentFailure?: (error: unknown) => boolean;
}

// Fire-and-forget resident titling for a freshly-untitled chat's first message:
// ordinary network/timeout/empty failures fall back to a timestamp title (typed
// lease revocation is caught and logged here; durable mode awaits it and retries).
// This still floats independently of handleIntent's own await chain (per
// the brief: titling must never block or fail the reply/dispatch below it). The
// listChats()/setTitle calls are still guarded here regardless, since an unexpected
// fs error from EITHER (not titleFor itself) must not become an unhandled rejection.
function maybeTitle(chatId: string, firstMessage: string, logErrFn: (m: string) => void, titleForImpl: (firstMessage: string) => Promise<string> = titleFor): void {
  let chat: ChatMeta | undefined;
  try {
    chat = listChats().find((c) => c.id === chatId);
  } catch (err) {
    logErrFn(`chat titling: could not read the chat index (${(err as Error).message})`);
    return;
  }
  if (!chat || chat.title !== null) return;
  titleForImpl(firstMessage)
    .then((title) => setTitle(chatId, title))
    .catch((err) => logErrFn(`chat titling: ${(err as Error).message}`));
}

// Apply one drained chat intent: create-chat mints an index entry (idempotent on the
// deterministic `wc-<id>`, see chat-transcript.ts's createChat); send-message appends
// the human's message to the transcript (the DO-stamped authorId/authorName are
// TRUSTED here -- the DO is the identity authority behind SigV4, so this does NOT
// re-derive or re-validate them beyond isChatIntentLike's shape check), fires titling
// when the chat is still untitled, and dispatches a scoped run. Mirrors sms-bot.ts's
// handleInbound: cursor-gated (an already-applied id is skipped but still re-acked, so
// a redelivery after a lost ack doesn't double-append or double-dispatch), and the
// cursor is persisted BEFORE the ack (crash-safety -- a crash here just redelivers).
export async function handleIntent(intent: ChatIntent, deps: ChatIntentDeps): Promise<void> {
  const cursor = deps.cursorLoad();
  if (intent.id <= cursor) { deps.sendAck(cursor); return; } // already applied; re-ack to prompt DO prune
  let applied = true;
  let nonAgentOutcome: string | undefined;
  // The try wraps ONLY the store write -- NOT the post-apply titling/dispatch below. The
  // catch's classification is "poison: the message was NOT applied", so it must not fire
  // for a failure AFTER the write already landed the message in the transcript (replaying
  // that DLQ entry would double-append). See the `if (applied ...)` block below.
  try {
    switch (intent.kind) {
      case "create-chat":
        await createChat(`wc-${intent.id}`, intent.at);
        break;
      case "delete-chat":
        await deleteChat(intent.chatId);
        break;
      case "send-message": {
        const message: ChatMessage = {
          id: `wc-${intent.id}`,
          at: intent.at,
          authorId: intent.authorId as ChatAuthor, // trusted -- see this function's header comment
          authorName: intent.authorName,
          content: intent.text,
        };
        await appendMessage(intent.chatId, message);
        break;
      }
    }
  } catch (err) {
    // A transcript/index/storage failure is retryable by default. Only explicit
    // semantic conflicts (missing/deleted chat or a changed deterministic message
    // ID) are poison. This is essential after a message append: redelivery safely
    // reconciles that row under lock and retries the index/admission tail.
    const permanent = deps.isPermanentFailure?.(err) ?? isPermanentChatTranscriptError(err);
    if (!permanent) throw err;
    applied = false;
    nonAgentOutcome = "chat-transcript-poison";
    deps.deadLetter(intent, err);
    deps.logErr(`chat handleIntent: dead-lettered intent ${intent.id} (${(err as Error)?.message ?? err})`);
  }
  // Titling + dispatch run ONLY after a successful apply. Both are non-throwing today
  // (maybeTitle guards its own sync calls and floats titleFor; dispatch is synchronous
  // map/timer work), but keeping them outside the try makes that independence explicit
  // rather than a silent precondition of the DLQ's "not applied" classification.
  if (applied && intent.kind !== "send-message") {
    deps.classifyNonAgent?.(intent, intent.kind === "create-chat" ? "chat-create" : "chat-delete");
  } else if (!applied) {
    deps.classifyNonAgent?.(intent, nonAgentOutcome ?? "chat-no-agent-dispatch");
  }
  if (applied && intent.kind === "send-message") {
    // Admission is deliberately ahead of the handoff sidecar and auto-title:
    // neither may become a crash window in which an accepted turn has mutated
    // chat state but has no durable dispatcher owner.
    const newlyAdmitted = deps.admit?.(intent) ?? true;
    if (newlyAdmitted && !deps.deferPostAdmission) {
      // Resident compatibility keeps the historical append -> close -> title ->
      // dispatch order. Durable admission has already fenced this path above.
      let morningClaim: MorningHandoffClaim | null = null;
      try { morningClaim = await deps.consumeMorningHandoff?.(intent) ?? null; }
      catch { /* sidecar failure preserves the normal chat path */ }
      maybeTitle(intent.chatId, intent.text, deps.logErr, deps.titleFor);
      deps.dispatch(intent.chatId, morningClaim ? { ...intent, morningClaim } : intent);
    }
  }
  deps.cursorStore(intent.id);
  deps.sendAck(intent.id);
}

// ---------- rendering the transcript into the prompt ----------

// Same composed sanitizer sms-bot.ts uses (see its own header comment for the full
// normalize-then-neutralize rationale) -- load-bearing here for the SAME reason plus
// one more: unlike sms-bot's fixed "The person"/"{{PERSONA_NAME}} (you)" labels, a
// chat message's `authorName` is itself attacker-reachable (any household member, or
// a compromised session) and gets INTERPOLATED as the column-0 speaker label -- so it
// must be sanitized too, not just the body. See renderHistory below for how the two
// are composed BEFORE the anti-forgery indent, not after.
const clean = cleanForPrompt;

// Render the chat transcript into a sanitized, oldest-first history, one line per
// message, labelled by the message's own authorName (NOT a generic "The person" --
// chat is a shared, multi-author thread, so the model needs to know WHO said what) or
// `{{PERSONA_NAME}} (you)` for Baxter's own messages (authorId === "baxter", a fixed
// literal -- never derived from the possibly-attacker-influenced authorName field even
// on Baxter's own rows, since chat-cli.ts always writes PERSONA_NAME there itself).
//
// Composition order is the load-bearing anti-forgery bit, and DIFFERENT from
// sms-bot.ts's renderHistory: sms-bot only ever indents the BODY's embedded newlines
// (`\n` -> `\n    `), because its label ("The person"/"PERSONA_NAME (you)") is always a
// fixed, trusted string with no embedded newline to forge a new column-0 entry from.
// Here `who` can be an attacker-influenced authorName, so a raw `\n` inside IT would
// forge a new column-0 speaker line just as effectively as one inside the body would
// (cleanForPrompt/normalizeTranscriptText normalizes exotic line-break characters INTO
// `\n`, it does not remove `\n` itself -- see transcript.ts's own header comment). This
// composes the FULL `who: body` line first, THEN runs the newline-to-indented-
// continuation transform over the WHOLE thing -- so an embedded newline in EITHER
// field becomes an indented continuation, never a fresh column-0 line. Only the
// template's own leading `who:` for each entry is ever a real column-0 label.
export function renderHistory(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const isBaxter = m.authorId === "baxter";
      const who = isBaxter ? `${PERSONA_NAME} (you)` : clean(m.authorName);
      const body = clean(m.content);
      const line = `${who}: ${body}`;
      return line.split("\n").join("\n    ");
    })
    .join("\n");
}

// The [list:<slug>] marker shape the home worker's listChatSeed embeds. ANCHORED to the start: the
// seed LEADS with the marker, so pinning to position 0 makes "the genuine marker wins" a structural
// guarantee rather than a comment -- a family-authored list NAME embedding a marker-shaped substring
// sits LATER in the seed and can never precede it. (The worker's exported LIST_CHAT_SLUG_RE is the
// unanchored shape contract; core pins it to the seed slot.) If a seed ever fails to lead with the
// marker, this returns null -> tools UNBOUND, the safe failure, never a mis-bind.
const LIST_CHAT_SLUG_RE = /^\[list:([a-z0-9-]+)\]/;
// The checklist slug a per-list side chat is bound to, or null for an ordinary chat. Reads ONLY the
// SEED -- message 0 of the FULL log (readMessages with no limit; the home worker appends the seed at
// chat creation). Anchoring to that one slot is on purpose: a family-authored chat MESSAGE carrying
// a marker-shaped substring must NOT bind checklist tools to an arbitrary list, and the tail-50
// window buildPrompt uses would drop the oldest message (the seed) on a long thread -- a window scan
// both false-positives on user content AND silently loses the binding past message 50.
export function listChatSlug(chatId: string): string | null {
  const seed = readMessages(chatId)[0];
  if (!seed) return null;
  const hit = LIST_CHAT_SLUG_RE.exec(seed.content);
  return hit ? hit[1] : null;
}

// Fill the rich chat-prompt.md template, mirroring sms-bot.ts's buildPrompt: persona,
// this chat's own id (needed for the reply instruction, `chat-cli send {{CHAT_ID}}`),
// memory/credentials/skills paths, the injection-safe collections + loaded/learned skills
// preambles, and the SANITIZED transcript as HISTORY. Single-pass fillTemplate (see
// runtime.ts) so an inserted value is never re-scanned. The slot map is split out as
// promptSlots (like sms-bot's) so the byte-identity regression test can render the
// placeholder-INTRO-stripped template with the same slots and compare.
export function promptSlots(chatId: string, morningHandoff = "", capturedIntro?: IntroDecision): Record<string, string> {
  // First-contact intro (spec 2026-08-15-first-contact-intro-design §3): chat is not an
  // SMS surface, so only the shared "first exchange" block can ever render here -- the
  // contact-card line is SMS-1:1-only (introDecision's card flag needs isSms1to1).
  // A run passes its already captured decision; direct callers retain the ambient
  // derivation and flag-off bytes.
  const note = introNote(capturedIntro ?? introDecision(process.env));
  return {
    PERSONA_NAME,
    CHAT_ID: chatId,
    HISTORY: renderHistory(readMessages(chatId, 50)),
    MEMORY_PATH,
    CREDENTIALS_PATH,
    LEARNED_SKILLS_DIR,
    // The household roster (who lives here, how to reach them, how to reach someone
    // new) -- rendered fresh per build from the allowlist/home-keys via the shared
    // read-only helper (default paths; chat has no per-surface override to thread).
    HOUSEHOLD: householdPreamble(),
    COLLECTIONS_LIST: collectionsPreamble(),
    LOADED_SKILLS: loadedSkillsList(CHAT_SKILL_NAMES),
    LEARNED_SKILLS_LIST: skillsPreamble(),
    // A nonempty handoff includes its own leading separators, so no-block prompts
    // retain their exact historical bytes.
    MORNING_HANDOFF: morningHandoff,
    // Empty when no intro block is due -- the template embeds the placeholder INLINE
    // ("...chasing it here.{{INTRO_NOTE}}"), so an empty value restores the exact
    // pre-intro bytes; a due note arrives "\n\n"-prefixed to read as its own paragraph.
    INTRO_NOTE: note ? `\n\n${note}` : "",
  };
}

export function buildPrompt(chatId: string, morningHandoff = "", capturedIntro?: IntroDecision): string {
  return fillTemplate(readFileSync(PROMPT_PATH, "utf8"), promptSlots(chatId, morningHandoff, capturedIntro));
}

// ---------- model override (mirrors sms-bot.ts's SMS_MODEL/applySmsModelOverride) ----------

// CHAT_MODEL overrides BAXTER_MODEL for THIS surface only, falling back to
// BAXTER_MODEL then "sonnet" -- same fleet-default fallback chain every surface uses.
export function chatModel(env: NodeJS.ProcessEnv): string {
  return env.CHAT_MODEL || env.BAXTER_MODEL || "sonnet";
}

// Route an explicit CHAT_MODEL through BAXTER_MODEL_OVERRIDE, the per-run override the
// openrouter runner honors -- see sms-bot.ts's applySmsModelOverride for the full
// rationale (unchanged here, just CHAT_MODEL instead of SMS_MODEL). Gated strictly on
// CHAT_MODEL being explicitly set, for the same reason: chatModel()'s "sonnet"
// fallback is a claude alias, not a valid OPENROUTER_MODEL id.
export function applyChatModelOverride(runEnv: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const override = (env.CHAT_MODEL ?? "").trim();
  if (override) runEnv.BAXTER_MODEL_OVERRIDE = override;
  return runEnv;
}

// ---------- fs.watch(CHATS_DIR) -> changed ----------

// How long to fold repeated fs.watch events for one on-disk change into a single
// onChange() call -- courtesy debounce, not a correctness requirement (chat-link.ts's
// reduceChanged is itself a no-op when the carried viewVersion doesn't move). Same
// value as home-bot.ts's WATCH_DEBOUNCE_MS. Exported so tests can compute boundaries
// off this value rather than a copied literal.
export const WATCH_DEBOUNCE_MS = 200;

// Re-anchor the process's liveness with a dedicated ref'd fallback timer if the watch
// itself dies -- mirrors home-bot.ts's keepAliveFallback (see its own comment: the
// watcher's open fs handle is what keeps a standalone daemon alive between HomeLink's
// own deliberately-unref'd timers).
function keepAliveFallback(): ReturnType<typeof setInterval> {
  return setInterval(() => {}, 2 ** 31 - 1);
}

// Watch CHATS_DIR (recursively -- unlike home-bot.ts's single-file checklist watch,
// this tree holds index.json AND one messages.jsonl per chat subdirectory, and any
// change under EITHER is relevant: a human append the bot just applied, a Baxter reply
// chat-cli just appended, or a title just set) and call onChange, leading-edge folded
// per WATCH_DEBOUNCE_MS. No basename filter (unlike home-bot's watchChecklistStore):
// every change under the tree is a candidate `changed` trigger, and a redundant one
// costs nothing (chat-link.ts's reduceChanged no-ops on a version that hasn't moved).
// `watchFn`/`logErrFn` are injectable seams (default: the real `node:fs` watch /
// runtime.ts's logErr), mirroring home-bot.ts's watchChecklistStore.
export function watchChats(
  dir: string,
  onChange: () => void | Promise<void>,
  watchFn: typeof watch = watch,
  logErrFn: (m: string) => void = logErr,
  admit?: () => (() => void) | null,
): { close(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingRelease: (() => void) | undefined;
  // Shared by both failure paths below, same discipline as home-bot.ts's
  // watchChecklistStore -- see its own comment.
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  // Gates both handlers below against an event arriving after close() -- neither
  // fs.watch's raw listener nor an EventEmitter's 'error' is suppressed by close()
  // just because the caller tore the watcher down. See watchChecklistStore's own
  // comment for the full rationale (unchanged here).
  let closed = false;
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watchFn(dir, { recursive: true }, (_event, _filename) => {
      if (closed) return;
      if (timer !== null) return; // leading-edge: a call is already pending, fold this one in
      pendingRelease = admit?.() ?? undefined;
      if (admit && !pendingRelease) return;
      timer = setTimeout(() => {
        timer = null;
        const release = pendingRelease; pendingRelease = undefined;
        try {
          const result = onChange();
          if (result) void result.catch(err => logErrFn(`chat: chats-dir watch callback failed: ${(err as Error).message}`)).finally(() => release?.());
          else release?.();
        } catch (err) { logErrFn(`chat: chats-dir watch callback failed: ${(err as Error).message}`); release?.(); }
      }, WATCH_DEBOUNCE_MS);
      timer.unref?.();
    });
    watcher.on("error", (err: Error) => {
      if (closed) return;
      logErrFn(`chat: chats-dir watch died (${err.message}) -- local edits won't push a 'changed' notice until restart`);
      if (keepAlive === null) keepAlive = keepAliveFallback(); // de-dupe: only the first error needs to re-anchor
    });
    return { close: () => {
      closed = true;
      watcher.close();
      if (!admit && timer !== null) { clearTimeout(timer); timer = null; }
      if (keepAlive !== null) clearInterval(keepAlive);
    } };
  } catch (err) {
    logErrFn(`chat: could not watch the chats dir (${(err as Error).message}) -- local edits won't push a 'changed' notice until the next reconnect`);
    keepAlive = keepAliveFallback();
    return { close: () => { if (keepAlive !== null) clearInterval(keepAlive); } };
  }
}

// ---------- the daemon ----------

export interface ChatBotDeps {
  loadHomeKeys: () => HomeKeys;
  env: NodeJS.ProcessEnv;
  makeSocket?: (url: string, headers: Record<string, string>) => WebSocketLike;
  log: (m: string) => void;
  logErr: (m: string) => void;
  lifecycle?: LightLifecycle;
  onDurableProgress?: (highWater: number) => void;
  admissions?: QueueAdmissionOutbox;
}
export function defaultDeps(): ChatBotDeps { return { loadHomeKeys, env: process.env, ...loggerFor("chat") }; }

export interface ChatDispatcherDeps {
  /** Production returns a discriminated outcome; void preserves resident test integrations. */
  runFn: (chatId: string, intent: ChatDispatchIntent) => Promise<ChatRunOutcome | void>;
  logErr: (message: string) => void;
  /** Durable queue admission ledger; omitted keeps the resident chat path unchanged. */
  admissions?: QueueAdmissionOutbox;
  /** Provider-wide namespace for chat queue identity; required with admissions. */
  tenantId?: string;
  retryDelayMs?: number;
  maxRunsPerWindow?: number;
  windowMs?: number;
  nowMs?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  deadLetter?: typeof recordDeadLetter;
  /** Test seam for explicit terminal errors. */
  isPermanentFailure?: (error: unknown) => boolean;
  env?: NodeJS.ProcessEnv;
  /** Sampled only after a successful send-message append. */
  now?: () => Date;
  consumeShared?: (occurrence: string, contextEligible: boolean, now: Date, receiptToken?: string) => Promise<SharedResult>;
  /** Narrow hermetic seams; production uses the fresh schedule and allowlist readers. */
  readTasksForMorningHandoff?: typeof readTasksForMorningHandoff;
  loadAllowlist?: (env: NodeJS.ProcessEnv, path: string | undefined, diagnostic: LoaderDiagnosticSink) => Allowlist;
  allowlistPath?: string;
  /** Build the schedule/roster candidate without mutating the shared sidecar. */
  morningHandoffCandidate?: (intent: Extract<ChatIntent, { kind: "send-message" }>, now: Date) => Promise<MorningHandoffClaim | null>;
  /** Close the sidecar for an already-durable candidate and work token. */
  closeMorningHandoffCandidate?: (claim: MorningHandoffClaim, receiptToken: string) => Promise<boolean>;
  prepareMorningHandoff?: typeof prepareMorningHandoff;
  handoffPromptBlock?: typeof handoffPromptBlock;
  titleFor?: (firstMessage: string) => Promise<string>;
  listChats?: typeof listChats;
  setTitleIfUntitled?: typeof setTitleIfUntitled;
  /** Idempotent browser change notification after title index reconciliation. */
  onTitleChanged?: (chatId: string) => void;
  lifecycle?: LightLifecycle;
}

export type ChatDispatchEnvelope = ChatDispatchIntent & {
  workId?: string;
  /** Coalesced scheduling membership; each work ID retains its own outcome. */
  workIds?: string[];
};

class ChatDispatcher extends ChannelDispatcher<ChatDispatchEnvelope> {
  override _coalesce(previous: ChatDispatchEnvelope, next: ChatDispatchEnvelope): ChatDispatchEnvelope {
    const claim = retainEarliestClaim(previous.morningClaim ?? null, next.morningClaim ?? null);
    const ids = [...(previous.workIds ?? (previous.workId ? [previous.workId] : [])), ...(next.workIds ?? (next.workId ? [next.workId] : []))];
    const merged = claim ? { ...next, morningClaim: claim } : next;
    return ids.length ? { ...merged, workIds: [...new Set(ids)] } : merged;
  }
}

type SerializedMorningClaim = Omit<MorningHandoffClaim, "consumedAt"> & { consumedAt: string };
type ChatLifecycleReceipt = {
  version: 1;
  handoff?: { kind: "candidate"; claim: SerializedMorningClaim } | { kind: "claimed"; claim: SerializedMorningClaim } | { kind: "prepared"; promptBlock: string };
  autoTitle?: { kind: "generated"; title: string } | { kind: "completed"; title: string | null };
};

function chatReceipt(record: AgentDispatchRecord): ChatLifecycleReceipt {
  if (record.receipt === undefined) return { version: 1 };
  const value = record.receipt as Record<string, unknown>;
  const fail = (): never => { throw Object.assign(new Error("invalid durable chat lifecycle receipt"), { permanent: true }); };
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
    || !Object.keys(value).every(key => key === "version" || key === "handoff" || key === "autoTitle")) return fail();
  const handoff = value.handoff as Record<string, unknown> | undefined;
  if (handoff !== undefined) {
    if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return fail();
    if (handoff.kind === "prepared") {
      if (Object.keys(handoff).length !== 2 || typeof handoff.promptBlock !== "string") return fail();
    } else if (handoff.kind === "claimed" || handoff.kind === "candidate") {
      const claim = handoff.claim as Record<string, unknown> | undefined;
      const audience = claim?.audience as Record<string, unknown> | undefined;
      const recipient = audience?.recipient as Record<string, unknown> | undefined;
      const validAudience = audience?.kind === "household"
        ? Array.isArray(audience.names) && audience.names.every(name => typeof name === "string") && Number.isSafeInteger(audience.omittedCount)
        : audience?.kind === "direct" && recipient !== undefined
          && (recipient.currentRecipientDisplayName === null || typeof recipient.currentRecipientDisplayName === "string")
          && Array.isArray(recipient.otherNamedHouseholdMembers) && recipient.otherNamedHouseholdMembers.every(name => typeof name === "string")
          && Number.isSafeInteger(recipient.omittedOtherNamedRecipientCount);
      if (Object.keys(handoff).length !== 2 || !claim || Object.keys(claim).length !== 3
        || typeof claim.occurrence !== "string" || typeof claim.consumedAt !== "string"
        || Number.isNaN(Date.parse(claim.consumedAt)) || !validAudience) return fail();
    } else return fail();
  }
  const autoTitle = value.autoTitle as Record<string, unknown> | undefined;
  if (autoTitle !== undefined && (!autoTitle || typeof autoTitle !== "object" || Array.isArray(autoTitle)
    || Object.keys(autoTitle).length !== 2
    || (autoTitle.kind === "generated" ? typeof autoTitle.title !== "string"
      : autoTitle.kind !== "completed" || (autoTitle.title !== null && typeof autoTitle.title !== "string")))) return fail();
  return value as ChatLifecycleReceipt;
}

/**
 * The production dispatcher factory. main uses this exact object, keeping durable
 * append/close/title/dispatch ordering and coalescing testable without a copy.
 */
export function makeChatDispatcher(deps: ChatDispatcherDeps): {
  dispatcher: ChannelDispatcher<ChatDispatchEnvelope>;
  handleIntent: (intent: ChatIntent, cursor: Pick<ChatIntentDeps, "cursorLoad" | "cursorStore" | "sendAck" | "deadLetter">) => Promise<void>;
  /** Reclaims interrupted records and schedules pending/retry records after restart. */
  replay: () => void;
  close: () => void;
} {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const consumeShared = deps.consumeShared ?? sharedClose;
  const readTasks = deps.readTasksForMorningHandoff ?? readTasksForMorningHandoff;
  const loadList = deps.loadAllowlist ?? ((loaderEnv, path, diagnostic) => loadAllowlist(loaderEnv, path, diagnostic));
  const defaultMorningHandoffCandidate = async (_intent: Extract<ChatIntent, { kind: "send-message" }>, capturedAt: Date): Promise<MorningHandoffClaim | null> => {
    const snapshot = readTasks();
    if (!snapshot.available) { deps.logErr("chat: morning handoff state-unavailable"); return null; }
    const occurrence = canonicalMorningOccurrence(snapshot.tasks, morningCheckInDefinition({ env }), capturedAt, householdTz(env));
    if (!occurrence) { deps.logErr("chat: morning handoff not-eligible"); return null; }
    const diagnostic: LoaderDiagnosticSink = ({ category }) => {
      const fixedCategory = category === "unreadable" || category === "malformed-shape"
        || category === "corrupt-json" || category === "feed-failure" || category === "refresh-lock-failure"
        ? category : "state-unavailable";
      deps.logErr(fixedCategory === "state-unavailable" ? "chat: morning handoff state-unavailable" : `chat: morning handoff allowlist-${fixedCategory}`);
    };
    const roster = resolveRecipients(loadList(env, deps.allowlistPath, diagnostic), env).contacts;
    return makeMorningClaim(occurrence, capturedAt, householdAudience(roster));
  };
  const morningHandoffCandidate = (intent: Extract<ChatIntent, { kind: "send-message" }>): Promise<MorningHandoffClaim | null> =>
    (deps.morningHandoffCandidate ?? defaultMorningHandoffCandidate)(intent, now());
  const defaultCloseMorningHandoffCandidate = async (claim: MorningHandoffClaim, receiptToken: string): Promise<boolean> => {
    const result = await consumeShared(claim.occurrence, true, claim.consumedAt, receiptToken);
    const rawDecision = result && typeof result === "object" ? (result as { decision?: unknown }).decision : undefined;
    const decision = rawDecision === "shared-closed" || rawDecision === "already-consumed" || rawDecision === "state-unavailable" ? rawDecision : "state-unavailable";
    deps.logErr(`chat: morning handoff ${decision}`);
    return decision === "shared-closed" && result.contextEligible;
  };
  const closeMorningHandoffCandidate = deps.closeMorningHandoffCandidate ?? defaultCloseMorningHandoffCandidate;
  const consumeMorningHandoff = async (intent: Extract<ChatIntent, { kind: "send-message" }>): Promise<MorningHandoffClaim | null> => {
    const claim = await morningHandoffCandidate(intent);
    return claim && await closeMorningHandoffCandidate(claim, "") ? claim : null;
  };
  const admissions = deps.admissions;
  if (admissions && !deps.tenantId) throw new Error("chat admission tenant id is required");
  const nowMs = deps.nowMs ?? Date.now;
  const setTimer = deps.setTimeoutImpl ?? setTimeout;
  const clearTimer = deps.clearTimeoutImpl ?? clearTimeout;
  const maxRuns = deps.maxRunsPerWindow ?? 60;
  const windowMs = deps.windowMs ?? 3_600_000;
  const scheduled = new Set<string>();
  const starts = new Map<string, number[]>();
  type DeferredTransition = { description: string; failures: number; nextAttemptAt: number; apply?: () => void };
  const deferredTransitions = new Map<string, DeferredTransition>();
  let retryTimer: NodeJS.Timeout | undefined;
  let schedulerActive = false;
  let dispatcher: ChatDispatcher;

  const deferTransition = (workId: string, description: string, error: unknown, apply?: () => void): void => {
    const failures = (deferredTransitions.get(workId)?.failures ?? 0) + 1;
    const base = Math.max(1, deps.retryDelayMs ?? 1_000);
    const delay = Math.min(5 * 60_000, base * (2 ** Math.min(failures - 1, 8)));
    deferredTransitions.set(workId, { description, failures, nextAttemptAt: nowMs() + delay, ...(apply ? { apply } : {}) });
    deps.logErr(`chat: deferred ${description} persistence for ${workId} (${(error as Error)?.message ?? error})`);
  };
  const persistTransition = (workId: string, description: string, apply: () => void, replayFromTop = false): boolean => {
    try { apply(); deferredTransitions.delete(workId); return true; }
    catch (error) { deferTransition(workId, description, error, replayFromTop ? undefined : apply); return false; }
  };
  const retryAt = (record: AgentDispatchRecord, reason: AgentRetryReason, message?: string, exactAt?: number): void => {
    if (!admissions) return;
    const base = Math.max(1, deps.retryDelayMs ?? 1_000);
    const delay = Math.min(5 * 60_000, base * (2 ** Math.min(record.attempts, 8)));
    const nextAttemptAt = exactAt ?? nowMs() + delay;
    persistTransition(record.workId, "retry", () => admissions.retry(record.workId, nextAttemptAt, { kind: "retry", reason, ...(message ? { message } : {}) }));
  };
  const rateRetryAt = (key: string): number | null => {
    if (!maxRuns) return null;
    const current = nowMs();
    const kept = (starts.get(key) ?? []).filter(started => started > current - windowMs);
    if (kept.length) starts.set(key, kept); else starts.delete(key);
    return kept.length >= maxRuns ? kept[0]! + windowMs : null;
  };
  const recordStart = (key: string): void => {
    if (!maxRuns) return;
    const values = starts.get(key) ?? []; values.push(nowMs()); starts.set(key, values);
  };
  const permanent = (record: AgentDispatchRecord, message: string): void => {
    if (!admissions) return;
    const recordedAt = new Date(nowMs()).toISOString();
    try {
      (deps.deadLetter ?? recordDeadLetter)("chat", { kind: "agent-permanent-failure", workId: record.workId, sequence: record.sequence, admittedAt: record.admittedAt, error: message, input: record.input });
    } catch (error) { retryAt(record, "dlq-write-failed", (error as Error)?.message ?? String(error)); return; }
    persistTransition(record.workId, "permanent failure", () => admissions.permanentFailure(record.workId, { kind: "permanent-failure", source: "chat", message, sourceDlq: { surface: "chat", recordedAt } }));
  };
  const recordReceipt = (workId: string, update: (receipt: ChatLifecycleReceipt) => ChatLifecycleReceipt): AgentDispatchRecord => {
    if (!admissions) throw new Error("chat receipt requires durable admission");
    const current = admissions.agent(workId);
    if (!current) throw new Error("admitted chat work is missing");
    return admissions.recordAgentReceipt(workId, update(chatReceipt(current)));
  };
  const prepareLifecycle = async (record: AgentDispatchRecord, input: Extract<ChatIntent, { kind: "send-message" }>): Promise<string> => {
    if (!admissions) return "";
    let receipt = chatReceipt(admissions.agent(record.workId) ?? record);
    if (!receipt.handoff) {
      const claim = await morningHandoffCandidate(input);
      if (claim) {
        const serialized: SerializedMorningClaim = { ...claim, consumedAt: claim.consumedAt.toISOString() };
        // This receipt is the crash boundary: schedule eligibility and audience
        // identity are durable before sharedClose mutates the sidecar.
        recordReceipt(record.workId, current => ({ ...current, handoff: { kind: "candidate", claim: serialized } }));
      } else {
        recordReceipt(record.workId, current => ({ ...current, handoff: { kind: "prepared", promptBlock: "" } }));
      }
      receipt = chatReceipt(admissions.agent(record.workId)!);
    }
    if (receipt.handoff?.kind === "candidate") {
      const serialized = receipt.handoff.claim;
      const claim: MorningHandoffClaim = { ...serialized, consumedAt: new Date(serialized.consumedAt) };
      const claimed = await closeMorningHandoffCandidate(claim, record.workId);
      recordReceipt(record.workId, current => ({ ...current, handoff: claimed
        ? { kind: "claimed", claim: serialized }
        : { kind: "prepared", promptBlock: "" } }));
      receipt = chatReceipt(admissions.agent(record.workId)!);
    }
    if (receipt.handoff?.kind === "claimed") {
      const claim: MorningHandoffClaim = { ...receipt.handoff.claim, consumedAt: new Date(receipt.handoff.claim.consumedAt) };
      let promptBlock = "";
      try {
        const packet = await (deps.prepareMorningHandoff ?? prepareMorningHandoff)(claim, { env });
        if (packet) promptBlock = (deps.handoffPromptBlock ?? handoffPromptBlock)(packet);
      } catch { /* durable empty receipt preserves the ordinary reply */ }
      recordReceipt(record.workId, current => ({ ...current, handoff: { kind: "prepared", promptBlock } }));
      receipt = chatReceipt(admissions.agent(record.workId)!);
    }

    if (!receipt.autoTitle) {
      const chat = (deps.listChats ?? listChats)().find(candidate => candidate.id === input.chatId);
      if (!chat) throw Object.assign(new Error(`chat ${input.chatId} is missing during title reconciliation`), { permanent: true });
      if (chat.title !== null) {
        recordReceipt(record.workId, current => ({ ...current, autoTitle: { kind: "completed", title: chat.title } }));
      } else {
        const generated = await (deps.titleFor ?? titleFor)(input.text);
        recordReceipt(record.workId, current => ({ ...current, autoTitle: { kind: "generated", title: generated } }));
      }
      receipt = chatReceipt(admissions.agent(record.workId)!);
    }
    if (receipt.autoTitle?.kind === "generated") {
      const applied = await (deps.setTitleIfUntitled ?? setTitleIfUntitled)(input.chatId, receipt.autoTitle.title);
      deps.onTitleChanged?.(input.chatId);
      recordReceipt(record.workId, current => ({ ...current, autoTitle: { kind: "completed", title: applied } }));
      receipt = chatReceipt(admissions.agent(record.workId)!);
    }
    return receipt.handoff?.kind === "prepared" ? receipt.handoff.promptBlock : "";
  };

  const recordChatKey = (record: AgentDispatchRecord): string => {
    const source = record.input && typeof record.input === "object" ? record.input as Partial<ChatDispatchEnvelope> : {};
    return source.kind === "send-message" && typeof source.chatId === "string" ? source.chatId : "__invalid_chat_envelope__";
  };
  const chatHeads = (): Map<string, AgentDispatchRecord> => {
    const heads = new Map<string, AgentDispatchRecord>();
    if (!admissions) return heads;
    for (const record of admissions.records()) {
      if (record.variant !== "agent-dispatch" || record.queue !== "chat" || record.tenantId !== deps.tenantId
        || record.state === "succeeded" || record.state === "permanent-failure") continue;
      const key = recordChatKey(record);
      const existing = heads.get(key);
      if (!existing || record.sequence < existing.sequence) heads.set(key, record);
    }
    return heads;
  };

  const runRecord = async (record: AgentDispatchRecord): Promise<void> => {
    if (!admissions) return;
    scheduled.delete(record.workId);
    try {
      const current = admissions.agent(record.workId);
      if (!current || (current.state !== "pending" && current.state !== "retry-wait")) return;
      if (chatHeads().get(recordChatKey(current))?.workId !== current.workId) return;
      const input = current.input as ChatDispatchIntent;
      if (!input || input.kind !== "send-message" || typeof input.chatId !== "string") { permanent(current, "invalid chat dispatch envelope"); return; }
      const rateAt = rateRetryAt(input.chatId);
      if (rateAt !== null) { retryAt(current, "rate-limit", undefined, rateAt); return; }
      if (!persistTransition(current.workId, "begin attempt", () => { admissions.beginAttempt(current.workId); }, true)) return;
      recordStart(input.chatId);
      let outcome: ChatRunOutcome | void;
      try {
        const morningHandoff = await prepareLifecycle(current, input as Extract<ChatIntent, { kind: "send-message" }>);
        outcome = await deps.runFn(input.chatId, { ...input, morningHandoff, workId: current.workId } as ChatDispatchEnvelope);
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        if (deps.isPermanentFailure?.(error) ?? (error as { permanent?: unknown })?.permanent === true) permanent(current, message);
        else retryAt(current, "transient-error", message);
        return;
      }
      const normalized: ChatRunOutcome = outcome ?? { kind: "succeeded", source: "chat", completedAt: new Date(nowMs()).toISOString(), providerReceipts: [] };
      if (normalized.kind === "succeeded") persistTransition(current.workId, "success", () => { admissions.succeed(current.workId, normalized); });
      else if (normalized.kind === "retry") retryAt(current, normalized.reason);
      else permanent(current, normalized.message);
    } finally { pumpRetries(); }
  };
  const enqueueRecord = (record: AgentDispatchRecord): void => {
    if (scheduled.has(record.workId)) return;
    scheduled.add(record.workId);
    const source = record.input && typeof record.input === "object" ? record.input as Partial<ChatDispatchEnvelope> : {};
    const key = source.kind === "send-message" && typeof source.chatId === "string" ? source.chatId : "__invalid_chat_envelope__";
    dispatcher.notify(key, { ...source, workId: record.workId, workIds: [record.workId] } as ChatDispatchEnvelope);
  };
  const pumpRetries = (): void => {
    if (!schedulerActive || !admissions) return;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = undefined; }
    const current = nowMs();
    for (const [workId, transition] of [...deferredTransitions]) {
      if (transition.nextAttemptAt > current) continue;
      if (!transition.apply) { deferredTransitions.delete(workId); continue; }
      try { transition.apply(); deferredTransitions.delete(workId); }
      catch (error) { deferTransition(workId, transition.description, error, transition.apply); }
    }
    const heads = chatHeads();
    for (const record of heads.values()) {
      if ((record.state === "pending" || record.state === "retry-wait") && record.nextAttemptAt <= current
        && !deferredTransitions.has(record.workId)) enqueueRecord(record);
    }
    let earliest: number | null = null;
    for (const transition of deferredTransitions.values()) if (earliest === null || transition.nextAttemptAt < earliest) earliest = transition.nextAttemptAt;
    for (const record of heads.values()) {
      if ((record.state !== "pending" && record.state !== "retry-wait") || scheduled.has(record.workId) || deferredTransitions.has(record.workId)) continue;
      if (earliest === null || record.nextAttemptAt < earliest) earliest = record.nextAttemptAt;
    }
    if (earliest !== null && earliest > current) {
      retryTimer = setTimer(() => { retryTimer = undefined; pumpRetries(); }, Math.max(0, earliest - current)); retryTimer.unref?.();
    }
  };
  dispatcher = new ChatDispatcher({
    debounceMs: 1200, maxConcurrent: 3, maxRunsPerWindow: admissions ? 0 : maxRuns, windowMs,
    lifecycle: deps.lifecycle,
    runFn: async (chatId, item) => {
      if (!admissions) { await deps.runFn(chatId, item); return; }
      const records = (item.workIds ?? (item.workId ? [item.workId] : [])).map(id => admissions.agent(id)).filter((value): value is AgentDispatchRecord => value !== undefined).sort((a, b) => a.sequence - b.sequence);
      for (const record of records) await runRecord(record);
    },
  });
  const admit = (intent: Extract<ChatIntent, { kind: "send-message" }>): boolean => {
    if (!admissions) return true;
    const candidate = { tenantId: deps.tenantId!, queue: "chat" as const, sequence: intent.id, workId: admissionWorkId("chat", intent.id, deps.tenantId), admittedAt: intent.at, variant: "agent-dispatch" as const, input: intent, state: "pending" as const, attempts: 0, nextAttemptAt: 0 };
    const admitted = admissions.admit(candidate);
    schedulerActive = true;
    pumpRetries();
    return admitted === candidate;
  };
  const classifyNonAgent = (intent: ChatIntent, outcomeType: string): void => {
    if (!admissions) return;
    const workId = admissionWorkId("chat", intent.id, deps.tenantId);
    admissions.admit({ tenantId: deps.tenantId!, queue: "chat", sequence: intent.id, workId, admittedAt: intent.at,
      variant: "non-agent-terminal", outcomeType, outcomeVersion: 1,
      outcome: { kind: intent.kind }, idempotencyKey: `${outcomeType}:${workId}`, state: "pending-side-effects" });
    admissions.completeNonAgent(workId, intent.kind === "send-message"
      ? { kind: "source-dead-letter", surface: "chat", recordedAt: new Date().toISOString() }
      : { kind: "source-applied", surface: "chat", detail: intent.kind });
  };
  const dispatchHandleIntent = (intent: ChatIntent, cursor: Pick<ChatIntentDeps, "cursorLoad" | "cursorStore" | "sendAck" | "deadLetter">): Promise<void> => handleIntent(intent, {
    ...cursor, admit, classifyNonAgent, deferPostAdmission: !!admissions,
    dispatch: (chatId, dispatchIntent) => { if (!admissions) dispatcher.notify(chatId, dispatchIntent); },
    consumeMorningHandoff: intent => consumeMorningHandoff(intent), titleFor: deps.titleFor, logErr: deps.logErr,
  });
  const replay = () => { if (admissions) { schedulerActive = true; admissions.recoverInterrupted(nowMs(), { queue: "chat", tenantId: deps.tenantId }); pumpRetries(); } };
  const close = () => { schedulerActive = false; if (retryTimer) { clearTimer(retryTimer); retryTimer = undefined; } dispatcher.closeIntake(); };
  return { dispatcher, handleIntent: dispatchHandleIntent, replay, close };
}

export interface ChatRunDeps {
  env: NodeJS.ProcessEnv;
  model: string;
  runEnv: NodeJS.ProcessEnv;
  logErr: (message: string) => void;
  /** Sends the post-run browser signals; main supplies the real link closure. */
  onFinished: (chatId: string) => void;
  runAgentImpl?: typeof runAgent;
  prepareMorningHandoffImpl?: typeof prepareMorningHandoff;
  handoffPromptBlockImpl?: typeof handoffPromptBlock;
  introDecisionImpl?: typeof introDecision;
  buildPromptImpl?: typeof buildPrompt;
  appendFallback?: (chatId: string, intent: ChatDispatchIntent) => Promise<void>;
  markExplainedImpl?: typeof markExplained;
}

/**
 * Production chat run closure. main passes this exact closure to makeChatDispatcher,
 * so handoff recheck/rendering and the single agent invocation stay directly testable.
 */
export function makeChatRunFn(deps: ChatRunDeps): (chatId: string, intent: ChatDispatchIntent) => Promise<ChatRunOutcome> {
  const runAgentImpl = deps.runAgentImpl ?? runAgent;
  const prepareImpl = deps.prepareMorningHandoffImpl ?? prepareMorningHandoff;
  const renderHandoff = deps.handoffPromptBlockImpl ?? handoffPromptBlock;
  const decideIntro = deps.introDecisionImpl ?? introDecision;
  const renderPrompt = deps.buildPromptImpl ?? buildPrompt;
  const appendFallback = deps.appendFallback ?? (async (chatId: string, intent: ChatDispatchIntent) => {
    if (intent.workId) await sendChatReply(chatId, FALLBACK_NOTICE, { BAXTER_WORK_ID: intent.workId });
    else await appendMessage(chatId, { id: `b-fallback-${intent.id}`, at: intent.at, authorId: "baxter", authorName: PERSONA_NAME, content: FALLBACK_NOTICE });
  });
  const markExplainedImpl = deps.markExplainedImpl ?? markExplained;
  return async (chatId, intent) => {
    const listSlug = listChatSlug(chatId);
    const runEnv = listSlug ? { ...deps.runEnv, BAXTER_LIST_SLUG: listSlug } : deps.runEnv;
    // Recheck and render before evaluating optional intro state. A failed/null
    // preparation only loses the optional aside; durable suppression remains closed.
    let morningHandoff = intent.morningHandoff ?? "";
    if (intent.morningHandoff === undefined && intent.morningClaim) {
      try {
        const packet = await prepareImpl(intent.morningClaim, { env: deps.env });
        if (packet) morningHandoff = renderHandoff(packet);
      } catch { /* ordinary chat reply continues */ }
    }
    const intro = decideIntro(deps.env);
    try {
      if (intent.workId) {
        const reconciled = await replayChatOutputs(intent.workId);
        if (reconciled.length) return { kind: "succeeded", source: "chat", completedAt: new Date().toISOString(), providerReceipts: reconciled };
      }
      let { outOfTokens, failed } = await runAgentImpl({
        prompt: renderPrompt(chatId, morningHandoff, intro),
        logId: String(intent.id), surface: "chat", cwd: MEMORY_DIR, model: deps.model,
        allowedTools: CHAT_TOOLS, runsDir: CHAT_RUNS_DIR,
        env: intent.workId ? { ...runEnv, BAXTER_WORK_ID: intent.workId } : runEnv,
        beforeRun: () => {
          ensurePlaywrightConfig(MEMORY_DIR);
          ensureSkills(CHAT_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
        },
      });
      let providerReceipts = intent.workId ? await replayChatOutputs(intent.workId) : [];
      if (providerReceipts.length) { failed = false; outOfTokens = false; }
      if (outOfTokens || failed) {
        deps.logErr(`chat: FALLBACK notice for ${chatId} -- run ${failed ? "failed" : "hit the token wall"} with no reply delivered`);
        try {
          await appendFallback(chatId, intent);
          providerReceipts = intent.workId ? await replayChatOutputs(intent.workId) : [];
          if (providerReceipts.length) { failed = false; outOfTokens = false; }
        }
        catch (err) { deps.logErr(`chat: fallback notice append failed: ${(err as Error).message}`); }
      }
      if (!failed && !outOfTokens) {
        try { if (intro.explain) markExplainedImpl(); }
        catch (err) { deps.logErr(`chat: intro latch write failed: ${(err as Error).message}`); }
        return { kind: "succeeded", source: "chat", completedAt: new Date().toISOString(), providerReceipts };
      }
      return { kind: "retry", source: "chat", reason: outOfTokens ? "out-of-tokens" : "agent-failed" };
    } finally {
      deps.onFinished(chatId);
    }
  };
}

export async function main(deps: ChatBotDeps = defaultDeps()): Promise<void> {
  let keys: HomeKeys;
  try {
    keys = deps.loadHomeKeys();
  } catch (err) {
    // Absent/malformed credential -> log once and idle (do NOT crash-loop the
    // container), mirroring sms-bot.ts's/home-bot.ts's startup handling.
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") deps.log("chat: no home-keys.json -- chat surface idle (provision with `baxctl home <id>`)");
    else deps.logErr(`chat: home-keys.json unreadable (${e.message}) -- chat surface idle until it's fixed`);
    idleForever(deps.lifecycle, "chat:idle-timer");
    return;
  }

  const MODEL = chatModel(deps.env);
  // Chat has no external-provider creds to strip (unlike sms-bot's makeRunEnv --
  // chat-cli.ts has no network/creds at all, see its own header comment), so this is a
  // plain copy (never mutate deps.env -- a daemon may pass its own process.env, and a
  // mutating write would leak BAXTER_MODEL_OVERRIDE/BAXTER_EXPECT_REPLY into it).
  const RUN_ENV = applyChatModelOverride({ ...deps.env }, deps.env);
  // Chat is a 1:1-per-turn reply surface (like SMS): a reply is EXPECTED, so opt into
  // the harness's unsent-reply poke. BAXTER_REPLY_REQUIRED is deliberately LEFT OFF --
  // see sms-bot.ts's own comment; the same reasoning applies (a "thanks" sign-off may
  // legitimately draw no reply). The poke naming chat-cli / isDeliveryCall recognizing
  // `chat-cli send` is Task 3.4's wiring, not this one's.
  RUN_ENV.BAXTER_EXPECT_REPLY = "1";

  // One ledger is shared with mail but namespaced by tenant + queue. It is created
  // before the link starts so replayed accepted turns never need a new DO delivery.
  const admissions = deps.admissions ?? new QueueAdmissionOutbox(QUEUE_ADMISSION_OUTBOX_PATH);
  if (deps.lifecycle) admissions.bindLifecycle(deps.lifecycle);
  // main deliberately uses the exported factory; it owns durable admission before
  // the chat-specific close/title paths and preserves resident compatibility.
  const { handleIntent: dispatchHandleIntent, replay, close: closeDispatcher } = makeChatDispatcher({
    logErr: deps.logErr, env: deps.env, admissions, tenantId: keys.tenant,
    onTitleChanged: () => link.sendChanged(chatIndexVersion()),
    lifecycle: deps.lifecycle,
    runFn: makeChatRunFn({
      env: deps.env, model: MODEL, runEnv: RUN_ENV, logErr: deps.logErr,
      onFinished: (chatId) => {
        // Push a final version before turn-done so a just-written reply is visible
        // even if fs.watch's debounce has not fired yet. Each signal is isolated.
        try { link.sendChanged(chatIndexVersion()); } catch (err) { deps.logErr(`chat: pre-turn-done version push failed: ${(err as Error).message}`); }
        try { link.sendTurnDone(chatId); } catch (err) { deps.logErr(`chat: turn-done signal failed: ${(err as Error).message}`); }
      },
    }),
  });

  // Reclaim a prior process's running records before admitting fresh link work.
  replay();

  const link = new HomeLink<ChatIntent>({
    connect: signedChatLinkConnect(keys, deps.makeSocket),
    viewVersion: () => chatIndexVersion(),
    appliedThrough: () => loadCursor(),
    isIntent: isChatIntentLike,
    logErr: deps.logErr,
  });

  wireChatIntentDrain(link, async intent => {
    await dispatchHandleIntent(intent, {
      cursorLoad: loadCursor, cursorStore: storeCursor,
      sendAck: (n) => link.sendAck(n),
      deadLetter: (i, err) => recordDeadLetter("chat", { outcomeId: admissionWorkId("chat", i.id, keys.tenant), id: i.id, at: i.at, kind: i.kind, error: String((err as Error)?.stack ?? err), intent: i }),
    });
    deps.onDurableProgress?.(intent.id);
  }, deps.logErr, deps.lifecycle);

  // B1-style containment (same discipline as home-mirror.ts's wireLink onPull): this
  // runs synchronously out of HomeLink's "message" listener, so an uncaught throw here
  // would take the whole process down over a single bad pull. Skip sendView on failure
  // and log loudly instead -- the DO's own bounded pull-timeout -> serve-stale-cache is
  // exactly the degradation this falls back to.
  link.onPull((pullId, scope, chatId) => {
    const release = deps.lifecycle?.admit("chat:socket-pull");
    if (deps.lifecycle && !release) return;
    try {
      // `lists: []` is a REQUIRED filler, not dead weight: the worker's shared
      // link-protocol decode() (workers/home/src/link-protocol.ts) validates EVERY
      // non-null `view` frame -- across the checklist, sms AND chat links -- by
      // requiring `Array.isArray(view.lists)`. A chat view has no lists, but the plan's
      // Task 2.5 contract deliberately left that shared checklist-wide check untouched
      // and has the container send an empty `lists` alongside its real `chats`/`messages`
      // payload; without it the DO's handleChatMessage 1003-closes the socket as a
      // "malformed chat frame" and the chat link can never sync. chat-link.ts's reduceView
      // reads `.chats`/settles the transcript pull and ignores this filler.
      if (scope === "usage") {
        // creditBudgetUsd() follows the codebase's "unset/invalid/<=0 -> tracking only"
        // convention (matches evaluateCap's `over`-decision everywhere else), so a tenant
        // without BAXTER_CREDIT_BUDGET_USD set stays on a 0 budget here rather than
        // getting a fabricated $5 cap that would flag any nonzero spend as over.
        link.sendView(pullId, { lists: [], usage: summary(Date.now(), creditBudgetUsd()) }, "", "usage");
        return;
      }
      if (scope === "chat" && chatId) {
        // The transcript branch of chat-link.ts's reduceView never reads `viewVersion`
        // (see reduceChat -- a chatId-scoped view settles a pull-await, it never
        // updates chatIndexVersion), so "" is deliberate here, not a placeholder that
        // wants filling in later.
        link.sendView(pullId, { lists: [], messages: readMessages(chatId, 50) }, "", chatId);
      } else {
        link.sendView(pullId, { lists: [], chats: listChats() }, chatIndexVersion());
      }
    } catch (err) {
      deps.logErr(`chat: pull ${pullId} failed -- serving stale via DO timeout: ${(err as Error).message}`);
    } finally { release?.(); }
  });

  const onChatsChanged = () => {
    try {
      link.sendChanged(chatIndexVersion());
    } catch (err) {
      deps.logErr(`chat: sendChanged failed: ${(err as Error).message}`);
    }
  };
  let watcher: { close(): void } | undefined;
  const openWatch = () => { watcher = watchChats(CHATS_DIR, onChatsChanged, watch, deps.logErr, deps.lifecycle ? () => deps.lifecycle!.admit("chat:watch-debounce") : undefined); };
  const closeWatch = () => { watcher?.close(); watcher = undefined; };
  openWatch();

  deps.onDurableProgress?.(loadCursor());
  link.start();
  deps.lifecycle?.source("chat:link", () => link.stop(), () => link.start());
  deps.lifecycle?.source("chat:watch", closeWatch, openWatch);
  deps.lifecycle?.resource("chat:dispatcher-retries", closeDispatcher);
  // Keep the process alive across reconnect windows -- HomeLink's own timers are all
  // unref'd (see home-link.ts's header comment), and this surface is standalone.
  idleForever(deps.lifecycle, "chat:idle-timer");
  deps.log(`chat: surface up (tenant ${keys.tenant}) -> ${keys.endpoint}`);
}

// A ref'd no-op timer that keeps the event loop non-empty (see main's call site).
function idleForever(lifecycle?: LightLifecycle, name = "chat:idle-timer"): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const open = () => { timer = setInterval(() => {}, 2 ** 31 - 1); };
  const close = () => { if (timer) clearInterval(timer); timer = undefined; };
  open(); lifecycle?.source(name, close, open);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // logErr (not console.error) so a fatal chat startup error also ships to the Discord
  // log mirror, mirroring sms-bot.ts's own entrypoint guard.
  main().catch(async (err) => { logErr(`chat: fatal: ${(err as Error).message}`); await flushLogs(); process.exit(1); });
}
