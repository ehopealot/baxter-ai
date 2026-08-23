import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "./schedule-store.ts";
import { buildTaskPrompt, makeFireTask } from "./heartbeat.ts";
import type { ExecutionContext, TickOptions } from "./heartbeat.ts";
import type { SystemTaskDefinition } from "./system-tasks.ts";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

async function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  return import(`./heartbeat.ts?t=${Date.now()}${Math.random()}`);
}

// The per-fire TickOptions wiring every tick test needs: an executor plus the
// reservation seams tick hands it (real quota is exercised separately, below).
// Overrides replace the defaults key-for-key; in particular `registry: undefined`
// restores tick's own default (the REAL SYSTEM_TASKS) for the default-registry
// gate tests below.
function tickOpts(runFn: TickOptions["runFn"], overrides: Partial<TickOptions> = {}): TickOptions {
  return {
    runFn,
    reserveAgentRunFor: async () => ({ token: "t" }),
    releaseAgentRun: async () => {},
    visibilityMs: 900000,
    maxAttempts: 3,
    fallbackTz: "UTC",
    // Legacy (pre-T12) tests are ordinary-task-only: an empty injected registry
    // keeps the per-tick gate from creating the real system:morning-check-in
    // record against their stores. The default-registry behavior (the gate
    // creating that record inside every tick) is pinned below.
    registry: [],
    log: () => {},
    ...overrides,
  };
}

function ordinaryTask(): Task {
  return { id: "t1", task: "x", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 };
}

function logLines(dir: string): Record<string, unknown>[] {
  const p = join(dir, "task-log.jsonl");
  if (!existsSync(p)) return []; // a tick that never logged leaves no file at all
  return readFileSync(p, "utf8").split("\n")
    .filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("tick fires a due one-shot, removes it on success, logs completed with agent_run", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}a`);
  await store.mutate((t: Task[]) => ({ tasks: [{ id: "o", task: "x", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  const fired: string[] = [];
  await tick(Date.parse("2026-01-02T00:00:00Z"), tickOpts(async (task: Task) => { fired.push(task.id); return { ok: true }; }));
  assert.deepEqual(fired, ["o"]);
  assert.equal((await store.readTasks()).length, 0);
  const entries = logLines(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, "completed");
  assert.equal(entries[0].agent_run, true); // ordinary fire: agent_run defaults true
  assert.equal("detail" in entries[0], false); // the injected successful FireResult omits detail, and undefined serializes away
});

test("tick: a deferredByCap fire defers to the next UTC reset — no attempt, no cron advance, one skipped line/day", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}b`);
  const now = Date.UTC(2026, 5, 10, 12, 0, 0); // injected clock: 2026-06-10T12:00:00Z
  await store.mutate((t: Task[]) => ({ tasks: [
    { id: "a", task: "x", cron: "0 4 * * *", at: null, tz: null, deliver: null, next_run_at: "2026-06-10T04:00:00Z", invisible_until: null, attempts: 0 },
  ], value: null }));
  let fired = 0;
  const opts = tickOpts(async () => { fired++; return { ok: false, deferredByCap: true, agentRun: false }; }, { reserveAgentRunFor: async () => null }); // reservation denied
  await tick(now, opts);
  assert.equal(fired, 1);
  const a = (await store.readTasks())[0];
  assert.equal(a.invisible_until, "2026-06-11T00:00:00.000Z"); // next UTC midnight
  assert.equal(a.attempts, 0);      // deferredByCap is neither success nor failure: no attempt
  assert.equal(a.next_run_at, "2026-06-10T04:00:00Z"); // no cron advance: the occurrence stays due
  let skipped = logLines(dir).filter((e) => e.outcome === "skipped");
  assert.equal(skipped.length, 1); // once per day, not once per tick
  assert.equal(skipped[0].id, "a");
  assert.equal(skipped[0].detail, "agent-run cap reached - deferred to next UTC reset");
  // Second tick the same UTC day: the deferred record is invisible until the
  // reset -> nothing fires, and the skipped line is not re-logged.
  await tick(now + 60000, opts);
  assert.equal(fired, 1);
  skipped = logLines(dir).filter((e) => e.outcome === "skipped");
  assert.equal(skipped.length, 1);
});

test("tick: a deferredByCap result ENDS the tick — remaining due occurrences are deferred, not fired", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}c`);
  const now = Date.UTC(2026, 5, 10, 12, 0, 0);
  await store.mutate((t: Task[]) => ({ tasks: [
    { id: "a", task: "x", at: "2026-06-10T05:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-06-10T05:00:00Z", invisible_until: null, attempts: 0 },
    { id: "b", task: "y", at: "2026-06-10T06:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-06-10T06:00:00Z", invisible_until: null, attempts: 0 },
  ], value: null }));
  let fired = 0;
  await tick(now, tickOpts(async () => { fired++; return { ok: false, deferredByCap: true, agentRun: false }; }, { reserveAgentRunFor: async () => null }));
  assert.equal(fired, 1); // b's runFn NEVER invoked this tick
  const tasks = await store.readTasks();
  assert.equal(tasks.length, 2);
  for (const t of tasks) assert.equal(t.invisible_until, "2026-06-11T00:00:00.000Z"); // BOTH deferred
});

test("skipped lines follow the injected clock: exactly one per injected UTC day across midnight", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}d`);
  const T = Date.UTC(2026, 5, 10, 12, 0, 0); // injected: 2026-06-10T12:00Z
  await store.mutate((t: Task[]) => ({ tasks: [
    { id: "a", task: "x", cron: "0 4 * * *", at: null, tz: null, deliver: null, next_run_at: "2026-06-10T04:00:00Z", invisible_until: null, attempts: 0 },
  ], value: null }));
  const opts = tickOpts(async () => ({ ok: false, deferredByCap: true, agentRun: false }), { reserveAgentRunFor: async () => null });
  await tick(T, opts); // day 1 deferral -> skipped line 1
  // A DIFFERENT task becomes due later the same injected day. Its deferral must
  // NOT re-log: once per UTC day. An ambient-clock check would find no line at
  // the REAL today and write a second one — this is what pins the injected clock.
  await store.mutate((t: Task[]) => ({ tasks: [...t, { id: "b", task: "y", at: "2026-06-10T12:30:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-06-10T12:30:00Z", invisible_until: null, attempts: 0 }], value: null }));
  await tick(T + 30 * 60000, opts); // a invisible until the reset; b due -> deferred, no new line
  await tick(T + 25 * 3600 * 1000, opts); // next UTC day: a+b due again -> line 2
  const skipped = logLines(dir).filter((e) => e.outcome === "skipped");
  assert.equal(skipped.length, 2); // exactly one per injected UTC day, regardless of the real date
});

