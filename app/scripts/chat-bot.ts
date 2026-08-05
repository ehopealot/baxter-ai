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
import { mkdirSync, readFileSync, renameSync, writeFileSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import { HomeLink, type WebSocketLike } from "./home-link.ts";
import { ChannelDispatcher } from "./dispatcher.ts";
import {
  createChat, appendMessage, listChats, readMessages, setTitle,
  type ChatMessage, type ChatMeta, type ChatAuthor,
} from "./chat-transcript.ts";
import { titleFor } from "./chat-title.ts";
import { runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, skillsPreamble, log, logErr, flushLogs } from "./runtime.ts";
import { cleanForPrompt } from "./transcript.ts";
import { projectsPreamble } from "./projects-cli.ts";
import { loadHomeKeys, type HomeKeys } from "./home-mirror.ts"; // key loader lives here, same as sms-bot's import
import { CHAT_STATE_PATH, CHATS_DIR, MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR } from "./paths.ts";
import { CHAT_TOOLS, CHAT_SKILL_SRCS, CHAT_SKILL_NAMES, loadedSkillsList } from "./grants.ts";

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
  | { id: number; kind: "send-message"; chatId: string; text: string; authorId: string; authorName: string; at: string };

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
// than assuming the DO-side length is itself bounded. authorId shares the same cap:
// it's a shorter `member:<address>` string in practice, so 200 is generous, but it is
// still interpolated nowhere in the prompt today -- bounding it is just consistency
// with authorName, not a distinct observed risk.
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
        && typeof o.authorId === "string" && o.authorId.length <= MAX_AUTHOR_NAME
        && typeof o.authorName === "string" && o.authorName.length <= MAX_AUTHOR_NAME;
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

function loadCursor(): number { try { return JSON.parse(readFileSync(CHAT_STATE_PATH, "utf8")).appliedThrough ?? -1; } catch { return -1; } }
function storeCursor(n: number): void { // monotonic: never regress the cursor; temp+rename so a mid-write kill can't leave a partial file (which would replay retained intents)
  const next = Math.max(loadCursor(), n);
  mkdirSync(dirname(CHAT_STATE_PATH), { recursive: true });
  const tmp = `${CHAT_STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ appliedThrough: next }));
  renameSync(tmp, CHAT_STATE_PATH);
}

// ---------- applying one drained intent ----------

export interface ChatIntentDeps {
  cursorLoad: () => number;
  cursorStore: (n: number) => void;
  sendAck: (appliedThrough: number) => void;
  dispatch: (chatId: string, intent: ChatIntent) => void;
  logErr: (m: string) => void;
}

// Fire-and-forget titling for a freshly-untitled chat's first message: titleFor never
// throws (its own contract -- network/timeout/empty all fall back to a timestamp
// title), but this still floats independently of handleIntent's own await chain (per
// the brief: titling must never block or fail the reply/dispatch below it). The
// listChats()/setTitle calls are still guarded here regardless, since an unexpected
// fs error from EITHER (not titleFor itself) must not become an unhandled rejection.
function maybeTitle(chatId: string, firstMessage: string, logErrFn: (m: string) => void): void {
  let chat: ChatMeta | undefined;
  try {
    chat = listChats().find((c) => c.id === chatId);
  } catch (err) {
    logErrFn(`chat titling: could not read the chat index (${(err as Error).message})`);
    return;
  }
  if (!chat || chat.title !== null) return;
  titleFor(firstMessage)
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
  switch (intent.kind) {
    case "create-chat":
      createChat(`wc-${intent.id}`, intent.at);
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
      maybeTitle(intent.chatId, intent.text, deps.logErr);
      deps.dispatch(intent.chatId, intent);
      break;
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

// Fill the rich chat-prompt.md template, mirroring sms-bot.ts's buildPrompt: persona,
// this chat's own id (needed for the reply instruction, `chat-cli send {{CHAT_ID}}`),
// memory/credentials/skills paths, the injection-safe projects + loaded/learned skills
// preambles, and the SANITIZED transcript as HISTORY. Single-pass fillTemplate (see
// runtime.ts) so an inserted value is never re-scanned.
export function buildPrompt(chatId: string): string {
  const template = readFileSync(PROMPT_PATH, "utf8");
  return fillTemplate(template, {
    PERSONA_NAME,
    CHAT_ID: chatId,
    HISTORY: renderHistory(readMessages(chatId, 50)),
    MEMORY_PATH,
    CREDENTIALS_PATH,
    LEARNED_SKILLS_DIR,
    PROJECTS_LIST: projectsPreamble(),
    LOADED_SKILLS: loadedSkillsList(CHAT_SKILL_NAMES),
    LEARNED_SKILLS_LIST: skillsPreamble(),
  });
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
  onChange: () => void,
  watchFn: typeof watch = watch,
  logErrFn: (m: string) => void = logErr,
): { close(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
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
      timer = setTimeout(() => { timer = null; onChange(); }, WATCH_DEBOUNCE_MS);
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
      if (timer !== null) { clearTimeout(timer); timer = null; }
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
}
export function defaultDeps(): ChatBotDeps { return { loadHomeKeys, env: process.env, log, logErr }; }

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
    idleForever();
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

  const dispatcher = new ChannelDispatcher<ChatIntent>({
    debounceMs: 4000, maxConcurrent: 3, maxRunsPerWindow: 60, windowMs: 3_600_000,
    runFn: async (chatId, intent) => {
      await runAgent({
        prompt: buildPrompt(chatId),
        logId: String(intent.id),
        surface: "chat",
        cwd: MEMORY_DIR,
        model: MODEL,
        allowedTools: CHAT_TOOLS,
        runsDir: CHAT_RUNS_DIR,
        env: RUN_ENV,
        beforeRun: () => {
          ensurePlaywrightConfig(MEMORY_DIR);
          ensureSkills(CHAT_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
        },
      });
    },
  });

  const link = new HomeLink<ChatIntent>({
    connect: signedChatLinkConnect(keys, deps.makeSocket),
    viewVersion: () => chatIndexVersion(),
    appliedThrough: () => loadCursor(),
    isIntent: isChatIntentLike,
    logErr: deps.logErr,
  });

  // Serialize inbound intent handling: a reconnect hello-replay burst arrives as
  // separate frames; running handleIntent concurrently would let proper-lockfile's
  // non-FIFO retry race regress the cursor and reorder the transcript (same rationale
  // as sms-bot.ts's own `chain`).
  let chain: Promise<void> = Promise.resolve();
  link.onIntent((intent) => {
    chain = chain.then(() => handleIntent(intent, {
      cursorLoad: loadCursor, cursorStore: storeCursor,
      sendAck: (n) => link.sendAck(n),
      dispatch: (chatId, i) => dispatcher.notify(chatId, i),
      logErr: deps.logErr,
    })).catch((err) => deps.logErr(`chat handleIntent: ${err}`));
  });

  // B1-style containment (same discipline as home-mirror.ts's wireLink onPull): this
  // runs synchronously out of HomeLink's "message" listener, so an uncaught throw here
  // would take the whole process down over a single bad pull. Skip sendView on failure
  // and log loudly instead -- the DO's own bounded pull-timeout -> serve-stale-cache is
  // exactly the degradation this falls back to.
  link.onPull((pullId, scope, chatId) => {
    try {
      if (scope === "chat" && chatId) {
        // The transcript branch of chat-link.ts's reduceView never reads `viewVersion`
        // (see reduceChat -- a chatId-scoped view settles a pull-await, it never
        // updates chatIndexVersion), so "" is deliberate here, not a placeholder that
        // wants filling in later.
        link.sendView(pullId, { messages: readMessages(chatId, 50) }, "", chatId);
      } else {
        link.sendView(pullId, { chats: listChats() }, chatIndexVersion());
      }
    } catch (err) {
      deps.logErr(`chat: pull ${pullId} failed -- serving stale via DO timeout: ${(err as Error).message}`);
    }
  });

  const watcher = watchChats(CHATS_DIR, () => {
    try {
      link.sendChanged(chatIndexVersion());
    } catch (err) {
      deps.logErr(`chat: sendChanged failed: ${(err as Error).message}`);
    }
  }, watch, deps.logErr);
  void watcher; // held only for its liveness side effect (mirrors home-bot.ts) -- this daemon never calls close()

  link.start();
  // Keep the process alive across reconnect windows -- HomeLink's own timers are all
  // unref'd (see home-link.ts's header comment), and this surface is standalone.
  idleForever();
  deps.log(`chat: surface up (tenant ${keys.tenant}) -> ${keys.endpoint}`);
}

// A ref'd no-op timer that keeps the event loop non-empty (see main's call site).
function idleForever(): void { setInterval(() => {}, 2 ** 31 - 1); }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // logErr (not console.error) so a fatal chat startup error also ships to the Discord
  // log mirror, mirroring sms-bot.ts's own entrypoint guard.
  main().catch(async (err) => { logErr(`chat: fatal: ${(err as Error).message}`); await flushLogs(); process.exit(1); });
}
