import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredEvent } from "./calendar-store.ts";
import type { Task } from "./schedule-store.ts";
import { morningCheckInDefinition } from "./morning-check-in.ts";
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
function setupFiles(dir: string, recipients: string[], own: StoredEvent[] = [], names: Record<string, string> = {}, senders: string[] = []): { allow: string; ownPath: string; cache: string; feeds: string; memory: string; collections: string } {
  const allow = join(dir, "allow.json"), ownPath = join(dir, "own.json"), cache = join(dir, "family.json"), feeds = join(dir, "feeds.json"), memory = join(dir, "MEMORY.md"), collections = join(dir, "collections");
  writeFileSync(allow, JSON.stringify({ version: 1, senders, recipients, names }));
  writeFileSync(ownPath, JSON.stringify(own));
  writeFileSync(feeds, JSON.stringify({ feeds: [] })); // real refresh still takes its lock/cache path
  writeFileSync(memory, "Family preferences: concise notes.");
  return { allow, ownPath, cache, feeds, memory, collections };
}
function definition(files: ReturnType<typeof setupFiles>, sent: Array<{ to: string; subject: string; body: string }>, runs: any[], sms: string[] = [], run = async () => ({ failed: false, outOfTokens: false, resetsAt: null, resultText: JSON.stringify({ subject: "A kind note", body: "Hope you have a good day. Let me know if I can help." }) })) {
  return morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds, memoryPath: files.memory, collectionsDir: files.collections,
    // Only model and transport are substituted. Refresh, cache locking, own-store
    // reads, allowlist/recipient resolution, delivery ordering and schedule store are real.
    runAgentImpl: async input => { runs.push(input); return run(); },
    sendSmsImpl: async phone => { sms.push(phone); throw new Error("sms transport unavailable"); },
    sendNewImpl: async (to, subject, body) => { sent.push({ to, subject, body }); },
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
  assert.deepEqual(sent.map(x => x.to), ["ari@example.test"]); assert.match(sent[0].subject, /2026-08-21/);
  assert.notEqual(after.next_run_at, before.next_run_at); assert.match(localMinute(after.next_run_at), /^08:/);
  const audit = readFileSync(join(dir, "task-log.jsonl"), "utf8"); assert.match(audit, /contacts=1, model-runs=1/); assert.doesNotMatch(audit, /Team meeting|Ari|HQ/);
  assert.ok(logs.every(line => !line.includes("Team meeting")));
});

// Scenario 2: both empty fallback modes use the full heartbeat path for two contacts.
test("integration 2: empty Friday and Monday snapshot reserve/model/deliver per contact with title-only Friday and calendar-free Monday", async () => {
  for (const [now, label] of [[friday, "friday"], [monday, "monday"]] as const) {
    const { dir, tick, store } = await fresh();
    const own = label === "friday" ? [event("Concert", "2026-08-22T20:00:00.000Z", { location: "Secret Hall" })] : [];
    const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], own, { "ari@example.test": "Ari", "bea@example.test": "Bea" });
    const sent: any[] = [], runs: any[] = [];
    const def = definition(files, sent, runs);
    const before = canonical(def, label === "friday" ? "2026-08-21T15:01:00.000Z" : "2026-08-24T15:01:00.000Z");
    await store.mutate((tasks: Task[]) => ({ tasks: [before], value: null }));
    await tick(now, opts(def, []));
    assert.equal(runs.length, 2); assert.equal(sent.length, 2); assert.notEqual((await store.readTasks())[0]!.next_run_at, before.next_run_at);
    if (label === "friday") { for (const run of runs) { assert.match(run.prompt, /\{"title":"Concert"\}/); assert.doesNotMatch(run.prompt, /Secret Hall|Saturday|20:00/); } }
    else for (const run of runs) assert.doesNotMatch(run.prompt, /Concert|CALENDAR|WEEKEND/);
  }
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
  const files = setupFiles(dir, ["ari@example.test"], [], { "ari@example.test": "Ari" });
  const sent: any[] = [], runs: any[] = [];
  let finish!: () => void, markStarted!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const def = definition(files, sent, runs, [], async () => { markStarted(); await done; return { failed: false, outOfTokens: false, resetsAt: null, resultText: JSON.stringify({ subject: "Note", body: "Hello. Let me know if I can help." }) }; });
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
  const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], [], { "ari@example.test": "Ari", "bea@example.test": "Bea" });
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
  const files = setupFiles(dir, ["ari@example.test", "bea@example.test"], [], { "ari@example.test": "Ari", "bea@example.test": "Bea", "+15550000001": "Ari", "+15550000002": "Bea" }, ["+15550000001", "+15550000002"]);
  const order: string[] = [], delivered: Array<{ channel: string; to: string; text: string }> = [];
  let model = 0;
  const def = morningCheckInDefinition({ env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds, memoryPath: files.memory, collectionsDir: files.collections,
    runAgentImpl: async () => { const index = model++; order.push(`model:${index}`); return { failed: false, outOfTokens: false, resetsAt: null, resultText: JSON.stringify(index === 0 ? { subject: "A kind note", body: "First private copy. Let me know if I can help." } : { subject: "A gentle note", body: "Second private copy. Let me know if I can help." }) }; },
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

test("integration 8: real provider entry admission rechecks revoked SMS/email recipients after generation without prompt or log leakage", async () => {
  const { dir, tick, store } = await fresh();
  const email = "ari@example.test", phone = "+15550000001";
  const files = setupFiles(dir, [email], [], { [email]: "Ari", [phone]: "Ari" }, [phone]);
  const sent: any[] = [], runs: any[] = [], wire: string[] = [], logs: string[] = [];
  const oldEmail = process.env.BAXTER_EMAIL;
  process.env.BAXTER_EMAIL = "baxter@example.test";
  // This cache-busted import samples BAXTER_EMAIL for the real sendNew entry.
  const mail = await import(`./mail-cli.ts?morning-provider-admission=${Date.now()}`);
  let revoked = false;
  const def = morningCheckInDefinition({
    env: { BAXTER_TZ: TZ }, allowlistPath: files.allow, ownEventsPath: files.ownPath, cachePath: files.cache, feedsPath: files.feeds, memoryPath: files.memory, collectionsDir: files.collections,
    runAgentImpl: async input => { runs.push(input); writeFileSync(files.allow, JSON.stringify({ version: 1, senders: [], recipients: [], names: {} })); revoked = true; return { failed: false, outOfTokens: false, resetsAt: null, resultText: JSON.stringify({ subject: "A kind note", body: "Hope you have a good day. Let me know if I can help." }) }; },
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
