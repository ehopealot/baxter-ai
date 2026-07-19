// Unit tests for voice-bot.mjs's pure helpers. The daemon's Discord/audio wiring
// (join/play) needs a live voice connection and isn't unit-tested; these cover the
// join/leave decision, speech-text sanitization, and the Piper spawn contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { humanCount, shouldBeConnected, isLiveOn, resolveVoice, sanitizeForSpeech, synthesize, transcribe, isMeaningfulTranscript, renderVoiceDispatchPrompt, capChars } from "./voice-bot.mjs";

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

test("renderVoiceDispatchPrompt embeds the task + channel + a discord-cli post instruction", () => {
  const p = renderVoiceDispatchPrompt({ task: "check the weather in Boston", textChannelId: "999", selfId: "SELF" });
  assert.match(p, /check the weather in Boston/);
  assert.match(p, /discord-cli send 999/);
  assert.match(p, /999/); // channel id present
  assert.match(p, /VOICE/); // notes it came in by voice
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
