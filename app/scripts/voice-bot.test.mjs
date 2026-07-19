// Unit tests for voice-bot.mjs's pure helpers. The daemon's Discord/audio wiring
// (join/play) needs a live voice connection and isn't unit-tested; these cover the
// join/leave decision, speech-text sanitization, and the Piper spawn contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { VoiceConnectionStatus, AudioPlayerStatus } from "@discordjs/voice";
import { humanCount, shouldBeConnected, isLiveOn, resolveVoice, sanitizeForSpeech, synthesize, transcribe, isMeaningfulTranscript, renderVoiceDispatchPrompt, splitDispatchResult, capChars, buildDispatchPlaceholder, postDispatchPlaceholder, Muzak, listMuzakTracks, pickMuzakTrack } from "./voice-bot.mjs";

test("capChars caps and drops a split-surrogate tail (never a lone high surrogate)", () => {
  assert.equal(capChars("hello", 10), "hello"); // under cap unchanged
  assert.equal(capChars("hello world", 5), "hello"); // simple cap
  const emoji = "ab" + "😀".repeat(5); // 😀 is a surrogate pair (2 code units)
  const capped = capChars(emoji, 3); // cut lands inside the first 😀 -> strip the lone high surrogate
  assert.equal(capped, "ab");
  assert.ok(!/[\uD800-\uDBFF]$/.test(capped), "no trailing lone high surrogate");
});

const member = (id, bot = false) => ({ id, user: { bot } });
// discord.js exposes channel.members as a Collection (a Map subclass with .values()).
const collection = (...members) => new Map(members.map((m) => [m.id, m]));

test("humanCount counts non-bot members, excluding bots and self", () => {
  const channel = { members: collection(member("u1"), member("u2"), member("bot1", true), member("SELF")) };
  assert.equal(humanCount(channel, "SELF"), 2);
});

test("humanCount accepts a plain array and is 0 for empty/missing", () => {
  assert.equal(humanCount({ members: [member("u1"), member("b", true)] }, "SELF"), 1);
  assert.equal(humanCount({ members: collection() }, "SELF"), 0);
  assert.equal(humanCount({}, "SELF"), 0);
  assert.equal(humanCount(null, "SELF"), 0);
});

test("shouldBeConnected is true iff a human is present (bots/self don't keep him in)", () => {
  assert.equal(shouldBeConnected({ members: collection(member("u1")) }, "SELF"), true);
  assert.equal(shouldBeConnected({ members: collection(member("SELF"), member("b", true)) }, "SELF"), false);
});

test("isLiveOn: only a Ready connection on the designated channel counts as present", () => {
  const conn = (channelId, status) => ({ joinConfig: { channelId }, state: { status } });
  assert.equal(isLiveOn(conn("C1", VoiceConnectionStatus.Ready), "C1"), true);
  assert.equal(isLiveOn(null, "C1"), false); // no connection
  assert.equal(isLiveOn(conn("C2", VoiceConnectionStatus.Ready), "C1"), false); // dragged elsewhere
  assert.equal(isLiveOn(conn("C1", VoiceConnectionStatus.Disconnected), "C1"), false); // kicked / 4014
  assert.equal(isLiveOn(conn("C1", VoiceConnectionStatus.Destroyed), "C1"), false); // torn down
  assert.equal(isLiveOn({ joinConfig: { channelId: "C1" } }, "C1"), false); // missing state -> fail closed
});

test("resolveVoice: VOICE_NAME -> baked model if it exists, else PIPER_VOICE fallback", () => {
  const exists = (p) => p === "/opt/piper/voices/en_US-amy-medium.onnx";
  const dflt = "/opt/piper/voices/en_US-lessac-medium.onnx";
  // named + present -> that model
  assert.equal(resolveVoice({ voiceName: "en_US-amy-medium", piperVoice: dflt, existsFn: exists }), "/opt/piper/voices/en_US-amy-medium.onnx");
  // named but not baked -> fall back to the default
  assert.equal(resolveVoice({ voiceName: "en_US-nope-medium", piperVoice: dflt, existsFn: exists }), dflt);
  // no name -> default
  assert.equal(resolveVoice({ voiceName: "", piperVoice: dflt, existsFn: exists }), dflt);
  // path-traversal / bad charset -> rejected, default (existsFn never consulted)
  assert.equal(resolveVoice({ voiceName: "../../etc/passwd", piperVoice: dflt, existsFn: () => true }), dflt);
});

