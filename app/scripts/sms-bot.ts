#!/usr/bin/env node
// SMS surface daemon (spec: the sms-bot container). A long-running process, gated by
// the `sms` token in BAXTER_SURFACES (compose profile). Holds one persistent SigV4-signed
// link to the control-plane Durable Object (dialing /sms-link), wakes a SCOPED agent run
// on every inbound message, and acks so the DO can prune. Mirrors home-bot.ts's link
// lifecycle and discord-bot.ts's scoped-run dispatch -- the daemon holds the Sendblue
// creds and writes them 0600 for sms-cli; the spawned run NEVER sees them (it replies
// only via `sms-cli send`).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import { HomeLink, type WebSocketLike } from "./home-link.ts";
import { ChannelDispatcher } from "./dispatcher.ts";
import { appendTranscript, readTranscript, type TranscriptEntry } from "./sms-transcript.ts";
import { deadLetter as recordDeadLetter } from "./dead-letter.ts";
import { sendReadReceipt, sendTypingIndicator } from "./sms-cli.ts";
import { runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, skillsPreamble, log, logErr, flushLogs } from "./runtime.ts";
import { cleanForPrompt, cleanForPromptLine } from "./transcript.ts";
import { projectsPreamble } from "./projects-cli.ts";
import { loadHomeKeys, type HomeKeys } from "./home-mirror.ts"; // key loader lives here; home-bot only re-imports it
import { SMS_KEYS_PATH, SMS_STATE_PATH, MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR } from "./paths.ts";
import { SMS_TOOLS, SMS_SKILL_SRCS, SMS_SKILL_NAMES, loadedSkillsList } from "./grants.ts";
import { nameForAddress } from "./allowlist.ts";
import { isModelFetchableUrl, type MediaItem } from "./harnesses/runner-common.ts";

// APP_DIR computed the same way grants.ts does (it is NOT exported from paths.ts).
// SMS's own run-log dir -- NOT discord's RUNS_DIR (a discord-bot-local const at
// .claude/discord-runs; reusing it would co-mingle the two surfaces' logs).
const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SMS_RUNS_DIR = join(APP_DIR, ".claude", "sms-runs");
// The rich SMS persona/briefing template, shipped alongside discord-prompt.md at
// APP_DIR and read at runtime (COPY . . in the Dockerfile picks up app/*.md).
const PROMPT_PATH = join(APP_DIR, "sms-prompt.md");
const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter";
// The run's cwd .claude/skills dir the baked/learned skills stage into (same as
// discord-bot.ts -- runs across all surfaces share MEMORY_DIR as cwd).
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");

// The multimodal model an MMS run is routed to (parity with discord-bot's MULTIMODAL_MODEL).
// Empty -> an MMS falls back to the text model and the image is described only by its marker.
const MULTIMODAL_MODEL = process.env.OPENROUTER_MULTIMODAL_MODEL || "";

// Sendblue's inbound webhook carries a media_url but no content-type, so infer one from
// the url's extension; MMS is image-dominant, so an unknown/extensionless url defaults to
// image/jpeg (keeps it routed as vision rather than dropped). buildMediaParts re-checks the
// type and, for image/video/pdf, hands the url straight to OpenRouter to fetch.
const MMS_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", bmp: "image/bmp", mp4: "video/mp4", mov: "video/quicktime",
};
function mmsContentType(url: string): string {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() || "";
    return MMS_MIME[ext] || "image/jpeg";
  } catch { return "image/jpeg"; }
}
// The current inbound's media, as a one-item BAXTER_MEDIA list (empty when no media_url or a
// non-https url the runner would reject). Only the triggering message's media is attached
// natively; prior messages stay the "[image]" transcript marker (we don't re-fetch history).
export function smsMedia(payload: SmsPayload): MediaItem[] {
  const url = payload.media_url;
  if (!isModelFetchableUrl(url)) return []; // no media, or a url the runner would reject anyway
  return [{ url, content_type: mmsContentType(url), filename: "mms", source: "sendblue" }];
}

