import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredEvent } from "./calendar-store.ts";
import type { Task } from "./schedule-store.ts";
import { morningCheckInDefinition } from "./morning-check-in.ts";
import { addressToken, inspectMorningHandoff, sharedClose } from "./morning-handoff-store.ts";
import { reserveAgentRunSlot, releaseAgentRunSlot } from "./fire-quota.ts";
import { sendSms } from "./sms-cli.ts";
import { buildScheduleView } from "./schedule-mirror.ts";
import type { TickOptions } from "./heartbeat.ts";

const TZ = "America/Los_Angeles";
const friday = Date.parse("2026-08-21T16:00:00.000Z"); // 09:00 PDT
const monday = Date.parse("2026-08-24T16:00:00.000Z");
const tuesday = Date.parse("2026-08-25T16:00:00.000Z");

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "morning-integration-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const heartbeat = await import(`./heartbeat.ts?morning-integration=${Date.now()}${Math.random()}`);
  const store = await import(`./schedule-store.ts?morning-integration=${Date.now()}${Math.random()}`);
  return { dir, ...heartbeat, store };
}

function event(title: string, start: string, extra: Partial<StoredEvent> = {}): StoredEvent {
  return { uid: title, title, start, created: "", updated: "", ...extra };
}
function canonical(def: ReturnType<typeof morningCheckInDefinition>, next: string, attempts = 0): Task {
  return { id: "system:morning-check-in", desc: def.desc, cron: def.cron, at: null, tz: TZ, next_run_at: next, invisible_until: null, attempts, deliver: null, system: { key: "morning-check-in", enabled: true, policy: "v1:0 8 * * *:8:60:12" }, created_at: "2026-08-01T00:00:00.000Z" };
}
function opts(def: ReturnType<typeof morningCheckInDefinition>, log: string[], maxAttempts = 3): TickOptions {
  return { runFn: async () => { throw new Error("ordinary executor must not run"); }, reserveAgentRunFor: async () => ({ token: "quota-token" }), releaseAgentRun: async () => {}, visibilityMs: 60_000, maxAttempts, fallbackTz: TZ, registry: [def], systemHandlerResolver: key => key === def.key ? def.execute : undefined, log: line => log.push(line), claimNow: now => new Date(now) };
}
function setupFiles(dir: string, recipients: string[], own: readonly StoredEvent[] = [], names: Record<string, string> = {}, senders: string[] = []): { allow: string; ownPath: string; cache: string; feeds: string } {
  const allow = join(dir, "allow.json"), ownPath = join(dir, "own.json"), cache = join(dir, "family.json"), feeds = join(dir, "feeds.json");
  writeFileSync(allow, JSON.stringify({ version: 1, senders, recipients, names }));
  writeFileSync(ownPath, JSON.stringify(own));
  writeFileSync(feeds, JSON.stringify({ feeds: [] })); // real refresh still takes its lock/cache path
  return { allow, ownPath, cache, feeds };
}
function definition(files: ReturnType<typeof setupFiles>, sent: Array<{ to: string; subject: string; body: string }>, runs: any[], sms: string[] = [], run = async () => ({ failed: false, outOfTokens: false, resetsAt: null, resultText: "Hope you have a good day. Let me know if I can help." }), nowImpl = () => new Date()) {
  return morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    // Only model and transport are substituted. Refresh, cache locking, own-store
    // reads, allowlist/recipient resolution, delivery ordering and schedule store are real.
    runAgentImpl: async input => { runs.push(input); return run(); },
    sendSmsImpl: async phone => { sms.push(phone); throw new Error("sms transport unavailable"); },
    sendNewImpl: async (to, subject, body) => { sent.push({ to, subject, body }); },
    nowImpl,
  });
}
function localMinute(iso: string): string { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)); }

// Scenario 1: real tick -> reconcile -> store advance -> model/delivery chain.
test("integration 1: Friday calendar precedence uses sanitized digest, same-contact email fallback, aggregate audit, and one fresh range", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test"], [event("Team meeting", "2026-08-21T18:00:00.000Z", { location: "HQ" })], { "ari@example.test": "Ari", "+15550000001": "Ari" }, ["+15550000001"]);
  const sent: any[] = [], runs: any[] = [], sms: string[] = [], logs: string[] = [];
  const def = definition(files, sent, runs, sms);
  const before = canonical(def, "2026-08-21T15:12:00.000Z");
  await store.mutate((tasks: Task[]) => ({ tasks: [before], value: null }));
  await tick(friday, opts(def, logs));
  const after = (await store.readTasks())[0]!;
  assert.equal(runs.length, 1); assert.match(runs[0].prompt, /CALENDAR DATA/); assert.match(runs[0].prompt, /Team meeting/);
  assert.deepEqual(sms, ["+15550000001"]); // SMS transport fails, then the paired email is the same contact's fallback
  assert.deepEqual(sent.map(x => x.to), ["ari@example.test"]); assert.match(sent[0].subject, /2026-08-21/); assert.match(sent[0].body, /Hope you have a good day/);
  assert.notEqual(after.next_run_at, before.next_run_at); assert.match(localMinute(after.next_run_at), /^08:/);
  const audit = readFileSync(join(dir, "task-log.jsonl"), "utf8"); assert.match(audit, /contacts=1, prior-consumed=0, automatic-consumed=1, model-runs=1/); assert.doesNotMatch(audit, /Team meeting|Ari|HQ/);
  assert.ok(logs.every(line => !line.includes("Team meeting")));
});