test("tick: a hard failure hits the retry path (attempts++), not success, and logs agent_run", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}f`);
  await store.mutate((t: Task[]) => ({ tasks: [{ id: "c", task: "x", cron: "0 * * * *", at: null, tz: null, deliver: null, next_run_at: "2000-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  await tick(Date.now(), tickOpts(async () => ({ ok: false })));
  const t = (await store.readTasks())[0];
  assert.equal(t.attempts, 1); // failure reached applyOnFailure (not silently completed)
  assert.ok(t.cron);           // cron task still present, not rescheduled/removed
  const entries = logLines(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, "failed");
  assert.equal(entries[0].agent_run, true); // ordinary failure still logs agent_run:true
});

test("tick: out-of-tokens leaves the claim, burns no attempt, stops the tick", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}g`);
  await store.mutate((t: Task[]) => ({ tasks: [
    { id: "a", task: "x", at: "2000-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2000-01-01T00:00:00Z", invisible_until: null, attempts: 0 },
    { id: "b", task: "y", at: "2000-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2000-01-01T00:00:00Z", invisible_until: null, attempts: 0 },
  ], value: null }));
  let fired = 0;
  await tick(Date.now(), tickOpts(async () => { fired++; return { ok: false, outOfTokens: true, agentRun: true }; }));
  assert.equal(fired, 1); // broke after the first; didn't march through b
  const tasks = await store.readTasks();
  assert.equal(tasks.length, 2); // both still present
  const a = tasks.find((t: Task) => t.id === "a");
  assert.equal(a.attempts, 0);   // no attempt burned
  assert.ok(a.invisible_until);  // claim left -> retries free after the window
});

test("makeFireTask: a NULL reservation never invokes runAgent", async () => {
  const calls: string[] = [];
  const fire = makeFireTask({ runAgent: async () => { calls.push("runAgent"); return { failed: false, outOfTokens: false, resetsAt: null }; } });
  const ctx: ExecutionContext = { reserveAgentRun: async () => null, releaseAgentRun: async () => {} };
  const result = await fire(ordinaryTask(), ctx);
  assert.deepEqual(calls, []); // ZERO runAgent invocations
  assert.deepEqual(result, { ok: false, deferredByCap: true, agentRun: false });
});

test("makeFireTask: a GRANTED reservation invokes runAgent strictly AFTER the reserve", async () => {
  const order: string[] = [];
  const fire = makeFireTask({ runAgent: async () => { order.push("runAgent"); return { failed: false, outOfTokens: false, resetsAt: null }; } });
  const ctx: ExecutionContext = {
    reserveAgentRun: async () => { order.push("reserve"); return { token: "tok-1" }; },
    releaseAgentRun: async () => {},
  };
  const result = await fire(ordinaryTask(), ctx);
  assert.deepEqual(order, ["reserve", "runAgent"]); // reserve strictly before the model run
  assert.equal(result.ok, true);
  assert.equal(result.agentRun, true);
});

test("makeFireTask: an out-of-tokens run releases exactly its own token (free retry, cap not burned)", async () => {
  const released: string[] = [];
  const fire = makeFireTask({ runAgent: async () => ({ failed: false, outOfTokens: true, resetsAt: Date.now() }) });
  const ctx: ExecutionContext = {
    reserveAgentRun: async () => ({ token: "tok-9" }),
    releaseAgentRun: async (token: string) => { released.push(token); },
  };
  const result = await fire(ordinaryTask(), ctx);
  assert.equal(result.ok, false);
  assert.equal(result.outOfTokens, true);
  assert.deepEqual(released, ["tok-9"]); // refunded exactly its own slot, atomically + idempotently
});

test("makeFireTask: success and hard failure keep the reservation consumed", async () => {
  const released: string[] = [];
  const ctx: ExecutionContext = {
    reserveAgentRun: async () => ({ token: "tok-2" }),
    releaseAgentRun: async (token: string) => { released.push(token); },
  };
  const okFire = makeFireTask({ runAgent: async () => ({ failed: false, outOfTokens: false, resetsAt: null }) });
  assert.deepEqual(await okFire(ordinaryTask(), ctx), { ok: true, agentRun: true });
  const failFire = makeFireTask({ runAgent: async () => ({ failed: true, outOfTokens: false, resetsAt: null }) });
  const failed = await failFire(ordinaryTask(), ctx);
  assert.equal(failed.ok, false);
  assert.deepEqual(released, []); // neither path releases: the cap stays consumed (fail-closed)
});

