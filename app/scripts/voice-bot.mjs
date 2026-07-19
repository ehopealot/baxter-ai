// "Fast Baxter" — the Discord voice surface (phases 1-4: speak, ears, brain/dispatch, read-back).
//
// A separate daemon from discord-bot.mjs (same image/config volume/network). It
// auto-joins ONE designated voice channel whenever a human is in it, leaves when
// the channel empties, and speaks via Piper (local neural TTS) -> ffmpeg -> Opus
// through @discordjs/voice. The front-of-house "greeter": it hears (whisper STT),
// decides via a fast one-tool brain, answers aloud, and for real work calls the
// single dispatch_to_baxter tool that hands off to the full text Baxter -- then
// reads a one-line summary of the result back. See
// docs/superpowers/specs/2026-07-18-discord-voice-fast-baxter-design.md.
//
// Phases 1-4 = join + greet + serialized speech queue + Piper->play pipeline; STT;
// the dispatch brain; and spoken read-back of dispatched results (barge-in deferred).
// The whole daemon is OFF unless BOTH DISCORD_BOT_TOKEN and DISCORD_VOICE_CHANNEL_ID
// are set (exit 0 otherwise), so it never disturbs the default fleet.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  EndBehaviorType,
} from "@discordjs/voice";
import prism from "prism-media";
import { log, logErr, runAgent, ensureSkills, ensurePlaywrightConfig } from "./runtime.mjs";
import { DISCORD_TOOLS, DISCORD_SKILL_SRCS } from "./grants.mjs";
import { MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR, discordChannelMemoryPath, DISCORD_TOKEN_PATH } from "./paths.mjs";
import { envInt } from "./schedule-store.mjs";
import { decide, isSpeakableAnswer } from "./voice-brain.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const PIPER_BIN = process.env.PIPER || "piper"; // PATH shim from the Dockerfile
const PIPER_DIR = process.env.PIPER_DIR || "/opt/piper";
const PIPER_VOICE = process.env.PIPER_VOICE; // /opt/piper/voices/...onnx (set in the image)
// VOICE_LENGTH_SCALE: Piper's --length_scale (pace; >1 slower, <1 faster). Empty =
// the model default. Validated at load (fail-fast, like MAX_SPEECH_CHARS): a
// non-numeric/nonpositive value is ignored with a warning rather than turning every
// utterance into a silent piper failure.
const VOICE_LENGTH_SCALE = (() => {
  const raw = process.env.VOICE_LENGTH_SCALE || "";
  if (raw && !(Number(raw) > 0)) { logErr(`voice: ignoring invalid VOICE_LENGTH_SCALE="${raw}" (need a number > 0)`); return ""; }
  return raw;
})();
const GREETING = process.env.VOICE_GREETING || "Hey, Fast Baxter here. What's up?";
// STT (phase 2 "ears"): whisper.cpp. WHISPER_MODEL is set in the image. VOICE_LISTEN
// gates transcription (still off means greeting-only phase-1 behavior). SILENCE_MS
// is the end-of-utterance gap that closes a speaker's audio stream (@discordjs/voice
// AfterSilence) -- the turn detector.
const WHISPER_BIN = process.env.WHISPER || "whisper"; // PATH shim from the Dockerfile
const WHISPER_MODEL = process.env.WHISPER_MODEL;
const LISTEN = process.env.VOICE_LISTEN !== "0"; // on by default when the daemon runs
const SILENCE_MS = Number(process.env.VOICE_SILENCE_MS) || 1000; // end-of-utterance gap; longer = fewer mid-thought splits
// Hard cap on a single capture: a source that never goes silent for SILENCE_MS (a
// music bot, a stuck-open mic) would otherwise grow the WAV unbounded and hand
// whisper an hours-long file. Force-ends the capture; the partial WAV still runs.
const MAX_UTTERANCE_MS = Number(process.env.VOICE_MAX_UTTERANCE_MS) || 60_000;
// Fast brain (phase 3): a single OpenRouter chat/completions call decides
// answer-aloud vs dispatch_to_baxter. Needs OPENROUTER_API_KEY; the model defaults
// to OPENROUTER_MODEL (in-family minimax). No key -> ears still transcribe+log but
// he doesn't respond (phase-2 behavior).
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const VOICE_BRAIN_MODEL = process.env.VOICE_BRAIN_MODEL || process.env.OPENROUTER_MODEL || "minimax/minimax-m2.7";
const BRAIN_ENABLED = Boolean(OPENROUTER_API_KEY);
// Read-only shared memory injected into the brain, capped (this is the hot path; an
// unbounded memory.md would bloat every call). envInt: unset/blank -> default, "0" =
// off, a bad value fails loud at startup (the fleet cap convention). Read fresh
// per-utterance so it reflects real Baxter's latest writes.
const VOICE_MEMORY_MAX_CHARS = envInt("VOICE_MEMORY_MAX_CHARS", 4000);
// a "turn" = user+assistant, so 2 messages each. Only a FINITE >=1 value is honored
// (else default 8): a negative would make pushCtx's `while length > MAX` trim loop
// never terminate (hang), and Infinity would never trim (unbounded context growth --
// a leak + ever-growing brain payload on the latency-critical path).
const _turns = Math.floor(Number(process.env.VOICE_BRAIN_CONTEXT_TURNS));
const BRAIN_CONTEXT_MAX = 2 * (Number.isFinite(_turns) && _turns >= 1 ? _turns : 8);