// Scenario 2: no qualifying calendar event uses the full heartbeat path but does no delivery work.
test("integration 2: empty Friday and Monday snapshots no-op and advance schedules", async () => {
  for (const [now, label, own] of [
    [friday, "friday", [event("Tomorrow's concert", "2026-08-22T20:00:00.000Z")]],
    [monday, "monday", []],
  ] as const) {
    const { dir, tick, store } = await fresh();
    const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], own, { "ari@example.test": "Ari", "bea@example.test": "Bea" });
    const sent: any[] = [], runs: any[] = [];
    const def = definition(files, sent, runs);
    const before = canonical(def, label === "friday" ? "2026-08-21T15:01:00.000Z" : "2026-08-24T15:01:00.000Z");
    await store.mutate((tasks: Task[]) => ({ tasks: [before], value: null }));
    await tick(now, opts(def, []));
    assert.equal(runs.length, 0); assert.equal(sent.length, 0); assert.notEqual((await store.readTasks())[0]!.next_run_at, before.next_run_at);
  }
});

test("integration: a no-event Monday does not consume a direct one-shot morning reminder", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test"], [], { "ari@example.test": "Ari" });
  const sent: any[] = [], runs: any[] = [];
  const def = definition(files, sent, runs, [], undefined, () => new Date(monday));
  const checkIn = canonical(def, "2026-08-24T15:01:00.000Z");
  const reminder = { id: "deadbeef", desc: "Send the Verizon phone back", task: "Remind Ari to send the Verizon phone back.", cron: null, at: "2026-08-24T17:00:00.000Z", tz: TZ, next_run_at: "2026-08-24T17:00:00.000Z", invisible_until: null, attempts: 0, deliver: { surface: "mail" as const, target: "ari@example.test" }, created_at: "2026-08-20T00:00:00.000Z" };
  await store.mutate((tasks: Task[]) => ({ tasks: [checkIn, reminder], value: null }));

  await tick(monday, opts(def, []));

  assert.equal(runs.length, 0); assert.equal(sent.length, 0);
  assert.deepEqual((await store.readTasks()).map((task: Task) => task.id), ["system:morning-check-in", "deadbeef"]);
});

// Scenario 3 deliberately has admitted recipients: no-contact success cannot mask quota behavior.
test("integration 3: empty Tuesday with a full real quota does no reservation/model/provider work and advances once", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test"], [], { "ari@example.test": "Ari" });
  const sent: any[] = [], runs: any[] = [];
  const def = definition(files, sent, runs);
  const before = canonical(def, "2026-08-25T15:01:00.000Z");
  await store.mutate((tasks: Task[]) => ({ tasks: [before], value: null }));
  let reservations = 0;
  const full = { ...opts(def, []), reserveAgentRunFor: async () => { reservations++; return null; } };
  await tick(tuesday, full);
  const after = (await store.readTasks())[0]!;
  assert.equal(reservations, 0); assert.equal(runs.length, 0); assert.equal(sent.length, 0); assert.notEqual(after.next_run_at, before.next_run_at);
  assert.match(readFileSync(join(dir, "task-log.jsonl"), "utf8"), /"agent_run":false/);
});