test("makeFireTask + real fire-quota: the persisted reservation is bound to the fired task's id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-bind-"));
  const prev = process.env.SCHEDULE_DIR_OVERRIDE;
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  try {
    const fq = await import("./fire-quota.ts");
    const task = ordinaryTask(); // id: "t1"
    // The per-fire context EXACTLY as tick builds it: zero-arg reserveAgentRun
    // bound to the fired task's id, releaseAgentRun passed straight through.
    const now = new Date();
    const reserveAgentRunFor = (taskId: string) => fq.reserveAgentRunSlot(now, 3, taskId);
    const ctx: ExecutionContext = { reserveAgentRun: () => reserveAgentRunFor(task.id), releaseAgentRun: (token: string) => fq.releaseAgentRunSlot(token) };
    const fire = makeFireTask({ runAgent: async () => ({ failed: false, outOfTokens: false, resetsAt: null }) });
    const result = await fire(task, ctx);
    assert.equal(result.ok, true);
    const state = JSON.parse(readFileSync(join(dir, "fire-quota.json"), "utf8")) as { reservations: { task: string }[] };
    const mine = state.reservations.filter((r) => r.task === task.id);
    assert.equal(mine.length, 1); // the granted reservation persisted, task-bound, through the real module
  } finally {
    if (prev === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE;
    else process.env.SCHEDULE_DIR_OVERRIDE = prev;
  }
});

