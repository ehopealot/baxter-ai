import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "./schedule-store.ts";
import { candidateInterval, findFollowUpCandidates } from "./followup-candidates.ts";
import { parseGregorianDate } from "./followup-normalization.ts";

const plan = parseGregorianDate("2026-08-28");
const tz = "America/Los_Angeles";

function one(id: string, instant: string, desc = id): Task {
  return { id, task: desc, desc, cron: null, at: instant, tz, next_run_at: instant, invisible_until: null, attempts: 0 };
}

test("candidate interval is half-open from prior-day midnight through day-after-plan midnight", () => {
  const interval = candidateInterval(plan, tz);
  assert.equal(new Date(interval.startMs).toISOString(), "2026-08-27T07:00:00.000Z");
  assert.equal(new Date(interval.endMs).toISOString(), "2026-08-29T07:00:00.000Z");
  const out = findFollowUpCandidates([
    one("before", "2026-08-27T06:59:59.999Z"),
    one("start", "2026-08-27T07:00:00.000Z"),
    one("last", "2026-08-29T06:59:00.000Z"),
    { ...one("offset", "2026-08-28T18:00:00.000Z"), at: "2026-08-28T11:00:00-07:00" },
    one("end", "2026-08-29T07:00:00.000Z"),
  ], plan, tz, 100);
  assert.deepEqual(out.map((x) => x.id), ["start", "last", "offset"]);
});

test("recurrences use the engine occurrence and ignore persisted next_run_at", () => {
  const tasks: Task[] = [
    { id: "hourly", task: "groceries", desc: "Grocery run", cron: "0 * * * *", at: null, tz, next_run_at: "2099-01-01T00:00:00.000Z", invisible_until: null, attempts: 0 },
    { id: "daily", task: "walk", desc: "Daily walk", cron: "0 9 * * *", at: null, tz, next_run_at: "2099-01-01T00:00:00.000Z", invisible_until: null, attempts: 0 },
    { id: "weekly", task: "weekly", desc: "Weekly", cron: "0 23 * * 5", at: null, tz: "America/New_York", next_run_at: "2099-01-01T00:00:00.000Z", invisible_until: null, attempts: 0 },
  ];
  const out = findFollowUpCandidates(tasks, plan, tz, 100);
  assert.equal(out.length, 3);
  assert.ok(out.every((x) => x.recurring));
  const interval = candidateInterval(plan, tz);
  assert.ok(out.every((x) => Date.parse(x.occurrence) >= interval.startMs && Date.parse(x.occurrence) < interval.endMs));
});

test("DST-crossing interval and recurrence retain civil boundaries", () => {
  const spring = parseGregorianDate("2026-03-08");
  const interval = candidateInterval(spring, tz);
  assert.equal(new Date(interval.startMs).toISOString(), "2026-03-07T08:00:00.000Z");
  assert.equal(new Date(interval.endMs).toISOString(), "2026-03-09T07:00:00.000Z");
  const out = findFollowUpCandidates([
    { id: "daily", task: "daily", desc: "Daily", cron: "30 9 * * *", at: null, tz, next_run_at: "2099-01-01T00:00:00.000Z", invisible_until: null, attempts: 0 },
  ], spring, tz, 100);
  assert.equal(out.length, 1);
});

test("candidate projection bounds descriptions and refuses oversized/corrupt stores", () => {
  const long = one("long", "2026-08-28T18:00:00.000Z", "x".repeat(500));
  const out = findFollowUpCandidates([long], plan, tz, 100);
  assert.equal(Array.from(out[0].desc).length, 200);
  assert.throws(() => findFollowUpCandidates(Array.from({ length: 101 }, (_, i) => one(String(i), "2026-08-28T18:00:00.000Z")), plan, tz, 100), /exceeds.*100/);
  assert.throws(() => findFollowUpCandidates([{ ...long, next_run_at: "bad" }], plan, tz, 100), /invalid one-shot/);
  assert.throws(() => findFollowUpCandidates([{ ...long, cron: "0 9 * * *", at: long.at }], plan, tz, 100), /recurring.*invalid/);
  const malformedFeature = { ...long, follow_up: { nope: true } } as unknown as Task;
  assert.throws(() => findFollowUpCandidates([malformedFeature], plan, tz, 100), /follow_up/);
});
