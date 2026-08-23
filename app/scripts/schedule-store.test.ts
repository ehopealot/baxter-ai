import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveNextRun, cronMinGapMinutes, selectDue, applyClaim, applyOnSuccess, applyOnFailure, envInt,
  isReservedId, mintTaskId,
} from "./schedule-store.ts";
import type { Task } from "./schedule-store.ts";
import { mkdtempSync, writeFileSync as wf, readFileSync as rf, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

const TZ = "America/Los_Angeles";
const ms = (iso: string) => Date.parse(iso);

test("resolveNextRun: offset-carrying at is absolute; naive at uses tz; cron computes next", () => {
  assert.equal(resolveNextRun({ at: "2026-07-20T14:00:00Z" }, ms("2026-07-15T00:00:00Z"), TZ), "2026-07-20T14:00:00.000Z");
  // naive 2026-07-20 09:00 in America/New_York (EDT, -4) => 13:00Z
  assert.equal(resolveNextRun({ at: "2026-07-20T09:00:00", tz: "America/New_York" }, ms("2026-07-15T00:00:00Z"), TZ), "2026-07-20T13:00:00.000Z");
  // cron 9am weekdays in NY, from Wed 2026-07-15T20:00Z => Thu 2026-07-16 09:00 EDT = 13:00Z
  assert.equal(resolveNextRun({ cron: "0 9 * * 1-5", tz: "America/New_York" }, ms("2026-07-15T20:00:00Z"), TZ), "2026-07-16T13:00:00.000Z");
});

test("envInt fails closed on bad env vars; defaults on unset/blank", () => {
  for (const bad of ["60m", "-1", "1.5", " x"]) {
    process.env.HB_TEST_LIMIT = bad;
    assert.throws(() => envInt("HB_TEST_LIMIT", 60), /non-negative integer/);
  }
  process.env.HB_TEST_LIMIT = "   ";
  assert.equal(envInt("HB_TEST_LIMIT", 60), 60); // blank -> default (not 0)
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
  assert.equal(r.claimed!.id, "a");
  assert.equal(r.claimed!.invisible_until, "2026-07-15T12:15:00.000Z");
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
  const { mutate, readTasks } = await import(`./schedule-store.ts?t=${Date.now()}`);
  // 20 concurrent appends must all land (lock prevents lost updates)
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      mutate((tasks: Task[]) => ({ tasks: [...tasks, { id: `t${i}` }], value: null })),
    ),
  );
  assert.equal((await readTasks()).length, 20);
});

test("a task with an sms deliver round-trips through the store", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { mutate, readTasks } = await import(`./schedule-store.ts?t=${Date.now()}c`);
  const deliver = { surface: "sms", target: "+15551234567" };
  await mutate((tasks: Task[]) => ({
    tasks: [...tasks, { id: "s1", task: "text them", cron: null, at: "2026-07-20T14:00:00Z", tz: null, deliver, next_run_at: "2026-07-20T14:00:00Z", invisible_until: null, attempts: 0 }],
    value: null,
  }));
  const tasks = await readTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].deliver, deliver);
});

test("a task with an sms-group deliver round-trips through the store, alongside older surfaces (scheduled-sms-group spec test 6)", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { mutate, readTasks } = await import(`./schedule-store.ts?t=${Date.now()}sg`);
  const deliver = { surface: "sms-group" as const, target: "grp_abc" }; // the exact provider group id
  await mutate((tasks: Task[]) => ({
    tasks: [
      ...tasks,
      { id: "g1", task: "digest the group", cron: "0 9 * * *", at: null, tz: null, deliver, next_run_at: "2026-07-20T14:00:00Z", invisible_until: null, attempts: 0 },
      { id: "g2", task: "legacy task", cron: null, at: "2026-07-21T14:00:00Z", tz: null, deliver: { surface: "mail" as const, target: "e@x.com" }, next_run_at: "2026-07-21T14:00:00Z", invisible_until: null, attempts: 0 },
    ],
    value: null,
  }));
  const tasks = await readTasks();
  assert.deepEqual(tasks[0].deliver, { surface: "sms-group", target: "grp_abc" }, "the widened surface persists and reads back exactly");
  assert.deepEqual(tasks[1].deliver, { surface: "mail", target: "e@x.com" }, "existing persisted surfaces remain compatible");
});

