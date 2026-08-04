#!/usr/bin/env node
// SMS surface daemon (spec: the sms-bot container). A long-running process, gated by
// the `sms` token in BAXTER_SURFACES (compose profile). Holds one persistent SigV4-signed
// link to the control-plane Durable Object (dialing /sms-link), wakes a SCOPED agent run
// on every inbound message, and acks so the DO can prune. Mirrors home-bot.ts's link
// lifecycle and discord-bot.ts's scoped-run dispatch -- the daemon holds the Sendblue
// creds and writes them 0600 for sms-cli; the spawned run NEVER sees them (it replies
// only via `sms-cli send`).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import { HomeLink, type WebSocketLike } from "./home-link.ts";
import { ChannelDispatcher } from "./dispatcher.ts";
import { appendTranscript, readTranscript, type TranscriptEntry } from "./sms-transcript.ts";
import { runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, skillsPreamble, log, logErr } from "./runtime.ts";
import { cleanForPrompt } from "./transcript.ts";
import { projectsPreamble } from "./projects-cli.ts";
import { loadHomeKeys, type HomeKeys } from "./home-mirror.ts"; // key loader lives here; home-bot only re-imports it
import { SMS_KEYS_PATH, SMS_STATE_PATH, MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR } from "./paths.ts";
import { SMS_TOOLS, SMS_SKILL_SRCS, SMS_SKILL_NAMES, loadedSkillsList } from "./grants.ts";

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

export interface SmsPayload { id: number; from: string; content: string; media_url?: string; at: string; }
export function isSmsPayload(p: unknown): p is SmsPayload {
  const o = p as any;
  return !!o && typeof o === "object" && Number.isSafeInteger(o.id) && typeof o.from === "string"
    && typeof o.content === "string" && (o.media_url === undefined || typeof o.media_url === "string") && typeof o.at === "string";
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
function storeCursor(n: number): void { const next = Math.max(loadCursor(), n); mkdirSync(dirname(SMS_STATE_PATH), { recursive: true }); writeFileSync(SMS_STATE_PATH, JSON.stringify({ appliedThrough: next })); } // monotonic: never regress the cursor

export interface InboundDeps {
  cursorLoad: () => number;
  cursorStore: (n: number) => void;
  sendAck: (appliedThrough: number) => void;
  dispatch: (phone: string, payload: SmsPayload) => void;
  logErr: (m: string) => void;
}

export async function handleInbound(payload: SmsPayload, deps: InboundDeps): Promise<void> {
  const cursor = deps.cursorLoad();
  if (payload.id <= cursor) { deps.sendAck(cursor); return; } // already applied; re-ack to prompt prune
  await appendTranscript(payload.from, { direction: "in", at: payload.at, content: payload.content, media_url: payload.media_url });
  deps.dispatch(payload.from, payload);
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
export function renderHistory(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => {
      const who = e.direction === "in" ? "The person" : `${PERSONA_NAME} (you)`;
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
export function buildPrompt(phone: string): string {
  const template = readFileSync(PROMPT_PATH, "utf8");
  return fillTemplate(template, {
    PERSONA_NAME,
    CONTACT: phone,
    HISTORY: renderHistory(readTranscript(phone, 20)),
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
  const MODEL = deps.env.BAXTER_MODEL || "sonnet";
  const RUN_ENV = makeRunEnv();
  const dispatcher = new ChannelDispatcher<SmsPayload>({
    debounceMs: 4000, maxConcurrent: 3, maxRunsPerWindow: 60, windowMs: 3_600_000,
    runFn: async (phone, payload) => {
      await runAgent({
        prompt: buildPrompt(phone),
        logId: String(payload.id),
        surface: "sms",
        cwd: MEMORY_DIR,
        model: MODEL,
        allowedTools: SMS_TOOLS,
        runsDir: SMS_RUNS_DIR,
        env: RUN_ENV,
        beforeRun: () => {
          ensurePlaywrightConfig(MEMORY_DIR);
          ensureSkills(SMS_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
        },
      });
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
      dispatch: (phone, p) => dispatcher.notify(phone, p),
      logErr: deps.logErr,
    })).catch(err => deps.logErr(`sms handleInbound: ${err}`));
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
  main().catch(err => { console.error(err); process.exit(1); });
}
