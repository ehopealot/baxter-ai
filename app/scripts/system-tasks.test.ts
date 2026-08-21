// Tests for the system-task registry module (system-scheduled-tasks plan, T3):
// canonical `system:` ids, the strict-boolean enabled predicate, member lookup
// against an INJECTED registry, and the DELIBERATE generic key parameter --
// tests construct fully-typed fake definitions under test-local keys with NO
// casts (the wide SystemTaskDefinition<string> consumer type accepts them),
// while SYSTEM_TASKS stays closed to the compile-time key union: a key outside
// SystemTaskKey may never enter the production registry, pinned with a
// ts-expect-error directive so a type that silently stopped rejecting it would fail
// `tsc --noEmit`. T11 registered the daily calendar digest as the registry's first
// real member (its handler's own tests live in daily-calendar-digest.test.ts); every
// consumer (T4/T5/T12) still takes the registry as an injectable parameter so these
// tests never depend on more than the registration metadata.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalSystemId,
  findSystemDef,
  SYSTEM_TASKS,
  systemTaskEnabled,
  type SystemTaskContext,
  type SystemTaskDefinition,
  type SystemTaskKey,
  type SystemTaskResult,
} from "./system-tasks.ts";
import type { Task } from "./schedule-store.ts";
import type { FireResult } from "./heartbeat.ts";

// A test-local key OUTSIDE the closed production union -- exactly what the
// generic K parameter exists for. This line typechecks with NO casts only
// because SystemTaskDefinition<K extends string = SystemTaskKey> accepts any
// string key at the definition site.
type TestKey = "test-evening-digest";

const testEveningDigest: SystemTaskDefinition<TestKey> = {
  key: "test-evening-digest",
  desc: "evening digest",
  cron: "30 18 * * *",
  execute: async (_task, ctx) => {
    ctx.log("ran");
    return { ok: true, agentRun: false };
  },
};

// A second fake under another test-local key: lookup must work over multi-key
// registries exactly as T4/T5/T12 will consume them.
const testWeeklyPing: SystemTaskDefinition<"test-weekly-ping"> = {
  key: "test-weekly-ping",
  desc: "weekly ping",
  cron: "0 8 * * 1",
  execute: async () => ({ ok: true }),
};

const TEST_REGISTRY: readonly SystemTaskDefinition<string>[] = [testEveningDigest, testWeeklyPing];

const baseTask = (id: string): Task => ({ id, cron: "0 8 * * *", next_run_at: "2026-08-20T15:00:00Z" });

// Persisted records are arbitrary JSON, so the strict-boolean predicate must
// treat malformed `enabled` values as disabled at RUNTIME regardless of the
// compile-time type. One localized `as unknown as Task` bridge stands in for
// exactly what readTasks() can hand the predicate off disk.
const withEnabled = (enabled: unknown): Task =>
  ({ ...baseTask("system:daily-calendar-digest"), system: { key: "daily-calendar-digest", enabled } }) as unknown as Task;

test("canonicalSystemId prefixes the reserved system: namespace", () => {
  assert.equal(canonicalSystemId("daily-calendar-digest"), "system:daily-calendar-digest");
  assert.equal(canonicalSystemId("other"), "system:other");
  assert.equal(canonicalSystemId(""), "system:");
});

test("system-tasks keeps canonical-record matching out of its public module surface", async () => {
  const module = await import("./system-tasks.ts");
  assert.equal("isCanonicalSystemRecord" in module, false);
});

test("systemTaskEnabled: literal boolean true only -- never a truthy read", () => {
  assert.equal(systemTaskEnabled(withEnabled(true)), true);
  for (const malformed of ["true", "false", "1", 1, null, undefined]) {
    assert.equal(systemTaskEnabled(withEnabled(malformed)), false, `enabled=${JSON.stringify(malformed)} must read as disabled`);
  }
  // no system metadata at all (an ordinary task) is never system-enabled
  assert.equal(systemTaskEnabled(baseTask("ab12cd34")), false);
});

test("findSystemDef resolves a member by key and rejects unknown keys", () => {
  assert.equal(findSystemDef(TEST_REGISTRY, "test-evening-digest"), testEveningDigest); // same object reference
  assert.equal(findSystemDef(TEST_REGISTRY, "test-weekly-ping"), testWeeklyPing);
  assert.equal(findSystemDef(TEST_REGISTRY, "daily-calendar-digest"), undefined); // valid key, not in THIS registry
  assert.equal(findSystemDef(TEST_REGISTRY, "nope"), undefined);
  assert.equal(findSystemDef([], "test-evening-digest"), undefined);
  // the production registry is assignable to the WIDE consumer parameter type
  // (covariance: K only appears as a property) and, since T11, carries the digest.
  assert.equal(SYSTEM_TASKS.length, 3);
  assert.deepEqual(SYSTEM_TASKS.map((definition) => definition.key), [
    "daily-calendar-digest",
    "friday-weekend-check-in",
    "monday-weekly-check-in",
  ]);
  const digestDef = findSystemDef(SYSTEM_TASKS, "daily-calendar-digest");
  assert.ok(digestDef, "T11 registered the daily calendar digest in SYSTEM_TASKS");
  assert.equal(digestDef.key, "daily-calendar-digest");
  assert.equal(digestDef.desc, "Here’s what’s on the calendar");
  assert.equal(digestDef.cron, "0 8 * * *");
  assert.equal(typeof digestDef.execute, "function");
  const friday = findSystemDef(SYSTEM_TASKS, "friday-weekend-check-in");
  const monday = findSystemDef(SYSTEM_TASKS, "monday-weekly-check-in");
  assert.deepEqual(friday && [friday.desc, friday.cron], ["Friday weekend planning check-in", "0 9 * * 5"]);
  assert.deepEqual(monday && [monday.desc, monday.cron], ["Monday weekly organization check-in", "0 9 * * 1"]);
});

test("a fake definition's execute receives the SystemTaskContext and returns a SystemTaskResult", async () => {
  const logged: string[] = [];
  const ctx: SystemTaskContext = {
    now: new Date("2026-08-20T15:05:00Z"),
    reserveAgentRun: async () => ({ token: "tok" }),
    releaseAgentRun: async () => {},
    log: (m) => logged.push(m),
  };
  const result: SystemTaskResult = await testEveningDigest.execute(baseTask("system:daily-calendar-digest"), ctx);
  assert.deepEqual(result, { ok: true, agentRun: false });
  assert.deepEqual(logged, ["ran"]);
});

test("SystemTaskResult is structurally compatible with heartbeat's FireResult (no import cycle)", async () => {
  const result = await testWeeklyPing.execute(baseTask("x"), {
    now: new Date(),
    reserveAgentRun: async () => null,
    releaseAgentRun: async () => {},
    log: () => {},
  });
  const asFireResult: FireResult = result; // compiles: handler results flow to the driver by shape
  assert.equal(asFireResult.ok, true);
});

test("SYSTEM_TASKS stays closed to the compile-time key union (@ts-expect-error)", () => {
  // The fake definition above typechecks against SystemTaskDefinition<TestKey>
  // and the wide SystemTaskDefinition<string> consumers take, but a key outside
  // SystemTaskKey may never enter the production registry: if the element type
  // ever stopped rejecting it, this unused directive fails `tsc --noEmit`, so
  // the closed union cannot silently erode.
  // @ts-expect-error -- 'test-evening-digest' is not assignable to SystemTaskKey
  const closed: readonly SystemTaskDefinition<SystemTaskKey>[] = [testEveningDigest];
  assert.ok(Array.isArray(closed)); // compile-time assertion; the value is only here to keep noUnusedVars quiet
});
