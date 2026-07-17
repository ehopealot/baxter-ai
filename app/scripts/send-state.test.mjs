import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMaxSends, createCounter } from "./send-state.mjs";

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

// The whole point of the lock: many processes sending at once must not lose a
// count. Each child imports the module fresh (its own process) and records once;
// the unlocked read-modify-write this replaced would let two children read the
// same count and both write count+1, dropping a send from the tally.
test("concurrent record() across processes never loses a count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "send-state-"));
  const modUrl = new URL("./send-state.mjs", import.meta.url).href;
  const N = 12;
  const child = () =>
    new Promise((resolve, reject) => {
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