export interface SmsPayload {
  id: number; from: string; content: string; media_url?: string; at: string;
  // Group fields (present only for a group message). from is the individual SENDER; the
  // conversation is keyed on group_id (see convKey), and a reply goes to the whole group.
  group_id?: string; group_name?: string; participants?: string[];
}
export function isSmsPayload(p: unknown): p is SmsPayload {
  const o = p as any;
  return !!o && typeof o === "object" && Number.isSafeInteger(o.id) && typeof o.from === "string"
    && typeof o.content === "string" && (o.media_url === undefined || typeof o.media_url === "string") && typeof o.at === "string"
    && (o.group_id === undefined || typeof o.group_id === "string")
    && (o.group_name === undefined || typeof o.group_name === "string")
    && (o.participants === undefined || (Array.isArray(o.participants) && o.participants.every((n: unknown) => typeof n === "string")));
}

// The conversation key: a group is ONE thread keyed by group_id (whichever member speaks);
// a 1:1 stays keyed by the sender's number. Drives the transcript file, the dispatcher
// bucket, and the reply target -- so a group's messages accumulate in one thread and a
// reply goes back into the group rather than to whoever happened to send last.
export function convKey(payload: { group_id?: string; from: string }): string {
  return payload.group_id ? `group:${payload.group_id}` : payload.from;
}