// Scenario 4 includes row 18 and the queue/cutoff/trigger contracts in one real store sequence.
test("integration 4 / row 18: retry/cutoff/trigger preserve queue semantics and a 11:59 claim may finish after noon", async () => {
  const oldTz = process.env.BAXTER_TZ; process.env.BAXTER_TZ = TZ;
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test"], [event("Team meeting", "2026-08-21T19:30:00.000Z")], { "ari@example.test": "Ari" });
  const sent: any[] = [], runs: any[] = [];
  let finish!: () => void, markStarted!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const def = definition(files, sent, runs, [], async () => { markStarted(); await done; return { failed: false, outOfTokens: false, resetsAt: null, resultText: "The calendar note is ready." }; });
  const before = canonical(def, "2026-08-21T15:59:00.000Z");
  await store.mutate((tasks: Task[]) => ({ tasks: [before], value: null }));
  let claimClock = new Date("2026-08-21T18:59:59.000Z"); // controlled 11:59:59 PDT
  const inFlight = tick(Date.parse("2026-08-21T18:59:00.000Z"), { ...opts(def, []), claimNow: () => claimClock });
  await started; // the handler has definitely begun under the pre-noon claim
  claimClock = new Date("2026-08-21T19:00:00.000Z"); // controlled exact noon after claim
  finish(); await inFlight;
  const advanced = (await store.readTasks())[0]!;
  assert.equal(runs.length, 1); assert.notEqual(advanced.next_run_at, before.next_run_at); assert.equal(advanced.attempts, 0);

  // Nonfinal failure preserves the selected instant; final failure reselects once.
  const failDef = { ...def, execute: async () => ({ ok: false, agentRun: false }) };
  const retry = canonical(failDef, "2026-08-22T15:10:00.000Z");
  await store.mutate((tasks: Task[]) => ({ tasks: [retry], value: null }));
  await tick(Date.parse("2026-08-22T16:00:00.000Z"), opts(failDef, [], 2));
  assert.equal((await store.readTasks())[0]!.next_run_at, retry.next_run_at);
  await store.mutate((tasks: Task[]) => ({ tasks: [retry], value: null }));
  await tick(Date.parse("2026-08-22T16:00:00.000Z"), opts(failDef, [], 1));
  assert.notEqual((await store.readTasks())[0]!.next_run_at, retry.next_run_at);

  // Noon expiry invokes no handler. A due-now trigger after noon does invoke it and cannot mutate canonical bytes.
  const noon = canonical(def, "2026-08-23T15:10:00.000Z");
  let calls = 0; const counted = { ...def, execute: async (...args: Parameters<typeof def.execute>) => { calls++; return def.execute(...args); } };
  await store.mutate((tasks: Task[]) => ({ tasks: [noon], value: null }));
  await tick(Date.parse("2026-08-23T19:00:00.000Z"), opts(counted, [])); assert.equal(calls, 0);
  const canonicalBytes = JSON.stringify((await store.readTasks())[0]!);
  await store.mutate((tasks: Task[]) => ({ tasks: [...tasks, { id: "trigger-1", desc: counted.desc, task: null, cron: null, at: "2026-08-23T19:00:00.000Z", tz: null, next_run_at: "2026-08-23T19:00:00.000Z", invisible_until: null, attempts: 0, deliver: null, system_trigger: { key: "morning-check-in" }, created_at: "2026-08-23T19:00:00.000Z" }], value: null }));
  await tick(Date.parse("2026-08-23T19:00:00.000Z"), opts(counted, []));
  assert.equal(calls, 1); assert.equal(JSON.stringify((await store.readTasks()).find((t: Task) => t.id === "system:morning-check-in")), canonicalBytes);
  if (oldTz === undefined) delete process.env.BAXTER_TZ; else process.env.BAXTER_TZ = oldTz;
});

test("integration 5: startup removes valid retired duplicate pairs, mirrors one enabled morning record, and wrong pairs write nothing or dispatch nothing", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test"], [], { "ari@example.test": "Ari" });
  const sent: any[] = [], runs: any[] = []; const def = definition(files, sent, runs);
  const retired = ["daily-calendar-digest", "friday-weekend-check-in", "monday-weekly-check-in"];
  const legacy = retired.flatMap((key, i) => [0, 1].map(member => ({ id: `system:${key}`, desc: "retired", cron: "0 9 * * *", at: null, tz: "UTC", next_run_at: `2026-08-2${i}T09:00:00.000Z`, invisible_until: "2026-08-20T10:00:00.000Z", attempts: member + 1, deliver: null, system: { key, enabled: false }, created_at: "2026-08-01T00:00:00.000Z" })));
  await store.mutate((tasks: Task[]) => ({ tasks: legacy as Task[], value: null }));
  await tick(friday, opts(def, []));
  const migrated = await store.readTasks(); assert.equal(migrated.length, 1); assert.equal(migrated[0]!.system?.key, "morning-check-in"); assert.equal(migrated[0]!.system?.enabled, true);
  const view = await buildScheduleView(); assert.deepEqual(view.items.map(item => [item.system, item.enabled]), [[true, true]]);

  // Migration's freshly-created record was eligible at this fixture time; only
  // collision behavior below is relevant to the fail-closed assertion.
  runs.length = 0; sent.length = 0;
  const collision = { ...legacy[0]!, system: { key: "monday-weekly-check-in", enabled: true } } as Task;
  const original = JSON.stringify([collision]); await store.mutate((tasks: Task[]) => ({ tasks: [collision], value: null }));
  await tick(friday, opts(def, []));
  assert.equal(JSON.stringify(await store.readTasks()), original); assert.equal(runs.length, 0); assert.equal(sent.length, 0);
});

