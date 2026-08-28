import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseMaxSends, createCounter, setSendStateFsyncForTest } from "./send-state.ts";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";

test("parseMaxSends returns default on unset/blank", () => {
  assert.equal(parseMaxSends(undefined, 500), 500);
  assert.equal(parseMaxSends("", 500), 500);
  assert.equal(parseMaxSends("   ", 500), 500);
});
test("parseMaxSends parses a valid number", () => {
  assert.equal(parseMaxSends("1000", 500), 1000);
  assert.equal(parseMaxSends("0", 500), 0);
});
test("parseMaxSends falls back on NaN or negative", () => {
  assert.equal(parseMaxSends("fifty", 500), 500);
  assert.equal(parseMaxSends("-3", 500), 500);
});

test("record increments and persists the day's count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "send-state-"));
  process.env.SEND_STATE_DIR_OVERRIDE = dir;
  try {
    const c = createCounter(join(dir, "send-state.json"), "MAX_SENDS_PER_DAY", 500);
    assert.equal(c.load().count, 0);
    await c.record();
    await c.record();
    assert.equal(c.load().count, 2);
  } finally {
    delete process.env.SEND_STATE_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SMS reserve and record fail closed on corrupt or invalid send-state", async () => {
  const root = mkdtempSync(join(tmpdir(), "sms-send-state-invalid-"));
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const invalid = [
    "{not-json",
    JSON.stringify({ date: today, count: -1 }),
    JSON.stringify({ date: today, count: 1, reservations: [""] }),
    JSON.stringify({ date: yesterday, count: "corrupt" }),
    JSON.stringify({ date: tomorrow, count: 0 }),
  ];
  try {
    for (const operation of ["record", "reserve"] as const) {
      const path = join(root, `${operation}.json`);
      const counter = createCounter(path, "SMS_MAX_SENDS_PER_DAY", 500);
      for (const raw of invalid) {
        writeFileSync(path, raw, { mode: 0o600 });
        const before = readFileSync(path, "utf8");
        await assert.rejects(
          operation === "record" ? counter.record() : counter.reserve("work:operation"),
          /invalid send state/,
        );
        assert.equal(readFileSync(path, "utf8"), before, `${operation} does not replace invalid state`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SMS reserve and record initialize only missing or valid prior-day state", async () => {
  const root = mkdtempSync(join(tmpdir(), "sms-send-state-prior-"));
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  try {
    for (const operation of ["record", "reserve"] as const) {
      const path = join(root, `${operation}.json`);
      writeFileSync(path, JSON.stringify({ date: yesterday, count: 400, reservations: ["old-operation"] }), { mode: 0o600 });
      const counter = createCounter(path, "SMS_MAX_SENDS_PER_DAY", 500);
      if (operation === "record") await counter.record();
      else await counter.reserve("new-operation");
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), operation === "record"
        ? { date: today, count: 1 }
        : { date: today, count: 1, reservations: ["new-operation"] });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The whole point of the lock: many processes sending at once must not lose a
// count. Each child imports the module fresh (its own process) and records once;
// the unlocked read-modify-write this replaced would let two children read the
// same count and both write count+1, dropping a send from the tally.
test("record and reserve durably create and replace send-state before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "send-state-durable-"));
  try {
    for (const operation of ["record", "reserve"] as const) {
      const dir = join(root, operation);
      const path = join(dir, "sms-send-state.json");
      const events: string[] = [];
      const restoreFile = setSendStateFsyncForTest(() => { events.push("file"); });
      const restoreDirectory = setDurableDirectorySyncForTest(candidate => {
        if (resolve(candidate) === resolve(dir)) events.push("directory");
      });
      try {
        const counter = createCounter(path, "SMS_MAX_SENDS_PER_DAY", 500);
        if (operation === "record") await counter.record();
        else await counter.reserve("work:operation");
      } finally { restoreFile(); restoreDirectory(); }
      assert.deepEqual(events, ["directory", "file", "directory", "file", "directory"], `${operation} fsync order`);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir), ["sms-send-state.json"], "no temp file survives publication");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent record() across processes never loses a count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "send-state-"));
  const modUrl = new URL("./send-state.ts", import.meta.url).href;
  const N = 12;
  const child = () =>
    new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        ["-e", `import(${JSON.stringify(modUrl)}).then((m) => m.recordDiscordSend()).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`],
        { env: { ...process.env, SEND_STATE_DIR_OVERRIDE: dir } },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  try {
    await Promise.all(Array.from({ length: N }, child));
    const state = JSON.parse(readFileSync(join(dir, "discord-send-state.json"), "utf8"));
    assert.equal(state.count, N);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
