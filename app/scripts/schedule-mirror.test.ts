import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScheduleView, scheduleViewVersion } from "./schedule-mirror.ts";

// The store reads SCHEDULE_DIR_OVERRIDE at call time, so setting it here (before any test body)
// is enough; a static import is fine (a top-level `await import` hangs node --test in this repo).
const DIR = mkdtempSync(join(tmpdir(), "sched-mirror-"));
process.env.SCHEDULE_DIR_OVERRIDE = DIR;
process.env.BAXTER_TZ = "America/New_York";

function seed(tasks: unknown[]) {
  writeFileSync(join(DIR, "schedule.json"), JSON.stringify(tasks, null, 2));
}

test("empty schedule -> empty items, lists filler, resolved tz", async () => {
  seed([]);
  const v = await buildScheduleView();
  assert.deepEqual(v.items, []);
  assert.deepEqual(v.lists, []);
  assert.equal(v.tz, "America/New_York");
});

test("sorts soonest-to-latest, sets recurring from cron, maps desc", async () => {
  seed([
    { id: "b", desc: "Later one-shot", next_run_at: "2026-09-01T10:00:00.000Z", at: "2026-09-01T10:00:00.000Z" },
    { id: "a", desc: "Sooner recurring", next_run_at: "2026-08-20T09:00:00.000Z", cron: "0 9 * * *" },
  ]);
  const v = await buildScheduleView();
  assert.deepEqual(v.items.map((i) => i.desc), ["Sooner recurring", "Later one-shot"]);
  assert.deepEqual(v.items.map((i) => i.recurring), [true, false]);
  assert.equal(v.items[0].nextRun, "2026-08-20T09:00:00.000Z");
});

test("a task with no desc renders the neutral placeholder, never the prompt", async () => {
  seed([{ id: "x", task: "Check the weather and message the family", next_run_at: "2026-08-20T09:00:00.000Z", cron: "0 9 * * *" }]);
  const v = await buildScheduleView();
  assert.equal(v.items[0].desc, "(no description)");
  assert.ok(!JSON.stringify(v).includes("Check the weather"), "internal prompt must not leak into the view");
});

test("scheduleViewVersion is a stable hash of the view", async () => {
  seed([{ id: "a", desc: "One", next_run_at: "2026-08-20T09:00:00.000Z", cron: "0 9 * * *" }]);
  const a = scheduleViewVersion(await buildScheduleView());
  const b = scheduleViewVersion(await buildScheduleView());
  assert.equal(typeof a, "string");
  assert.equal(a, b);
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