test("buildTaskPrompt renders the household section immediately before collections", () => {
  const task: Task = { id: "t", task: "x", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 };
  const prompt = buildTaskPrompt(task);
  assert.match(prompt, /## Your household/);
  assert.match(prompt, /The people in this household, and how to reach them:/);
  // Identical in both URL variants of the guidance, so it holds on any box.
  assert.match(prompt, /you can text any phone number listed for the household/);
  // no filled-prompt brace scan (false-failure trap): household names from ambient env keep
  // {{...}} byte-intact under the single-pass fill. The positive matches above already prove
  // the fill happened (the placement pin can only render from a real preamble), so pin the
  // template side instead: the raw template carries the placeholder.
  assert.ok(readFileSync(join(APP_DIR, "heartbeat-prompt.md"), "utf8").includes("{{HOUSEHOLD}}"));
  // The guidance tail ends the household block in both URL variants, so this
  // proves the section renders immediately before the collections section
  // (catches misplacement, not just presence).
  assert.match(prompt, /can't be texted\.\n\n## Your collections/);
});

test("buildTaskPrompt distinguishes an sms-group destination from a 1:1 sms one, with the send-group verb and the operator fallback (scheduled-sms-group spec test 7)", () => {
  // An sms-group task renders its own DELIVER line and its own delivery bullet.
  const groupTask: Task = { id: "g", task: "digest the group", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: { surface: "sms-group", target: "grp_abc" }, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 };
  const prompt = buildTaskPrompt(groupTask);
  assert.match(prompt, /\*\*sms-group -> grp_abc\*\*/, "the DELIVER line names the surface and the exact group id");
  assert.match(prompt, /sms-cli send-group <groupId>/, "the group bullet gives the send-group verb");
  assert.match(prompt, /never claim the group delivery succeeded/, "a refused/failed group send escalates instead of silently succeeding");
  assert.match(prompt, /naming the intended group/, "the fallback names the intended group for the operator");
  // A 1:1 sms task keeps its own verb -- the two cannot drift into one another.
  const smsTask: Task = { id: "s", task: "text them", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: { surface: "sms", target: "+15551234567" }, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 };
  const smsPrompt = buildTaskPrompt(smsTask);
  assert.match(smsPrompt, /\*\*sms -> \+15551234567\*\*/);
  assert.match(smsPrompt, /sms-cli send <phone>/, "the 1:1 bullet keeps the plain send verb");
});

// ---------- T12: reconciliation gate, system dispatch, in-lock guards ----------
//
// The gate (runReconcileGate) is directly testable; tick runs it FIRST and
// scans only its returned canonical snapshot; every id-based mutation
// (claim/success/failure/deferral) revalidates in-lock via refuseOnCollision;
// system records dispatch only through registry handlers with the reservation
// context bound to the CLAIMED task's id; and the whole cancel-repair loop
// (collision tick -> schedule-cli cancel -> clean reconcile) is covered e2e.

// Controlled household-tz env for gate/tick tests: householdTz reads
// BAXTER_TZ -> HEARTBEAT_TZ -> America/Los_Angeles at gate-run time.
async function withTzEnv(tz: { BAXTER_TZ?: string; HEARTBEAT_TZ?: string }, fn: () => Promise<void>): Promise<void> {
  const prev = { BAXTER_TZ: process.env.BAXTER_TZ, HEARTBEAT_TZ: process.env.HEARTBEAT_TZ };
  const set = (env: { BAXTER_TZ?: string; HEARTBEAT_TZ?: string }) => {
    for (const k of ["BAXTER_TZ", "HEARTBEAT_TZ"] as const) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  };
  set(tz);
  try { await fn(); } finally { set(prev); }
}

// A fully-typed fake registry under a test-local key (the generic key
// parameter exists for exactly this): canonical-consistent records seeded via
// pingCanonical() stay untouched by the gate, so queue state stays test-owned.
const pingDef: SystemTaskDefinition<"test-system-ping"> = {
  key: "test-system-ping", desc: "test ping", cron: "0 4 * * *",
  execute: async () => ({ ok: true, agentRun: false }),
};
const PING_REGISTRY: readonly SystemTaskDefinition<string>[] = [pingDef];
const PING_TZ = "America/Los_Angeles"; // withTzEnv({}) resolves exactly this
const PING_DUE = "2026-08-20T11:00:00.000Z"; // today's 04:00 PDT -- stale due next_run_at
function pingCanonical(over: Partial<Task> = {}): Task {
  return {
    id: "system:test-system-ping", desc: "test ping", cron: "0 4 * * *", at: null, tz: PING_TZ,
    next_run_at: PING_DUE, invisible_until: null, attempts: 0, deliver: null,
    system: { key: "test-system-ping", enabled: true }, created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}
// A one-shot ordinary record due at `due` (UTC ISO).
function ordinaryDue(id: string, due = "2026-08-20T10:00:00.000Z"): Task {
  return { id, task: `task ${id}`, at: due, cron: null, tz: null, deliver: null, next_run_at: due, invisible_until: null, attempts: 0 };
}
function pingTrigger(id = "feedbeef", over: Partial<Task> = {}): Task {
  const created = "2026-08-20T15:59:00.000Z";
  return {
    id, desc: "test ping", at: created, cron: null, tz: null, deliver: null,
    next_run_at: created, invisible_until: null, attempts: 0,
    system_trigger: { key: "test-system-ping" }, created_at: created,
    ...over,
  };
}
async function seed(tasks: Task[]): Promise<void> {
  const store = await import(`./schedule-store.ts?t=${Date.now()}${Math.random()}`);
  await store.mutate((t: Task[]) => ({ tasks: [...t, ...tasks], value: null }));
}
const T12_NOW = Date.parse("2026-08-20T16:00:00Z"); // 09:00 America/Los_Angeles (after 08:00)

test("runReconcileGate: empty store creates the single ranged morning record", async () => {
  await freshStore();
  const { runReconcileGate } = await import(`./heartbeat.ts?t=${Date.now()}${Math.random()}`);
  await withTzEnv({}, async () => {
    const gate = await runReconcileGate(new Date(T12_NOW), { log: () => {} });
    assert.equal(gate.ok, true);
    if (!gate.ok) return;
    assert.equal(gate.tasks.length, 1);
    const rec = gate.tasks[0]!;
    assert.equal(rec.id, "system:morning-check-in");
    assert.equal(rec.system?.key, "morning-check-in");
    assert.equal(rec.system?.enabled, true);
    assert.equal(rec.tz, "America/Los_Angeles");
    assert.ok(Date.parse(rec.next_run_at) <= T12_NOW); // selected 08:00-08:59 occurrence catches up before noon
  });
});

test("runReconcileGate: seeded 'system:other' collision -> ok:false, repair instruction logged, nothing thrown past the helper, nothing written", async () => {
  await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const { runReconcileGate } = await import(`./heartbeat.ts?t=${Date.now()}${Math.random()}`);
  await withTzEnv({}, async () => {
    await seed([ordinaryDue("system:other")]);
    const before = readFileSync(join(dir, "schedule.json"), "utf8");
    const logs: string[] = [];
    const gate = await runReconcileGate(new Date(T12_NOW), { log: (m: string) => logs.push(m) });
    assert.equal(gate.ok, false);
    if (gate.ok) return;
    assert.match(gate.error, /Operator repair required/);
    assert.ok(logs.some((l) => l.includes("system:other") && l.includes("Operator repair required")));
    assert.equal(readFileSync(join(dir, "schedule.json"), "utf8"), before); // nothing written
  });
});

test("runReconcileGate: the created record resolves tz via householdTz (garbage BAXTER_TZ + HEARTBEAT_TZ America/New_York)", async () => {
  await freshStore();
  const { runReconcileGate } = await import(`./heartbeat.ts?t=${Date.now()}${Math.random()}`);
  await withTzEnv({ BAXTER_TZ: "Not/AZone", HEARTBEAT_TZ: "America/New_York" }, async () => {
    const gate = await runReconcileGate(new Date(T12_NOW), { log: () => {} }); // 12:00 EDT -- after 08:00
    assert.equal(gate.ok, true);
    if (!gate.ok) return;
    const rec = gate.tasks[0];
    assert.equal(rec.tz, "America/New_York");
    assert.ok(Date.parse(rec.next_run_at) > T12_NOW); // noon expiry creates tomorrow's local window
  });
});

test("first tick against an empty store creates the morning record before selection; a no-change second tick does not rewrite schedule.json", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}z`);
  const handlerCalls = { n: 0 };
  const opts = () => tickOpts(
    async () => { throw new Error("ordinary runFn must not run"); },
    { registry: undefined, systemHandlerResolver: () => async () => { handlerCalls.n++; return { ok: true, agentRun: false }; } },
  );
  await withTzEnv({}, async () => {
    await tick(T12_NOW, opts());
    assert.equal(handlerCalls.n, 1); // the gate created the record BEFORE selection; it was already due and dispatched this same tick
    const tasks = await store.readTasks();
    assert.equal(tasks.length, 1);
    const digest = tasks.find((task: Task) => task.id === "system:morning-check-in")!;
    assert.ok(Date.parse(digest.next_run_at) > T12_NOW); // success selects tomorrow's occurrence
    const path = join(dir, "schedule.json");
    const before = { content: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs };
    await tick(T12_NOW + 60000, opts());
    assert.equal(handlerCalls.n, 1); // tomorrow's occurrence: not due again
    assert.equal(readFileSync(path, "utf8"), before.content);
    assert.equal(statSync(path).mtimeMs, before.mtime); // the no-change gate skipped the rewrite
  });
});

test("a seeded reserved-ID collision makes the tick select/claim/dispatch nothing and log the repair instruction", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}y`);
  await withTzEnv({}, async () => {
    await seed([ordinaryDue("system:other")]);
    const before = readFileSync(join(dir, "schedule.json"), "utf8");
    const logs: string[] = [];
    let runFnCalls = 0, handlerCalls = 0;
    await tick(T12_NOW, tickOpts(
      async () => { runFnCalls++; return { ok: true }; },
      { registry: undefined, log: (m: string) => logs.push(m), systemHandlerResolver: () => async () => { handlerCalls++; return { ok: true, agentRun: false }; } },
    ));
    assert.equal(runFnCalls, 0);
    assert.equal(handlerCalls, 0);
    assert.ok(logs.some((l) => l.includes("Operator repair required")));
    assert.equal(readFileSync(join(dir, "schedule.json"), "utf8"), before); // nothing claimed or written
    assert.equal(logLines(dir).length, 0); // no log entries
    assert.equal((await store.readTasks()).length, 1);
  });
});