// Dispatch (phase 3c): dispatch_to_baxter spawns the FULL text Baxter (same
// runAgent/DISCORD_TOOLS as the discord daemon) to work on a task and post the
// result to a text channel. Default target = the voice channel's own integrated
// text chat (its id works as a text channel), overridable.
const MODEL = process.env.BAXTER_MODEL || "sonnet";
const RUNS_DIR = join(APP_DIR, ".claude", "voice-runs");
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");
const VOICE_TEXT_CHANNEL_ID = process.env.DISCORD_VOICE_TEXT_CHANNEL_ID || VOICE_CHANNEL_ID;
// Bound concurrent dispatched runs -- the code-enforced cap every Baxter-spawning
// path has (discord's per-channel hourly budget, heartbeat's daily cap). Without it
// an open mic (music/TV) yielding a transcript every MAX_UTTERANCE_MS could stack
// unbounded parallel `claude -p` runs. Over the cap -> drop + log.
const MAX_INFLIGHT_DISPATCHES = envInt("VOICE_MAX_INFLIGHT_DISPATCHES", 3); // fail-loud on a bad value, like the fleet's other caps
if (MAX_INFLIGHT_DISPATCHES < 1) throw new Error("VOICE_MAX_INFLIGHT_DISPATCHES must be >= 1");
let inflightDispatches = 0;
// Env for a spawned run, token stripped (the run reaches Discord only via discord-cli,
// which reads the token from DISCORD_TOKEN_PATH) -- mirrors discord-bot's RUN_ENV.
const RUN_ENV = { ...process.env };
delete RUN_ENV.DISCORD_BOT_TOKEN;
const PERSONA_NAME = process.env.BAXTER_PERSONA_NAME || "Baxter";
// Guard against a pathologically long TTS input (later phases feed model text in);
// Piper is fast but there's no reason to synthesize an essay into a voice channel.
const MAX_SPEECH_CHARS = Number(process.env.VOICE_MAX_SPEECH_CHARS) || 600;

// --- pure helpers (exported for tests) ---

// Count the humans (non-bot, and never Baxter himself) currently in a voice
// channel. `channel.members` is a discord.js Collection of GuildMember; accept a
// plain array/Map too for testing. This decides join/leave: >0 humans => be there.
export function humanCount(channel, selfId) {
  const members = channel?.members;
  const list = members
    ? (typeof members.values === "function" ? [...members.values()] : Array.isArray(members) ? members : [])
    : [];
  return list.filter((m) => m && !m.user?.bot && m.id !== selfId).length;
}