// These use the durable quota file, rather than a hand-written reserve callback.
// The handler still gets its reservation through a real heartbeat tick.
test("integration 6: real durable quota denial and token refund stop later models but fallback-deliver every contact", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], [event("Monday plan", "2026-08-24T19:00:00.000Z")], { "ari@example.test": "Ari", "bea@example.test": "Bea" });
  const sent: any[] = [], runs: any[] = [];
  const before = canonical(morningCheckInDefinition(), "2026-08-24T15:01:00.000Z");
  const at = new Date(monday);
  const quota = (id: string) => reserveAgentRunSlot(at, 1, id);
  const release = (token: string) => releaseAgentRunSlot(token);

  // Fill the real one-slot quota before the fire: every admitted contact gets
  // fallback delivery, but there is no model attempt after the first denial.
  assert.ok(await quota("already-used"));
  const deniedDef = definition(files, sent, runs);
  await store.mutate((tasks: Task[]) => ({ tasks: [{ ...before, desc: deniedDef.desc, cron: deniedDef.cron }], value: null }));
  await tick(monday, { ...opts(deniedDef, []), reserveAgentRunFor: quota, releaseAgentRun: release });
  assert.equal(runs.length, 0); assert.deepEqual(sent.map(x => x.to), ["ari@example.test", "bea@example.test"]);

  // A fresh durable quota and an out-of-tokens first model refund only that
  // token; it stops later model attempts while both contacts receive fallback.
  writeFileSync(join(dir, "fire-quota.json"), JSON.stringify({ version: 1, date: "2026-08-24", reservations: [] }));
  // This is a distinct test scenario for the same synthetic selected instant;
  // reset the sidecar as well as quota state rather than accidentally asserting
  // prior-consumption suppression instead of the token-refund contract.
  writeFileSync(join(dir, "morning-handoff.json"), JSON.stringify({ version: 1, occurrences: {} }));
  sent.length = 0; runs.length = 0;
  const tokenDef = definition(files, sent, runs, [], async () => ({ failed: false, outOfTokens: true, resetsAt: null, resultText: "" }));
  await store.mutate((tasks: Task[]) => ({ tasks: [{ ...before, desc: tokenDef.desc, cron: tokenDef.cron }], value: null }));
  await tick(monday, { ...opts(tokenDef, []), reserveAgentRunFor: quota, releaseAgentRun: release });
  assert.equal(runs.length, 1); assert.deepEqual(sent.map(x => x.to), ["ari@example.test", "bea@example.test"]);
  const quotaState = JSON.parse(readFileSync(join(dir, "fire-quota.json"), "utf8"));
  assert.deepEqual(quotaState.reservations, [], "out-of-tokens refunded exactly its own real durable reservation");
});

test("integration 7: real two-contact loop reserves immediately before each model, preserves copy attribution, and isolates provider failure", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], [event("Monday plan", "2026-08-24T19:00:00.000Z")], { "ari@example.test": "Ari", "bea@example.test": "Bea", "+15550000001": "Ari", "+15550000002": "Bea" }, ["+15550000001", "+15550000002"]);
  const order: string[] = [], delivered: Array<{ channel: string; to: string; text: string }> = [];
  let model = 0;
  const def = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    runAgentImpl: async () => { const index = model++; order.push(`model:${index}`); return { failed: false, outOfTokens: false, resetsAt: null, resultText: index === 0 ? "First private copy. Let me know if I can help." : "Second private copy. Let me know if I can help." }; },
    sendSmsImpl: async (phone, text) => { order.push(`sms:${phone}`); delivered.push({ channel: "sms", to: phone, text }); if (phone.endsWith("01")) throw new Error("provider one failed"); },
    sendNewImpl: async (to, _subject, text) => { order.push(`email:${to}`); delivered.push({ channel: "email", to, text }); },
  });
  let reserve = 0;
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(def, "2026-08-24T15:01:00.000Z")], value: null }));
  await tick(monday, { ...opts(def, []), reserveAgentRunFor: async () => { order.push(`reserve:${reserve}`); return { token: `slot-${reserve++}` }; } });
  assert.deepEqual(order, ["reserve:0", "model:0", "sms:+15550000001", "email:ari@example.test", "reserve:1", "model:1", "sms:+15550000002"]);
  assert.match(delivered.find(x => x.to === "ari@example.test")!.text, /First private copy/);
  assert.match(delivered.find(x => x.to === "+15550000002")!.text, /Second private copy/);
  assert.doesNotMatch(delivered.find(x => x.to === "ari@example.test")!.text, /Second private copy/);
});