test("sanitizeForSpeech collapses whitespace/newlines and strips control chars", () => {
  assert.equal(sanitizeForSpeech("  hello\n\tworld  "), "hello world");
  // control chars (NUL, DEL) -> space -> collapsed; use fromCodePoint to keep the
  // source ASCII (see the Unicode footgun note in app/CLAUDE.md).
  assert.equal(sanitizeForSpeech("a" + String.fromCodePoint(0) + "b" + String.fromCodePoint(0x7f) + "c"), "a b c");
  assert.equal(sanitizeForSpeech(null), "");
  assert.equal(sanitizeForSpeech(undefined), "");
});

test("sanitizeForSpeech caps pathologically long input", () => {
  const out = sanitizeForSpeech("word ".repeat(1000));
  assert.ok(out.length <= 600, `expected <=600, got ${out.length}`);
});

// --- STT: transcribe() spawn contract + transcript filtering ---

function fakeWhisper({ exitCode = 0, stdout = "", stderr = "" } = {}) {
  return () => {
    const l = {};
    const proc = {
      stdout: { on(ev, cb) { if (ev === "data" && stdout) cb(Buffer.from(stdout)); } },
      stderr: { on(ev, cb) { if (ev === "data" && stderr) cb(Buffer.from(stderr)); } },
      on(ev, cb) { l[ev] = cb; },
    };
    queueMicrotask(() => l.close?.(exitCode));
    return proc;
  };
}

test("transcribe resolves trimmed stdout on a clean whisper exit", async () => {
  const text = await transcribe("/x.wav", { model: "/m.bin", spawnFn: fakeWhisper({ stdout: "  Hello there.  \n" }) });
  assert.equal(text, "Hello there.");
});

test("transcribe rejects on a non-zero exit, surfacing stderr", async () => {
  await assert.rejects(
    () => transcribe("/x.wav", { model: "/m.bin", spawnFn: fakeWhisper({ exitCode: 2, stderr: "failed to load model" }) }),
    /whisper exited 2.*failed to load model/s,
  );
});

test("transcribe rejects when no model is configured", async () => {
  await assert.rejects(() => transcribe("/x.wav", { model: undefined, spawnFn: fakeWhisper() }), /WHISPER_MODEL/);
});

test("isMeaningfulTranscript filters empty/silence/filler tags, keeps real speech", () => {
  assert.equal(isMeaningfulTranscript("what's the weather"), true);
  assert.equal(isMeaningfulTranscript(""), false);
  assert.equal(isMeaningfulTranscript("   "), false);
  assert.equal(isMeaningfulTranscript("[BLANK_AUDIO]"), false);
  assert.equal(isMeaningfulTranscript("(silence)"), false);
  assert.equal(isMeaningfulTranscript("[ Music ]"), false);
  assert.equal(isMeaningfulTranscript("[BLANK_AUDIO]\n[BLANK_AUDIO]"), false); // multiple tags
  assert.equal(isMeaningfulTranscript("(clears throat) (silence)"), false);
  assert.equal(isMeaningfulTranscript("call john (mobile)"), true); // speech with an aside survives
  assert.equal(isMeaningfulTranscript(null), false);
});

test("renderVoiceDispatchPrompt embeds the task + channel post + the SPOKEN---FULL final-message format", () => {
  const p = renderVoiceDispatchPrompt({ task: "check the weather in Boston", textChannelId: "999", selfId: "SELF" });
  assert.match(p, /check the weather in Boston/);
  assert.match(p, /discord-cli send 999/);
  assert.match(p, /VOICE/); // notes it came in by voice
  assert.match(p, /ONLY "---"/); // the two-part final-message separator
  assert.match(p, /DMs the person part 2/); // delivery is code-owned, model just formats
  assert.doesNotMatch(p, /discord-cli dm/); // the model does NOT send the DM itself
});

