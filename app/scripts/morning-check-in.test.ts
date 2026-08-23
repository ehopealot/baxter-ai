import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { morningCheckInDefinition } from "./morning-check-in.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { SystemTaskContext } from "./system-tasks.ts";

const task = { id: "system:morning-check-in", cron: "0 8 * * *", next_run_at: "2026-08-21T15:00:00Z", system: { key: "morning-check-in", enabled: true } };
function harness(now: Date, own: StoredEvent[] = [], family: any[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "morning-")); const allow = join(dir, "allow.json");
  writeFileSync(allow, JSON.stringify({ version: 1, senders: [], recipients: ["a@x.test"], names: { "a@x.test": "Ari" } }));
  const calls = { refresh: 0, own: 0, knowledge: 0, reserve: 0, run: [] as any[], sms: 0, email: [] as any[] };
  const def = morningCheckInDefinition({ env: { BAXTER_TZ: "America/Los_Angeles" }, allowlistPath: allow,
    refreshImpl: async () => { calls.refresh++; return { urls: ["https://feed.test/x.ics"], ok: true, events: family, errors: [], wroteCache: false, familySnapshot: family }; },
    readOwnEventsImpl: () => { calls.own++; return own; }, loadKnowledgeImpl: () => { calls.knowledge++; return { text: "private household note", empty: false, includedCollections: 1, omittedCollections: 0, truncatedSources: 0 }; },
    runAgentImpl: async (o) => { calls.run.push(o); return { failed: false, outOfTokens: false, resetsAt: null, resultText: o.prompt.includes("CALENDAR DATA") ? "A clear calendar update." : JSON.stringify({ subject: "A gentle note", body: "Hope things are going well. Let me know if I can help." }) }; },
    sendSmsImpl: async () => { calls.sms++; throw new Error("sms unavailable"); }, sendNewImpl: async (...args) => { calls.email.push(args); },
  });
  const ctx: SystemTaskContext = { now, reserveAgentRun: async () => { calls.reserve++; return { token: "t" }; }, releaseAgentRun: async () => {}, log: () => {} };
  return { calls, execute: () => def.execute(task, ctx) };
}
const event = (title = "Dentist"): StoredEvent => ({ uid: title, title, start: "2026-08-21T18:00:00Z", end: "2026-08-21T19:00:00Z", created: "", updated: "" });

test("morning check-in is the single daily ranged system definition", () => {
  const def = morningCheckInDefinition(); assert.equal(def.key, "morning-check-in"); assert.equal(def.cron, "0 8 * * *"); assert.deepEqual(def.window, { startHour: 8, minuteSlots: 60, cutoffHour: 12 });
});
test("calendar wins over Friday and Monday fallback modes", async () => {
  for (const [now, todayEvent] of [[new Date("2026-08-21T16:00:00Z"), event()], [new Date("2026-08-24T16:00:00Z"), { ...event(), start: "2026-08-24T18:00:00Z", end: "2026-08-24T19:00:00Z" }]] as const) { const h = harness(now, [todayEvent]); await h.execute(); assert.match(h.calls.run[0].prompt, /CALENDAR DATA/); assert.equal(h.calls.knowledge, 0); }
});
test("empty Friday uses title-only weekend hint and empty Monday has no calendar prompt", async () => {
  const friday = harness(new Date("2026-08-21T16:00:00Z"), [], [{ uid: "w", title: "Concert", location: "Secret Hall", startMs: Date.parse("2026-08-22T20:00:00Z"), endMs: null, allDay: false, rrule: null, url: "https://secret.test" }]); await friday.execute();
  assert.match(friday.calls.run[0].prompt, /Optional weekend title: Concert/); assert.doesNotMatch(friday.calls.run[0].prompt, /Secret Hall|secret\.test|Saturday|20:00/);
  const monday = harness(new Date("2026-08-24T16:00:00Z")); await monday.execute(); assert.doesNotMatch(monday.calls.run[0].prompt, /CALENDAR|Optional weekend/);
});
test("empty non-Friday/Monday does no recipient, knowledge, quota, model, or provider work", async () => {
  const h = harness(new Date("2026-08-20T16:00:00Z")); const result = await h.execute(); assert.deepEqual(result, { ok: true, agentRun: false, detail: "no qualifying events" }); assert.deepEqual(h.calls, { refresh: 1, own: 1, knowledge: 0, reserve: 0, run: [], sms: 0, email: [] });
});
test("calendar unavailability fails before recipient work and never falls through to Friday", async () => {
  const h = harness(new Date("2026-08-21T16:00:00Z")); const def = morningCheckInDefinition({ readOwnEventsImpl: () => { throw new Error("bad"); } });
  const result = await def.execute(task, { now: new Date("2026-08-21T16:00:00Z"), reserveAgentRun: async () => { throw new Error("must not reserve"); }, releaseAgentRun: async () => {}, log: () => {} }); assert.equal(result.ok, false); assert.equal(h.calls.run.length, 0);
});
test("configured feed failure without a retained snapshot fails before Friday fallback work", async () => {
  const def = morningCheckInDefinition({
    env: { BAXTER_TZ: "America/Los_Angeles" },
    refreshImpl: async () => ({ urls: ["https://feed.test/x.ics"], ok: false, events: [], errors: ["failed"], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: false }),
    readOwnEventsImpl: () => [],
  });
  const result = await def.execute(task, {
    now: new Date("2026-08-21T16:00:00Z"),
    reserveAgentRun: async () => { throw new Error("must not reserve"); },
    releaseAgentRun: async () => {}, log: () => {},
  });
  assert.deepEqual(result, { ok: false, agentRun: false, detail: "calendar unavailable" });
});

test("per-recipient quota denial sends fallback without a model run", async () => {
  const h = harness(new Date("2026-08-21T16:00:00Z")); const result = await morningCheckInDefinition({ env: { BAXTER_TZ: "America/Los_Angeles" }, refreshImpl: async () => ({ urls: [], ok: false, events: [], errors: [], wroteCache: false, familySnapshot: [] }), readOwnEventsImpl: () => [], allowlistPath: join(tmpdir(), "missing") }).execute(task, { now: new Date("2026-08-21T16:00:00Z"), reserveAgentRun: async () => null, releaseAgentRun: async () => {}, log: () => {} }); assert.equal(result.ok, true); void h;
});