// SigV4-signed sms-link connect -- mirrors home-bot.ts's signedLinkConnect but dials
// /sms-link. Signed fresh on every dial (x-amz-date skew window; see signedLinkConnect's
// header comment for why this must be a per-call closure, not a construction-time signature).
export function signedSmsLinkConnect(
  keys: HomeKeys,
  makeSocket: (url: string, headers: Record<string, string>) => WebSocketLike =
    (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike,
): () => Promise<WebSocketLike> {
  const aws = new AwsClient({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: "auto", service: "home" });
  const linkUrl = `${keys.endpoint.replace(/\/+$/, "")}/sms-link`;
  const wssUrl = linkUrl.replace(/^http/, "ws");
  return async () => {
    const signed = await aws.sign(linkUrl, { method: "GET" });
    return makeSocket(wssUrl, {
      authorization: signed.headers.get("authorization") ?? "",
      "x-amz-date": signed.headers.get("x-amz-date") ?? "",
    });
  };
}

// Container-side appliedThrough cursor (persisted for restart safety).
function loadCursor(): number { try { return JSON.parse(readFileSync(SMS_STATE_PATH, "utf8")).appliedThrough ?? -1; } catch { return -1; } }
function storeCursor(n: number): void { // monotonic: never regress the cursor; temp+rename so a mid-write kill can't leave a partial file (which would replay retained inbounds)
  const next = Math.max(loadCursor(), n);
  mkdirSync(dirname(SMS_STATE_PATH), { recursive: true });
  const tmp = `${SMS_STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ appliedThrough: next }));
  renameSync(tmp, SMS_STATE_PATH);
}

export interface InboundDeps {
  cursorLoad: () => number;
  cursorStore: (n: number) => void;
  sendAck: (appliedThrough: number) => void;
  dispatch: (phone: string, payload: SmsPayload) => void;
  markRead: (phone: string) => void; // fire-and-forget read receipt for a NEW inbound (best-effort)
  // Record a poison inbound (preserve it) when handling it fails non-retryably. MAY throw
  // (if the DLQ write itself fails) -- handleInbound lets that propagate so the cursor is
  // NOT advanced and the DO redelivers. See dead-letter.ts.
  deadLetter: (payload: SmsPayload, err: unknown) => void;
  logErr: (m: string) => void;
}

export async function handleInbound(payload: SmsPayload, deps: InboundDeps): Promise<void> {
  const cursor = deps.cursorLoad();
  if (payload.id <= cursor) { deps.sendAck(cursor); return; } // already applied; re-ack to prompt prune (no re-read-receipt)
  let applied = true;
  // The try wraps ONLY the transcript write -- NOT markRead/dispatch below -- so the
  // catch's "poison: not applied" classification can't fire after the inbound is already
  // durably in the transcript (replaying that DLQ entry would double-append). Mirrors
  // chat-bot.ts's handleIntent.
  try {
    // Keyed on the conversation (group_id for a group, else the sender). `from` is recorded
    // only for a group message, so renderHistory can attribute "who said what"; a 1:1's key
    // already IS the speaker.
    await appendTranscript(convKey(payload), { direction: "in", at: payload.at, content: payload.content, media_url: payload.media_url, from: payload.group_id ? payload.from : undefined });
  } catch (err) {
    // Poison inbound: appendTranscript's lock retries are exhausted or the failure is
    // non-retryable. Dead-letter it (preserved for inspection/replay), then FALL THROUGH to
    // advance the cursor + ack so the drain moves on -- not lost silently (a later success
    // would ack this id away), and the cursor advances exactly once so the redelivery gate
    // never dispatches this inbound's run twice. Full rationale in chat-bot.ts's
    // handleIntent. A deadLetter() that throws (FS write failed) propagates to the drain's
    // .catch, skipping the cursorStore/sendAck below, so the DO redelivers.
    applied = false;
    deps.deadLetter(payload, err);
    deps.logErr(`sms handleInbound: dead-lettered inbound ${payload.id} (${(err as Error)?.message ?? err})`);
  }
  // "Read" receipt (fire-and-forget) + dispatch run ONLY after a successful apply. The read
  // receipt is 1:1 only (a group's presence isn't modelled here); dispatch buckets on the
  // conversation key so a group coalesces into one thread/run.
  if (applied) {
    if (!payload.group_id) deps.markRead(payload.from);
    deps.dispatch(convKey(payload), payload);
  }
  deps.cursorStore(payload.id);
  deps.sendAck(payload.id);
}

// Same sanitizer pipeline Discord uses on attacker-influenced transcript text
// before it enters the prompt: strip invisible \p{Cf} format chars + fold exotic
// line terminators (normalizeTranscriptText, char-level, FIRST), then byte-exact
// structural marker/separator removal (neutralizeStructuralMarkers). Load-bearing:
// an inbound text body is untrusted, so it must NEVER be interpolated raw -- that
// was the parked buildPrompt prompt-injection concern (a texter forging a fake
// speaker turn or trigger marker in the history). The composition itself now lives
// in transcript.ts (cleanForPrompt) so the normalize-then-neutralize ordering isn't
// duplicated across the two bot files on this security boundary.
const clean = cleanForPrompt;

// Render the SMS transcript into a sanitized, oldest-first history with a clear
// speaker label per line (inbound = the person, outbound = Baxter). Every inbound
// body goes through `clean`; continuation lines are indented four spaces so a
// multi-line body can't forge a new column-0 speaker entry attributed to someone
// else (mirrors discord-bot.ts's renderHistory).
export function renderHistory(entries: TranscriptEntry[], opts: { group?: boolean; nameOf?: (phone: string) => string } = {}): string {
  return entries
    .map((e) => {
      let who: string;
      if (e.direction === "out") who = `${PERSONA_NAME} (you)`;
      else if (opts.group) {
        // Attribute the speaker in a group (name if we know it, else the number). The label
        // is sanitized like any other single-line slot -- a name is operator-set, but a phone
        // is provider-supplied, and neither may forge a column-0 speaker line.
        const label = (e.from && opts.nameOf?.(e.from)) || e.from || "Someone";
        who = cleanForPromptLine(label);
      } else who = "The person";
      const body = clean(e.content);
      // Media is a fixed marker (images aren't rendered into the prompt); the URL
      // is not interpolated. Keep it on one line so it can't forge an entry.
      const marks = e.media_url ? "[image]" : "";
      const text = marks ? (body ? `${body} ${marks}` : marks) : body;
      return `${who}: ${text.split("\n").join("\n    ")}`;
    })
    .join("\n");
}

// Fill the rich sms-prompt.md template, mirroring discord-bot.ts's renderPrompt:
// persona, the contact phone, memory/credentials/skills paths, the injection-safe
// projects + loaded/learned skills preambles, and the SANITIZED transcript as
// HISTORY. Single-pass fillTemplate (see runtime.ts) so an inserted value is never
// re-scanned -- an attacker-influenced HISTORY can't smuggle in another placeholder.
// Group context for a group run (absent -> a 1:1). `sender` is who sent the triggering
// message, used as the schedule-cli target (schedule-cli delivers 1:1, not into a group).
export interface GroupCtx { id: string; name?: string; participants?: string[]; sender?: string; }

export function buildPrompt(convId: string, allowlistPath?: string, group?: GroupCtx): string {
  const template = readFileSync(PROMPT_PATH, "utf8");
  // A family name for a number, if the DO taught us one (deriveSnapshot -> allowlist names),
  // so Baxter uses names rather than bare numbers. cleanForPromptLine collapses newlines in
  // the correct pipeline order (a name could carry one and forge a column-0 line); an
  // all-format-char name (-> "") falls back to the bare number. Path injectable for tests.
  const nameCache = new Map<string, string>();
  const nameOf = (ph: string): string => {
    // Memoized per build: nameForAddress re-reads the allowlist JSON off disk each call, and a
    // group prompt asks for the same numbers once per participant AND once per history entry.
    // One read per distinct number keeps the "fresh per build" behavior without the loop of I/O.
    let v = nameCache.get(ph);
    if (v === undefined) {
      const raw = nameForAddress(ph, process.env, allowlistPath);
      v = raw ? cleanForPromptLine(raw) : "";
      nameCache.set(ph, v);
    }
    return v;
  };
  // CONVO_DESC frames who Baxter is talking to and how to reply; REPLY_CMD is the exact
  // reply command; CONTACT is the schedule-cli target; GROUP_NOTE adds the be-selective rule.
  let convoDesc: string, replyCmd: string, contactArg: string, groupNote: string;
  if (group) {
    // group.id and the participant phones come off the webhook (isSmsPayload validates them only
    // as strings) -- unlike `from`, they are NOT the Worker-authorized sender, so they get the same
    // single-line sanitization as every other prompt slot, or a newline/marker in one could forge a
    // column-0 line in this section. group.id is also the reply command's arg; a legit Sendblue id
    // is untouched by the clean, and a malformed one failing the reply is the safe direction.
    replyCmd = `sms-cli send-group ${cleanForPromptLine(group.id)}`;
    const members = (group.participants ?? []).map((ph) => {
      const p = cleanForPromptLine(ph); const n = nameOf(ph);
      return n ? `${n} (${p})` : p;
    });
    const namePart = group.name ? ` "${cleanForPromptLine(group.name)}"` : "";
    const memberPart = members.length ? ` with ${members.join(", ")}` : "";
    convoDesc = `- This is a group text${namePart}${memberPart}. To answer, run \`${replyCmd}\` with your message on stdin -- it goes to EVERYONE in the group, not one person.`;
    // schedule-cli delivers to a single number, so a deferred action targets the sender.
    contactArg = group.sender || group.participants?.[0] || "";
    groupNote = "\n- **You're one of several people here.** Don't reply to every message -- chime in only when you're addressed by name, asked something you can answer, or can clearly help; otherwise just update memory if needed and exit WITHOUT sending. When you do reply, everyone in the group sees it.";
  } else {
    replyCmd = `sms-cli send ${convId}`;
    const display = nameOf(convId);
    const contactDesc = display ? `${display} (${convId})` : convId;
    convoDesc = `- The person you're texting is ${contactDesc}; ${convId} is the phone number you reply to and the argument to the sms-cli / schedule-cli commands below.`;
    contactArg = convId;
    groupNote = "";
  }
  return fillTemplate(template, {
    PERSONA_NAME,
    CONVO_DESC: convoDesc,
    GROUP_NOTE: groupNote,
    // The exact reply command (bare number / group id -- no name, since it's a command arg).
    REPLY_CMD: replyCmd,
    // Keep CONTACT bare: it is interpolated into schedule-cli arguments.
    CONTACT: contactArg,
    HISTORY: renderHistory(readTranscript(convId, 20), { group: !!group, nameOf }),
    MEMORY_PATH,
    CREDENTIALS_PATH,
    LEARNED_SKILLS_DIR,
    // Injection-safe (slug + date only) -- see projectsPreamble.
    PROJECTS_LIST: projectsPreamble(),
    // Static list of the surface's baked skills (from grants.ts).
    LOADED_SKILLS: loadedSkillsList(SMS_SKILL_NAMES),
    // Injection-safe (learned-skill NAMES only, sanitized) -- see skillsPreamble.
    LEARNED_SKILLS_LIST: skillsPreamble(),
  });
}