test("a due trigger dispatches the registered handler independently of a disabled canonical task, counts as its own fire, and is removed on success", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}trigger-success`);
  await withTzEnv({}, async () => {
    const disabled = pingCanonical({
      system: { key: "test-system-ping", enabled: false },
      next_run_at: "2026-08-22T11:00:00.000Z",
      invisible_until: "2026-08-20T20:00:00.000Z",
      attempts: 2,
    });
    await seed([disabled, pingTrigger()]);
    let runFnCalls = 0;
    const handlerIds: string[] = [];
    const reservedFor: string[] = [];
    await tick(T12_NOW, tickOpts(
      async () => { runFnCalls++; return { ok: true }; },
      {
        registry: PING_REGISTRY,
        reserveAgentRunFor: async (id) => { reservedFor.push(id); return { token: "trigger-slot" }; },
        systemHandlerResolver: (key) => key === "test-system-ping"
          ? async (task, ctx) => { handlerIds.push(task.id); await ctx.reserveAgentRun(); return { ok: true, agentRun: true }; }
          : undefined,
      },
    ));
    assert.equal(runFnCalls, 0, "trigger never enters the ordinary prompt executor");
    assert.deepEqual(handlerIds, ["feedbeef"]);
    assert.deepEqual(reservedFor, ["feedbeef"], "quota binds to the distinct trigger id");
    const tasks = await store.readTasks();
    assert.deepEqual(tasks, [disabled], "success removes only the one-shot trigger and leaves canonical queue state unchanged");
    const [entry] = logLines(dir);
    assert.equal(entry.id, "feedbeef");
    assert.equal(entry.system_key, "test-system-ping");
    assert.equal(entry.outcome, "completed");
  });
});

test("a trigger hard failure follows one-shot retries and give-up removal", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}trigger-failure`);
  await withTzEnv({}, async () => {
    await seed([
      pingCanonical({ system: { key: "test-system-ping", enabled: false } }),
      pingTrigger(),
    ]);
    let handlerCalls = 0;
    const opts = tickOpts(
      async () => { throw new Error("ordinary executor must not run"); },
      {
        registry: PING_REGISTRY,
        visibilityMs: 0,
        maxAttempts: 2,
        systemHandlerResolver: () => async () => { handlerCalls++; return { ok: false, agentRun: false }; },
      },
    );
    await tick(T12_NOW, opts);
    let trigger = (await store.readTasks()).find((t: Task) => t.id === "feedbeef");
    assert.equal(trigger?.attempts, 1);
    assert.equal(logLines(dir).at(-1)?.outcome, "failed");

    await tick(T12_NOW + 1, opts);
    trigger = (await store.readTasks()).find((t: Task) => t.id === "feedbeef");
    assert.equal(trigger, undefined, "one-shot trigger is removed after max hard-failure attempts");
    assert.equal(handlerCalls, 2);
    assert.deepEqual(logLines(dir).map((entry) => entry.outcome), ["failed", "gave-up"]);
  });
});

test("reconciliation drops unknown or malformed trigger records before selection, so neither registered nor ordinary executors run", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}trigger-invalid`);
  await withTzEnv({}, async () => {
    const unknown = pingTrigger("bad0bad0", { system_trigger: { key: "not-registered" } });
    const malformed = pingTrigger("bad1bad1", { task: "arbitrary prompt must never run" });
    await seed([pingCanonical({ system: { key: "test-system-ping", enabled: false } }), unknown, malformed]);
    let runFnCalls = 0, handlerCalls = 0;
    const logs: string[] = [];
    await tick(T12_NOW, tickOpts(
      async () => { runFnCalls++; return { ok: true }; },
      {
        registry: PING_REGISTRY,
        log: (line) => logs.push(line),
        systemHandlerResolver: () => async () => { handlerCalls++; return { ok: true }; },
      },
    ));
    assert.equal(runFnCalls, 0);
    assert.equal(handlerCalls, 0);
    assert.deepEqual((await store.readTasks()).map((task: Task) => task.id), ["system:test-system-ping"]);
    assert.ok(logs.some((line) => line.includes("bad0bad0") && line.includes("removed")));
    assert.ok(logs.some((line) => line.includes("bad1bad1") && line.includes("removed")));
  });
});

test("a disabled system record with a stale due next_run_at never fires (strict literal-true due filter)", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}p`);
  await withTzEnv({}, async () => {
    await seed([pingCanonical({ system: { key: "test-system-ping", enabled: false } })]);
    let handlerCalls = 0;
    await tick(T12_NOW, tickOpts(
      async () => { throw new Error("must not run"); },
      { registry: PING_REGISTRY, systemHandlerResolver: () => async () => { handlerCalls++; return { ok: true, agentRun: false }; } },
    ));
    assert.equal(handlerCalls, 0);
    const rec = (await store.readTasks())[0];
    assert.equal(rec.next_run_at, PING_DUE); // untouched: never selected, claimed, or deferred
    assert.equal(rec.invisible_until, null);
    assert.equal(logLines(dir).length, 0);
  });
});

