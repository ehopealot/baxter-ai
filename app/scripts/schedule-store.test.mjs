import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveNextRun, cronMinGapMinutes, selectDue, applyClaim, applyOnSuccess, applyOnFailure, envInt,
} from "./schedule-store.mjs";
import { mkdtempSync, writeFileSync as wf, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

const TZ = "America/Los_Angeles";
const ms = (iso) => Date.parse(iso);

test("resolveNextRun: offset-carrying at is absolute; naive at uses tz; cron computes next", () => {
  assert.equal(resolveNextRun({ at: "2026-07-20T14:00:00Z" }, ms("2026-07-15T00:00:00Z"), TZ), "2026-07-20T14:00:00.000Z");
  // naive 2026-07-20 09:00 in America/New_York (EDT, -4) => 13:00Z
  assert.equal(resolveNextRun({ at: "2026-07-20T09:00:00", tz: "America/New_York" }, ms("2026-07-15T00:00:00Z"), TZ), "2026-07-20T13:00:00.000Z");
  // cron 9am weekdays in NY, from Wed 2026-07-15T20:00Z => Thu 2026-07-16 09:00 EDT = 13:00Z
  assert.equal(resolveNextRun({ cron: "0 9 * * 1-5", tz: "America/New_York" }, ms("2026-07-15T20:00:00Z"), TZ), "2026-07-16T13:00:00.000Z");
});

test("envInt fails closed on a non-numeric env var, defaults otherwise", () => {
  process.env.HB_TEST_LIMIT = "60m";
  assert.throws(() => envInt("HB_TEST_LIMIT", 60), /must be a number/);
  delete process.env.HB_TEST_LIMIT;
  assert.equal(envInt("HB_TEST_UNSET", 100), 100);
});

test("resolveNextRun: naive at is DST-correct across spring-forward", () => {
  // 5am on 2026-03-08 in LA is PDT (after the 2am spring-forward) => 12:00Z,
  // not 13:00Z (a single-offset correction would sample PST and be an hour off).
  assert.equal(resolveNextRun({ at: "2026-03-08T05:00:00", tz: "America/Los_Angeles" }, ms("2026-03-01T00:00:00Z"), "UTC"), "2026-03-08T12:00:00.000Z");
});

test("cronMinGapMinutes catches uneven exprs regardless of add-time", () => {
  assert.ok(cronMinGapMinutes("0,30 9 * * *", null, TZ) <= 30);   // twice within 30 min
  assert.equal(cronMinGapMinutes("0 * * * *", null, TZ), 60);     // hourly
  assert.ok(cronMinGapMinutes("0 9 * * 1-5", null, TZ) >= 60);    // daily-ish
  assert.ok(cronMinGapMinutes("* * 25 12 *", null, TZ) <= 1);     // calendar-sparse: still caught (no wall-clock cap)
});

test("selectDue picks past-due visible tasks only", () => {
  const now = ms("2026-07-15T12:00:00Z");
  const tasks = [
    { id: "due", next_run_at: "2026-07-15T11:00:00Z", invisible_until: null },
    { id: "future", next_run_at: "2026-07-15T13:00:00Z", invisible_until: null },
    { id: "claimed", next_run_at: "2026-07-15T11:00:00Z", invisible_until: "2026-07-15T12:10:00Z" },
    { id: "expired", next_run_at: "2026-07-15T11:00:00Z", invisible_until: "2026-07-15T11:59:00Z" },
  ];
  assert.deepEqual(selectDue(tasks, now).map((t) => t.id), ["due", "expired"]);
});

test("applyClaim sets the window and returns the task; null when absent", () => {
  const now = ms("2026-07-15T12:00:00Z");
  const tasks = [{ id: "a", invisible_until: null }];
  const r = applyClaim(tasks, "a", now, 15 * 60000);
  assert.equal(r.claimed.id, "a");
  assert.equal(r.claimed.invisible_until, "2026-07-15T12:15:00.000Z");
  assert.equal(r.tasks[0].invisible_until, "2026-07-15T12:15:00.000Z");
  assert.equal(applyClaim(tasks, "gone", now, 1000).claimed, null);
});

test("applyOnSuccess: one-shot removed, cron rescheduled, absent is no-op", () => {
  const now = ms("2026-07-16T13:05:00Z");
  const one = [{ id: "o", at: "2026-07-16T13:00:00Z", invisible_until: "x" }];
  assert.deepEqual(applyOnSuccess(one, "o", now, TZ), []);
  const cron = [{ id: "c", cron: "0 9 * * 1-5", tz: "America/New_York", invisible_until: "x", attempts: 0, next_run_at: "2026-07-16T13:00:00Z" }];
  const after = applyOnSuccess(cron, "c", now, TZ)[0];
  assert.equal(after.invisible_until, null);
  assert.equal(after.next_run_at, "2026-07-17T13:00:00.000Z"); // next weekday 9am NY
  assert.deepEqual(applyOnSuccess(cron, "gone", now, TZ), cron);
});

test("applyOnFailure: retry then give up; absent is no-op", () => {
  const now = ms("2026-07-15T12:00:00Z");
  const t = [{ id: "f", at: "2026-07-15T11:00:00Z", invisible_until: "2026-07-15T12:15:00Z", attempts: 0 }];
  const r1 = applyOnFailure(t, "f", now, 3, TZ);
  assert.equal(r1.gaveUp, false);
  assert.equal(r1.tasks[0].attempts, 1);
  assert.equal(r1.tasks[0].invisible_until, "2026-07-15T12:15:00Z"); // window left for retry
  const t2 = [{ id: "f", at: "x", invisible_until: "x", attempts: 2 }];
  const r2 = applyOnFailure(t2, "f", now, 3, TZ);
  assert.equal(r2.gaveUp, true);
  assert.deepEqual(r2.tasks, []); // one-shot dropped
  assert.equal(applyOnFailure(t2, "gone", now, 3, TZ).gaveUp, false);
});

test("mutate serializes concurrent writers without lost updates", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir; // impl reads this for test isolation
  const { mutate, readTasks } = await import(`./schedule-store.mjs?t=${Date.now()}`);
  // 20 concurrent appends must all land (lock prevents lost updates)
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      mutate((tasks) => ({ tasks: [...tasks, { id: `t${i}` }], value: null })),
    ),
  );
  assert.equal((await readTasks()).length, 20);
});

test("fireCountToday counts today's non-skipped log lines", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { appendLog, fireCountToday } = await import(`./schedule-store.mjs?t=${Date.now()}b`);
  const today = new Date().toISOString();
  appendLog({ ts: today, id: "a", outcome: "completed" });
  appendLog({ ts: today, id: "b", outcome: "failed" });
  appendLog({ ts: today, id: "c", outcome: "skipped" });      // not counted
  appendLog({ ts: "2000-01-01T00:00:00Z", id: "d", outcome: "completed" }); // not today
  assert.equal(fireCountToday(), 2);
});