test("integration 9: prior consumption filters work and unavailable sidecar advances without calendar/model/provider work", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], [event("Monday plan", "2026-08-24T19:00:00.000Z")], { "ari@example.test": "Ari", "bea@example.test": "Bea" });
  const sent: any[] = [], runs: any[] = [], logs: string[] = [];
  const def = definition(files, sent, runs);
  const occurrence = "2026-08-24T15:01:00.000Z";
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(def, occurrence)], value: null }));
  writeFileSync(join(dir, "morning-handoff.json"), JSON.stringify({ version: 1, occurrences: { [occurrence]: { closed: false, consumed: [addressToken("ari@example.test")], updated_at: "2026-08-24T16:00:00.000Z" } } }));
  await tick(monday, opts(def, logs));
  assert.equal(runs.length, 1, "prior-consumed contact has no quota/model work");
  assert.deepEqual(sent.map(item => item.to), ["bea@example.test"], "only pending contact reaches provider fallback");
  assert.match(readFileSync(join(dir, "task-log.jsonl"), "utf8"), /prior-consumed=1, automatic-consumed=1/);
  assert.deepEqual(await inspectMorningHandoff(occurrence, new Date(monday)), { state: "closed" }, "final automatic winner closes the occurrence");

  const unavailableOccurrence = "2026-08-24T15:02:00.000Z";
  let unavailableRefresh = 0, unavailableOwn = 0, unavailableReserve = 0, unavailableProvider = 0;
  const unavailableDef = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    refreshImpl: async () => { unavailableRefresh++; throw new Error("sidecar inspection must precede qualifying calendar preparation"); },
    readOwnEventsImpl: () => { unavailableOwn++; return [event("Calendar evidence", "2026-08-24T18:00:00.000Z")]; },
    runAgentImpl: async () => { throw new Error("unavailable sidecar must not model"); },
    sendSmsImpl: async () => { unavailableProvider++; }, sendNewImpl: async () => { unavailableProvider++; },
  });
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(unavailableDef, unavailableOccurrence)], value: null }));
  writeFileSync(join(dir, "morning-handoff.json"), "corrupt");
  sent.length = 0; runs.length = 0;
  await tick(monday, { ...opts(unavailableDef, logs), reserveAgentRunFor: async () => { unavailableReserve++; return { token: "must-not-reserve" }; } });
  assert.deepEqual([unavailableRefresh, unavailableOwn, unavailableReserve, unavailableProvider, runs.length, sent.length], [0, 0, 0, 0, 0, 0], "unavailable sidecar is an advancing no-op before calendar/quota/model/provider work");
  const unavailableAdvanced = (await store.readTasks())[0]!.next_run_at;
  assert.notEqual(unavailableAdvanced, unavailableOccurrence, "unavailable no-op advances exactly once");
  await tick(monday + 60_000, { ...opts(unavailableDef, logs), reserveAgentRunFor: async () => { unavailableReserve++; return { token: "must-not-reserve" }; } });
  assert.equal((await store.readTasks())[0]!.next_run_at, unavailableAdvanced, "a second unavailable tick does not advance the already-advanced occurrence");
  assert.ok(logs.every(line => !/ari@example\.test|bea@example\.test|deadbeef/i.test(line)), "handoff diagnostics remain aggregate only");
});

test("integration 10: real sidecar serializes shared-close races around automatic consumption and preserves the winning fallback chain", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], [event("Monday plan", "2026-08-24T19:00:00.000Z")], { "ari@example.test": "Ari", "bea@example.test": "Bea", "+15550000001": "Ari" }, ["+15550000001"]);
  const occurrence = "2026-08-24T15:01:00.000Z";
  const sent: Array<{ to: string }> = [];
  const runs: any[] = [];
  const provider = { calls: [] as string[] };
  const logs: string[] = [];
  let modelStarted!: () => void, releaseModel!: () => void;
  const started = new Promise<void>(resolve => { modelStarted = resolve; });
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  const beforeFinal = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    runAgentImpl: async input => { runs.push(input); modelStarted(); await modelGate; return { failed: false, outOfTokens: false, resetsAt: null, resultText: "A calm update. Let me know if I can help." }; },
    sendSmsImpl: async phone => { provider.calls.push(`sms:${phone}`); },
    sendNewImpl: async to => { provider.calls.push(`email:${to}`); sent.push({ to }); },
  });
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(beforeFinal, occurrence)], value: null }));
  const early = tick(monday, opts(beforeFinal, logs));
  await started;
  assert.deepEqual(await sharedClose(occurrence, true, new Date(monday)), { decision: "shared-closed", contextEligible: true }, "real inbound/shared transaction wins while automatic copy is gated");
  releaseModel(); await early;
  assert.deepEqual(provider.calls, [], "shared close before final automatic consume discards prepared SMS/email provider work");
  assert.equal(sent.length, 0, "prepared email work is suppressed before it can reach the provider");
  assert.deepEqual(await inspectMorningHandoff(occurrence, new Date(monday)), { state: "closed" });

  // Reset the next canonical occurrence.  Automatic consumption wins before
  // provider work; a later shared close cannot interrupt that contact's
  // SMS-failure/email fallback, but does suppress Bea's later provider chain.
  const second = "2026-08-24T15:02:00.000Z";
  let smsStarted!: () => void, releaseSms!: () => void;
  const smsStartedPromise = new Promise<void>(resolve => { smsStarted = resolve; });
  const smsGate = new Promise<void>(resolve => { releaseSms = resolve; });
  const automaticFirst = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    runAgentImpl: async input => { runs.push(input); return { failed: false, outOfTokens: false, resetsAt: null, resultText: "A calm update. Let me know if I can help." }; },
    sendSmsImpl: async (...args: any[]) => { const phone = args[0] as string; provider.calls.push(`sms:${phone}`); smsStarted(); await smsGate; throw new Error("provider failure"); },
    sendNewImpl: async (...args: any[]) => { const to = args[0] as string; provider.calls.push(`email:${to}`); sent.push({ to }); },
  });
  provider.calls.length = 0; runs.length = 0;
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(automaticFirst, second)], value: null }));
  const automatic = tick(monday, opts(automaticFirst, logs));
  await smsStartedPromise;
  assert.deepEqual(await sharedClose(second, true, new Date(monday)), { decision: "shared-closed", contextEligible: false }, "automatic token makes later shared close silent");
  releaseSms(); await automatic;
  assert.deepEqual(provider.calls, ["sms:+15550000001", "email:ari@example.test"], "automatic winner completes its same-contact fallback and later contact is suppressed");
  assert.deepEqual(sent.map(item => item.to), ["ari@example.test"]);
  assert.deepEqual(await inspectMorningHandoff(second, new Date(monday)), { state: "closed" }, "provider failure never rolls back durable automatic consumption");
  const automaticToken = addressToken("ari@example.test");
  const persistedAutomatic = readFileSync(join(dir, "morning-handoff.json"), "utf8");
  assert.match(persistedAutomatic, new RegExp(automaticToken), "the automatic winner token remains persisted after the later shared close and provider failure");
  const audit = readFileSync(join(dir, "task-log.jsonl"), "utf8");
  assert.match(audit, /automatic-consumed=1/); assert.doesNotMatch(audit, /ari@example\.test|bea@example\.test|15550000001/);
});

