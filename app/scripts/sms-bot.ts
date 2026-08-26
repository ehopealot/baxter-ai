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
import { appendTranscript, readTranscript, isStrictGroupId, type TranscriptEntry } from "./sms-transcript.ts";
import { deadLetter as recordDeadLetter } from "./dead-letter.ts";
import { sendReadReceipt, sendTypingIndicator, sendSms } from "./sms-cli.ts";
import { introDecision, introNote, markCardSent, markExplained, markFeaturesIntroduced, type IntroDecision } from "./intro-state.ts";
import { concludeDiscovery, discoveryDecision, discoveryNote, type DiscoveryDecision } from "./feature-discovery.ts";
import { RunObserver } from "./run-observer.ts";
import { recordSignal } from "./signal-store.ts";
import { normalizePhone } from "./normalize-phone.ts";
import { isStopMessage, setSmsOptOut } from "./sms-opt-out.ts";
import { runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, skillsPreamble, log, logErr, flushLogs, FALLBACK_NOTICE, loggerFor } from "./runtime.ts";
import { PROACTIVE_FOLLOWUP_GUIDANCE } from "./proactive-followup-guidance.ts";
import { cleanForPrompt, cleanForPromptLine } from "./transcript.ts";
import { collectionsPreamble } from "./collections-cli.ts";
import { householdPreamble } from "./household.ts";
import { loadHomeKeys, type HomeKeys } from "./home-mirror.ts"; // key loader lives here; home-bot only re-imports it
import { SMS_KEYS_PATH, SMS_STATE_PATH, MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR } from "./paths.ts";
import { SMS_TOOLS, SMS_SKILL_SRCS, SMS_SKILL_NAMES, loadedSkillsList } from "./grants.ts";
import { loadAllowlist, nameForAddress } from "./allowlist.ts";
import { householdTz } from "./household-tz.ts";
import { resolveRecipients } from "./recipients.ts";
import { canonicalMorningOccurrence, decideInboundIdentity, handoffPromptBlock, makeMorningClaim, retainEarliestClaim, type MorningHandoffClaim } from "./morning-handoff.ts";
import { directConsume, sharedClose } from "./morning-handoff-store.ts";
import { morningCheckInDefinition, prepareMorningHandoff } from "./morning-check-in.ts";
import { readTasksForMorningHandoff } from "./schedule-store.ts";
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
  if (!o || typeof o !== "object" || !Number.isSafeInteger(o.id) || typeof o.from !== "string"
    || typeof o.content !== "string" || (o.media_url !== undefined && typeof o.media_url !== "string") || typeof o.at !== "string"
    // group_id is core routing data whenever present; optional display metadata is not.
    || (o.group_id !== undefined && typeof o.group_id !== "string")) return false;
  // Provider optional metadata is all-or-nothing. Do not reject an otherwise valid
  // group inbound or filter a mixed list into a deceptively safe subset: degrade both
  // fields to unavailable so it preserves ordinary transcript/reply behavior but can
  // only take the silent handoff-close path.
  if ((o.group_name !== undefined && typeof o.group_name !== "string")
    || (o.participants !== undefined && (!Array.isArray(o.participants) || !o.participants.every((n: unknown) => typeof n === "string")))) {
    delete o.group_name;
    delete o.participants;
  }
  return true;
}

// The conversation key: a group is ONE thread keyed by group_id (whichever member speaks);
// a 1:1 stays keyed by the sender's number. Drives the transcript file, the dispatcher
// bucket, and the reply target -- so a group's messages accumulate in one thread and a
// reply goes back into the group rather than to whoever happened to send last.
// group_id is tested for PRESENCE, not truthiness: an empty string is still a group
// message (it keys "group:" and quarantines under gx-<sha256>), never a 1:1 keyed on
// the sender (spec 2026-08-18-scheduled-sms-group-delivery §Error handling).
export function convKey(payload: { group_id?: string; from: string }): string {
  return payload.group_id !== undefined ? `group:${payload.group_id}` : payload.from;
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
  dispatch: (phone: string, payload: SmsDispatchItem) => void;
  markRead: (phone: string) => void; // fire-and-forget read receipt for a NEW inbound (best-effort)
  // Record a poison inbound (preserve it) when handling it fails non-retryably. MAY throw
  // (if the DLQ write itself fails) -- handleInbound lets that propagate so the cursor is
  // NOT advanced and the DO redelivers. See dead-letter.ts.
  deadLetter: (payload: SmsPayload, err: unknown) => void;
  logErr: (m: string) => void;
  /** Invoked only after the transcript append has durably completed. */
  consumeMorningHandoff?: (payload: SmsPayload) => Promise<MorningHandoffClaim | null>;
}

