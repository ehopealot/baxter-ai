import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  return import(`./heartbeat.mjs?t=${Date.now()}${Math.random()}`);
}

test("tick fires a due one-shot, removes it on success, logs completed", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.mjs?t=${Date.now()}a`);
  await store.mutate((t) => ({ tasks: [{ id: "o", task: "x", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  const fired = [];
  await tick(Date.parse("2026-01-02T00:00:00Z"), { runFn: async (task) => { fired.push(task.id); return { ok: true }; }, fireCap: 100, visibilityMs: 900000, maxAttempts: 3, fallbackTz: "UTC" });
  assert.deepEqual(fired, ["o"]);
  assert.equal((await store.readTasks()).length, 0);
});

test("tick does NOT fire when the cap is exhausted, and logs skipped once/day", async () => {
  // Use real 'now' so the store's today() (real clock) matches the logged ts;
  // a past next_run_at keeps the task due. Two ticks, still capped.
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE;
  const store = await import(`./schedule-store.mjs?t=${Date.now()}b`);
  const now = Date.now();
  for (let i = 0; i < 3; i++) store.appendLog({ ts: new Date(now).toISOString(), id: `x${i}`, outcome: "completed" });
  await store.mutate((t) => ({ tasks: [{ id: "d", task: "x", at: "2000-01-01T00:00:00Z", cron: null, next_run_at: "2000-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  let fired = 0;
  const opts = { runFn: async () => { fired++; return { ok: true }; }, fireCap: 3, visibilityMs: 900000, maxAttempts: 3, fallbackTz: "UTC" };
  await tick(now, opts);
  await tick(now + 60000, opts); // next tick, still capped -> must NOT re-log skipped
  assert.equal(fired, 0);
  const { readFileSync } = await import("node:fs");
  const skipped = readFileSync(join(dir, "task-log.jsonl"), "utf8").split("\n").filter((l) => l.includes('"skipped"')).length;
  assert.equal(skipped, 1); // once per day, not once per tick
});