test("integration 11: real ticks advance closed/unavailable no-ops once and retain an open fully-consumed occurrence across calendar recovery", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test"], [], { "ari@example.test": "Ari" });
  const occurrence = "2026-08-24T15:01:00.000Z";
  let refresh = 0, reserve = 0, model = 0, provider = 0;
  const closedDef = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    refreshImpl: async () => { refresh++; throw new Error("calendar must not run"); }, readOwnEventsImpl: () => { throw new Error("own calendar must not run"); },
    runAgentImpl: async () => { model++; return { failed: false, outOfTokens: false, resetsAt: null, resultText: "" }; }, sendSmsImpl: async () => { provider++; }, sendNewImpl: async () => { provider++; },
  });
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(closedDef, occurrence)], value: null }));
  assert.deepEqual(await sharedClose(occurrence, false, new Date(monday)), { decision: "shared-closed", contextEligible: false });
  await tick(monday, { ...opts(closedDef, []), reserveAgentRunFor: async () => { reserve++; return { token: "must-not-reserve" }; } });
  const advanced = (await store.readTasks())[0]!;
  assert.notEqual(advanced.next_run_at, occurrence); assert.deepEqual([refresh, reserve, model, provider], [0, 0, 0, 0]);
  await tick(monday + 60_000, { ...opts(closedDef, []), reserveAgentRunFor: async () => { reserve++; return { token: "must-not-reserve" }; } });
  assert.equal((await store.readTasks())[0]!.next_run_at, advanced.next_run_at, "a second closed tick does not advance the already-advanced occurrence");
  assert.deepEqual([refresh, reserve, model, provider], [0, 0, 0, 0], "closed tick advanced exactly once");

  const retryOccurrence = "2026-08-21T15:01:00.000Z";
  let calendarAvailable = false;
  let recoveryReserve = 0, recoveryModel = 0, recoverySms = 0, recoveryEmail = 0;
  const recoveryDef = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    refreshImpl: async () => calendarAvailable ? ({ urls: [], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: true }) : ({ urls: ["https://calendar.test/feed"], ok: false, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: false }),
    readOwnEventsImpl: () => [event("Friday plan", "2026-08-21T19:00:00.000Z")], runAgentImpl: async () => { recoveryModel++; throw new Error("fully consumed roster must not model"); }, sendSmsImpl: async () => { recoverySms++; throw new Error("fully consumed roster must not send"); }, sendNewImpl: async () => { recoveryEmail++; throw new Error("fully consumed roster must not send"); },
  });
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(recoveryDef, retryOccurrence)], value: null }));
  writeFileSync(join(dir, "morning-handoff.json"), JSON.stringify({ version: 1, occurrences: { [retryOccurrence]: { closed: false, consumed: [addressToken("ari@example.test")], updated_at: "2026-08-21T16:00:00.000Z" } } }));
  await tick(friday, { ...opts(recoveryDef, []), reserveAgentRunFor: async () => { recoveryReserve++; return { token: "must-not-reserve" }; } });
  assert.equal((await store.readTasks())[0]!.next_run_at, retryOccurrence, "qualifying Friday calendar failure retains the selected occurrence despite fully-consumed tokens");
  calendarAvailable = true;
  await tick(friday + 60_001, { ...opts(recoveryDef, []), visibilityMs: 0, reserveAgentRunFor: async () => { recoveryReserve++; return { token: "must-not-reserve" }; } });
  const recovered = (await store.readTasks())[0]!;
  assert.notEqual(recovered.next_run_at, retryOccurrence, "successful preparation filters the fully-consumed roster and advances once");
  assert.deepEqual([recoveryReserve, recoveryModel, recoverySms, recoveryEmail], [0, 0, 0, 0], "fully-consumed recovery has no hidden reservation, model, or provider work");
  await tick(friday + 120_002, { ...opts(recoveryDef, []), visibilityMs: 0, reserveAgentRunFor: async () => { recoveryReserve++; return { token: "must-not-reserve" }; } });
  assert.equal((await store.readTasks())[0]!.next_run_at, recovered.next_run_at, "recovery's all-consumed no-op is not retried after advancement");
});

