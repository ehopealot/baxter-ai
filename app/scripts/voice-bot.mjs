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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "@discordjs/voice";
import { log, logErr } from "./runtime.mjs";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const PIPER_BIN = process.env.PIPER || "piper"; // PATH shim from the Dockerfile
const PIPER_VOICE = process.env.PIPER_VOICE; // /opt/piper/voices/...onnx (set in the image)
const GREETING = process.env.VOICE_GREETING || "Hey, Fast Baxter here. What's up?";
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
export function synthesize(text, { piperBin = PIPER_BIN, voice = PIPER_VOICE, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (!voice) return reject(new Error("PIPER_VOICE is not set"));
    const dir = mkdtempSync(join(tmpdir(), "baxter-tts-"));
    const outPath = join(dir, "speech.wav");
    const proc = spawnFn(piperBin, ["--model", voice, "--output_file", outPath], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d));
    proc.on("error", (err) => { rmSync(dir, { recursive: true, force: true }); reject(err); });
    proc.on("close", (code) => {
      if (code === 0) return resolve({ path: outPath, dir });
      rmSync(dir, { recursive: true, force: true });
      reject(new Error(`piper exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
    proc.stdin.end(text);
  });
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
  if (!PIPER_VOICE) {
    logErr("PIPER_VOICE is not set; voice bot disabled (the image sets it -- check the build).");
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
      log(`voice: joined "${channel.name}" (${channel.id}) -- greeting`);
      speech.speak(GREETING);
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
    const present = getVoiceConnection(channel.guild.id);
    if (shouldBeConnected(channel, client.user.id)) {
      if (!present) await connect(channel);
    } else if (present) {
      disconnect(channel.guild.id, "channel empty");
    }
  };

  client.once("clientReady", (c) => {
    log(`Voice bot ready as ${c.user.tag} (${c.user.id}); watching voice channel ${VOICE_CHANNEL_ID}; TTS=piper (${PERSONA_NAME}).`);
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