test("splitDispatchResult: splits on a dashes-only line into spoken + full; no marker -> both the same", () => {
  assert.deepEqual(
    splitDispatchResult("Sam Burns leads at ten under.\n---\n1. Burns -10\n2. McIlroy -8"),
    { spoken: "Sam Burns leads at ten under.", full: "1. Burns -10\n2. McIlroy -8" },
  );
  // extra padding around the --- tolerated
  assert.equal(splitDispatchResult("hi\n  ---  \nbody").full, "body");
  // CRLF line endings (content pasted from a fetched source) split correctly
  assert.deepEqual(splitDispatchResult("hi\r\n---\r\nbody"), { spoken: "hi", full: "body" });
  // no separator -> both parts are the whole text (speak capped, DM all of it)
  assert.deepEqual(splitDispatchResult("just one line"), { spoken: "just one line", full: "just one line" });
  assert.deepEqual(splitDispatchResult(""), { spoken: "", full: "" });
  assert.deepEqual(splitDispatchResult(null), { spoken: "", full: "" });
});

// A fake child process so synthesize's spawn contract is testable without Piper.
function fakeSpawn({ exitCode = 0, err = null, stderr = "" } = {}) {
  return () => {
    const listeners = {};
    const proc = {
      stdin: { end() {}, on() {} },
      stderr: { on(ev, cb) { if (ev === "data" && stderr) cb(Buffer.from(stderr)); } },
      on(ev, cb) { listeners[ev] = cb; },
    };
    queueMicrotask(() => (err ? listeners.error?.(err) : listeners.close?.(exitCode)));
    return proc;
  };
}

test("synthesize resolves the wav path on a clean piper exit", async () => {
  const { path, dir } = await synthesize("hi", { voice: "/x.onnx", spawnFn: fakeSpawn({ exitCode: 0 }) });
  assert.match(path, /speech\.wav$/);
  rmSync(dir, { recursive: true, force: true });
});

test("synthesize rejects on a non-zero piper exit, surfacing stderr", async () => {
  await assert.rejects(
    () => synthesize("hi", { voice: "/x.onnx", spawnFn: fakeSpawn({ exitCode: 1, stderr: "model load failed" }) }),
    /piper exited 1.*model load failed/s,
  );
});

test("synthesize rejects on a spawn error (piper missing)", async () => {
  await assert.rejects(
    () => synthesize("hi", { voice: "/x.onnx", spawnFn: fakeSpawn({ err: new Error("ENOENT") }) }),
    /ENOENT/,
  );
});

test("synthesize rejects when no voice model is configured", async () => {
  await assert.rejects(() => synthesize("hi", { voice: undefined, spawnFn: fakeSpawn() }), /PIPER_VOICE/);
});

test("synthesize passes --length_scale only when set", async () => {
  const capture = () => { let args; const fn = (bin, a) => { args = a; return fakeSpawn({ exitCode: 0 })(bin, a); }; return { fn, get: () => args }; };
  const withScale = capture();
  const a = await synthesize("hi", { voice: "/x.onnx", lengthScale: "1.3", spawnFn: withScale.fn });
  assert.ok(withScale.get().includes("--length_scale") && withScale.get().includes("1.3"), "length_scale passed");
  rmSync(a.dir, { recursive: true, force: true });
  const noScale = capture();
  const b = await synthesize("hi", { voice: "/x.onnx", lengthScale: "", spawnFn: noScale.fn });
  assert.ok(!noScale.get().includes("--length_scale"), "length_scale omitted when empty");
  rmSync(b.dir, { recursive: true, force: true });
});

