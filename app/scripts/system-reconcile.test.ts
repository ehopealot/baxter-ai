// Tests for the system-task reconciliation body (system-scheduled-tasks plan,
// T4): the reserved `system:` namespace validates fail-closed BEFORE any
// mutation byte, the catch-up anchor for creation and next_run_at repair is
// derived from EACH DEFINITION'S OWN cron through the shared tz-aware
// recurrence engine (no hardcoded 08:00, no daily-only cron-shape gate --
// weekly fakes anchor by the same rule), refuseOnCollision is the shared
// in-lock guard for every id-based mutation (excludeId repair path, mutatedId
// ambiguity), and reconcileSystemTasks creates/repairs/collapses canonical
// records deterministically while preserving queue progress. Registry-bearing
// cases run against an INJECTED test registry (digest-shaped + fully-typed
// fakes under test-local keys), so production registration state never leaks
// into these tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import {
  AmbiguousIdError,
  ReservedIdCollisionError,
  cronCatchUpAnchor,
  occurrenceExpired,
  reconcileSystemTasks,
  selectWindowOccurrence,
  refuseOnCollision,
  validateReservedNamespace,
  validWindowOccurrence,
} from "./system-reconcile.ts";
import { applyOnSuccess, mutate, resolveNextRun, type Task } from "./schedule-store.ts";
import { isFeatureShapedTask } from "./followup-types.ts";
import type { SystemTaskDefinition } from "./system-tasks.ts";

const TZ = "America/Los_Angeles"; // PDT (UTC-7) on all August 2026 dates used below
const noop = () => {};

// 2026-08-20 is a Thursday; 2026-08-24 the following Monday. 08:00 PDT = 15:00Z.
const BEFORE_0800 = new Date("2026-08-20T13:00:00Z"); // 06:00 PDT
const AFTER_0800 = new Date("2026-08-20T16:00:00Z"); // 09:00 PDT
const TODAY_0800 = "2026-08-20T15:00:00.000Z";
const TOMORROW_0800 = "2026-08-21T15:00:00.000Z";
// 18:30 PDT on Aug 20 = 01:30Z Aug 21.
const TODAY_1830 = "2026-08-21T01:30:00.000Z";
const NEXT_MONDAY_0800 = "2026-08-24T15:00:00.000Z";

// The injected registries: a definition shaped exactly like the real digest
// (its key IS a SystemTaskKey, so no casts) plus fully-typed fakes under
// test-local keys -- the generic key parameter T3 introduced exists for this.
const digestDef: SystemTaskDefinition<"test-daily-digest"> = {
  key: "test-daily-digest",
  desc: "Here’s what’s on the calendar",
  cron: "0 8 * * *",
  execute: async () => ({ ok: true }),
};
const eveningDef: SystemTaskDefinition<"test-evening-digest"> = {
  key: "test-evening-digest",
  desc: "evening digest",
  cron: "30 18 * * *",
  execute: async () => ({ ok: true }),
};
const weeklyDef: SystemTaskDefinition<"test-weekly-ping"> = {
  key: "test-weekly-ping",
  desc: "weekly ping",
  cron: "0 8 * * 1",
  execute: async () => ({ ok: true }),
};
const DIGEST_REGISTRY: readonly SystemTaskDefinition<string>[] = [digestDef];
const MORNING: SystemTaskDefinition<"morning-check-in"> = {
  key: "morning-check-in", desc: "Morning calendar and household check-in", cron: "0 8 * * *",
  window: { startHour: 8, minuteSlots: 60, cutoffHour: 12 }, execute: async () => ({ ok: true }),
};

const ordinary = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  task: "an ordinary task",
  cron: "0 9 * * *",
  at: null,
  tz: TZ,
  next_run_at: TOMORROW_0800,
  invisible_until: null,
  attempts: 0,
  deliver: null,
  created_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