// Should Baxter be connected to the channel right now? True iff a human is present.
export function shouldBeConnected(channel, selfId) {
  return humanCount(channel, selfId) > 0;
}

// Resolve which Piper voice model to use: a friendly VOICE_NAME (e.g.
// "en_US-amy-medium") -> the baked <piperDir>/voices/<name>.onnx if it exists,
// else fall back to PIPER_VOICE (the image default). VOICE_NAME is operator config
// but still charset-restricted so it can't be a path-traversal into an arbitrary
// .onnx. existsFn injectable for tests.
export function resolveVoice({ voiceName, piperVoice, piperDir = "/opt/piper", existsFn = existsSync } = {}) {
  if (voiceName && /^[A-Za-z0-9_-]+$/.test(voiceName)) {
    const p = join(piperDir, "voices", `${voiceName}.onnx`);
    if (existsFn(p)) return p;
  }
  return piperVoice;
}

// The voice model actually used, resolved once at load from VOICE_NAME over PIPER_VOICE.
const VOICE_MODEL = resolveVoice({ voiceName: process.env.VOICE_NAME, piperVoice: PIPER_VOICE, piperDir: PIPER_DIR });

// Is `conn` a voice connection genuinely LIVE on the designated channel? A
// Disconnected connection (a kick / Discord code 4014) or one dragged to another
// channel is not-destroyed and still returned by getVoiceConnection, but must NOT
// count as "present" -- or evaluate() would see it and never rejoin (the daemon's
// whole job, silently broken). Exported + tested because it's the core presence
// decision with four independently-regressable conditions.
export function isLiveOn(conn, channelId) {
  const status = conn?.state?.status;
  // Fail CLOSED on an unknown/missing status (`status !== undefined`): the
  // defensive `?.` must not report a state-less conn as live, which would wedge
  // the rejoin. (@discordjs/voice always sets state; this guards a future edit.)
  return Boolean(
    conn &&
      conn.joinConfig?.channelId === channelId &&
      status !== undefined &&
      status !== VoiceConnectionStatus.Destroyed &&
      status !== VoiceConnectionStatus.Disconnected,
  );
}

// Make arbitrary text safe + bounded to hand to Piper on stdin: collapse
// whitespace/newlines to single spaces (Piper reads a line per utterance), drop
// control chars, and cap the length. Phase 1 only speaks a fixed greeting, but the
// STT/dispatch phases will feed model output through here.
// Cap `s` at `n` chars, dropping a lone trailing high surrogate if the cut split an
// astral char (a broken pair mangles to U+FFFD on Piper's stdin / can break a strict
// JSON decoder). The one place every char-cap in the voice path goes through.
export function capChars(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n).replace(/[\uD800-\uDBFF]$/, "") : str;
}

export function sanitizeForSpeech(text) {
  const clean = String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // drop a lone high surrogate if the cap split an astral char (same guard as the
  // memory cap) -- this is the shared choke point for every speech path.
  return capChars(clean, MAX_SPEECH_CHARS);
}

// --- Piper synthesis ---