test("synthesize survives a stdin EPIPE (has an error listener, doesn't crash)", async () => {
  // A real EventEmitter stdin: emitting 'error' with no listener throws (an uncaught
  // exception that would kill the daemon), so this proves synthesize attached one.
  const stdin = Object.assign(new EventEmitter(), { end() {} });
  const spawnFn = () => ({
    stdin,
    stderr: { on() {} },
    on(ev, cb) { if (ev === "close") queueMicrotask(() => cb(0)); },
  });
  const p = synthesize("hi", { voice: "/x.onnx", spawnFn });
  assert.doesNotThrow(() => stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
  const { dir } = await p;
  rmSync(dir, { recursive: true, force: true });
});

test("buildDispatchPlaceholder: question kind uses 'Looking into' + label", () => {
  const s = buildDispatchPlaceholder("question", "the Open leaderboard");
  assert.match(s, /Looking into the Open leaderboard\.\.\.$/);
  assert.ok(!/Working on/.test(s));
});

test("buildDispatchPlaceholder: task kind uses 'Working on' + label", () => {
  const s = buildDispatchPlaceholder("task", "the dinner reservation");
  assert.match(s, /Working on the dinner reservation\.\.\.$/);
});

test("buildDispatchPlaceholder: empty/missing label -> generic line per kind", () => {
  assert.match(buildDispatchPlaceholder("question", ""), /Looking into that\.\.\.$/);
  assert.match(buildDispatchPlaceholder("question", "   "), /Looking into that\.\.\.$/);
  assert.match(buildDispatchPlaceholder("task", undefined), /working on that now\.\.\.$/);
});

test("buildDispatchPlaceholder: collapses whitespace and caps a runaway label", () => {
  assert.match(buildDispatchPlaceholder("question", "the\n\n  Open   leaderboard"), /Looking into the Open leaderboard\.\.\.$/);
  const long = buildDispatchPlaceholder("task", "x".repeat(500));
  // label capped at 80 -> total stays bounded (prefix+emoji+cap+trailer well under 120)
  assert.ok(long.length < 120, `placeholder too long: ${long.length}`);
});

test("postDispatchPlaceholder: sends with mentions suppressed; remove() deletes, replace() edits", async () => {
  const calls = { sent: null, deleted: 0, edited: null };
  const msg = { delete: async () => { calls.deleted++; }, edit: async (p) => { calls.edited = p; } };
  const client = { channels: { fetch: async () => ({ send: async (p) => { calls.sent = p; return msg; } }) } };
  const ph = await postDispatchPlaceholder(client, "C1", "working...");
  assert.equal(calls.sent.content, "working...");
  assert.deepEqual(calls.sent.allowedMentions, { parse: [] }); // no @everyone ping from a label
  await ph.replace("failure note");
  assert.equal(calls.edited.content, "failure note");
  assert.deepEqual(calls.edited.allowedMentions, { parse: [] });
  await ph.remove();
  assert.equal(calls.deleted, 1);
});

test("postDispatchPlaceholder: post failure -> null (never throws), handle swallows delete/edit errors", async () => {
  const bad = await postDispatchPlaceholder({ channels: { fetch: async () => { throw new Error("no channel"); } } }, "C1", "x");
  assert.equal(bad, null);
  const msg = { delete: async () => { throw new Error("gone"); }, edit: async () => { throw new Error("locked"); } };
  const ph = await postDispatchPlaceholder({ channels: { fetch: async () => ({ send: async () => msg }) } }, "C1", "x");
  await assert.doesNotReject(() => ph.remove());
  await assert.doesNotReject(() => ph.replace("y"));
});

// --- Muzak coordinator (state logic; the live audio path isn't unit-tested) ---
function fakePlayer(status = AudioPlayerStatus.Idle) {
  return {
    state: { status }, handlers: {},
    on(ev, cb) { this.handlers[ev] = cb; },
    play() { this.played = (this.played || 0) + 1; this.state.status = AudioPlayerStatus.Playing; },
    stop() { this.stopped = (this.stopped || 0) + 1; this.state.status = AudioPlayerStatus.Idle; },
  };
}
function fakeConnection() {
  return {
    subscribed: null, unsubs: 0,
    subscribe(p) { this.subscribed = p; const self = this; return { unsubscribe() { self.unsubs++; } }; },
  };
}
const fakeResource = () => ({ volume: { setVolume() {} } });
const newMuzak = () => {
  const speechPlayer = fakePlayer(), musicPlayer = fakePlayer(), connection = fakeConnection();
  const m = new Muzak({ connection, speechPlayer, musicPlayer, pickFile: () => "/x.ogg", volume: 0.15, createResource: fakeResource });
  return { m, speechPlayer, musicPlayer, connection };
};

test("Muzak: subscribes speech by default; start->music, duck->speech, unduck->music, stop->speech", () => {
  const { m, speechPlayer, musicPlayer, connection } = newMuzak();
  assert.equal(connection.subscribed, speechPlayer); // default: speech audible
  m.start();
  assert.equal(connection.subscribed, musicPlayer); // music playing
  assert.equal(musicPlayer.played, 1);
  m.duck();
  assert.equal(connection.subscribed, speechPlayer); // ducked: speech audible (music AutoPauses)
  musicPlayer.state.status = AudioPlayerStatus.AutoPaused; // real no-subscriber state
  m.unduck();
  assert.equal(connection.subscribed, musicPlayer); // resumed
  assert.equal(musicPlayer.played, 1, "a paused (non-idle) loop is not replayed");
  m.stop();
  assert.equal(musicPlayer.stopped, 1);
  assert.equal(connection.subscribed, speechPlayer);
  assert.equal(m.active, false);
});

test("Muzak: start() while speaking defers music until unduck; start/stop idempotent", () => {
  const { m, speechPlayer, musicPlayer, connection } = newMuzak();
  m.duck(); // speaking
  m.start(); // active, but mid-utterance -> stay on speech
  assert.equal(connection.subscribed, speechPlayer);
  assert.equal(musicPlayer.played, undefined);
  m.start(); // idempotent (no double)
  assert.equal(m.active, true);
  m.unduck(); // utterance done, still active -> music
  assert.equal(connection.subscribed, musicPlayer);
  assert.equal(musicPlayer.played, 1);
});

test("Muzak: the music player's Idle handler replays the loop while active, not after stop", () => {
  const { m, musicPlayer } = newMuzak();
  m.start();
  assert.equal(musicPlayer.played, 1);
  musicPlayer.state.status = AudioPlayerStatus.Idle; // loop segment ended
  musicPlayer.handlers[AudioPlayerStatus.Idle]();
  assert.equal(musicPlayer.played, 2, "replays on Idle while active");
  m.stop();
  musicPlayer.state.status = AudioPlayerStatus.Idle;
  musicPlayer.handlers[AudioPlayerStatus.Idle]();
  assert.equal(musicPlayer.played, 2, "no replay after stop");
});

test("listMuzakTracks: filters to audio, skips dotfiles, sorts, absolutizes; bad dir -> []", () => {
  const fake = () => ["b.mp3", "a.wav", "notes.txt", "c.OGG", "sub", "._junk.mp3", ".hidden.ogg"];
  const out = listMuzakTracks("/opt/muzak/tracks", fake);
  assert.deepEqual(out, ["/opt/muzak/tracks/a.wav", "/opt/muzak/tracks/b.mp3", "/opt/muzak/tracks/c.OGG"]);
  assert.deepEqual(listMuzakTracks("/nope", () => { throw new Error("ENOENT"); }), []);
});

test("pickMuzakTrack: random pick within range; empty -> ''; rng==1 stays in bounds", () => {
  const pool = ["/a.mp3", "/b.mp3", "/c.mp3"];
  assert.equal(pickMuzakTrack(pool, () => 0), "/a.mp3");
  assert.equal(pickMuzakTrack(pool, () => 0.99), "/c.mp3");
  assert.equal(pickMuzakTrack(pool, () => 1), "/c.mp3"); // guarded against out-of-range
  assert.equal(pickMuzakTrack([], () => 0.5), "");
  // spread across the pool over many draws (not stuck on one)
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(pickMuzakTrack(pool));
  assert.equal(seen.size, 3, "all tracks reachable");
});

test("Muzak: _loop picks a FRESH track each play (random pool)", () => {
  const speechPlayer = fakePlayer(), musicPlayer = fakePlayer(), connection = fakeConnection();
  const picks = ["/one.mp3", "/two.mp3", "/three.mp3"];
  let i = 0;
  const captured = [];
  const createResource = (f) => { captured.push(f); return fakeResource(); };
  const m = new Muzak({ connection, speechPlayer, musicPlayer, pickFile: () => picks[i++ % picks.length], volume: 0.1, createResource });
  m.start(); // first play
  musicPlayer.state.status = AudioPlayerStatus.Idle;
  musicPlayer.handlers[AudioPlayerStatus.Idle](); // loop -> second play
  musicPlayer.state.status = AudioPlayerStatus.Idle;
  musicPlayer.handlers[AudioPlayerStatus.Idle](); // loop -> third play
  assert.deepEqual(captured, ["/one.mp3", "/two.mp3", "/three.mp3"], "a new track is chosen each play");
});