test("a malformed-enabled ('true' string) system record is repaired to disabled by the gate and never fires", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}q`);
  await withTzEnv({}, async () => {
    // Persisted records are arbitrary JSON: the 'true' string rides in as unknown.
    const malformed = pingCanonical() as unknown as { system: { key: string; enabled: string } };
    malformed.system.enabled = "true";
    await seed([malformed as unknown as Task]);
    let handlerCalls = 0;
    const logs: string[] = [];
    await tick(T12_NOW, tickOpts(
      async () => { throw new Error("must not run"); },
      { log: (m: string) => logs.push(m), registry: PING_REGISTRY, systemHandlerResolver: () => async () => { handlerCalls++; return { ok: true, agentRun: false }; } },
    ));
    assert.equal(handlerCalls, 0);
    const rec = (await store.readTasks())[0];
    assert.equal(rec.system?.enabled, false); // repaired to the literal false
    assert.equal(rec.invisible_until, null);  // never claimed
    assert.ok(logs.some((l) => l.includes("repaired non-boolean system.enabled")));
    assert.equal(logLines(dir).length, 0);
  });
});

test("a system task disabled between the tick's snapshot and its claim is not dispatched (claim-time strict-enabled recheck)", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}r`);
  await withTzEnv({}, async () => {
    await seed([ordinaryDue("a", "2026-08-20T09:00:00.000Z"), pingCanonical()]); // a first (fires), ping second (due)
    let handlerCalls = 0;
    await tick(T12_NOW, tickOpts(
      // a 'schedule-cli system disable' landing mid-tick, between the snapshot and the claim
      async () => {
        await store.mutate((ts: Task[]) => ({
          tasks: ts.map((t) => t.id === "system:test-system-ping" ? { ...t, system: { key: "test-system-ping", enabled: false } } : t),
          value: null,
        }));
        return { ok: true };
      },
      { registry: PING_REGISTRY, systemHandlerResolver: () => async () => { handlerCalls++; return { ok: true, agentRun: false }; } },
    ));
    assert.equal(handlerCalls, 0); // the disable won the race: no dispatch
    const ping = (await store.readTasks()).find((t: Task) => t.id === "system:test-system-ping");
    assert.equal(ping?.system?.enabled, false);
    assert.equal(ping?.invisible_until, null); // NO claim write: the recheck refused before applyClaim
    assert.equal(ping?.attempts, 0);
    assert.equal(ping?.next_run_at, PING_DUE); // no cron advance
  });
});

test("two ordinary records sharing one id refuse the claim mutation with nothing written", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  await withTzEnv({}, async () => {
    await seed([ordinaryDue("dup", "2026-08-20T09:00:00.000Z"), ordinaryDue("dup", "2026-08-20T09:30:00.000Z")]);
    const before = readFileSync(join(dir, "schedule.json"), "utf8");
    let runFnCalls = 0;
    await assert.rejects(
      tick(T12_NOW, tickOpts(async () => { runFnCalls++; return { ok: true }; })),
      /ambiguous/, // the in-lock guard refused the id-based claim mutation
    );
    assert.equal(runFnCalls, 0);
    assert.equal(readFileSync(join(dir, "schedule.json"), "utf8"), before); // nothing written
    assert.equal(logLines(dir).length, 0);
  });
});

test("a duplicate id inserted mid-runFn refuses the success and failure mutations with nothing written", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}s`);
  const dir = () => process.env.SCHEDULE_DIR_OVERRIDE as string;
  for (const result of [{ ok: true }, { ok: false }] as const) {
    // fresh single-record store per sub-case (replace, not append)
    await store.mutate(() => ({ tasks: [ordinaryDue("uniq")], value: null }));
    let contentAfterInsert = "";
    await assert.rejects(
      tick(T12_NOW, tickOpts(async () => {
        // from inside runFn (outside the driver's own transactions): a second
        // record sharing the claimed task's id lands on disk
        await store.mutate((ts: Task[]) => ({ tasks: [...ts, ordinaryDue("uniq", "2026-08-20T09:30:00.000Z")], value: null }));
        contentAfterInsert = readFileSync(join(dir(), "schedule.json"), "utf8");
        return result;
      })),
      /ambiguous/, // the in-lock guard refused the id-based mutation (success removal/advance, failure increment)
    );
    const tasks = await store.readTasks();
    assert.equal(tasks.length, 2); // both records with id 'uniq' survive
    for (const t of tasks) assert.equal(t.attempts, 0); // no failure increment, no give-up
    // neither mutation wrote: the file still holds exactly what runFn's insert left
    assert.equal(readFileSync(join(dir(), "schedule.json"), "utf8"), contentAfterInsert);
    assert.equal(logLines(dir()).length, 0);
  }
});

test("the deferredByCap deferral write refuses on a duplicated id inserted mid-runFn: nothing written, the duplicated id logged", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}u`);
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  await withTzEnv({}, async () => {
    await store.mutate(() => ({ tasks: [ordinaryDue("uniq", "2026-06-10T05:00:00.000Z")], value: null }));
    const now = Date.UTC(2026, 5, 10, 12, 0, 0); // 2026-06-10T12:00:00Z; reset = 2026-06-11T00:00:00.000Z
    const logs: string[] = [];
    let contentAfterInsert = "";
    await tick(now, tickOpts(
      async () => {
        await store.mutate((ts: Task[]) => ({ tasks: [...ts, ordinaryDue("uniq", "2026-06-10T05:30:00.000Z")], value: null }));
        contentAfterInsert = readFileSync(join(dir, "schedule.json"), "utf8");
        return { ok: false, deferredByCap: true, agentRun: false };
      },
      { reserveAgentRunFor: async () => null, log: (m: string) => logs.push(m) },
    )); // does NOT throw: the deferral pass catches its refusal per record
    assert.equal(readFileSync(join(dir, "schedule.json"), "utf8"), contentAfterInsert); // the deferral itself wrote nothing
    const tasks = await store.readTasks();
    assert.equal(tasks.length, 2);
    for (const t of tasks) assert.notEqual(t.invisible_until, "2026-06-11T00:00:00.000Z"); // neither gained the reset deferral
    assert.ok(
      logs.some((l) => l.includes("deferral refused for 'uniq' -- duplicated id left due, nothing written:") && l.includes("ambiguous")),
      `duplicated id left due, nothing written: ${JSON.stringify(logs)}`,
    );
    assert.equal(logLines(dir).filter((e) => e.outcome === "skipped").length, 0); // no skipped line for the refused record
  });
});