test("integration 12: mid-handler sidecar loss preserves completed work, and automatic provider failure remains an advancing no-retry", async () => {
  const { dir, tick, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], [], { "ari@example.test": "Ari", "bea@example.test": "Bea", "+15550000001": "Ari" }, ["+15550000001"]);
  const calls: string[] = [];
  const mid = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    refreshImpl: async () => ({ urls: [], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: true }), readOwnEventsImpl: () => [event("Qualifying calendar", "2026-08-24T18:00:00.000Z")],
    runAgentImpl: async () => ({ failed: false, outOfTokens: false, resetsAt: null, resultText: "Hello. Let me know if I can help." }),
    sendSmsImpl: async phone => { calls.push(`sms:${phone}`); writeFileSync(join(dir, "morning-handoff.json"), "raw-sidecar-error-secret"); },
    sendNewImpl: async to => { calls.push(`email:${to}`); },
  });
  const midOccurrence = "2026-08-24T15:03:00.000Z";
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(mid, midOccurrence)], value: null }));
  await tick(monday, opts(mid, []));
  assert.deepEqual(calls, ["sms:+15550000001"], "sidecar loss stops later recipients without undoing completed provider work");
  assert.notEqual((await store.readTasks())[0]!.next_run_at, midOccurrence, "mid-handler unavailable is a successful advancing completion");

  const failureFiles = setupFiles(dir, ["ari@example.test"], [], { "ari@example.test": "Ari" });
  let failures = 0;
  const failure = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: failureFiles.allow, ownEventsPath: failureFiles.ownPath, cachePath: failureFiles.cache, feedsPath: failureFiles.feeds,
    refreshImpl: async () => ({ urls: [], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: true }), readOwnEventsImpl: () => [event("Qualifying calendar", "2026-08-21T18:00:00.000Z")],
    runAgentImpl: async () => ({ failed: false, outOfTokens: false, resetsAt: null, resultText: "Hello. Let me know if I can help." }),
    sendSmsImpl: async () => { failures++; throw new Error("provider-total-secret"); }, sendNewImpl: async () => { failures++; throw new Error("provider-total-secret"); },
  });
  const failureOccurrence = "2026-08-21T15:04:00.000Z";
  writeFileSync(join(dir, "morning-handoff.json"), JSON.stringify({ version: 1, occurrences: {} }));
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical(failure, failureOccurrence)], value: null }));
  await tick(friday, opts(failure, []));
  assert.equal(failures, 1, "email-only contact records one total provider failure after automatic consumption");
  assert.deepEqual(await inspectMorningHandoff(failureOccurrence, new Date(friday)), { state: "closed" }, "provider failure retains the durable automatic winner");
  assert.match(readFileSync(join(dir, "morning-handoff.json"), "utf8"), new RegExp(addressToken("ari@example.test")), "total provider failure retains the automatic winner token in raw sidecar state");
  const failureAdvanced = (await store.readTasks())[0]!.next_run_at;
  await tick(friday + 60_000, { ...opts(failure, []), visibilityMs: 0 });
  assert.equal(failures, 1); assert.equal((await store.readTasks())[0]!.next_run_at, failureAdvanced, "automatic provider failure creates no handoff retry");
});