// Synthesize `text` to a WAV file with Piper and resolve its path. The caller
// cleans up the temp dir. spawnFn is injectable for tests. Rejects on a Piper
// error or non-zero exit so speak() can log and skip rather than hang.
export function synthesize(text, { piperBin = PIPER_BIN, voice = VOICE_MODEL, lengthScale = VOICE_LENGTH_SCALE, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (!voice) return reject(new Error("PIPER_VOICE is not set"));
    const dir = mkdtempSync(join(tmpdir(), "baxter-tts-"));
    const outPath = join(dir, "speech.wav");
    const args = ["--model", voice, "--output_file", outPath];
    if (lengthScale) args.push("--length_scale", String(lengthScale));
    const proc = spawnFn(piperBin, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d));
    proc.on("error", (err) => { rmSync(dir, { recursive: true, force: true }); reject(err); });
    proc.on("close", (code) => {
      if (code === 0) return resolve({ path: outPath, dir });
      rmSync(dir, { recursive: true, force: true });
      reject(new Error(`piper exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
    // Swallow an EPIPE if Piper dies before draining stdin (e.g. a bad model) --
    // an unhandled stream 'error' would crash the daemon; the real failure still
    // surfaces via the 'error'/'close' handlers above.
    proc.stdin.on("error", () => {});
    proc.stdin.end(text);
  });
}

// --- STT (whisper.cpp) ---

// Transcribe a 16kHz mono WAV with whisper.cpp and resolve the text. `-nt` = no
// timestamps (transcript to stdout), `-l en`. spawnFn injectable for tests. Rejects
// on a whisper error / non-zero exit so the caller can log-and-skip.
export function transcribe(wavPath, { whisperBin = WHISPER_BIN, model = WHISPER_MODEL, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (!model) return reject(new Error("WHISPER_MODEL is not set"));
    const proc = spawnFn(whisperBin, ["-m", model, "-f", wavPath, "-nt", "-l", "en"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => (out += d));
    proc.stderr?.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) return resolve(out.trim());
      reject(new Error(`whisper exited ${code}: ${err.trim().slice(0, 300)}`));
    });
  });
}

// Filler-only / empty transcripts whisper emits for silence, breaths, or noise --
// don't treat these as real speech to act on. `[BLANK_AUDIO]` / `(silence)` etc.
export function isMeaningfulTranscript(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  // Strip EVERY bracketed/parenthesized tag (whisper emits one per segment, so noise
  // can yield several: "[BLANK_AUDIO]\n[BLANK_AUDIO]"), then require real residue.
  // Speech with an aside ("call john (mobile)") still passes via the surviving words.
  const stripped = t.replace(/[[(][^\])]*[\])]/g, "").trim();
  return /[a-z0-9]/i.test(stripped);
}

// --- speech queue (serialized playback) ---

// Serializes speak() calls: only one utterance plays at a time, so overlapping
// requests (a greeting + a later read-back) queue instead of colliding on the
// single audio player. Phase 1 uses it for the greeting; kept general for later.
class SpeechQueue {
  constructor(player) {
    this.player = player;
    this.chain = Promise.resolve();
  }
  speak(text) {
    this.chain = this.chain.then(() => this._playOne(text)).catch((err) => logErr(`voice: speak failed: ${err?.message ?? err}`));
    return this.chain;
  }
  async _playOne(rawText) {
    const text = sanitizeForSpeech(rawText);
    if (!text) return;
    const { path, dir } = await synthesize(text);
    try {
      const resource = createAudioResource(path); // ffmpeg transcodes WAV -> 48k stereo Opus
      this.player.play(resource);
      // Wait until it actually starts, then until it finishes (or a safety timeout).
      await entersState(this.player, AudioPlayerStatus.Playing, 5_000);
      await entersState(this.player, AudioPlayerStatus.Idle, 60_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// --- STT receive pipeline (live; validated by a real speaker, not unit tests --
// the transcribe() core IS tested) ---

// Attach whisper STT to a live connection: when a user starts speaking, subscribe
// to their audio, end it after SILENCE_MS of quiet (turn detection), decode
// Opus->PCM, resample to a 16k mono WAV via ffmpeg (whisper's required format), run
// whisper, and hand a meaningful transcript to onTranscript. One capture per
// speaker at a time; per-utterance errors are logged, never fatal. Phase 2 just
// logs the transcript; phase 3 routes it to the fast brain / dispatch.
function startListening(connection, channel, onTranscript) {
  const receiver = connection.receiver;
  const capturing = new Set();
  receiver.speaking.on("start", (userId) => {
    if (capturing.has(userId)) return; // already capturing this speaker's current utterance
    if (channel?.members?.get?.(userId)?.user?.bot) return; // ignore music/other bots (they don't pause)
    capturing.add(userId);
    const dir = mkdtempSync(join(tmpdir(), "baxter-stt-"));
    const wavPath = join(dir, "utt.wav");
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    // ffmpeg: raw s16le 48k stereo (stdin) -> 16k mono WAV. The opus stream ending
    // (AfterSilence, or the safety cap below) closes ff.stdin, so ffmpeg finalizes
    // the file and exits.
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-y", wavPath], { stdio: ["pipe", "ignore", "ignore"] });
    const cap = setTimeout(() => { try { opus.destroy(); } catch {} }, MAX_UTTERANCE_MS);
    ff.stdin.on("error", () => {}); // EPIPE if ffmpeg dies first -> surfaces via 'close'
    ff.on("error", (e) => { logErr(`voice: ffmpeg spawn failed: ${e.message}`); clearTimeout(cap); capturing.delete(userId); cleanup(); });
    pipeline(opus, decoder, ff.stdin, () => {}); // errors handled via ff 'close'
    ff.on("close", async (code) => {
      clearTimeout(cap);
      // Release the slot the moment the CAPTURE ends -- transcription (whisper on CPU)
      // adds seconds, and the next utterance may start during it; each capture has its
      // own dir/WAV so concurrent whisper runs don't collide.
      capturing.delete(userId);
      if (code !== 0) return cleanup();
      try {
        const text = await transcribe(wavPath);
        if (isMeaningfulTranscript(text)) onTranscript(userId, text);
      } catch (e) {
        logErr(`voice: transcribe failed: ${e?.message ?? e}`);
      } finally {
        cleanup();
      }
    });
  });
}

// --- dispatch: hand a task to the full text Baxter (phase 3c) ---

// The prompt for a voice-dispatched run: real Baxter does the task and posts the
// result to the linked text channel via discord-cli. The task came from the user's
// speech (an instruction from a person in the allowed voice channel -- same trust
// level as a typed Discord message; real Baxter's tool allowlist bounds it).
export function renderVoiceDispatchPrompt({ task, textChannelId, selfId }) {
  return [
    `You are ${PERSONA_NAME}. A request just came in by VOICE in a Discord voice call (speech-to-text, so expect minor transcription errors). A lightweight voice assistant already acknowledged it out loud and handed it to you to actually carry out.`,
    ``,
    `TASK: ${task}`,
    ``,
    `Do the task with your tools, then POST the full result to Discord text channel ${textChannelId} using discord-cli (e.g. \`discord-cli send ${textChannelId}\` with the message on stdin). Keep it useful for someone who asked by voice. If you can't do it, post a short explanation to that channel instead. Your own user id is ${selfId} (don't act on your own messages).`,
    ``,
    `THEN, as your FINAL message (plain text, NOT a tool call), give a ONE-SENTENCE spoken summary of the result -- the headline only, conversational, no markdown/lists/emoji, phrased to be read aloud. That sentence is what the voice assistant speaks back to the person; the full details stay in the channel post. (E.g. "Sam Burns is leading the Open at ten under.")`,
    ``,
    `Shared memory: ${MEMORY_PATH}`,
    `Credentials note: ${CREDENTIALS_PATH}`,
    `This channel's notes: ${discordChannelMemoryPath(textChannelId)}`,
    `Learned skills dir: ${LEARNED_SKILLS_DIR}`,
  ].join("\n");
}

// Spawn the full text Baxter for a voice-dispatched task. The SYNCHRONOUS part
// (validate, cap check, kick off the run) decides the return value; the run itself
// is async -- on completion the `speak` callback reads back a one-sentence summary
// (or an honest "couldn't finish" line on failure). Task length-capped defensively.
// Returns true iff a run was actually kicked off, so the caller can pick an honest
// spoken ack (a "busy/couldn't" line on a drop, not a false "On it.").
function dispatchToBaxter(task, selfId, speak) {
  // Trim BEFORE the cap so this agrees with the caller's trimmed gate: a task
  // non-empty after a full trim starts with non-whitespace and survives the slice,
  // so `false` here can only mean the in-flight cap (never a whitespace mismatch).
  // capChars (not a bare slice) so an emoji at the 1000-char boundary can't leave a
  // lone surrogate in the dispatch prompt / run request body.
  const t = capChars(String(task || "").trim(), 1000);
  if (!t) { logErr("voice: dispatch with an empty/malformed task from the brain -- dropped"); return false; }
  if (inflightDispatches >= MAX_INFLIGHT_DISPATCHES) {
    logErr(`voice: dropping dispatch, ${inflightDispatches} already in flight (cap ${MAX_INFLIGHT_DISPATCHES}): "${t}"`);
    return false;
  }
  inflightDispatches++;
  const textChannelId = VOICE_TEXT_CHANNEL_ID;
  log(`voice: dispatching to Baxter -> "${t}" (post to ${textChannelId})`);
  runAgent({
    prompt: renderVoiceDispatchPrompt({ task: t, textChannelId, selfId }),
    logId: `voice-dispatch-${Date.now()}`,
    cwd: MEMORY_DIR,
    model: MODEL,
    allowedTools: DISCORD_TOOLS,
    runsDir: RUNS_DIR,
    // A voice dispatch genuinely OWES a post (the user was told "on it"), so set both
    // reply flags -- the openrouter/local runners (openrouter is live) then poke a run
    // that drafted an answer but never sent it, and nudge an empty turn harder, instead
    // of silently accepting a run that leaves nothing in the channel.
    env: { ...RUN_ENV, BAXTER_EXPECT_REPLY: "1", BAXTER_REPLY_REQUIRED: "1" },
    beforeRun: () => {
      ensurePlaywrightConfig(MEMORY_DIR);
      ensureSkills(DISCORD_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
    },
  })
    .then((res) => {
      // Phase 4 read-back: the run's FINAL message is a one-sentence spoken summary
      // (see the prompt). Speak it + point to the channel, queued via the speech queue
      // so it can't collide with live talk. Empty summary -> a generic pointer.
      if (!speak) return;
      let line;
      // `succeeded === false` catches the graceful context-full stop (exit 0, not
      // failed/out-of-tokens, but an error subtype) that DIDN'T finish the task.
      if (res?.failed || res?.outOfTokens || res?.succeeded === false) {
        line = "Sorry, I couldn't finish that one -- take a look in the chat.";
      } else {
        const summary = capChars(sanitizeForSpeech(res?.resultText || ""), 400);
        line = summary ? `${summary} The rest is in the chat.` : "Okay, I've posted that in the chat.";
      }
      log(`voice: read-back -> ${line}`);
      speak(line);
    })
    .catch((e) => { logErr(`voice: dispatch run failed: ${e?.message ?? e}`); speak?.("Sorry, I hit a problem with that one."); })
    .finally(() => { inflightDispatches--; });
  return true;
}

// Read the shared memory, capped for the hot path. Read fresh each call so it
// reflects real Baxter's latest writes; a missing/unreadable file -> "" (no memory).
function readVoiceMemory() {
  if (VOICE_MEMORY_MAX_CHARS <= 0) return "";
  try {
    const m = readFileSync(MEMORY_PATH, "utf8");
    return m.length > VOICE_MEMORY_MAX_CHARS
      // strip a trailing lone high surrogate if the cap split an emoji/astral char,
      // else the request body carries a broken pair (replacement char, or a strict
      // provider decoder rejecting it -> a persistent brain outage until memory changes)
      ? capChars(m, VOICE_MEMORY_MAX_CHARS) + "\n[...memory truncated -- dispatch for deeper recall]"
      : m;
  } catch {
    return "";
  }
}

// --- daemon ---

async function main() {
  if (!TOKEN) {
    logErr("DISCORD_BOT_TOKEN is not set; voice bot disabled.");
    process.exit(0);
  }
  if (!VOICE_CHANNEL_ID) {
    logErr("DISCORD_VOICE_CHANNEL_ID is not set; voice bot disabled (set it to a voice channel id to enable).");
    process.exit(0);
  }
  if (!VOICE_MODEL) {
    logErr("No Piper voice resolved (PIPER_VOICE unset and no VOICE_NAME match); voice bot disabled -- the image sets PIPER_VOICE, so check the build.");
    process.exit(0);
  }
  // Diagnosability: if VOICE_NAME was set but didn't resolve (typo/wrong case/not
  // baked), say so -- otherwise the operator just silently gets the default back.
  const wantedVoice = process.env.VOICE_NAME;
  if (wantedVoice && basename(VOICE_MODEL, ".onnx") !== wantedVoice) {
    logErr(`voice: VOICE_NAME="${wantedVoice}" not found under ${PIPER_DIR}/voices; using ${basename(VOICE_MODEL, ".onnx")} instead.`);
  }

  // Persist the token (0600, outside the run cwd) so a dispatched run's discord-cli
  // can read it from the file with the token stripped from its env -- same boundary
  // as discord-bot. Idempotent if the discord daemon already wrote it (shared volume).
  mkdirSync(dirname(DISCORD_TOKEN_PATH), { recursive: true });
  writeFileSync(DISCORD_TOKEN_PATH, JSON.stringify({ token: TOKEN }), { mode: 0o600 });

  const client = new Client({
    // GuildVoiceStates is what delivers who's in a voice channel (join/leave events)
    // -- a NON-privileged intent, but it must be enabled in the Developer Portal.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  let player = null;
  let speech = null;
  let connecting = false;

  const getChannel = async () => {
    const ch = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.isVoiceBased?.()) return null;
    return ch;
  };

  const connect = async (channel) => {
    if (connecting || getVoiceConnection(channel.guild.id)) return;
    connecting = true;
    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false, // phase 2 needs to hear; harmless now
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      connection.subscribe(player);
      speech = new SpeechQueue(player);
      // Own recovery from a dropped voice WS (a manual disconnect/kick, a drag to
      // another channel, or Discord closing the socket e.g. code 4014). A real
      // network blip re-enters Signalling/Connecting on its own within a few
      // seconds; if it doesn't, destroy the (otherwise-not-destroyed) connection so
      // getVoiceConnection stops returning a dead one and the presence loop can
      // rejoin. Without this, evaluate() sees a lingering Disconnected connection as
      // "present" and never rejoins -- the daemon's whole job, silently broken.
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          try { connection.destroy(); } catch {}
          evaluate();
        }
      });
      log(`voice: joined "${channel.name}" (${channel.id}) -- greeting`);
      speech.speak(GREETING);
      // Phase 2 ears + phase 3 brain: transcribe -> decide -> speak an answer, or
      // (phase 3c, pending) dispatch to the full agent. A short rolling context lets
      // follow-ups ("...and in Boston?") work.
      if (LISTEN && WHISPER_MODEL) {
        const brainContext = [];
        const pushCtx = (role, content) => { brainContext.push({ role, content }); while (brainContext.length > BRAIN_CONTEXT_MAX) brainContext.shift(); };
        const handleUtterance = async (userId, text) => {
          if (!BRAIN_ENABLED) return; // ears-only: transcribe + log, no response
          const d = await decide(text, { model: VOICE_BRAIN_MODEL, apiKey: OPENROUTER_API_KEY, baseUrl: OPENROUTER_BASE_URL, context: brainContext.slice(), memory: readVoiceMemory() });
          pushCtx("user", text);
          if (d.action === "dispatch" && String(d.task || "").trim()) {
            // Decide dispatch BEFORE speaking, so the ack is honest: a real "On it."
            // only if a run actually started, else a "busy, try again" line -- here
            // `ok` is false only on the in-flight cap (a whitespace task falls to the
            // "didn't catch that" branch below). Never a false promise.
            // The read-back fires later (when the run finishes); resolve `speech`
            // fresh then (a reconnect swaps the queue; a disconnect -> skip safely).
            const ok = dispatchToBaxter(d.task, client.user.id, (s) => { try { speech?.speak(s); } catch (e) { logErr(`voice: read-back speak failed: ${e?.message ?? e}`); } });
            // Guard d.ack too -- it's the same model `content` field that emits "no
            // response" placeholders; fall back to "On it." rather than speak one.
            const ack = ok ? (isSpeakableAnswer(d.ack) ? d.ack : "On it.") : "Sorry, I couldn't get to that right now -- ask me again in a moment.";
            speech?.speak(ack);
            pushCtx("assistant", ack);
          } else if (d.action === "dispatch") {
            // no usable task (garbled tool call or whitespace-only) -> don't spawn a
            // no-op; the honest signal is "didn't catch that", not "I'm busy".
            const miss = "Sorry, I didn't catch that.";
            speech?.speak(miss);
            pushCtx("assistant", miss);
          } else if (isSpeakableAnswer(d.text)) {
            // isSpeakableAnswer drops placeholder non-answers ("no response",
            // "(silence)") the model emits instead of a truly empty message.
            speech?.speak(d.text);
            pushCtx("assistant", d.text);
          }
        };
        // Serialize the brain (like the speech queue): decide->push->speak for one
        // utterance completes before the next starts, so concurrent captures can't
        // cross the rolling context or interleave replies.
        let brainChain = Promise.resolve();
        startListening(connection, channel, (userId, text) => {
          log(`voice: heard <${userId}>: ${text}`);
          brainChain = brainChain.then(() => handleUtterance(userId, text)).catch((e) => logErr(`voice: brain failed: ${e?.message ?? e}`));
        });
        log(`voice: listening (whisper STT on${BRAIN_ENABLED ? `, brain=${VOICE_BRAIN_MODEL}` : ", brain OFF -- no OPENROUTER_API_KEY"})`);
      } else {
        log(`voice: NOT listening (${LISTEN ? "WHISPER_MODEL unset" : "VOICE_LISTEN=0"}) -- greeting-only`);
      }
    } catch (err) {
      logErr(`voice: failed to join ${channel.id}: ${err?.message ?? err}`);
      getVoiceConnection(channel.guild?.id)?.destroy();
    } finally {
      connecting = false;
    }
  };

  const disconnect = (guildId, why) => {
    const conn = getVoiceConnection(guildId);
    if (!conn) return;
    conn.destroy();
    player = null;
    speech = null;
    log(`voice: left the channel (${why})`);
  };

  // Re-evaluate presence: join if a human is there and we're not connected; leave
  // if the channel emptied. Fired on ready and on every voice-state change.
  const evaluate = async () => {
    const channel = await getChannel();
    if (!channel) return;
    const conn = getVoiceConnection(channel.guild.id);
    const present = isLiveOn(conn, VOICE_CHANNEL_ID);
    if (shouldBeConnected(channel, client.user.id)) {
      if (!present) {
        if (conn) { try { conn.destroy(); } catch {} } // clear a dead/misplaced conn so connect() isn't blocked
        await connect(channel);
      }
    } else if (conn) {
      disconnect(channel.guild.id, "channel empty");
    }
  };

  client.once("clientReady", (c) => {
    log(`Voice bot ready as ${c.user.tag} (${c.user.id}); watching voice channel ${VOICE_CHANNEL_ID}; TTS=piper voice=${VOICE_MODEL ? basename(VOICE_MODEL, ".onnx") : "(none!)"}${VOICE_LENGTH_SCALE ? ` @${VOICE_LENGTH_SCALE}x` : ""} (${PERSONA_NAME}).`);
    evaluate();
  });
  client.on("voiceStateUpdate", (oldState, newState) => {
    // Only care about the designated channel (someone joined/left it).
    if (oldState.channelId === VOICE_CHANNEL_ID || newState.channelId === VOICE_CHANNEL_ID) evaluate();
  });

  const shutdown = () => {
    try { for (const [, g] of client.guilds.cache) disconnect(g.id, "shutdown"); } catch {}
    client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await client.login(TOKEN);
}

// Only run the daemon when executed directly (tests import the pure helpers).
import { pathToFileURL } from "node:url";
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { logErr(`voice bot fatal: ${err?.stack ?? err}`); process.exit(1); });
}