test("a non-guard error mid-deferral (store failure) escapes tick instead of being logged as a guard refusal", async () => {
  // Only guard refusals (ReservedIdCollisionError / AmbiguousIdError) are
  // per-record recoverable in deferRecordToReset. An infrastructure failure --
  // here schedule.json becomes unparseable between the claim and the deferral
  // write -- must propagate out of deferCapExhausted/tick to main's per-tick
  // handler, never be mislabeled a guard refusal and swallowed.
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}${Math.random()}`);
  await withTzEnv({}, async () => {
    await store.mutate(() => ({ tasks: [ordinaryDue("uniq", "2026-06-10T05:00:00Z")], value: null }));
    const now = Date.UTC(2026, 5, 10, 12, 0, 0); // reset would be 2026-06-11T00:00:00.000Z
    const logs: string[] = [];
    await assert.rejects(
      tick(now, tickOpts(
        async () => {
          // from inside runFn (outside the driver's transactions): corrupt the
          // store so the deferral's own mutate() hits a JSON/infrastructure error
          writeFileSync(join(dir, "schedule.json"), "not json");
          return { ok: false, deferredByCap: true, agentRun: false };
        },
        { reserveAgentRunFor: async () => null, log: (m: string) => logs.push(m) },
      )),
      SyntaxError, // the store failure escapes tick
    );
    assert.ok(!logs.some((l) => l.includes("deferral refused")), `no mislabeled refusal: ${JSON.stringify(logs)}`);
    assert.equal(logLines(dir).filter((e) => e.outcome === "skipped").length, 0); // no skipped line either
  });
});

test("a deferredByCap system handler ENDS the tick: the remaining ordinary runFn is never invoked and both records defer", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}v`);
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  await withTzEnv({}, async () => {
    await seed([pingCanonical(), ordinaryDue("b", "2026-08-20T10:30:00.000Z")]); // system first, ordinary second
    let runFnCalls = 0, handlerCalls = 0;
    const now = Date.UTC(2026, 7, 20, 16, 0, 0);
    await tick(now, tickOpts(
      async () => { runFnCalls++; return { ok: true }; },
      { reserveAgentRunFor: async () => null, registry: PING_REGISTRY, systemHandlerResolver: () => async () => { handlerCalls++; return { ok: false, deferredByCap: true, agentRun: false }; } },
    ));
    assert.equal(handlerCalls, 1); // exactly one executor invocation this tick
    assert.equal(runFnCalls, 0);   // b's runFn NEVER invoked
    const tasks = await store.readTasks();
    assert.equal(tasks.length, 2);
    for (const t of tasks) assert.equal(t.invisible_until, "2026-08-21T00:00:00.000Z"); // BOTH deferred to the next UTC reset
    const ping = tasks.find((t: Task) => t.id === "system:test-system-ping");
    assert.equal(ping?.attempts, 0);          // deferredByCap is neither success nor failure
    assert.equal(ping?.next_run_at, PING_DUE); // no cron advance
    const skipped = logLines(dir).filter((e) => e.outcome === "skipped");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].id, "system:test-system-ping");
  });
});

test("system dispatch resolves the handler by validated key and binds ctx.reserveAgentRun() to the claimed task's id; system fires log system_key + agent_run", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  await withTzEnv({}, async () => {
    await seed([pingCanonical()]);
    const reservedFor: string[] = [];
    let observedTaskId = "", wrongKeyAsked = false;
    await tick(T12_NOW, tickOpts(
      async () => { throw new Error("ordinary runFn must not run for a system task"); },
      {
        reserveAgentRunFor: async (taskId: string) => { reservedFor.push(taskId); return { token: "granted" }; },
        registry: PING_REGISTRY,
        systemHandlerResolver: (key: string) => {
          if (key !== "test-system-ping") { wrongKeyAsked = true; return undefined; }
          return async (task: Task, ctx: import("./system-tasks.ts").SystemTaskContext) => {
            observedTaskId = task.id;
            const slot = await ctx.reserveAgentRun(); // the SPEC'S zero-arg context shape
            assert.deepEqual(slot, { token: "granted" });
            return { ok: true, agentRun: true };
          };
        },
      },
    ));
    assert.equal(wrongKeyAsked, false);
    assert.equal(observedTaskId, "system:test-system-ping");
    assert.deepEqual(reservedFor, ["system:test-system-ping"]); // bound to the CLAIMED task's id
    const entries = logLines(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "completed");
    assert.equal(entries[0].system_key, "test-system-ping");
    assert.equal(entries[0].agent_run, true);
  });
});