// The env handed to a spawned run, with the Sendblue creds stripped: the run replies via
// sms-cli, which reads them from the 0600 SMS_KEYS_PATH file (written at startup), so the
// raw values never sit in the run's env where an allowed command could echo them. Mirrors
// discord-bot.ts's DISCORD_BOT_TOKEN strip (and runAgent's own central stripRunSecrets,
// which does NOT know about the Sendblue vars -- so this local strip is load-bearing).
export function makeRunEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e.SENDBLUE_API_KEY; delete e.SENDBLUE_API_SECRET; delete e.SENDBLUE_FROM_NUMBER;
  return e;
}

// The model the SMS surface runs on. SMS_MODEL overrides BAXTER_MODEL for THIS surface
// ONLY -- SMS turns are small and low-volume, so a smarter/pricier model (better at
// navigating ambiguity) is affordable here even when the fleet default stays cheaper.
// Falls back to BAXTER_MODEL, then "sonnet", exactly like every other surface's default.
// NOTE: this string only reaches the `claude` adapter (runAgent's `model` -> --model).
// The structured-tool harnesses (openrouter/openai/custom -- openrouter is the DEFAULT)
// ignore `model` and read their own OPENROUTER_MODEL/OPENAI_MODEL/CUSTOM_API_MODEL. Of
// those, only openrouter-runner honors a per-run override (BAXTER_MODEL_OVERRIDE);
// applySmsModelOverride() below routes SMS_MODEL through THAT so the override takes effect
// on the default openrouter harness, not just claude.
export function smsModel(env: NodeJS.ProcessEnv): string {
  return env.SMS_MODEL || env.BAXTER_MODEL || "sonnet";
}

