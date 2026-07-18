// Unit tests for voice-bot.mjs's pure helpers. The daemon's Discord/audio wiring
// (join/play) needs a live voice connection and isn't unit-tested; these cover the
// join/leave decision, speech-text sanitization, and the Piper spawn contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { humanCount, shouldBeConnected, sanitizeForSpeech, synthesize } from "./voice-bot.mjs";

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

// A fake child process so synthesize's spawn contract is testable without Piper.
function fakeSpawn({ exitCode = 0, err = null, stderr = "" } = {}) {
  return () => {
    const listeners = {};
    const proc = {
      stdin: { end() {} },
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