export interface SmsDrainLink {
  onCommand(cb: (payload: unknown) => void): void;
  onOpen(cb: () => void): void;
  start(): void;
}

// Serialize the production command drain and establish a cumulative-ACK barrier after any
// unrecorded inbound. Higher commands already queued on the old connection are skipped; a
// forced reconnect makes the DO replay from its own cursor, and onOpen clears the barrier in
// chain order before that new connection's ascending replay can arrive.
export function wireSmsDrain(
  link: SmsDrainLink,
  handle: (payload: SmsPayload) => Promise<void>,
  logErr: (message: string) => void,
): { flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  let failedFloor = Infinity;

  link.onOpen(() => {
    chain = chain.then(() => { failedFloor = Infinity; });
  });
  link.onCommand(payload => {
    if (!isSmsPayload(payload)) { logErr("sms: bad inbound payload"); return; }
    chain = chain
      .then(async () => {
        if (payload.id > failedFloor) return;
        await handle(payload);
      })
      .catch(err => {
        failedFloor = Math.min(failedFloor, payload.id);
        logErr(`sms drain: inbound not fully recorded -- forcing replay before any higher ACK: ${err}`);
        link.start();
      });
  });

  return { flush: () => chain };
}

export type SmsDispatchItem = SmsPayload & {
  morningClaim?: MorningHandoffClaim;
  /** Internal classification of this inbound's complete group snapshot. */
  morningGroupSafe?: boolean;
  /** A pending claim was invalidated by an unsafe successor; never set by admission alone. */
  morningClaimInvalidated?: boolean;
};