// Route an explicit SMS_MODEL through BAXTER_MODEL_OVERRIDE -- the per-run model override
// the openrouter runner honors (openrouter-runner reads BAXTER_MODEL_OVERRIDE ||
// OPENROUTER_MODEL; it's the same channel multimodal routing uses). Without this, SMS_MODEL
// is a silent no-op on the default openrouter harness -- runAgent's `model` only feeds the
// claude adapter. (The openai/custom runners read only OPENAI_MODEL/CUSTOM_API_MODEL and
// have no per-surface override; they aren't in use here -- openrouter is the fleet harness.)
// Mutates and returns `runEnv`.
//
// Gated STRICTLY on SMS_MODEL being explicitly set: smsModel()'s "sonnet" fallback is a
// claude alias, not a valid OPENROUTER_MODEL id -- pinning it via BAXTER_MODEL_OVERRIDE
// would break every default SMS run on openrouter. Unset SMS_MODEL -> env untouched, so the
// run uses the fleet default (OPENROUTER_MODEL). The value must match the active harness's
// model-id format (a full OpenRouter id under openrouter; a claude alias under claude).
export function applySmsModelOverride(runEnv: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const override = (env.SMS_MODEL ?? "").trim();
  if (override) runEnv.BAXTER_MODEL_OVERRIDE = override;
  return runEnv;
}

export interface SmsBotDeps { loadHomeKeys: () => HomeKeys; env: NodeJS.ProcessEnv; makeSocket?: (url: string, headers: Record<string, string>) => WebSocketLike; log: (m: string) => void; logErr: (m: string) => void; }
export function defaultDeps(): SmsBotDeps { return { loadHomeKeys, env: process.env, log, logErr }; }