test("fireCountToday counts today's non-skipped log lines", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { appendLog, fireCountToday } = await import(`./schedule-store.ts?t=${Date.now()}b`);
  const today = new Date().toISOString();
  appendLog({ ts: today, id: "a", outcome: "completed" });
  appendLog({ ts: today, id: "b", outcome: "failed" });
  appendLog({ ts: today, id: "c", outcome: "skipped" });      // not counted
  appendLog({ ts: "2000-01-01T00:00:00Z", id: "d", outcome: "completed" }); // not today
  assert.equal(fireCountToday(), 2);
});

test("fireCountToday/capSkipLoggedToday follow an injected instant's UTC day (quota clock injection)", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { appendLog, fireCountToday, capSkipLoggedToday } = await import(`./schedule-store.ts?t=${Date.now()}clk`);
  appendLog({ ts: "2024-05-10T10:00:00Z", id: "a", outcome: "completed" });
  appendLog({ ts: "2024-05-10T23:30:00Z", id: "b", outcome: "failed" });    // non-skipped too
  appendLog({ ts: "2024-05-10T23:59:00Z", id: "c", outcome: "skipped" });
  appendLog({ ts: "2024-05-11T00:30:00Z", id: "d", outcome: "completed" }); // next UTC day
  appendLog({ ts: new Date().toISOString(), id: "e", outcome: "completed" }); // real-today decoy
  // an injected instant selects ITS OWN UTC day's entries, never the ambient date's
  assert.equal(fireCountToday(new Date("2024-05-10T12:00:00Z")), 2);
  assert.equal(capSkipLoggedToday(new Date("2024-05-10T23:59:59Z")), true);
  assert.equal(fireCountToday(new Date("2024-05-11T00:31:00Z")), 1);
  assert.equal(capSkipLoggedToday(new Date("2024-05-11T00:31:00Z")), false);
  // the no-arg default still reads the ambient today for direct/legacy callers and tests
  assert.equal(fireCountToday(), 1);
  assert.equal(capSkipLoggedToday(), false);
});

test("no-change mutate skips the rewrite (content+mtime untouched) yet returns the value; changed mutate writes", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { mutate } = await import(`./schedule-store.ts?t=${Date.now()}nc`);
  const file = pjoin(dir, "schedule.json");
  await mutate((tasks: Task[]) => ({
    tasks: [...tasks, { id: "keep", cron: "0 9 * * *", at: null, tz: null, next_run_at: "2026-07-20T14:00:00Z", invisible_until: null, attempts: 0 }],
    value: "seeded",
  }));
  const before = rf(file, "utf8");
  const beforeMtime = statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 10)); // a real rewrite would move mtime even at coarse granularity
  const v = await mutate((tasks: Task[]) => ({ tasks, value: "unchanged" })); // same array, nothing changed
  assert.equal(v, "unchanged");                        // the value still flows back
  assert.equal(rf(file, "utf8"), before);               // byte-identical content
  assert.equal(statSync(file).mtimeMs, beforeMtime);    // file not rewritten
  // a changed transaction keeps the atomic tmp+rename replace
  await new Promise((r) => setTimeout(r, 10));
  await mutate((tasks: Task[]) => ({
    tasks: tasks.map((t) => (t.id === "keep" ? { ...t, attempts: 3 } : t)),
    value: "changed",
  }));
  const after = JSON.parse(rf(file, "utf8")) as Task[];
  assert.equal(after[0].attempts, 3);                   // persisted
  assert.notEqual(rf(file, "utf8"), before);            // the file WAS rewritten this time
});

