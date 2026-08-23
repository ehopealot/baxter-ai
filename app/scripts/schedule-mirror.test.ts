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

test("skips tasks with an invalid/missing next_run_at (no NaN sort key, no blank row)", async () => {
  seed([
    { id: "ok", desc: "Valid", next_run_at: "2026-08-20T09:00:00.000Z" },
    { id: "bad", desc: "Corrupt time", next_run_at: "not-a-date" },
    { id: "missing", desc: "No time" }, // next_run_at absent
    // the drop filter applies to system rows too (disabled or not): an unparseable
    // next_run_at still sorts as NaN and would render a blank time row
    { id: "system:morning-check-in", desc: "Digest", next_run_at: "garbage", cron: "0 8 * * *",
      system: { key: "morning-check-in", enabled: false } },
  ]);
  const v = await buildScheduleView();
  assert.deepEqual(v.items.map((i) => i.desc), ["Valid"]);
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

// ── T13 (system scheduled tasks): additive system/enabled emission + shared tz ──

test("ordinary/legacy tasks emit system:false enabled:true; system tasks emit system:true enabled from the strict check", async () => {
  seed([
    { id: "a", desc: "Ordinary", next_run_at: "2026-08-20T09:00:00.000Z", cron: "0 9 * * *" },
    { id: "system:morning-check-in", desc: "Here’s what’s on the calendar", next_run_at: "2026-08-20T15:00:00.000Z", cron: "0 8 * * *",
      system: { key: "morning-check-in", enabled: true } },
  ]);
  const v = await buildScheduleView();
  const [ordinary, sys] = v.items;
  assert.equal(ordinary.system, false);
  assert.equal(ordinary.enabled, true);
  assert.equal(sys.system, true);
  assert.equal(sys.enabled, true);
});

test("enabled comes ONLY from the strict system.enabled === true check - a malformed persisted 'true' string never surfaces as enabled:true", async () => {
  seed([
    // hand-edited malformed enabled (string 'true') on the canonical record
    { id: "system:morning-check-in", desc: "Digest", next_run_at: "2026-08-20T15:00:00.000Z", cron: "0 8 * * *",
      system: { key: "morning-check-in", enabled: "true" } },
    // force-disabled unknown-key record on a non-reserved id: visible for diagnosis
    { id: "hand-made", desc: "Unknown key", next_run_at: "2026-08-20T16:00:00.000Z",
      system: { key: "mystery", enabled: false } },
  ]);
  const v = await buildScheduleView();
  assert.deepEqual(v.items.map((i) => [i.system, i.enabled]), [[true, false], [true, false]]);
});

test("ordering: enabled items soonest-first by nextRun (system among them), then disabled system items by description", async () => {
  seed([
    { id: "sys-z", desc: "Zeta digest", next_run_at: "2026-08-19T15:00:00.000Z", cron: "0 8 * * *", system: { key: "k2", enabled: false } },
    { id: "ord-b", desc: "Ordinary later", next_run_at: "2026-09-01T10:00:00.000Z" },
    { id: "sys-a", desc: "Alpha digest", next_run_at: "2026-08-21T15:00:00.000Z", cron: "0 8 * * *", system: { key: "k1", enabled: false } },
    { id: "ord-a", desc: "Ordinary sooner", next_run_at: "2026-08-20T09:00:00.000Z", cron: "0 9 * * *" },
    { id: "sys-on", desc: "Enabled digest", next_run_at: "2026-08-20T10:00:00.000Z", cron: "0 8 * * *", system: { key: "k3", enabled: true } },
  ]);
  const v = await buildScheduleView();
  assert.deepEqual(v.items.map((i) => i.desc), [
    "Ordinary sooner", "Enabled digest", "Ordinary later", "Alpha digest", "Zeta digest",
  ]);
});

test("disabled system items with equal descriptions tie-break deterministically by nextRun", async () => {
  seed([
    { id: "sys-2", desc: "Dup", next_run_at: "2026-08-22T15:00:00.000Z", cron: "0 8 * * *", system: { key: "k2", enabled: false } },
    { id: "sys-1", desc: "Dup", next_run_at: "2026-08-21T15:00:00.000Z", cron: "0 8 * * *", system: { key: "k1", enabled: false } },
  ]);
  const v = await buildScheduleView();
  assert.deepEqual(v.items.map((i) => i.nextRun), ["2026-08-21T15:00:00.000Z", "2026-08-22T15:00:00.000Z"]);
});

test("tz resolves through the shared householdTz chain: valid BAXTER_TZ wins, invalid falls to HEARTBEAT_TZ, then America/Los_Angeles", async () => {
  seed([]);
  const savedBaxter = process.env.BAXTER_TZ;
  const savedHeartbeat = process.env.HEARTBEAT_TZ;
  try {
    process.env.BAXTER_TZ = "Not/A_Zone";
    process.env.HEARTBEAT_TZ = "America/New_York";
    assert.equal((await buildScheduleView()).tz, "America/New_York");
    process.env.BAXTER_TZ = "Europe/Berlin"; // valid BAXTER_TZ wins over HEARTBEAT_TZ
    assert.equal((await buildScheduleView()).tz, "Europe/Berlin");
    process.env.BAXTER_TZ = "bogus/zone";
    process.env.HEARTBEAT_TZ = "also bogus";
    assert.equal((await buildScheduleView()).tz, "America/Los_Angeles");
  } finally {
    if (savedBaxter === undefined) delete process.env.BAXTER_TZ;
    else process.env.BAXTER_TZ = savedBaxter;
    if (savedHeartbeat === undefined) delete process.env.HEARTBEAT_TZ;
    else process.env.HEARTBEAT_TZ = savedHeartbeat;
  }
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