// A canonical digest record exactly as a healthy store holds it.
const canonical = (over: Partial<Task> = {}): Task => ({
  id: "system:test-daily-digest",
  desc: "Here’s what’s on the calendar",
  cron: "0 8 * * *",
  at: null,
  tz: TZ,
  next_run_at: TODAY_0800,
  invisible_until: null,
  attempts: 0,
  deliver: null,
  system: { key: "test-daily-digest", enabled: true },
  created_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

// Persisted records are arbitrary JSON; a hand-edited `system` value (string
// 'true', 1, null, missing enabled) rides in as unknown. One localized bridge
// stands in for exactly what readTasks() can hand reconciliation off disk.
const asTask = (t: object): Task => t as unknown as Task;

const withEnabled = (enabled: unknown): Task =>
  asTask({ ...canonical(), system: { key: "test-daily-digest", enabled } });

function collisionVariants(): Task[][] {
  return [
    [ordinary("system:other")], // ordinary record under a reserved id
    [ordinary("system:test-daily-digest")], // ordinary record under the canonical id
    [canonical({ system: { key: "test-evening-digest", enabled: true } })], // wrong-key metadata
    [asTask({ ...canonical(), id: "system:unknown-task", system: { key: "unknown-task", enabled: true } })], // unknown system:* id
    [canonical(), ordinary("o1", { system: { key: "test-daily-digest", enabled: true } })], // mixed ordinary/system duplicate set
  ];
}

// --- cronCatchUpAnchor: each definition's OWN cron, same-day-or-next rule ----

test("cronCatchUpAnchor: daily 08:00 -- before 08:00 anchors today 08:00; at/after anchors today's (due)", () => {
  assert.equal(cronCatchUpAnchor("0 8 * * *", BEFORE_0800, TZ), TODAY_0800); // future
  assert.equal(cronCatchUpAnchor("0 8 * * *", AFTER_0800, TZ), TODAY_0800); // already due
  assert.ok(Date.parse(cronCatchUpAnchor("0 8 * * *", AFTER_0800, TZ)) <= AFTER_0800.getTime());
  // The exact-instant case: cron-parser v4 resolves the 08:00:00.000 landing to
  // today's occurrence (due now); only before/after are spec-mandated, this pins
  // the observed engine behavior so a silent drift would surface here.
  assert.equal(cronCatchUpAnchor("0 8 * * *", new Date("2026-08-20T15:00:00.000Z"), TZ), TODAY_0800);
});

test("cronCatchUpAnchor: a different daily time anchors at ITS own time, never 08:00", () => {
  // 13:00 PDT: before 18:30 -> today's 18:30 (future).
  assert.equal(cronCatchUpAnchor("30 18 * * *", new Date("2026-08-20T20:00:00Z"), TZ), TODAY_1830);
  // 19:00 PDT Aug 20: after 18:30 -> today's already-passed 18:30 (due now).
  const after = new Date("2026-08-21T02:00:00Z");
  const anchor = cronCatchUpAnchor("30 18 * * *", after, TZ);
  assert.equal(anchor, TODAY_1830);
  assert.ok(Date.parse(anchor) <= after.getTime());
});

test("selectWindowOccurrence always uses a cron-eligible civil date before sampling", () => {
  const mondayOnly = { ...MORNING, cron: "0 8 * * 1" };
  for (const [now, futureOnly, expected] of [
    [new Date("2026-08-19T16:00:00Z"), false, "2026-08-24T15:59:00.000Z"], // creation/repair on Wednesday
    [new Date("2026-08-19T16:00:00Z"), true, "2026-08-24T15:59:00.000Z"], // enable/advance
    [new Date("2026-08-24T20:00:00Z"), false, "2026-08-31T15:59:00.000Z"], // cutoff/expiry on Monday
  ] as const) {
    let calls = 0;
    const selected = selectWindowOccurrence(mondayOnly, now, TZ, () => { calls++; return 59; }, futureOnly);
    assert.equal(selected, expected);
    assert.equal(calls, 1, "the selector is consumed once after choosing the eligible date");
  }
});

test("validWindowOccurrence is the exported ranged-occurrence authority", () => {
  const selected = ordinary("system:morning-check-in", {
    desc: MORNING.desc, cron: MORNING.cron, at: null,
    next_run_at: "2026-08-20T15:12:00.000Z", system: { key: "morning-check-in", enabled: true },
  });
  assert.equal(validWindowOccurrence(selected, MORNING, TZ), true);
  assert.equal(validWindowOccurrence({ ...selected, next_run_at: "2026-08-20T15:12:01.000Z" }, MORNING, TZ), false);
});

test("ranged validity rejects an otherwise in-window occurrence on an off-cron date", () => {
  const mondayOnly = { ...MORNING, cron: "0 8 * * 1" };
  const offCron = ordinary("system:morning-check-in", { desc: mondayOnly.desc, cron: mondayOnly.cron, at: null, next_run_at: "2026-08-19T15:12:00.000Z", system: { key: "morning-check-in", enabled: true } });
  let calls = 0;
  const out = reconcileSystemTasks([offCron], [mondayOnly], new Date("2026-08-19T16:00:00Z"), TZ, noop, () => { calls++; return 0; });
  assert.equal(out.tasks[0]!.next_run_at, "2026-08-24T15:00:00.000Z");
  assert.equal(calls, 1);
});

test("cronCatchUpAnchor: weekly cron -- mid-week anchors NEXT Monday, Monday-after anchors today's (due)", () => {
  // Wednesday 2026-08-19, 09:00 PDT -> next Monday's 08:00.
  assert.equal(cronCatchUpAnchor("0 8 * * 1", new Date("2026-08-19T16:00:00Z"), TZ), NEXT_MONDAY_0800);
  // Monday 2026-08-24, 09:00 PDT -> today's already-passed Monday 08:00 (due now).
  const anchor = cronCatchUpAnchor("0 8 * * 1", new Date("2026-08-24T16:00:00Z"), TZ);
  assert.equal(anchor, NEXT_MONDAY_0800);
  assert.ok(Date.parse(anchor) <= new Date("2026-08-24T16:00:00Z").getTime());
});

// --- validateReservedNamespace: fail-closed, enabled shape never a collision --

test("validateReservedNamespace: every collision variant throws ReservedIdCollisionError", () => {
  for (const tasks of collisionVariants()) {
    assert.throws(() => validateReservedNamespace(tasks, DIGEST_REGISTRY), ReservedIdCollisionError);
  }
});

test("validateReservedNamespace: the error carries the colliding ids and an operator repair instruction", () => {
  try {
    validateReservedNamespace([ordinary("system:other"), canonical()], DIGEST_REGISTRY);
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof ReservedIdCollisionError);
    assert.deepEqual(err.ids, ["system:other"]);
    assert.match(err.message, /system:other/);
    assert.match(err.message, /cancel/i); // the repair instruction names the way out
    assert.match(err.message, /never/i); // ...and states the runtime will not do it itself
  }
});

test("validateReservedNamespace: enabled presence/type is never a collision; healthy stores pass", () => {
  for (const t of [withEnabled("true"), withEnabled("false"), withEnabled(1), withEnabled(null)]) {
    validateReservedNamespace([t], DIGEST_REGISTRY); // must not throw
  }
  validateReservedNamespace([canonical(), ordinary("fine")], DIGEST_REGISTRY);
  validateReservedNamespace([], DIGEST_REGISTRY);
});

test("validateReservedNamespace preserves accessor-backed system read semantics", () => {
  const task = canonical();
  let systemReads = 0;
  Object.defineProperty(task, "system", {
    enumerable: true,
    configurable: true,
    get() {
      systemReads++;
      return {
        key: systemReads === 1 ? "test-daily-digest" : "wrong-key",
        enabled: true,
      };
    },
  });

  assert.throws(() => validateReservedNamespace([task], DIGEST_REGISTRY), ReservedIdCollisionError);
  assert.equal(systemReads, 4, "the null guard, key comparison, and collision diagnostic perform the original reads");
});

// --- refuseOnCollision: the shared in-lock guard for id-based mutations ------

test("refuseOnCollision excludeId: passes when the ONLY collision is the excluded record itself", () => {
  // The exact repair precondition: one unambiguous ordinary record under a
  // reserved id. Full validation necessarily rejects the store; validating
  // as-if it were removed is what makes schedule-cli cancel's repair reachable.
  const tasks = [ordinary("system:other"), canonical()];
  refuseOnCollision(tasks, DIGEST_REGISTRY, { excludeId: "system:other" }); // no throw
  assert.throws(() => refuseOnCollision(tasks, DIGEST_REGISTRY), ReservedIdCollisionError); // no exclusion -> still refuses
  assert.throws(() => refuseOnCollision(tasks, DIGEST_REGISTRY, { excludeId: "unrelated" }), ReservedIdCollisionError);
});

test("refuseOnCollision excludeId: still throws when another collision remains", () => {
  const tasks = [ordinary("system:other"), ordinary("system:more"), canonical()];
  assert.throws(
    () => refuseOnCollision(tasks, DIGEST_REGISTRY, { excludeId: "system:other" }),
    ReservedIdCollisionError,
  );
});

test("refuseOnCollision mutatedId: refuses a duplicated id loudly, passes a unique one", () => {
  const tasks = [ordinary("dup", { next_run_at: TODAY_0800 }), ordinary("dup"), canonical()];
  // The queue helpers mutate EVERY record sharing an id, so ambiguity must
  // refuse rather than multi-mutate.
  assert.throws(() => refuseOnCollision(tasks, DIGEST_REGISTRY, { mutatedId: "dup" }), /dup.*ambiguous|ambiguous.*dup/i);
  // The ambiguity refusal is its own typed error (per-record recoverable, like
  // ReservedIdCollisionError) so catch sites can rethrow everything else.
  try {
    refuseOnCollision(tasks, DIGEST_REGISTRY, { mutatedId: "dup" });
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof AmbiguousIdError, `AmbiguousIdError, got ${String(err)}`);
    assert.equal(err.name, "AmbiguousIdError");
    assert.match(err.message, /ambiguous/); // the message is the refusal's own words
  }
  refuseOnCollision([ordinary("dup"), canonical()], DIGEST_REGISTRY, { mutatedId: "dup" }); // unique -> passes
  refuseOnCollision([ordinary("dup"), canonical()], DIGEST_REGISTRY, { mutatedId: "system:test-daily-digest" });
  // A reserved-namespace violation anywhere still refuses, even for a valid mutatedId.
  assert.throws(
    () => refuseOnCollision([ordinary("dup"), ordinary("system:bad")], DIGEST_REGISTRY, { mutatedId: "dup" }),
    ReservedIdCollisionError,
  );
});