test("integration 13: manual morning triggers never inspect a closed or corrupt handoff sidecar", async () => {
  const { dir, store } = await fresh();
  const files = setupFiles(dir, ["ari@example.test"], [], { "ari@example.test": "Ari" });
  writeFileSync(join(dir, "morning-handoff.json"), "corrupt-sidecar-token");
  let inspected = 0, automatic = 0, sent = 0;
  const def = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    inspectMorningHandoffImpl: async () => { inspected++; throw new Error("manual trigger must not inspect"); },
    automaticConsumeImpl: async () => { automatic++; throw new Error("manual trigger must not consume automatically"); },
    refreshImpl: async () => ({ urls: [], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: true }), readOwnEventsImpl: () => [event("Manual calendar", "2026-08-24T18:00:00.000Z")],
    runAgentImpl: async () => ({ failed: false, outOfTokens: false, resetsAt: null, resultText: "Hello. Let me know if I can help." }), sendSmsImpl: async () => {}, sendNewImpl: async () => { sent++; }, nowImpl: () => new Date(monday),
  });
  const manual = { id: "manual", desc: def.desc, task: null, cron: null, at: "2026-08-24T16:00:00.000Z", tz: null, next_run_at: "2026-08-24T16:00:00.000Z", invisible_until: null, attempts: 0, deliver: null, system_trigger: { key: "morning-check-in" }, created_at: "2026-08-24T16:00:00.000Z" } as unknown as Task;
  const reminder = { id: "deadbeef", desc: "Keep for normal scheduling", task: "Remind Ari later.", cron: null, at: "2026-08-24T17:00:00.000Z", tz: TZ, next_run_at: "2026-08-24T17:00:00.000Z", invisible_until: null, attempts: 0, deliver: { surface: "mail" as const, target: "ari@example.test" }, created_at: "2026-08-24T00:00:00.000Z" };
  await store.mutate((tasks: Task[]) => ({ tasks: [reminder], value: null }));
  const result = await def.execute(manual, { now: new Date(monday), reserveAgentRun: async () => ({ token: "manual" }), releaseAgentRun: async () => {}, log: () => {} });
  assert.deepEqual([inspected, automatic, sent], [0, 0, 1]);
  assert.deepEqual((await store.readTasks()).map((task: Task) => task.id), ["deadbeef"], "manual triggers leave ordinary reminders to normal scheduling");
  assert.equal(readFileSync(join(dir, "morning-handoff.json"), "utf8"), "corrupt-sidecar-token", "manual execution leaves corrupt sidecar bytes byte-identical");
  assert.equal(result.ok, true, "manual standalone delivery survives closed/corrupt sidecar state");
  assert.equal(result.detail, "contacts=1, model-runs=1, generated=0, fallbacks=1, delivered=0sms+1email, failed=0", "manual delivery retains the exact standalone aggregate without handoff fields");

  const emptyFiles = setupFiles(dir, []);
  const emptyDef = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: emptyFiles.allow, ownEventsPath: emptyFiles.ownPath, cachePath: emptyFiles.cache, feedsPath: emptyFiles.feeds,
    inspectMorningHandoffImpl: async () => { throw new Error("manual zero-recipient trigger must not inspect"); },
    automaticConsumeImpl: async () => { throw new Error("manual zero-recipient trigger must not consume automatically"); },
    refreshImpl: async () => ({ urls: [], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: true }), readOwnEventsImpl: () => [],
  });
  const emptyManual = { ...manual, id: "manual-empty", desc: emptyDef.desc };
  const empty = await emptyDef.execute(emptyManual, { now: new Date(monday), reserveAgentRun: async () => ({ token: "must-not-reserve" }), releaseAgentRun: async () => {}, log: () => {} });
  assert.deepEqual(empty, { ok: true, agentRun: false, detail: "no qualifying events" }, "a no-event manual trigger does no recipient or sidecar work");
});

test("integration 8: real provider entry admission rechecks revoked SMS/email recipients after generation without prompt or log leakage", async () => {
  const { dir, tick, store } = await fresh();
  const email = "ari@example.test", phone = "+15550000001";
  const files = setupFiles(dir, [email], [event("Monday plan", "2026-08-24T19:00:00.000Z")], { [email]: "Ari", [phone]: "Ari" }, [phone]);
  const sent: any[] = [], runs: any[] = [], wire: string[] = [], logs: string[] = [];
  const oldEmail = process.env.BAXTER_EMAIL;
  process.env.BAXTER_EMAIL = "baxter@example.test";
  // This cache-busted import samples BAXTER_EMAIL for the real sendNew entry.
  const mail = await import(`./mail-cli.ts?morning-provider-admission=${Date.now()}`);
  let revoked = false;
  const def = morningCheckInDefinition({
    env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds,
    runAgentImpl: async input => { runs.push(input); writeFileSync(files.allow, JSON.stringify({ version: 1, senders: [], recipients: [], names: {} })); revoked = true; return { failed: false, outOfTokens: false, resetsAt: null, resultText: "Hope you have a good day. Let me know if I can help." }; },
    // Real sendSms admission; transport is the only stub and must never run.
    sendSmsImpl: async (number, body, providerDeps) => sendSms(number, body, { ...providerDeps, fetchImpl: async url => { wire.push(url); return new Response("{}", { status: 200 }); } }),
    // Real sendNew admission; Resend transport and post-admission guards only are stubbed.
    sendNewImpl: async (to, subject, body, providerDeps) => mail.sendNew(to, subject, body, { ...providerDeps, gateOutbound: async () => {}, assertUnderSendCap: async () => {}, append: async () => {}, resend: () => ({ emails: { send: async () => { wire.push("resend"); return { data: { id: "test" }, error: null }; } } }) }),
  });
  try {
    await store.mutate((tasks: Task[]) => ({ tasks: [canonical(def, "2026-08-24T15:01:00.000Z")], value: null }));
    await tick(monday, opts(def, logs));
  } finally {
    if (oldEmail === undefined) delete process.env.BAXTER_EMAIL; else process.env.BAXTER_EMAIL = oldEmail;
  }
  assert.equal(revoked, true); assert.equal(runs.length, 1); assert.deepEqual(wire, [], "revoked destinations never reach either external transport");
  assert.doesNotMatch(runs[0].prompt, /ari@example\.test|15550000001/);
  assert.ok(logs.every(line => !line.includes(email) && !line.includes(phone)));
  assert.equal(sent.length, 0);
});
