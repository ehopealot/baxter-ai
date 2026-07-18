// "Fast Baxter" — the Discord voice surface (phase 1: the speak path).
//
// A separate daemon from discord-bot.mjs (same image/config volume/network). It
// auto-joins ONE designated voice channel whenever a human is in it, leaves when
// the channel empties, and speaks via Piper (local neural TTS) -> ffmpeg -> Opus
// through @discordjs/voice. This is the front-of-house "greeter": later phases add
// ears (STT) and the single dispatch_to_baxter tool that hands real work to the
// text Baxter. See docs/superpowers/specs/2026-07-18-discord-voice-fast-baxter-design.md.
//
// Phase 1 = join + greet aloud + a serialized speech queue + the Piper->play
// pipeline. STT / brain / dispatch / spoken read-back are NOT here yet. The whole
// daemon is OFF unless BOTH DISCORD_BOT_TOKEN and DISCORD_VOICE_CHANNEL_ID are set
// (exit 0 otherwise), so it never disturbs the default fleet.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { pipeline } from "node:stream";
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
import { log, logErr } from "./runtime.mjs";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const PIPER_BIN = process.env.PIPER || "piper"; // PATH shim from the Dockerfile
const PIPER_DIR = process.env.PIPER_DIR || "/opt/piper";
const PIPER_VOICE = process.env.PIPER_VOICE; // /opt/piper/voices/...onnx (set in the image)
// VOICE_LENGTH_SCALE: Piper's --length_scale (pace; >1 slower, <1 faster). Empty = the model default.
const VOICE_LENGTH_SCALE = process.env.VOICE_LENGTH_SCALE || "";
const GREETING = process.env.VOICE_GREETING || "Hey, Fast Baxter here. What's up?";
// STT (phase 2 "ears"): whisper.cpp. WHISPER_MODEL is set in the image. VOICE_LISTEN
// gates transcription (still off means greeting-only phase-1 behavior). SILENCE_MS
// is the end-of-utterance gap that closes a speaker's audio stream (@discordjs/voice
// AfterSilence) -- the turn detector.
const WHISPER_BIN = process.env.WHISPER || "whisper"; // PATH shim from the Dockerfile
const WHISPER_MODEL = process.env.WHISPER_MODEL;
const LISTEN = process.env.VOICE_LISTEN !== "0"; // on by default when the daemon runs
const SILENCE_MS = Number(process.env.VOICE_SILENCE_MS) || 800;
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
export function sanitizeForSpeech(text) {
  const clean = String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > MAX_SPEECH_CHARS ? clean.slice(0, MAX_SPEECH_CHARS) : clean;
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
  if (/^[\[(][^\])]*[\])]$/.test(t)) return false; // whole thing is a [tag]/(note)
  return /[a-z0-9]/i.test(t);
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
function startListening(connection, onTranscript) {
  const receiver = connection.receiver;
  const capturing = new Set();
  receiver.speaking.on("start", (userId) => {
    if (capturing.has(userId)) return; // already capturing this speaker's current utterance
    capturing.add(userId);
    const dir = mkdtempSync(join(tmpdir(), "baxter-stt-"));
    const wavPath = join(dir, "utt.wav");
    const finish = () => { capturing.delete(userId); rmSync(dir, { recursive: true, force: true }); };
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    // ffmpeg: raw s16le 48k stereo (stdin) -> 16k mono WAV. The opus stream ending
    // (AfterSilence) closes ff.stdin, so ffmpeg finalizes the file and exits.
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-y", wavPath], { stdio: ["pipe", "ignore", "ignore"] });
    ff.stdin.on("error", () => {}); // EPIPE if ffmpeg dies first -> surfaces via 'close'
    ff.on("error", (e) => { logErr(`voice: ffmpeg spawn failed: ${e.message}`); finish(); });
    pipeline(opus, decoder, ff.stdin, () => {}); // errors handled via ff 'close'
    ff.on("close", async (code) => {
      if (code !== 0) return finish();
      try {
        const text = await transcribe(wavPath);
        if (isMeaningfulTranscript(text)) onTranscript(userId, text);
      } catch (e) {
        logErr(`voice: transcribe failed: ${e?.message ?? e}`);
      } finally {
        finish();
      }
    });
  });
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
      // Phase 2: start transcribing what people say (logs it; no response yet).
      if (LISTEN && WHISPER_MODEL) {
        startListening(connection, (userId, text) => log(`voice: heard <${userId}>: ${text}`));
        log("voice: listening (whisper STT on)");
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