test("ranged morning success and final give-up advance exactly one fresh occurrence while nonfinal retry preserves it", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}ranged-advance`);
  const priorTz = process.env.BAXTER_TZ; process.env.BAXTER_TZ = "UTC";
  const def: SystemTaskDefinition<string> = { key: "morning-check-in", desc: "Morning calendar and household check-in", cron: "0 8 * * *", window: { startHour: 8, minuteSlots: 60, cutoffHour: 12 }, execute: async () => ({ ok: true }) };
  const base: Task = { id: "system:morning-check-in", desc: def.desc, cron: def.cron, at: null, tz: "UTC", next_run_at: "2026-08-20T08:12:00.000Z", invisible_until: null, attempts: 0, deliver: null, system: { key: def.key, enabled: true }, created_at: "2026-08-01T00:00:00.000Z" };
  try {
    await store.mutate((tasks: Task[]) => ({ tasks: [base], value: null }));
    await tick(Date.parse("2026-08-20T09:00:00Z"), tickOpts(async () => ({ ok: true, agentRun: false }), { registry: [def], systemHandlerResolver: () => async () => ({ ok: true, agentRun: false }) }));
    const success = (await store.readTasks())[0]!;
    assert.notEqual(success.next_run_at, base.next_run_at); assert.equal(success.attempts, 0); assert.equal(success.invisible_until, null);
    await store.mutate((tasks: Task[]) => ({ tasks: [{ ...base, attempts: 0 }], value: null }));
    await tick(Date.parse("2026-08-20T09:00:00Z"), tickOpts(async () => ({ ok: false }), { registry: [def], maxAttempts: 2, systemHandlerResolver: () => async () => ({ ok: false, agentRun: false }) }));
    const retry = (await store.readTasks())[0]!;
    assert.equal(retry.next_run_at, base.next_run_at); assert.equal(retry.attempts, 1, "nonfinal retry retains the selected instant");
    await store.mutate((tasks: Task[]) => ({ tasks: [{ ...base, attempts: 0 }], value: null }));
    await tick(Date.parse("2026-08-20T09:00:00Z"), tickOpts(async () => ({ ok: false }), { registry: [def], maxAttempts: 1, systemHandlerResolver: () => async () => ({ ok: false, agentRun: false }) }));
    const gaveUp = (await store.readTasks())[0]!;
    assert.notEqual(gaveUp.next_run_at, base.next_run_at); assert.equal(gaveUp.attempts, 0); assert.equal(gaveUp.invisible_until, null);
  } finally { if (priorTz === undefined) delete process.env.BAXTER_TZ; else process.env.BAXTER_TZ = priorTz; }
});

test("a system fire that leaves agentRun unset logs agent_run:false (the ordinary default-true never leaks into system audits)", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  await withTzEnv({}, async () => {
    await seed([pingCanonical()]);
    await tick(T12_NOW, tickOpts(
      async () => { throw new Error("must not run"); },
      { registry: PING_REGISTRY, systemHandlerResolver: () => async () => ({ ok: true }) }, // agentRun unset
    ));
    const entries = logLines(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agent_run, false); // system default, not the ordinary default-true
    assert.equal(entries[0].system_key, "test-system-ping");
  });
});

test("system handler detail summaries reach task-log.jsonl: the bounded aggregate only, never a digest body", async () => {
  // Spec (Queue and log integration): delivery summaries record aggregate
  // sms/email/unresolved/refresh counts; the generated digest body is never
  // recorded. The fake handler returns a digest-shaped bounded aggregate AND
  // emits a digest-body-like string on its logging channel -- only the bounded
  // detail may land in task-log.jsonl, on both the completed and failed paths.
  const detail = "delivered 1 sms + 0 email of 1 contact(s)";
  const digestBody = "## Your day\n\n09:00 -- dentist (Home calendar)";
  for (const variant of [
    { ok: true, outcome: "completed" },
    { ok: false, outcome: "failed" },
  ] as const) {
    const { tick } = await freshStore();
    const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
    await withTzEnv({}, async () => {
      await seed([pingCanonical()]);
      await tick(T12_NOW, tickOpts(
        async () => { throw new Error("must not run"); },
        {
          registry: PING_REGISTRY,
          systemHandlerResolver: () => async (_task: Task, ctx: import("./system-tasks.ts").SystemTaskContext) => {
            ctx.log(digestBody); // the body goes to the delivery/log channel only
            return { ok: variant.ok, agentRun: true, detail };
          },
        },
      ));
      const entries = logLines(dir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].outcome, variant.outcome);
      assert.equal(entries[0].detail, detail); // the bounded aggregate is recorded
      for (const e of entries) assert.ok(!JSON.stringify(e).includes("## Your day"), "no digest body in any log entry");
    });
  }
});

test("a missing registry entry for a system key refuses dispatch (log, never executes) and leaves the claim for a free retry", async () => {
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}w`);
  await withTzEnv({}, async () => {
    await seed([pingCanonical()]);
    const logs: string[] = [];
    await tick(T12_NOW, tickOpts(
      async () => { throw new Error("must not run"); },
      { log: (m: string) => logs.push(m), registry: PING_REGISTRY, systemHandlerResolver: () => undefined }, // no handler for the key
    ));
    assert.ok(logs.some((l) => l.includes("test-system-ping")), `refusal logged: ${JSON.stringify(logs)}`);
    const rec = (await store.readTasks())[0];
    assert.equal(rec.attempts, 0);           // no failure burned
    assert.equal(rec.next_run_at, PING_DUE); // no cron advance
    assert.ok(rec.invisible_until);          // claim left in place -> free retry after the window
    assert.equal(logLines(dir).length, 0);   // no log entries
  });
});

test("e2e cancel-repair: collision tick refuses, schedule-cli cancel repairs, the next tick reconciles and creates the system task", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}x`);
  const { cmdCancel } = await import("./schedule-cli.ts");
  await withTzEnv({}, async () => {
    await seed([ordinaryDue("system:other")]); // an ordinary record squatting on a reserved id
    const logs: string[] = [];
    let handlerCalls = 0;
    const opts = () => tickOpts(
      async () => { throw new Error("must not run"); },
      { registry: undefined, log: (m: string) => logs.push(m), systemHandlerResolver: () => async () => { handlerCalls++; return { ok: true, agentRun: false }; } },
    );
    await tick(T12_NOW, opts());
    assert.equal(handlerCalls, 0);
    assert.ok(logs.some((l) => l.includes("Operator repair required")));
    // operator repair: cancel the ONE unambiguous ordinary record under the reserved id
    await cmdCancel("system:other");
    assert.equal((await store.readTasks()).length, 0);
    // the NEXT tick's gate reconciles cleanly and creates/restores the canonical system task
    handlerCalls = 0;
    logs.length = 0;
    await tick(T12_NOW + 60000, opts());
    const tasks = await store.readTasks();
    assert.equal(tasks.length, 1);
    const digest = tasks.find((task: Task) => task.id === "system:morning-check-in")!;
    assert.equal(digest.system?.enabled, true);
    assert.equal(handlerCalls, 1); // ...and dispatched it (already due at the catch-up anchor)
    assert.ok(!logs.some((l) => l.includes("collision")));
  });
});