export async function main(deps: SmsBotDeps = defaultDeps()): Promise<void> {
  let keys: HomeKeys;
  try {
    keys = deps.loadHomeKeys();
  } catch (err) {
    // Absent/malformed credential -> log once and idle (do NOT crash-loop the container),
    // mirroring home-bot.ts's startup handling.
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") deps.log("sms: no home-keys.json -- sms surface idle (provision with `baxctl home <id>`)");
    else deps.logErr(`sms: home-keys.json unreadable (${e.message}) -- sms surface idle until it's fixed`);
    idleForever();
    return;
  }

  // Persist Sendblue creds 0600 for sms-cli (daemon holds them; run never sees them).
  const { SENDBLUE_API_KEY, SENDBLUE_API_SECRET, SENDBLUE_FROM_NUMBER } = deps.env;
  if (SENDBLUE_API_KEY && SENDBLUE_API_SECRET && SENDBLUE_FROM_NUMBER) {
    mkdirSync(dirname(SMS_KEYS_PATH), { recursive: true });
    writeFileSync(SMS_KEYS_PATH, JSON.stringify({ apiKey: SENDBLUE_API_KEY, apiSecret: SENDBLUE_API_SECRET, fromNumber: SENDBLUE_FROM_NUMBER }), { mode: 0o600 });
  }
  const MODEL = smsModel(deps.env);
  // makeRunEnv strips the Sendblue creds; applySmsModelOverride pins SMS_MODEL via
  // BAXTER_MODEL_OVERRIDE so the override reaches the openrouter runner too (the `model`
  // below only feeds the claude adapter). See applySmsModelOverride's comment.
  const RUN_ENV = applySmsModelOverride(makeRunEnv(), deps.env);
  // Opt into the harness's unsent-reply poke (parity with discord-bot): if the model composes
  // an answer as TEXT but forgets to send it via sms-cli, the runner pokes it to actually send
  // instead of ending in silence. The poke names sms-cli (surface-aware replyHint), and an
  // sms-cli send / send-group now marks `delivered` (isDeliveryCall), so a real reply never
  // triggers a duplicate poke. BAXTER_REPLY_REQUIRED is deliberately LEFT OFF: the model may
  // legitimately choose no reply (a 1:1 "thanks" sign-off, or staying quiet in a group) without
  // being nudged to manufacture one -- EXPECT_REPLY only fixes an ALREADY-composed-but-unsent
  // answer, it doesn't force one.
  RUN_ENV.BAXTER_EXPECT_REPLY = "1";
  // Presence signals (read receipts + typing bubbles), best-effort and fire-and-forget: they must
  // NEVER delay the ack, dispatch, or the reply. Enabled only when Sendblue creds are present (else
  // sms-cli's creds() would throw per call); iMessage/RCS-only, so a no-op for green-bubble SMS.
  const smsSendable = Boolean(SENDBLUE_API_KEY && SENDBLUE_API_SECRET && SENDBLUE_FROM_NUMBER);
  const markRead = smsSendable
    ? (phone: string) => { sendReadReceipt(phone).catch((e) => deps.logErr(`sms mark-read: ${(e as Error).message}`)); }
    : () => {};
  const typing = smsSendable
    ? (phone: string, state: "start" | "stop") => { sendTypingIndicator(phone, state).catch((e) => deps.logErr(`sms typing ${state}: ${(e as Error).message}`)); }
    : () => {};
  const dispatcher = new (class extends ChannelDispatcher<SmsPayload> {
    // Carry a burst's media forward when coalescing: "send a photo, then a caption" arrives
    // as two near-simultaneous webhooks inside the debounce, and a plain latest-wins would
    // drop the image when the text-only caption becomes the surface message (there's no
    // get-attachment fallback on SMS). Keep next, but graft prev's media_url when next lacks
    // one. Mirrors discord-bot's _coalesce media carry.
    _coalesce(prev: SmsPayload, next: SmsPayload): SmsPayload {
      return next.media_url || !prev.media_url ? next : { ...next, media_url: prev.media_url };
    }
  })({
    debounceMs: 4000, maxConcurrent: 3, maxRunsPerWindow: 60, windowMs: 3_600_000,
    runFn: async (convId, payload) => {
      const isGroup = Boolean(payload.group_id);
      // Presence (typing bubble) is 1:1 only; for a 1:1 convId IS the sender's number.
      if (!isGroup) typing(payload.from, "start"); // "…" bubble while the run works; the reply (or ~60s) clears it
      // Route an MMS run to the multimodal model with the image attached, exactly as
      // discord-bot does; a text-only SMS (or an unconfigured multimodal model) keeps RUN_ENV
      // unchanged. The override supersedes SMS_MODEL only for this one media-carrying run.
      const media = smsMedia(payload);
      const useMedia = Boolean(MULTIMODAL_MODEL) && media.length > 0;
      const env = useMedia
        ? { ...RUN_ENV, BAXTER_MODEL_OVERRIDE: MULTIMODAL_MODEL, BAXTER_MEDIA: JSON.stringify(media) }
        : RUN_ENV;
      const group: GroupCtx | undefined = isGroup
        ? { id: payload.group_id!, name: payload.group_name, participants: payload.participants, sender: payload.from }
        : undefined;
      try {
        await runAgent({
          prompt: buildPrompt(convId, undefined, group),
          logId: String(payload.id),
          surface: "sms",
          cwd: MEMORY_DIR,
          model: MODEL,
          allowedTools: SMS_TOOLS,
          runsDir: SMS_RUNS_DIR,
          env,
          beforeRun: () => {
            ensurePlaywrightConfig(MEMORY_DIR);
            ensureSkills(SMS_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
          },
        });
      } finally {
        if (!isGroup) typing(payload.from, "stop"); // stop promptly when the run ends (harmless if the reply already cleared it)
      }
    },
  });
  const link = new HomeLink({
    connect: signedSmsLinkConnect(keys, deps.makeSocket),
    viewVersion: () => null,
    appliedThrough: () => loadCursor(),
    logErr: deps.logErr,
  });
  // Serialize inbound handling: a reconnect hello-replay burst arrives as separate
  // frames; running handleInbound concurrently would let proper-lockfile's non-FIFO
  // retry race regress the cursor and reorder transcript entries.
  let chain: Promise<void> = Promise.resolve();
  link.onCommand((payload) => {
    if (!isSmsPayload(payload)) { deps.logErr("sms: bad inbound payload"); return; }
    chain = chain.then(() => handleInbound(payload, {
      cursorLoad: loadCursor, cursorStore: storeCursor,
      sendAck: (n) => link.sendAck(n),
      dispatch: (convId, p) => dispatcher.notify(convId, p),
      markRead,
      deadLetter: (p, err) => recordDeadLetter("sms", { id: p.id, at: p.at, from: p.from, error: String((err as Error)?.stack ?? err), payload: p }),
      logErr: deps.logErr,
    // Reached when handleInbound rejected: either the DLQ write itself failed (cursor NOT
    // advanced -- the DO redelivers, safe), or cursorStore/sendAck threw AFTER a successful
    // apply+dispatch (redelivery would then double-dispatch -- a pre-existing narrow window,
    // not introduced by the DLQ). Log loudly either way.
    })).catch(err => deps.logErr(`sms drain: inbound not fully recorded -- the DO may redeliver: ${err}`));
  });
  link.start();
  // Keep the process alive across reconnect windows: HomeLink's heartbeat/reconnect/hbAck
  // timers are all unref'd (home-link.ts -- "a live link must never be the reason the
  // process can't exit", written for a link sharing a process with Discord/mail). This
  // surface is standalone, so between a disconnect and the next redial nothing else would
  // ref the event loop and the process would exit (Docker would restart-loop it). A ref'd
  // timer parks us, exactly like home-bot.ts's idleForever.
  idleForever();
  deps.log(`sms: surface up (tenant ${keys.tenant}) -> ${keys.endpoint}`);
}

// A ref'd no-op timer that keeps the event loop non-empty (see main's call site).
function idleForever(): void { setInterval(() => {}, 2 ** 31 - 1); }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // logErr (not console.error) so a fatal SMS startup error also ships to the Discord log
  // mirror (#baxter-logs-sms). await flushLogs() first: logErr only BUFFERS the line, so a
  // synchronous process.exit() would kill the shipper before it posts (bounded, so a wedged
  // webhook can't delay the exit; the line is in `docker logs` either way).
  main().catch(async err => { logErr(`sms: fatal: ${(err as Error).message}`); await flushLogs(); process.exit(1); });
}