// --- reconcileSystemTasks: creation, anchors, and the cron-gate --------------

test("reconcile creates a missing definition once, anchored at its own cron (before/after 08:00)", () => {
  const before = reconcileSystemTasks([], DIGEST_REGISTRY, BEFORE_0800, TZ, noop);
  assert.equal(before.changed, true);
  assert.equal(before.tasks.length, 1);
  const rec = before.tasks[0];
  assert.equal(rec.id, "system:test-daily-digest");
  assert.equal(rec.system?.key, "test-daily-digest");
  assert.equal(rec.system?.enabled, true);
  assert.equal(rec.desc, "Here’s what’s on the calendar");
  assert.equal(rec.cron, "0 8 * * *");
  assert.equal(rec.at, null);
  assert.equal(rec.tz, TZ);
  assert.equal(rec.deliver, null);
  assert.equal(rec.task, undefined); // no task prompt
  assert.equal(rec.next_run_at, TODAY_0800); // future occurrence today
  assert.equal(rec.invisible_until, null);
  assert.equal(rec.attempts, 0);
  assert.equal(rec.created_at, BEFORE_0800.toISOString());

  const after = reconcileSystemTasks([], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.equal(after.tasks[0].next_run_at, TODAY_0800); // already passed -> due now
  assert.ok(Date.parse(after.tasks[0].next_run_at!) <= AFTER_0800.getTime());
});

test("reconcile is idempotent: a second no-change run returns changed:false with the SAME references", () => {
  const first = reconcileSystemTasks([], DIGEST_REGISTRY, BEFORE_0800, TZ, noop);
  const second = reconcileSystemTasks(first.tasks, DIGEST_REGISTRY, BEFORE_0800, TZ, noop);
  assert.equal(second.changed, false);
  assert.equal(second.tasks, first.tasks); // same array
  assert.equal(second.tasks[0], first.tasks[0]); // same record objects -> store skips the rewrite
  // A healthy pre-existing store is equally a no-op.
  const healthy = [canonical(), ordinary("keepme")];
  const r = reconcileSystemTasks(healthy, DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.equal(r.changed, false);
  assert.equal(r.tasks, healthy);
  assert.equal(r.tasks[0], healthy[0]);
  assert.equal(r.tasks[1], healthy[1]);
});

test("a second registry definition anchors at ITS OWN cron, never the digest's 08:00", () => {
  const registry: readonly SystemTaskDefinition<string>[] = [digestDef, eveningDef];
  // Created at 13:00 PDT (before 18:30): digest -> today 08:00, evening -> today 18:30.
  const r = reconcileSystemTasks([], registry, new Date("2026-08-20T20:00:00Z"), TZ, noop);
  const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
  assert.equal(byId["system:test-daily-digest"].next_run_at, TODAY_0800);
  assert.equal(byId["system:test-evening-digest"].next_run_at, TODAY_1830);
  // Created after 18:30 local: the evening record is already due.
  const r2 = reconcileSystemTasks([], registry, new Date("2026-08-21T02:00:00Z"), TZ, noop);
  const evening2 = r2.tasks.find((t) => t.id === "system:test-evening-digest")!;
  assert.equal(evening2.next_run_at, TODAY_1830);
  assert.ok(Date.parse(evening2.next_run_at!) <= Date.parse("2026-08-21T02:00:00Z"));
});

test("a weekly registry definition anchors by the same rule (no daily-only gate)", () => {
  // Wednesday mid-week -> next Monday 08:00.
  const midweek = reconcileSystemTasks([], [weeklyDef], new Date("2026-08-19T16:00:00Z"), TZ, noop);
  assert.equal(midweek.tasks[0].next_run_at, NEXT_MONDAY_0800);
  // Monday after 08:00 -> today's already-passed Monday 08:00 (due now).
  const monday = reconcileSystemTasks([], [weeklyDef], new Date("2026-08-24T16:00:00Z"), TZ, noop);
  assert.equal(monday.tasks[0].next_run_at, NEXT_MONDAY_0800);
  assert.ok(Date.parse(monday.tasks[0].next_run_at!) <= Date.parse("2026-08-24T16:00:00Z"));
});

test("an invalid next_run_at is repaired via the definition's OWN cron anchor", () => {
  const digestRepaired = reconcileSystemTasks(
    [canonical({ next_run_at: "junk" })],
    DIGEST_REGISTRY,
    BEFORE_0800,
    TZ,
    noop,
  );
  assert.equal(digestRepaired.tasks[0].next_run_at, TODAY_0800); // digest -> 08:00 anchor
  assert.equal(digestRepaired.changed, true);
  // The evening fake repairs onto 18:30, not 08:00 -- the anchor follows the
  // definition's own cron, never a hardcoded time.
  const evening = canonical({
    id: "system:test-evening-digest",
    cron: "30 18 * * *",
    next_run_at: "junk",
    system: { key: "test-evening-digest", enabled: true },
  });
  const r = reconcileSystemTasks([evening], [eveningDef], new Date("2026-08-20T20:00:00Z"), TZ, noop);
  assert.equal(r.tasks[0].next_run_at, TODAY_1830);
});

test("a malformed registry cron throws loudly at the gate, before any mutation (nothing written)", async () => {
  const junkDef: SystemTaskDefinition<"test-junk-cron"> = {
    key: "test-junk-cron",
    desc: "junk",
    cron: "not a cron",
    execute: async () => ({ ok: true }),
  };
  // Pure call: the cron-parser parse error propagates before any record logic.
  assert.throws(() => reconcileSystemTasks([canonical()], [junkDef], AFTER_0800, TZ, noop), /Invalid characters/);
  // Through the store: the transaction aborts and schedule.json is byte-identical.
  const dir = mkdtempSync(pjoin(tmpdir(), "sysrec-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const seed = JSON.stringify([canonical()], null, 2);
  writeFileSync(pjoin(dir, "schedule.json"), seed);
  await assert.rejects(
    mutate((tasks) => {
      const r = reconcileSystemTasks(tasks, [junkDef], AFTER_0800, TZ, noop);
      return { tasks: r.tasks, value: r };
    }),
    /Invalid characters/,
  );
  assert.equal(readFileSync(pjoin(dir, "schedule.json"), "utf8"), seed);
});

// --- reconcile: enabled normalization and unknown-key force-disable ----------

test("a non-boolean system.enabled is repaired to literal false, logged, persisted -- never a collision", async () => {
  for (const bad of ["true", "false", 1, null, undefined]) {
    const logs: string[] = [];
    const tasks = bad === undefined
      ? [asTask({ ...canonical(), system: { key: "test-daily-digest" } })]
      : [withEnabled(bad)];
    const r = reconcileSystemTasks(tasks, DIGEST_REGISTRY, AFTER_0800, TZ, (m) => logs.push(m));
    assert.equal(r.changed, true);
    assert.equal(r.tasks[0].system?.key, "test-daily-digest");
    assert.strictEqual(r.tasks[0].system?.enabled, false); // literal boolean
    assert.ok(logs.some((m) => m.includes("enabled") && m.includes("system:test-daily-digest")), `repair logged for ${String(bad)}`);
  }
  // Persisted through the store as the literal boolean.
  const dir = mkdtempSync(pjoin(tmpdir(), "sysrec-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  writeFileSync(pjoin(dir, "schedule.json"), JSON.stringify([withEnabled("true")]));
  await mutate((tasks) => {
    const r = reconcileSystemTasks(tasks, DIGEST_REGISTRY, AFTER_0800, TZ, noop);
    return { tasks: r.tasks, value: null };
  });
  const persisted = JSON.parse(readFileSync(pjoin(dir, "schedule.json"), "utf8")) as Task[];
  assert.strictEqual(persisted[0].system?.enabled, false);
  assert.equal(typeof persisted[0].system?.enabled, "boolean");
});

test("a disabled record is never re-enabled; a literal true is preserved untouched", () => {
  const disabled = reconcileSystemTasks([canonical({ system: { key: "test-daily-digest", enabled: false } })], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.strictEqual(disabled.tasks[0].system?.enabled, false);
  assert.equal(disabled.changed, false); // nothing to do
  const enabled = reconcileSystemTasks([canonical()], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.strictEqual(enabled.tasks[0].system?.enabled, true);
  assert.equal(enabled.changed, false);
});

test("an unknown system.key on a NON-reserved id is force-disabled, logged, and kept visible", () => {
  const logs: string[] = [];
  const t = asTask({ ...ordinary("mystery-holder", { next_run_at: TODAY_0800 }), system: { key: "mystery", enabled: true } });
  const r = reconcileSystemTasks([t, canonical()], DIGEST_REGISTRY, AFTER_0800, TZ, (m) => logs.push(m));
  assert.equal(r.changed, true);
  const kept = r.tasks.find((x) => x.id === "mystery-holder")!;
  assert.ok(kept, "the record is never deleted");
  assert.strictEqual(kept.system?.enabled, false); // literal false
  assert.equal(kept.next_run_at, TODAY_0800); // kept visible: no queue surgery
  assert.ok(logs.some((m) => m.includes("mystery") && m.includes("mystery-holder")), "log names key and id");
  // Idempotent: a second run over the repaired output changes nothing (no per-tick log spam).
  const logs2: string[] = [];
  const again = reconcileSystemTasks(r.tasks, DIGEST_REGISTRY, AFTER_0800, TZ, (m) => logs2.push(m));
  assert.equal(again.changed, false);
  assert.equal(logs2.length, 0);
});

test("reconcile preserves a canonical trigger but removes unknown or malformed trigger records before heartbeat can select them", () => {
  const valid = asTask({
    id: "feedbeef",
    desc: "Here’s what’s on the calendar",
    cron: null,
    at: AFTER_0800.toISOString(),
    tz: null,
    next_run_at: AFTER_0800.toISOString(),
    invisible_until: null,
    attempts: 0,
    deliver: null,
    system_trigger: { key: "test-daily-digest" },
    created_at: AFTER_0800.toISOString(),
  });
  const unknown = asTask({ ...valid, id: "bad0bad0", system_trigger: { key: "not-registered" } });
  const promptBearing = asTask({ ...valid, id: "bad1bad1", task: "arbitrary prompt" });
  const recurring = asTask({ ...valid, id: "bad2bad2", cron: "* * * * *" });
  const extraMetadata = asTask({ ...valid, id: "bad3bad3", system_trigger: { key: "test-daily-digest", command: "arbitrary" } });
  const logs: string[] = [];
  const input = [canonical(), valid, unknown, promptBearing, recurring, extraMetadata];
  const r = reconcileSystemTasks(input, DIGEST_REGISTRY, AFTER_0800, TZ, (line) => logs.push(line));
  assert.equal(r.changed, true);
  assert.deepEqual(r.tasks.map((task) => task.id), ["system:test-daily-digest", "feedbeef"]);
  assert.equal(r.tasks[1], valid, "a well-formed trigger and its retry/claim state are untouched");
  for (const id of ["bad0bad0", "bad1bad1", "bad2bad2", "bad3bad3"]) {
    assert.ok(logs.some((line) => line.includes(id) && line.includes("removed")), `removal logged for ${id}`);
  }
  const again = reconcileSystemTasks(r.tasks, DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.equal(again.changed, false);
  assert.equal(again.tasks, r.tasks);
});

test("a trigger-shaped field on a canonical reserved record is stripped without changing canonical queue state", () => {
  const base = canonical({ invisible_until: "2026-08-20T20:00:00.000Z", attempts: 2 });
  const polluted = asTask({ ...base, system_trigger: { key: "test-daily-digest" } });
  const r = reconcileSystemTasks([polluted], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.equal(r.changed, true);
  assert.deepEqual(r.tasks[0], base);
});

// --- reconcile: registry-owned field restoration preserves queue progress ----

test("hand-edited registry-owned fields are restored; at -> null survives a completed occurrence", () => {
  const handEdited = canonical({
    desc: "hand edited",
    task: "sneaky prompt",
    deliver: { surface: "sms", target: "+15551234567" },
    at: "2026-08-19T15:00:00.000Z", // a hand-edited PAST at
    next_run_at: TODAY_0800,
    invisible_until: "2026-08-20T16:30:00.000Z",
    attempts: 1,
  });
  const r = reconcileSystemTasks([handEdited], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.equal(r.changed, true);
  const rec = r.tasks[0];
  assert.equal(rec.desc, "Here’s what’s on the calendar");
  assert.equal(rec.task, undefined);
  assert.deepEqual(rec.deliver, null);
  assert.equal(rec.at, null); // restored -- resolveNextRun would re-anchor to it otherwise
  assert.equal(rec.next_run_at, TODAY_0800); // VALID queue progress preserved
  assert.equal(rec.invisible_until, "2026-08-20T16:30:00.000Z");
  assert.equal(rec.attempts, 1);
  // The load-bearing consequence: after reconcile, a completed occurrence
  // advances to the NEXT cron occurrence, never back to the past `at`.
  const after = applyOnSuccess(r.tasks, "system:test-daily-digest", AFTER_0800.getTime(), TZ);
  assert.equal(after[0].next_run_at, TOMORROW_0800);
  assert.notEqual(after[0].next_run_at, "2026-08-19T15:00:00.000Z");
});

test("hand-DELETED at/deliver are restored to the literal-null persisted shape, idempotently", () => {
  // A hand edit can DELETE the registry-owned fields rather than set them: the
  // record rides in with at/deliver absent (undefined), but the canonical
  // persisted shape (spec design section 2) carries the literal null and the
  // restore is unconditional -- reconcile must re-materialize both, never
  // leave the fields undefined.
  const { at: _goneAt, deliver: _goneDeliver, ...handDeleted } = canonical();
  const r = reconcileSystemTasks([asTask(handDeleted)], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.equal(r.changed, true);
  const rec = r.tasks[0];
  assert.strictEqual(rec.at, null); // strictEqual: undefined fails here
  assert.strictEqual(rec.deliver, null);
  // The repaired record is itself canonical: a second run is a no-op -- no
  // repair churn, same references, the store skips the rewrite.
  const again = reconcileSystemTasks(r.tasks, DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.equal(again.changed, false);
  assert.equal(again.tasks, r.tasks);
  assert.equal(again.tasks[0], rec);
});

test("a cron or tz change clears claim/retry state and recomputes strictly after now", () => {
  const now = AFTER_0800; // 09:00 PDT Thursday
  const expected = TOMORROW_0800; // the next 08:00 strictly after now
  assert.equal(resolveNextRun({ cron: "0 8 * * *", tz: TZ }, now.getTime(), TZ), expected);
  const cronChanged = reconcileSystemTasks(
    [canonical({ cron: "0 9 * * *", invisible_until: "2026-08-20T16:30:00.000Z", attempts: 2 })],
    DIGEST_REGISTRY,
    now,
    TZ,
    noop,
  );
  const c = cronChanged.tasks[0];
  assert.equal(c.cron, "0 8 * * *"); // registry-owned field restored
  assert.equal(c.next_run_at, expected);
  assert.equal(c.invisible_until, null);
  assert.equal(c.attempts, 0);
  const tzChanged = reconcileSystemTasks(
    [canonical({ tz: "America/New_York", invisible_until: "2026-08-20T16:30:00.000Z", attempts: 2 })],
    DIGEST_REGISTRY,
    now,
    TZ,
    noop,
  );
  const z = tzChanged.tasks[0];
  assert.equal(z.tz, TZ);
  assert.equal(z.next_run_at, expected);
  assert.equal(z.invisible_until, null);
  assert.equal(z.attempts, 0);
});

// --- reconcile: duplicate collapse (validation proved them all system records) --

test("duplicate system records collapse disabled-wins, onto the deterministic survivor's queue fields", () => {
  const a = canonical({ created_at: "2026-08-01T00:00:00.000Z", next_run_at: "2026-08-21T15:00:00.000Z", invisible_until: "2026-08-21T15:30:00.000Z", attempts: 3 });
  const b = canonical({ created_at: "2026-08-02T00:00:00.000Z", next_run_at: "2026-08-22T15:00:00.000Z", invisible_until: null, attempts: 0 });
  const r = reconcileSystemTasks([b, a], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.equal(r.changed, true);
  const sys = r.tasks.filter((t) => t.id === "system:test-daily-digest");
  assert.equal(sys.length, 1, "exactly one canonical record remains");
  const survivor = sys[0];
  // Survivor = earliest created_at (A); the survivor's queue fields persist.
  assert.equal(survivor.next_run_at, "2026-08-21T15:00:00.000Z");
  assert.equal(survivor.invisible_until, "2026-08-21T15:30:00.000Z");
  assert.equal(survivor.attempts, 3);
  assert.equal(survivor.created_at, "2026-08-01T00:00:00.000Z");
  assert.equal(survivor.system?.enabled, true); // all members literal true -> true
  // Equal created_at -> deterministic: the first array member survives.
  const c1 = canonical({ created_at: "2026-08-01T00:00:00.000Z", next_run_at: "2026-08-23T15:00:00.000Z", attempts: 7 });
  const c2 = canonical({ created_at: "2026-08-01T00:00:00.000Z", next_run_at: "2026-08-24T15:00:00.000Z", attempts: 9 });
  const tie = reconcileSystemTasks([c1, c2], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  const tied = tie.tasks.filter((t) => t.id === "system:test-daily-digest")[0];
  assert.equal(tied.next_run_at, "2026-08-23T15:00:00.000Z");
  assert.equal(tied.attempts, 7);
});

test("duplicate canonical reconciliation preserves feature-shaped evidence regardless of clean/feature ordering", () => {
  for (const [featureKind, featureFields] of [
    ["malformed follow_up", { follow_up: { version: 99 } as never }],
    ["unknown delivery", { deliver: { surface: "future-provider", target: "x" } as never }],
    ["trigger plus malformed follow_up", { system_trigger: { key: "test-daily-digest" }, follow_up: { version: 99 } as never }],
  ] as const) {
    for (const featureFirst of [false, true]) {
      const clean = canonical();
      const feature = canonical({ ...featureFields });
      const input = featureFirst ? [feature, clean] : [clean, feature];
      const out = reconcileSystemTasks(input, DIGEST_REGISTRY, AFTER_0800, TZ, noop);
      const members = out.tasks.filter((task) => task.id === "system:test-daily-digest" || task.system?.key === "test-daily-digest");
      assert.equal(members.length, 1, `${featureKind}: duplicate set still collapses to one classifiable record`);
      assert.equal(isFeatureShapedTask(members[0]), true, `${featureKind}: evidence survives ${featureFirst ? "feature/clean" : "clean/feature"} ordering`);
      if (Object.prototype.hasOwnProperty.call(featureFields, "follow_up")) {
        assert.deepEqual(members[0].follow_up, feature.follow_up, "malformed feature metadata is not normalized or deleted before heartbeat classification");
      } else {
        assert.deepEqual(members[0].deliver, feature.deliver, "unknown delivery evidence is not normalized or deleted before heartbeat classification");
      }
    }
  }
});

test("duplicate canonical reconciliation refuses multiple feature-shaped members rather than erase one", () => {
  const one = canonical({ follow_up: { version: 99 } as never });
  const two = canonical({ deliver: { surface: "future-provider", target: "x" } as never });
  assert.throws(
    () => reconcileSystemTasks([one, two], DIGEST_REGISTRY, AFTER_0800, TZ, noop),
    /multiple feature-shaped duplicate|operator repair/i,
  );
});

test("collapse disabled-wins on false, malformed, and missing enabled members", () => {
  const mk = (enabled: unknown, at: string) =>
    enabled === undefined
      ? asTask({ ...canonical({ created_at: at }), system: { key: "test-daily-digest" } })
      : asTask({ ...canonical({ created_at: at }), system: { key: "test-daily-digest", enabled } });
  for (const bad of [false, "true", 1, null, undefined]) {
    const r = reconcileSystemTasks([mk(true, "2026-08-01T00:00:00.000Z"), mk(bad, "2026-08-02T00:00:00.000Z")], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
    const survivor = r.tasks.find((t) => t.id === "system:test-daily-digest")!;
    assert.strictEqual(survivor.system?.enabled, false, `disabled wins when a member is ${String(bad)}`);
  }
  // Both literal true -> stays enabled.
  const bothTrue = reconcileSystemTasks([mk(true, "2026-08-01T00:00:00.000Z"), mk(true, "2026-08-02T00:00:00.000Z")], DIGEST_REGISTRY, AFTER_0800, TZ, noop);
  assert.strictEqual(bothTrue.tasks.find((t) => t.id === "system:test-daily-digest")!.system?.enabled, true);
});

// --- reconcile: scale and fail-closed integration through the store ----------

test("100 ordinary tasks do not block canonical creation; ordinary records pass through untouched", () => {
  const tasks = Array.from({ length: 100 }, (_, i) => ordinary(`o${i}`));
  const r = reconcileSystemTasks(tasks, DIGEST_REGISTRY, BEFORE_0800, TZ, noop);
  assert.equal(r.changed, true);
  assert.equal(r.tasks.length, 101);
  assert.equal(r.tasks.filter((t) => t.id.startsWith("system:")).length, 1);
  for (let i = 0; i < 100; i++) {
    assert.equal(r.tasks.find((t) => t.id === `o${i}`), tasks[i], "same object reference preserved");
  }
});

test("a reserved-ID collision propagates out of mutate with nothing written (byte-for-byte)", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sysrec-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const seed = JSON.stringify([ordinary("system:other"), ordinary("keepme")], null, 2);
  writeFileSync(pjoin(dir, "schedule.json"), seed);
  await assert.rejects(
    mutate((tasks) => {
      const r = reconcileSystemTasks(tasks, DIGEST_REGISTRY, AFTER_0800, TZ, noop);
      return { tasks: r.tasks, value: r };
    }),
    ReservedIdCollisionError,
  );
  assert.equal(readFileSync(pjoin(dir, "schedule.json"), "utf8"), seed);
});

test("the collision variants each refuse through reconcile with the original tasks untouched", () => {
  for (const tasks of collisionVariants()) {
    assert.throws(() => reconcileSystemTasks(tasks, DIGEST_REGISTRY, AFTER_0800, TZ, noop), ReservedIdCollisionError);
  }
});


test("morning range persists one selected local minute and catches up only before noon", () => {
  let calls = 0;
  const select = () => { calls++; return 59; };
  assert.equal(selectWindowOccurrence(MORNING, new Date("2026-08-20T14:00:00Z"), TZ, select), "2026-08-20T15:59:00.000Z");
  assert.equal(calls, 1);
  // A creation after noon selects tomorrow, while a stored same-day occurrence
  // is expired by reconciliation at the cutoff.
  const created = selectWindowOccurrence(MORNING, new Date("2026-08-20T19:00:00Z"), TZ, () => 0);
  assert.equal(created, "2026-08-21T15:00:00.000Z");
  const record = ordinary("system:morning-check-in", { desc: MORNING.desc, cron: MORNING.cron, at: null, next_run_at: "2026-08-20T15:00:00.000Z", system: { key: "morning-check-in", enabled: true } });
  const expired = reconcileSystemTasks([record], [MORNING], new Date("2026-08-20T19:00:00Z"), TZ, noop, () => 0);
  assert.equal(expired.tasks[0]!.next_run_at, "2026-08-21T15:00:00.000Z");
  assert.equal(expired.tasks[0]!.attempts, 0);
});

test("enabling a morning range chooses tomorrow once after today's window", () => {
  let calls = 0;
  const selected = selectWindowOccurrence(MORNING, new Date("2026-08-20T15:30:00Z"), TZ, () => { calls++; return 12; }, true);
  assert.equal(selected, "2026-08-21T15:12:00.000Z");
  assert.equal(calls, 1, "advancement must select a civil date before sampling its slot");
});

test("retirement deletes only exact legacy canonical pairs and remains fail closed", () => {
  const retired = ordinary("system:daily-calendar-digest", { system: { key: "daily-calendar-digest", enabled: false } });
  const out = reconcileSystemTasks([retired], [MORNING], BEFORE_0800, TZ, noop, () => 0);
  assert.deepEqual(out.tasks.map((t) => t.id), ["system:morning-check-in"]);
  const collision = ordinary("ordinary", { system: { key: "daily-calendar-digest", enabled: true } });
  assert.throws(() => reconcileSystemTasks([collision], [MORNING], BEFORE_0800, TZ, noop), ReservedIdCollisionError);
});

// Matrix rows 12--14, 16--17, and 20--26: the range remains a persisted queue
// value, not a tick-local random choice.  These use the real reconciler rather
// than a hand-written policy model so the transaction seam stays covered.
test("ranged selector endpoints are local whole minutes and invalid selectors refuse", () => {
  for (const [slot, minute] of [[0, "00"], [59, "59"]] as const) {
    const selected = selectWindowOccurrence(MORNING, BEFORE_0800, TZ, () => slot);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(selected));
    assert.equal(local, `08:${minute}:00`);
    assert.equal(new Date(selected).getUTCMilliseconds(), 0);
  }
  assert.throws(() => selectWindowOccurrence(MORNING, BEFORE_0800, TZ, () => 60), /invalid minute slot/);
  assert.throws(() => selectWindowOccurrence(MORNING, BEFORE_0800, TZ, () => -1), /invalid minute slot/);
});

test("creation, restart, claim-shaped state, retry, cap and token invisibility preserve one persisted selection", () => {
  let calls = 0;
  const selected = reconcileSystemTasks([], [MORNING], BEFORE_0800, TZ, noop, () => { calls++; return 12; }).tasks[0]!;
  assert.equal(calls, 1);
  const queued = { ...selected, invisible_until: "2026-08-20T16:30:00.000Z", attempts: 2 };
  for (const now of [new Date("2026-08-20T15:05:00Z"), new Date("2026-08-20T18:59:00Z")]) {
    const out = reconcileSystemTasks([queued], [MORNING], now, TZ, noop, () => { calls++; return 33; });
    assert.strictEqual(out.tasks[0], queued);
    assert.equal(out.changed, false);
  }
  assert.equal(calls, 1, "no restart/claim/retry/deferral state reselects");
});

test("ranged creation and expiry cover before-08, window, catch-up, exact noon, after noon, and stale dates", () => {
  const dates: Array<[Date, string]> = [
    [BEFORE_0800, "2026-08-20T15:00:00.000Z"],
    [new Date("2026-08-20T15:30:00Z"), "2026-08-20T15:00:00.000Z"],
    [new Date("2026-08-20T16:00:00Z"), "2026-08-20T15:00:00.000Z"],
    [new Date("2026-08-20T19:00:00Z"), "2026-08-21T15:00:00.000Z"],
  ];
  for (const [now, expected] of dates) assert.equal(selectWindowOccurrence(MORNING, now, TZ, () => 0), expected);
  const due = ordinary("system:morning-check-in", { desc: MORNING.desc, cron: MORNING.cron, at: null, next_run_at: TODAY_0800, invisible_until: "x", attempts: 2, system: { key: "morning-check-in", enabled: true, policy: "v1:0 8 * * *:8:60:12" } });
  const logs: string[] = [];
  const expired = reconcileSystemTasks([due], [MORNING], new Date("2026-08-20T19:00:00Z"), TZ, (m) => logs.push(m), () => 1).tasks[0]!;
  assert.equal(expired.next_run_at, "2026-08-21T15:01:00.000Z"); assert.equal(expired.invisible_until, null); assert.equal(expired.attempts, 0);
  assert.ok(logs.every((m) => !m.includes(due.desc!)) && logs.some((m) => m.includes("expired occurrence")));
  const stale = reconcileSystemTasks([{ ...due, next_run_at: "2026-08-19T15:00:00.000Z" }], [MORNING], BEFORE_0800, TZ, noop, () => 2).tasks[0]!;
  assert.equal(stale.next_run_at, "2026-08-20T15:02:00.000Z");
});

test("a changed ranged window policy repairs even a still-valid selected minute and clears queue state", () => {
  const current = reconcileSystemTasks([], [MORNING], BEFORE_0800, TZ, noop, () => 10).tasks[0]!;
  const changed: SystemTaskDefinition<string> = { ...MORNING, window: { startHour: 8, minuteSlots: 30, cutoffHour: 11 } };
  let selections = 0;
  const repaired = reconcileSystemTasks([{ ...current, invisible_until: "2026-08-20T17:00:00.000Z", attempts: 2 }], [changed], new Date("2026-08-20T16:00:00.000Z"), TZ, noop, () => { selections++; return 20; }).tasks[0]!;
  assert.equal(selections, 1); assert.equal(repaired.next_run_at, "2026-08-21T15:20:00.000Z"); assert.equal(repaired.invisible_until, null); assert.equal(repaired.attempts, 0);
  const unchanged = reconcileSystemTasks([repaired], [changed], new Date("2026-08-20T16:00:00.000Z"), TZ, noop, () => { selections++; return 1; });
  assert.equal(unchanged.changed, false); assert.strictEqual(unchanged.tasks[0], repaired); assert.equal(selections, 1);
});

test("range DST endpoints and definition/timezone repairs select once and clear queue state", () => {
  for (const now of [new Date("2026-03-08T16:00:00Z"), new Date("2026-11-01T17:00:00Z")]) {
    const selected = selectWindowOccurrence(MORNING, now, TZ, () => 59);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(selected));
    assert.equal(local, "08:59");
  }
  const bad = ordinary("system:morning-check-in", { desc: MORNING.desc, cron: MORNING.cron, at: null, next_run_at: "2026-08-20T14:00:30.000Z", invisible_until: "later", attempts: 2, system: { key: "morning-check-in", enabled: true } });
  let calls = 0;
  const repaired = reconcileSystemTasks([bad], [MORNING], BEFORE_0800, TZ, noop, () => { calls++; return 4; }).tasks[0]!;
  assert.equal(calls, 1); assert.equal(repaired.next_run_at, "2026-08-20T15:04:00.000Z"); assert.equal(repaired.invisible_until, null); assert.equal(repaired.attempts, 0);
  const tzRepair = reconcileSystemTasks([repaired], [MORNING], BEFORE_0800, "America/New_York", noop, () => { calls++; return 5; }).tasks[0]!;
  assert.equal(calls, 2); assert.equal(tzRepair.tz, "America/New_York"); assert.equal(tzRepair.attempts, 0);
});

test("DST cutoff uses each occurrence civil date at local noon and selects the next civil date", () => {
  const transitions = [
    { selected: "2026-03-08T15:00:00.000Z", before: "2026-03-08T18:59:59.999Z", noon: "2026-03-08T19:00:00.000Z", next: "2026-03-09T15:07:00.000Z" },
    { selected: "2026-11-01T16:00:00.000Z", before: "2026-11-01T19:59:59.999Z", noon: "2026-11-01T20:00:00.000Z", next: "2026-11-02T16:07:00.000Z" },
  ];
  for (const transition of transitions) {
    const rec = ordinary("system:morning-check-in", { desc: MORNING.desc, task: undefined, cron: MORNING.cron, at: null, next_run_at: transition.selected, system: { key: MORNING.key, enabled: true, policy: "v1:0 8 * * *:8:60:12" } });
    assert.equal(occurrenceExpired(rec, MORNING, new Date(transition.before), TZ), false);
    assert.equal(occurrenceExpired(rec, MORNING, new Date(transition.noon), TZ), true);
    const replacement = reconcileSystemTasks([rec], [MORNING], new Date(transition.noon), TZ, noop, () => 7).tasks[0]!;
    assert.equal(replacement.next_run_at, transition.next);
  }
});

test("empty store, all exact retired pairs and duplicate members migrate once; uncertain pairs do not write", () => {
  const retiredKeys = ["daily-calendar-digest", "friday-weekend-check-in", "monday-weekly-check-in"];
  const old = retiredKeys.flatMap((key) => [
    ordinary(`system:${key}`, { system: { key, enabled: false }, attempts: 3, invisible_until: "later" }),
    ordinary(`system:${key}`, { system: { key, enabled: true }, attempts: 9, invisible_until: "later" }),
  ]);
  let calls = 0;
  const migrated = reconcileSystemTasks(old, [MORNING], BEFORE_0800, TZ, noop, () => { calls++; return 7; });
  assert.deepEqual(migrated.tasks.map((t) => t.id), ["system:morning-check-in"]); assert.equal(migrated.tasks[0]!.system?.enabled, true); assert.equal(calls, 1);
  const bytes = JSON.stringify([ordinary("system:daily-calendar-digest")]);
  assert.throws(() => reconcileSystemTasks([ordinary("system:daily-calendar-digest")], [MORNING], BEFORE_0800, TZ, noop), ReservedIdCollisionError);
  assert.equal(JSON.stringify([ordinary("system:daily-calendar-digest")]), bytes);
  assert.throws(() => reconcileSystemTasks([ordinary("system:daily-calendar-digest", { system: { key: "friday-weekend-check-in", enabled: true } })], [MORNING], BEFORE_0800, TZ, noop), ReservedIdCollisionError);
});

test("retired trigger is removed before dispatch and post-migration reconciliation is byte/reference idempotent", () => {
  const trigger = ordinary("deadbeef", { desc: "Morning calendar and household check-in", cron: null, tz: null, at: BEFORE_0800.toISOString(), next_run_at: BEFORE_0800.toISOString(), system_trigger: { key: "daily-calendar-digest" } });
  let calls = 0;
  const first = reconcileSystemTasks([trigger], [MORNING], BEFORE_0800, TZ, noop, () => { calls++; return 8; });
  assert.deepEqual(first.tasks.map((t) => t.id), ["system:morning-check-in"]);
  const second = reconcileSystemTasks(first.tasks, [MORNING], BEFORE_0800, TZ, noop, () => { calls++; return 9; });
  assert.equal(second.changed, false); assert.strictEqual(second.tasks, first.tasks); assert.equal(calls, 1);
});

test("duplicate stale or missing ranged policy forces one queue normalization then is reference-idempotent", () => {
  const good = reconcileSystemTasks([], [MORNING], BEFORE_0800, TZ, noop, () => 10).tasks[0]!;
  for (const policy of [undefined, "v1:stale"] as const) {
    let selections = 0;
    const stale = { ...good, attempts: 2, invisible_until: "2026-08-20T18:00:00.000Z", system: { key: MORNING.key, enabled: true, ...(policy === undefined ? {} : { policy }) } };
    const repaired = reconcileSystemTasks([good, stale], [MORNING], AFTER_0800, TZ, noop, () => { selections++; return 21; });
    const rec = repaired.tasks[0]!;
    assert.equal(selections, 1); assert.equal(rec.attempts, 0); assert.equal(rec.invisible_until, null);
    assert.equal(rec.next_run_at, "2026-08-21T15:21:00.000Z");
    const second = reconcileSystemTasks([rec], [MORNING], AFTER_0800, TZ, noop, () => { selections++; return 22; });
    assert.equal(selections, 1); assert.equal(second.changed, false); assert.strictEqual(second.tasks[0], rec);
  }
});