export async function handleInbound(payload: SmsPayload, deps: InboundDeps): Promise<void> {
  const cursor = deps.cursorLoad();
  if (payload.id <= cursor) { deps.sendAck(cursor); return; } // already applied; re-ack to prompt prune (no re-read-receipt)
  // Usage metering (usage-metrics spec §2, round-3 amendment): one sms_rx signal per
  // APPLIED inbound, recorded BEFORE the transcript append -- a poison inbound still
  // counts (the message WAS received), and because the cursor advances only after a
  // fully-recorded pass, the ONLY duplicate source is a DO redelivery after a
  // deadLetter() throw (at-least-once, accepted; retry test in sms-bot.test.ts). The
  // counterpart is CANONICALIZED HERE, not by convKey(): convKey deliberately normalizes
  // nothing (transcript keys stay raw), so the hook supplies normalizePhone's E.164 form
  // for a 1:1 -- the same canonical form sms-cli's gatedSend records as sms_tx, so rx and
  // tx collapse onto one label series -- and `group:<id>` for a group. An un-normalizable
  // garbage `from` falls back to the raw string (the store clamps it) so the count is
  // never lost. recordSignal never throws (metering cannot break the inbound path).
  recordSignal({ t: Date.now(), kind: "sms_rx", counterpart: payload.group_id !== undefined ? `group:${payload.group_id}` : (normalizePhone(payload.from) ?? payload.from) });

  // Carrier-style STOP applies only to direct conversations. Persist the canonical number
  // before acknowledging, then consume the control message silently: it is neither chat
  // history nor an agent trigger. Any later non-STOP direct inbound reopens outbound before
  // normal processing. Store errors deliberately propagate, leaving the cursor unadvanced so
  // the DO redelivers instead of losing an opt-out or dispatching while state is uncertain.
  if (payload.group_id === undefined) {
    if (isStopMessage(payload.content)) {
      await setSmsOptOut(payload.from, true);
      deps.cursorStore(payload.id);
      deps.sendAck(payload.id);
      return;
    }
    // Preserve the existing defensive path for malformed provider senders: there can be no
    // canonical suppression record to clear, but an ordinary malformed inbound still follows
    // the transcript/DLQ handling below rather than becoming a new fatal condition.
    if (normalizePhone(payload.from)) await setSmsOptOut(payload.from, false);
  }

  let applied = true;
  // The try wraps ONLY the transcript write -- NOT markRead/dispatch below -- so the
  // catch's "poison: not applied" classification can't fire after the inbound is already
  // durably in the transcript (replaying that DLQ entry would double-append). Mirrors
  // chat-bot.ts's handleIntent.
  try {
    // Keyed on the conversation (group_id for a group, else the sender). `from` is recorded
    // only for a group message, so renderHistory can attribute "who said what"; a 1:1's key
    // already IS the speaker. A group is decided by group_id PRESENCE, so an empty id still
    // takes the group path. A group inbound ALSO persists the webhook's available group
    // metadata on its own entry (spec 2026-08-18-scheduled-sms-group-delivery): group_id is
    // the EXACT raw provider id (a malformed id lands under the gx-<sha256> quarantine path
    // and keeps its raw id on every entry), group_name / participants are untrusted display
    // metadata persisted as JSON values. One-to-one entries stay unchanged, and there is no
    // backfill: a legacy transcript enriches at its next inbound.
    const entry: TranscriptEntry = {
      direction: "in", at: payload.at, content: payload.content, media_url: payload.media_url,
      from: payload.group_id !== undefined ? payload.from : undefined,
    };
    if (payload.group_id !== undefined) {
      entry.group_id = payload.group_id;
      if (payload.group_name !== undefined) entry.group_name = payload.group_name;
      if (payload.participants !== undefined) entry.participants = payload.participants;
    }
    await appendTranscript(convKey(payload), entry);
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
    // Handoff authority is intentionally after durable receipt but before the
    // existing receipt/dispatch boundary. A sidecar failure is represented by no
    // claim and never changes ordinary acknowledgement or dispatch behavior.
    const morningClaim = await deps.consumeMorningHandoff?.(payload) ?? null;
    if (payload.group_id === undefined) deps.markRead(payload.from);
    deps.dispatch(convKey(payload), morningClaim ? { ...payload, morningClaim } : payload);
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
// collections + loaded/learned skills preambles, and the SANITIZED transcript as
// HISTORY. Single-pass fillTemplate (see runtime.ts) so an inserted value is never
// re-scanned -- an attacker-influenced HISTORY can't smuggle in another placeholder.
// Group context for a group run (absent -> a 1:1). Scheduling delivers back INTO the
// group via `--sms-group <id>` (spec 2026-08-18-scheduled-sms-group-delivery), never to
// the triggering sender's individual number.
export interface GroupCtx { id: string; name?: string; participants?: string[]; }

// Build the fillTemplate SLOT MAP for one SMS run. Split out of buildPrompt (which
// just reads the template and fills it) so the byte-identity regression test can
// render the placeholder-INTRO-stripped template with the same slots and compare.
// opts threads PRE-CAPTURED intro/discovery decisions (the runFn factory captures
// them once at dispatch so the rendered note and the post-run conclusion share ONE
// decision); the defaults re-derive per render, the pre-factory behavior.
export function promptSlots(convId: string, allowlistPath?: string, group?: GroupCtx, opts?: { intro?: IntroDecision; discovery?: DiscoveryDecision; morningHandoff?: string }): Record<string, string> {
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
  // reply command; SCHEDULE_ARG is the schedule-cli delivery flag for THIS conversation
  // (a dedicated slot, so the 1:1 and group forms can never drift into one another);
  // GROUP_NOTE adds the be-selective rule.
  let convoDesc: string, replyCmd: string, scheduleArg: string, groupNote: string;
  if (group) {
    // group.id lands in REPLY_CMD and in SCHEDULE_ARG, slots the template tells the run to
    // EXECUTE, so they're COMMAND-ARGUMENT slots: line-cleaning would still pass shell
    // metacharacters (; | && $() `) straight into that command. group.id is off the webhook
    // (isSmsPayload checks only typeof string) and is NOT the Worker-authorized sender, so
    // validate its charset instead -- the ONE shared strict predicate from sms-transcript
    // (spec 2026-08-18-scheduled-sms-group-delivery), the same shape the transcript filename
    // and every outbound boundary use. Anything else drops BOTH the reply verb and the
    // group scheduling flag (never a 1:1 fallback) rather than risk injection (this also
    // catches the newline case, which cleaning would truncate to a real id).
    const gid = isStrictGroupId(group.id) ? group.id : "";
    replyCmd = gid ? `sms-cli send-group ${gid}` : "";
    // Scheduling delivers back INTO the group (spec §Agent-facing behavior): a deferred
    // result reaches everyone, so the flag is the group id -- never the triggering sender's
    // phone. A validated-failure run renders the fixed unavailable literal instead of any
    // --sms fallback.
    scheduleArg = gid ? `--sms-group ${gid}` : "(unavailable -- this group's id failed validation; don't schedule into it and don't substitute a 1:1 --sms)";
    // Participant phones are DISPLAY-only (never a command arg), so single-line cleaning is right.
    const members = (group.participants ?? []).map((ph) => {
      const p = cleanForPromptLine(ph); const n = nameOf(ph);
      return n ? `${n} (${p})` : p;
    });
    const namePart = group.name ? ` "${cleanForPromptLine(group.name)}"` : "";
    const memberPart = members.length ? ` with ${members.join(", ")}` : "";
    const howToReply = gid
      ? `To answer, run \`${replyCmd}\` with your message on stdin -- it goes to EVERYONE in the group, not one person.`
      : "Replying to this group is unavailable (its id failed validation), so don't try to send or schedule into it -- just read, and note anything useful to memory.";
    convoDesc = `- This is a group text${namePart}${memberPart}. ${howToReply}`;
    groupNote = "\n- **You're one of several people here.** Don't reply to every message -- chime in only when you're addressed by name, asked something you can answer, or can clearly help; otherwise just update memory if needed and exit WITHOUT sending. When you do reply, everyone in the group sees it.";
  } else {
    replyCmd = `sms-cli send ${convId}`;
    const display = nameOf(convId);
    const contactDesc = display ? `${display} (${convId})` : convId;
    convoDesc = `- The person you're texting is ${contactDesc}; ${convId} is the phone number you reply to and the argument to the sms-cli / schedule-cli commands below.`;
    // 1:1 scheduling is unchanged: the delivery target is the contact's own number.
    scheduleArg = `--sms ${convId}`;
    groupNote = "";
  }
  // First-contact intro (spec 2026-08-15-first-contact-intro-design §3): the shared
  // "first exchange" block renders when BAXTER_INTRO_GUIDANCE is ON and the latch's
  // explainedAt is unset; the SMS-only contact-card line additionally requires a 1:1
  // (never a group) and smsCardSentAt unset -- INDEPENDENT of explainedAt, so an
  // email-first household that already got the explanation still gets only the card
  // line on its first SMS. The feature-discovery note (spec 2026-08-19-cross-surface-
  // home-link-discovery §2) rides the SAME INTRO_NOTE slot: [introNote, discoveryNote]
  // filtered and joined with "\n\n", rendered "\n\n"-prefixed when non-empty and ""
  // otherwise -- so with the flag OFF, nothing pending, or an invalid HOME_BASE_URL
  // (discoveryNote returns "" in exactly those cases) the filled template stays
  // byte-identical to the no-intro build (pinned by the byte-identity test).
  const intro = opts?.intro ?? introDecision(process.env, !group);
  const discovery = opts?.discovery ?? discoveryDecision(process.env);
  const note = [introNote(intro), discoveryNote(discovery)].filter((s) => s !== "").join("\n\n");
  return {
    PERSONA_NAME,
    CONVO_DESC: convoDesc,
    GROUP_NOTE: groupNote,
    // The exact reply command (bare number / group id -- no name, since it's a command arg). When
    // a group id fails validation replyCmd is "", and the template interpolates {{REPLY_CMD}} at two
    // other unconditional sites ("run `...`" / "send via `...`"); an empty string there renders as
    // runnable-looking empty backticks that contradict CONVO_DESC's "replying unavailable". Fill it
    // with a fixed literal (a constant, so no command-arg concern) so all three sites read as "don't
    // send" -- otherwise the run might improvise `sms-cli send <sender>` on the read-only path.
    REPLY_CMD: replyCmd || "(unavailable -- replying is disabled for this run; do not send)",
    // The schedule-cli delivery flag for THIS conversation, in its own slot so the 1:1
    // (`--sms <phone>`) and group (`--sms-group <id>`) forms are rendered -- never
    // interchangeable. An empty group id renders the fixed unavailable literal above.
    SCHEDULE_ARG: scheduleArg,
    HISTORY: renderHistory(readTranscript(convId, 20), { group: !!group, nameOf }),
    MEMORY_PATH,
    CREDENTIALS_PATH,
    LEARNED_SKILLS_DIR,
    // The household roster (who lives here, how to reach them, how to reach someone
    // new) -- rendered fresh from the allowlist householdPreamble already knows how to
    // read, threading promptSlots's optional path through so an injected fixture drives
    // it in tests (undefined -> the default ALLOWLIST_PATH, same as nameOf above). Covers
    // 1:1 and group runs alike: the slot map is shared, so no group-path change is needed.
    HOUSEHOLD: householdPreamble(process.env, allowlistPath),
    // Injection-safe (slug + date only) -- see collectionsPreamble.
    COLLECTIONS_LIST: collectionsPreamble(),
    // Static list of the surface's baked skills (from grants.ts).
    LOADED_SKILLS: loadedSkillsList(SMS_SKILL_NAMES),
    // Injection-safe (learned-skill NAMES only, sanitized) -- see skillsPreamble.
    LEARNED_SKILLS_LIST: skillsPreamble(),
    // A nonempty handoff block supplies its own separating whitespace. This keeps
    // the established prompt byte-identical when there is no claim.
    MORNING_HANDOFF: opts?.morningHandoff || "",
    // Empty when no intro/discovery note is due -- the template embeds the placeholder INLINE
    // ("...chasing it here.{{INTRO_NOTE}}"), so an empty value restores the exact
    // pre-intro bytes; a due note arrives "\n\n"-prefixed to read as its own paragraph.
    INTRO_NOTE: note ? `\n\n${note}` : "",
  };
}

export function buildPrompt(convId: string, allowlistPath?: string, group?: GroupCtx, opts?: { intro?: IntroDecision; discovery?: DiscoveryDecision; morningHandoff?: string }): string {
  return `${fillTemplate(readFileSync(PROMPT_PATH, "utf8"), promptSlots(convId, allowlistPath, group, opts))}\n\n${PROACTIVE_FOLLOWUP_GUIDANCE}`;
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

// Options for makeSmsRunFn (below): production wiring plus injectable typing, sendSms,
// runAgent, marker, discovery-decision, and morning-handoff-preparation seams. They default
// to the REAL imported implementations -- except typing, which defaults to a no-op (tests
// never emit presence signals) -- so main()'s factory-built dispatcher
// closure IS the closure the tests drive. sendSms MUST be injectable because the 1:1
// failure path sends FALLBACK_NOTICE (a wiring test returning {failed:true} would
// otherwise attempt a real send). markFeaturesIntroduced carries intro-state's
// ENV-AWARE signature -- the factory passes deps.env so the discovery read and the mark
// write resolve the SAME latch file even when deps.env is a non-global object (the
// asymmetry markExplained/markCardSent still carry is out of scope, deferred).
export interface SmsRunDeps {
  env: NodeJS.ProcessEnv;
  runEnv: NodeJS.ProcessEnv;
  model: string;
  logErr: (m: string) => void;
  typing?: (phone: string, state: "start" | "stop") => void;
  sendSms?: typeof sendSms;
  runAgent?: typeof runAgent;
  markExplained?: typeof markExplained;
  markCardSent?: typeof markCardSent;
  markFeaturesIntroduced?: typeof markFeaturesIntroduced;
  discoveryDecision?: typeof discoveryDecision;
  prepareMorningHandoff?: typeof prepareMorningHandoff;
}

// The dispatcher run closure, extracted from main()'s anonymous ChannelDispatcher subclass
// (the makeHandleMessage/makeMailRunFn extraction precedent) so its metering/discovery
// seams are unit-testable. Behavior is the old inline closure's plus morning-handoff
// preparation/recheck and feature discovery (spec §2/§5/§6 SMS), same flow for both run shapes:
//   - a pending morning-handoff claim is prepared and rechecked before intro/discovery;
//     a failure retains the ordinary reply;
//   - the intro AND discovery decisions are captured ONCE at dispatch (one state read
//     each, provable via the injectable discoveryDecision seam); the prompt note and the
//     post-run conclusion share that ONE captured decision -- there is never a second
//     read;
//   - an invalid HOME_BASE_URL (decision.origin === null) fails open: the note is
//     omitted, no delivered URL can match, nothing is marked -- logged best-effort,
//     never blocking the reply;
//   - a fresh RunObserver rides the run as runAgent's onEvent (one observer per
//     dispatched run; its tool_use/tool_result FIFO pairing is per-stream);
//   - after a completed run (!failed && !outOfTokens), the pure concludeDiscovery seam
//     decides the mark set against the TRIGGERING TARGET -- the 1:1 convId or the group
//     id EXACTLY as validated for the reply command (isStrictGroupId; an unvalidated id
//     becomes "", which no delivery target can ever equal, fail open) -- and ONE
//     env-aware markFeaturesIntroduced call writes it (a multi-feature set from a
//     multi-link reply is one atomic mark); a mark failure logs and never fails the
//     reply. markExplained/markCardSent behavior is unchanged (contact-card and
//     first-contact marking stay independent).
export function makeSmsRunFn(deps: SmsRunDeps): (convId: string, payload: SmsDispatchItem) => Promise<void> {
  const typingImpl = deps.typing ?? (() => {});
  const sendSmsImpl = deps.sendSms ?? sendSms;
  const runAgentImpl = deps.runAgent ?? runAgent;
  const markExplainedImpl = deps.markExplained ?? markExplained;
  const markCardSentImpl = deps.markCardSent ?? markCardSent;
  const markFeaturesIntroducedImpl = deps.markFeaturesIntroduced ?? markFeaturesIntroduced;
  const discoveryDecisionImpl = deps.discoveryDecision ?? discoveryDecision;
  const prepareMorningHandoffImpl = deps.prepareMorningHandoff ?? prepareMorningHandoff;
  return async (convId: string, payload: SmsDispatchItem): Promise<void> => {
    const isGroup = payload.group_id !== undefined;
    // A persisted winner may be stale by debounce time; preparation rechecks the
    // canonical occurrence and failure merely leaves the ordinary prompt unchanged.
    let morningHandoff = "";
    if (payload.morningClaim) {
      try {
        const packet = await prepareMorningHandoffImpl(payload.morningClaim, { env: deps.env });
        if (packet) morningHandoff = handoffPromptBlock(packet);
      } catch { /* suppression remains durable; the conversational run continues */ }
    }
    // Presence (typing bubble) is 1:1 only; for a 1:1 convId IS the sender's number.
    if (!isGroup) typingImpl(payload.from, "start"); // "…" bubble while the run works; the reply (or ~60s) clears it
    // Route an MMS run to the multimodal model with the image attached, exactly as
    // discord-bot does; a text-only SMS (or an unconfigured multimodal model) keeps runEnv
    // unchanged. The override supersedes SMS_MODEL only for this one media-carrying run.
    const media = smsMedia(payload);
    const useMedia = Boolean(MULTIMODAL_MODEL) && media.length > 0;
    const env = useMedia
      ? { ...deps.runEnv, BAXTER_MODEL_OVERRIDE: MULTIMODAL_MODEL, BAXTER_MEDIA: JSON.stringify(media) }
      : deps.runEnv;
    const group: GroupCtx | undefined = isGroup
      ? { id: payload.group_id!, name: payload.group_name, participants: payload.participants }
      : undefined;
    // The first-contact and feature-discovery decisions for THIS run, captured at
    // dispatch time; buildPrompt renders from them below and the post-run conclusion
    // reuses the same captured objects (no re-read).
    const intro = introDecision(deps.env, !isGroup);
    const discovery = discoveryDecisionImpl(deps.env);
    // A null origin can only arise from a set-but-invalid HOME_BASE_URL (empty
    // means unset -> the default origin): best-effort operator signal; the note
    // is omitted and nothing can match regardless (fail-open, spec §3).
    if (discovery.origin === null && deps.env.HOME_BASE_URL) {
      deps.logErr(`sms: HOME_BASE_URL is set but invalid -- Home feature-discovery note omitted (replies are unaffected)`);
    }
    const observer = new RunObserver();
    try {
      const { outOfTokens, failed } = await runAgentImpl({
        prompt: buildPrompt(convId, undefined, group, { intro, discovery, morningHandoff }),
        logId: String(payload.id),
        surface: "sms",
        cwd: MEMORY_DIR,
        model: deps.model,
        allowedTools: SMS_TOOLS,
        runsDir: SMS_RUNS_DIR,
        env: isGroup
          ? { ...env, BAXTER_FOLLOWUP_SURFACE: "sms-group", BAXTER_FOLLOWUP_TARGET: payload.group_id! }
          : { ...env, BAXTER_FOLLOWUP_SURFACE: "sms", BAXTER_FOLLOWUP_TARGET: convId },
        onEvent: (ev) => observer.observe(ev),
        beforeRun: () => {
          ensurePlaywrightConfig(MEMORY_DIR);
          ensureSkills(SMS_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
        },
      });
      // A 1:1 text always owes a reply, so a run that delivered nothing (failed = hard error;
      // outOfTokens = credit/rate wall -- both mean no send went out, since the structured runners
      // return success when a reply DID) texts back a short courtesy note instead of going silent.
      // NOT for groups: SMS dispatches a run for EVERY group message with no addressed-to-Baxter
      // gate, and Baxter may legitimately stay quiet there, so a group-wide "couldn't process
      // that" on unaddressed chatter would be noise (same reason Discord gates its hard-fail
      // notice). sendSms carries its own daily cap + household-roster admission. LOUD-logged.
      if (!isGroup && (outOfTokens || failed)) {
        deps.logErr(`sms: FALLBACK notice for ${convId} -- run ${failed ? "failed" : "hit the token wall"} with no reply delivered`);
        try {
          await sendSmsImpl(payload.from, FALLBACK_NOTICE);
        } catch (err) { deps.logErr(`sms: fallback notice send failed: ${(err as Error).message}`); }
      }
      // First-contact latch writes (spec §5): the SURFACE process (here, not the
      // runner) sets explainedAt once the run whose prompt carried the intro block
      // completed with a reply (failed/outOfTokens both mean nothing went out, per
      // runAgent's contract), and smsCardSentAt once the CARD block rendered and the
      // run completed -- regardless of whether the run actually called
      // `sms-cli send-contact` (the once-only contract is the OFFER; a model that
      // skipped the call must not re-trigger it forever). Best-effort: a latch write
      // failure logs and never fails the reply.
      if (!failed && !outOfTokens) {
        try {
          if (intro.explain) markExplainedImpl();
          if (intro.card) markCardSentImpl();
        } catch (err) { deps.logErr(`sms: intro latch write failed: ${(err as Error).message}`); }
        // Feature-discovery latch write (spec §6/§8): mark all and only verified
        // introductions, as one atomic set, through the env-aware marker so the write
        // lands on the same latch file the captured decision read. The triggering
        // target is the 1:1 convId (the exact string rendered into 'sms-cli send
        // <convId>') or the group id EXACTLY as validated for the reply command -- an
        // unvalidated id becomes "", which no delivery target can equal. Best-effort alike.
        try {
          const triggerTarget = isGroup ? (isStrictGroupId(payload.group_id!) ? payload.group_id! : "") : convId;
          const toMark = concludeDiscovery(discovery, observer.summary(), triggerTarget, { failed, outOfTokens });
          if (toMark.length) markFeaturesIntroducedImpl(toMark, deps.env);
        } catch (err) { deps.logErr(`sms: feature-discovery latch write failed: ${(err as Error).message}`); }
      }
    } finally {
      if (!isGroup) typingImpl(payload.from, "stop"); // stop promptly when the run ends (harmless if the reply already cleared it)
    }
  };
}

export interface SmsDispatcherDeps extends SmsRunDeps {
  /** Sampled once per successfully appended, admitted inbound; never at construction. */
  now?: () => Date;
  allowlistPath?: string;
  loadAllowlistImpl?: typeof loadAllowlist;
}

class MorningSmsDispatcher extends ChannelDispatcher<SmsDispatchItem> {
  override _coalesce(previous: SmsDispatchItem, next: SmsDispatchItem): SmsDispatchItem {
    const claim = retainEarliestClaim(previous.morningClaim ?? null, next.morningClaim ?? null);
    // Only an unsafe successor to a real pending claim can close that claim. An
    // unsafe non-admitted item has no handoff authority, so it cannot poison a
    // later safe winner merely by crossing latest/waiting/queued transitions.
    // The explicit invalidation marker carries only a completed invalidation;
    // it is distinct from an inbound snapshot's safety classification.
    const invalidated = previous.morningClaimInvalidated === true
      || (previous.morningClaim !== undefined && next.morningGroupSafe === false);
    // An unsafe successor removes only the pending handoff claim. It still follows
    // the normal latest-payload/media merge; returning `next` here would discard
    // an MMS carried by the prior item when the successor is caption-only.
    const merged = next.media_url || !previous.media_url ? next : { ...next, media_url: previous.media_url };
    return invalidated ? { ...merged, morningClaim: undefined, morningClaimInvalidated: true } : claim ? { ...merged, morningClaim: claim } : merged;
  }
}

/** The main-used SMS production seam: durable admission plus the real coalescer. */
export function makeSmsDispatcher(deps: SmsDispatcherDeps): {
  dispatcher: ChannelDispatcher<SmsDispatchItem>;
  handleInbound: (payload: SmsPayload, inbound: Omit<InboundDeps, "consumeMorningHandoff" | "dispatch"> & { dispatch: (phone: string, payload: SmsDispatchItem) => void }) => Promise<void>;
} {
  const now = deps.now ?? (() => new Date());
  const consumeMorningHandoff = async (payload: SmsPayload): Promise<MorningHandoffClaim | null> => {
    const list = (deps.loadAllowlistImpl ?? loadAllowlist)(deps.env, deps.allowlistPath, () => deps.logErr("sms: morning handoff state-unavailable"));
    const roster = resolveRecipients(list, deps.env).contacts;
    const identity = payload.group_id === undefined
      ? decideInboundIdentity({ type: "direct", address: payload.from, allowlist: list, roster })
      : decideInboundIdentity({ type: "group", payload, allowlist: list, roster, baxterNumber: deps.env.SENDBLUE_FROM_NUMBER });
    if (identity.kind === "none") {
      if (payload.group_id !== undefined) (payload as SmsDispatchItem).morningGroupSafe = false;
      return null;
    }
    if (identity.kind === "shared") (payload as SmsDispatchItem).morningGroupSafe = identity.sharedClose.contextEligible;
    const capturedAt = now();
    const snapshot = readTasksForMorningHandoff();
    if (!snapshot.available) { deps.logErr("sms: morning handoff state-unavailable"); return null; }
    const occurrence = canonicalMorningOccurrence(snapshot.tasks, morningCheckInDefinition({ env: deps.env }), capturedAt, householdTz(deps.env));
    if (!occurrence) { deps.logErr("sms: morning handoff not-eligible"); return null; }
    if (identity.kind === "direct") {
      const decision = await directConsume(occurrence, identity.directConsume.contact, identity.directConsume.address, roster, capturedAt);
      deps.logErr(`sms: morning handoff ${decision}`);
      return decision === "direct-consumed" ? makeMorningClaim(occurrence, capturedAt, identity.audience) : null;
    }
    const decision = await sharedClose(occurrence, identity.sharedClose.contextEligible, capturedAt);
    deps.logErr(`sms: morning handoff ${decision.decision}`);
    return decision.decision === "shared-closed" && decision.contextEligible && identity.audience
      ? makeMorningClaim(occurrence, capturedAt, identity.audience) : null;
  };
  const dispatcher = new MorningSmsDispatcher({
    debounceMs: 4000, maxConcurrent: 3, maxRunsPerWindow: 60, windowMs: 3_600_000,
    runFn: makeSmsRunFn(deps),
  });
  return {
    dispatcher,
    handleInbound: (payload, inbound) => handleInbound(payload, {
      ...inbound,
      dispatch: (key, item) => { dispatcher.notify(key, item); inbound.dispatch(key, item); },
      consumeMorningHandoff,
    }),
  };
}

export interface SmsBotDeps { loadHomeKeys: () => HomeKeys; env: NodeJS.ProcessEnv; makeSocket?: (url: string, headers: Record<string, string>) => WebSocketLike; log: (m: string) => void; logErr: (m: string) => void; }
export function defaultDeps(): SmsBotDeps { return { loadHomeKeys, env: process.env, ...loggerFor("sms") }; }

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
  // Main uses the exported production factory so durable handoff ordering and
  // coalescing are exercised through this exact seam.
  const smsDispatcher = makeSmsDispatcher({ env: deps.env, runEnv: RUN_ENV, model: MODEL, logErr: deps.logErr, typing });
  const link = new HomeLink({
    connect: signedSmsLinkConnect(keys, deps.makeSocket),
    viewVersion: () => null,
    appliedThrough: () => loadCursor(),
    logErr: deps.logErr,
  });
  // Serialize inbound handling and never cumulatively ACK across a failed command.
  // wireSmsDrain forces a reconnect/replay barrier on rejection and accounts for higher
  // commands that were already chained before the failure resolved.
  wireSmsDrain(link, payload => smsDispatcher.handleInbound(payload, {
    cursorLoad: loadCursor, cursorStore: storeCursor,
    sendAck: (n) => link.sendAck(n),
    dispatch: () => {},
    markRead,
    deadLetter: (p, err) => recordDeadLetter("sms", { id: p.id, at: p.at, from: p.from, error: String((err as Error)?.stack ?? err), payload: p }),
    logErr: deps.logErr,
  }), deps.logErr);
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