test("an in-place mutate callback that returns its own argument persists (skip compares the PRE-callback snapshot)", async () => {
  // The skip must compare against the serialization captured BEFORE fn runs.
  // Serializing both sides after fn makes an in-place mutation (tasks[0].x = y)
  // identical on both sides and silently drops the write -- a generic lost-update
  // trap for any transaction that mutates records in place and returns the same array.
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { mutate } = await import(`./schedule-store.ts?t=${Date.now()}ip`);
  const file = pjoin(dir, "schedule.json");
  await mutate((tasks: Task[]) => ({
    tasks: [...tasks, { id: "keep", cron: "0 9 * * *", at: null, tz: null, next_run_at: "2026-07-20T14:00:00Z", invisible_until: null, attempts: 0 }],
    value: null,
  }));
  const beforeMtime = statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 15)); // a real rewrite would move mtime even at coarse granularity
  const v = await mutate((tasks: Task[]) => {
    tasks[0].attempts = 3; // field mutation in place...
    tasks.push({ id: "pushed", cron: "0 9 * * *", at: null, tz: null, next_run_at: "2026-07-20T14:00:00Z", invisible_until: null, attempts: 0 }); // ...and a record push
    return { tasks, value: "in-place" }; // the SAME mutated array returned
  });
  assert.equal(v, "in-place");
  const after = JSON.parse(rf(file, "utf8")) as Task[];
  assert.equal(after.length, 2, "the pushed record persisted");
  assert.equal(after.find((t) => t.id === "keep")?.attempts, 3, "the in-place field mutation persisted");
  assert.notEqual(statSync(file).mtimeMs, beforeMtime, "the file WAS rewritten");
});

test("isReservedId detects the system: namespace; mintTaskId never issues a reserved id", () => {
  assert.equal(isReservedId("system:morning-check-in"), true);
  assert.equal(isReservedId("system:"), true);
  assert.equal(isReservedId("system"), false);   // prefix must be the full "system:"
  assert.equal(isReservedId("abcdef01"), false);
  assert.equal(isReservedId(""), false);
  for (let i = 0; i < 100; i++) assert.equal(isReservedId(mintTaskId()), false);
});

test("system task and trigger metadata round-trip; LogEntry audit fields persist and absence stays compatible", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { mutate, readTasks, appendLog } = await import(`./schedule-store.ts?t=${Date.now()}sys`);
  const system = { key: "morning-check-in", enabled: true };
  const system_trigger = { key: "morning-check-in" };
  await mutate((tasks: Task[]) => ({
    tasks: [
      ...tasks,
      { id: "system:morning-check-in", cron: "0 8 * * *", at: null, tz: "America/Los_Angeles", deliver: null, next_run_at: "2026-07-20T15:00:00Z", invisible_until: null, attempts: 0, system },
      { id: "feedbeef", desc: "Here’s what’s on the calendar", cron: null, at: "2026-07-20T15:00:00Z", tz: null, deliver: null, next_run_at: "2026-07-20T15:00:00Z", invisible_until: null, attempts: 0, system_trigger },
    ],
    value: null,
  }));
  const tasks = await readTasks();
  assert.deepEqual(tasks[0].system, system); // optional system metadata survives the store round-trip
  assert.equal(tasks[0].deliver, null);      // system records have no delivery surface
  assert.deepEqual(tasks[1].system_trigger, system_trigger); // explicit registry-backed trigger metadata survives too
  assert.equal(tasks[1].task, undefined);   // a trigger stores no prompt/executable identity
  appendLog({ ts: new Date().toISOString(), id: "system:morning-check-in", outcome: "completed", agent_run: true, system_key: "morning-check-in" });
  appendLog({ ts: new Date().toISOString(), id: "legacy", outcome: "completed" }); // older writers omit both
  const lines = rf(pjoin(dir, "task-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].agent_run, true);
  assert.equal(lines[0].system_key, "morning-check-in");
  assert.equal(lines[1].agent_run, undefined);
  assert.equal(lines[1].system_key, undefined);
});
