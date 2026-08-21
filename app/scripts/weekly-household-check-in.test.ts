import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  weeklyHouseholdCheckInDefinition,
  selectWeekendEvents,
  projectWeekendEvents,
  composeFridayBody,
  composeMondayBody,
  type WeeklyCheckInDeps,
} from "./weekly-household-check-in.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";
import type { SystemTaskContext } from "./system-tasks.ts";
import type { Task } from "./schedule-store.ts";
import type { RunAgentOptions } from "./runtime.ts";

const FRIDAY = new Date("2026-08-21T16:00:00Z"); // 09:00 America/Los_Angeles
const task = (mode: "friday" | "monday"): Task => ({
  id: `system:${mode === "friday" ? "friday-weekend-check-in" : "monday-weekly-check-in"}`,
  cron: mode === "friday" ? "0 9 * * 5" : "0 9 * * 1",
  next_run_at: FRIDAY.toISOString(),
  system: { key: mode === "friday" ? "friday-weekend-check-in" : "monday-weekly-check-in", enabled: true },
});

function makeHarness(
  mode: "friday" | "monday",
  knowledge = "",
  runResult: { failed: boolean; outOfTokens: boolean; resultText?: string } = {
    failed: false,
    outOfTokens: false,
    resultText: JSON.stringify({ context: "You once enjoyed a museum visit." }),
  },
  overrides: Partial<WeeklyCheckInDeps> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "weekly-check-in-"));
  const allowlistPath = join(dir, "allowlist.json");
  const ownEventsPath = join(dir, "events.json");
  writeFileSync(ownEventsPath, "[]");
  writeFileSync(allowlistPath, JSON.stringify({ version: 1, senders: ["+15550000001"], recipients: ["alex@example.com", "+15550000001"], names: { "+15550000001": "Alex", "alex@example.com": "Alex" } }));
  const state = {
    reserve: 0,
    releases: [] as string[],
    runs: [] as RunAgentOptions[],
    sms: [] as Array<{ target: string; body: string }>,
    email: [] as Array<{ target: string; subject: string; body: string }>,
    refresh: 0,
    ownReads: 0,
    logs: [] as string[],
  };
  const weekend: VEvent[] = [{ uid: "plan", title: "Picnic", location: "Park", startMs: Date.parse("2026-08-22T19:00:00Z"), endMs: Date.parse("2026-08-22T21:00:00Z"), allDay: false, rrule: null, url: "https://secret.invalid" }];
  const deps: Partial<WeeklyCheckInDeps> = {
    env: {}, allowlistPath, ownEventsPath,
    loadKnowledgeImpl: () => ({ text: knowledge, empty: knowledge.trim() === "", includedCollections: knowledge ? 1 : 0, omittedCollections: 0, truncatedSources: 0 }),
    refreshImpl: async () => { state.refresh++; return { urls: ["https://feed.test/x.ics"], ok: true, events: weekend, errors: [], wroteCache: true, familySnapshot: weekend }; },
    readOwnEventsImpl: (path) => { state.ownReads++; return JSON.parse(String(requireRead(path))) as StoredEvent[]; },
    runAgentImpl: async (opts) => { state.runs.push(opts); return { ...runResult, resetsAt: null }; },
    sendSmsImpl: async (phone, body) => { state.sms.push({ target: phone, body }); throw new Error("sms unavailable"); },
    sendNewImpl: async (to, subject, body) => { state.email.push({ target: to, subject, body }); },
    ...overrides,
  };
  const def = weeklyHouseholdCheckInDefinition(mode, deps);
  const ctx = (over: Partial<SystemTaskContext> = {}): SystemTaskContext => ({
    now: FRIDAY,
    reserveAgentRun: async () => { state.reserve++; return { token: "slot" }; },
    releaseAgentRun: async (token) => { state.releases.push(token); },
    log: (message) => state.logs.push(message),
    ...over,
  });
  return { state, def, execute: (over: Partial<SystemTaskContext> = {}) => def.execute(task(mode), ctx(over)) };
}

function requireRead(path: string): Buffer {
  return requireFs().readFileSync(path);
}
function requireFs(): typeof import("node:fs") {
  return globalThis.process.getBuiltinModule("node:fs") as typeof import("node:fs");
}

test("definition factory exposes the two approved keys, descriptions, and 09:00 crons", () => {
  const friday = weeklyHouseholdCheckInDefinition("friday");
  const monday = weeklyHouseholdCheckInDefinition("monday");
  assert.deepEqual([friday.key, friday.desc, friday.cron], ["friday-weekend-check-in", "Friday weekend planning check-in", "0 9 * * 5"]);
  assert.deepEqual([monday.key, monday.desc, monday.cron], ["monday-weekly-check-in", "Monday weekly organization check-in", "0 9 * * 1"]);
});

test("Friday with plans and empty durable knowledge skips quota/model, code-owns plan mention, personalizes once, and preserves SMS body in silent email fallback", async () => {
  const h = makeHarness("friday", "");
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(result.agentRun, false);
  assert.equal(h.state.reserve, 0);
  assert.equal(h.state.runs.length, 0);
  assert.equal(h.state.refresh, 1);
  assert.match(h.state.sms[0]!.body, /^Hi Alex — /);
  assert.match(h.state.sms[0]!.body, /Picnic/);
  assert.match(h.state.sms[0]!.body, /help you plan around/i);
  assert.equal(h.state.email[0]!.body, h.state.sms[0]!.body);
  assert.equal(h.state.email[0]!.subject, "Friday check-in from Baxter");
  assert.ok(!h.state.email[0]!.subject.toLowerCase().includes("sms"));
});

test("nonempty knowledge reserves and invokes one tool-less household-level run; context is runtime-wrapped", async () => {
  const h = makeHarness("monday", "A prior museum visit and a tax priority");
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(result.agentRun, true);
  assert.equal(h.state.reserve, 1);
  assert.equal(h.state.runs.length, 1);
  assert.equal(h.state.runs[0]!.allowedTools, "");
  assert.equal(h.state.runs[0]!.surface, "heartbeat");
  assert.equal(h.state.runs[0]!.suppressContent, true);
  assert.match(h.state.email[0]!.body, /museum visit/);
  assert.match(h.state.email[0]!.body, /keep the week organized/);
  assert.equal(h.state.refresh, 0, "Monday never refreshes calendars");
  assert.equal(h.state.ownReads, 0, "Monday never reads calendars");
});

test("quota denial and model out-of-tokens degrade to timely deterministic delivery; only out-of-tokens releases its slot", async () => {
  const denied = makeHarness("monday", "priority");
  const deniedResult = await denied.execute({ reserveAgentRun: async () => null });
  assert.equal(deniedResult.ok, true);
  assert.equal(deniedResult.agentRun, false);
  assert.match(denied.state.email[0]!.body, /Another week begins/);
  assert.deepEqual(denied.state.releases, []);

  const outage = makeHarness("monday", "priority", { failed: false, outOfTokens: true });
  const outageResult = await outage.execute();
  assert.equal(outageResult.ok, true);
  assert.equal(outageResult.agentRun, true);
  assert.deepEqual(outage.state.releases, ["slot"]);
  assert.match(outage.state.email[0]!.body, /Another week begins/);
});

test("generic runtime compositions are stable and context insertion never removes the closing offer", () => {
  assert.equal(composeFridayBody([], null), "The weekend’s almost here! Can I help you plan any activities?");
  assert.equal(composeMondayBody(null), "Another week begins! Anything I can help you with to keep the week organized?");
  assert.match(composeFridayBody([{ when: "Saturday 12:00 PM", title: "Picnic", allDay: false, ongoing: false }], "Past activity may fit."), /Picnic.*Past activity.*help you plan around/s);
});

test("Friday composition drops optional context before plans and retains a recomputed omitted count under the shared-body bound", () => {
  const events = Array.from({ length: 5 }, (_, index) => ({
    when: `Sunday ${index + 1}:00 PM`,
    title: `Plan-${index}-${"x".repeat(190)}`,
    location: `Location-${index}-${"y".repeat(145)}`,
    allDay: false,
    ongoing: false,
  }));
  const body = composeFridayBody(events, `OPTIONAL-CONTEXT-${"z".repeat(300)}`, 7);
  assert.ok(body.length <= 1200);
  assert.match(body, /Plan-0/);
  assert.match(body, /and \d+ more/);
  assert.doesNotMatch(body, /OPTIONAL-CONTEXT/);
  assert.match(body, /help you plan around those activities or anything else\?$/);
});

test("spanning all-day plans are projected as ongoing into the weekend", () => {
  const weekendStart = Date.parse("2026-08-22T07:00:00Z");
  const projection = projectWeekendEvents([{
    uid: "cabin",
    startMs: Date.parse("2026-08-21T00:00:00Z"),
    endMs: Date.parse("2026-08-24T00:00:00Z"),
    title: "Cabin trip",
    location: null,
    allDay: true,
    recurring: false,
    url: null,
    source: "family",
  }, {
    uid: "saturday",
    startMs: Date.parse("2026-08-22T00:00:00Z"),
    endMs: Date.parse("2026-08-23T00:00:00Z"),
    title: "Saturday plan",
    location: null,
    allDay: true,
    recurring: false,
    url: null,
    source: "family",
  }], { tz: "America/Los_Angeles", weekendStartMs: weekendStart });
  assert.equal(projection.events[0]!.ongoing, true);
  assert.equal(projection.events[0]!.when, "Ongoing into the weekend (all day)");
  assert.equal(projection.events[1]!.ongoing, false);
  assert.equal(projection.events[1]!.when, "Saturday, all day");
});

test("model context with controls or multiple ASCII/Unicode sentences is rejected before normalization", async () => {
  for (const context of [
    "Private\u0000context.",
    "First sentence. Second sentence.",
    "First sentence.Second sentence.",
    "First sentence. Second sentence",
    "First sentence。Second sentence。",
    "First sentence。第二文",
    "First sentence！Second sentence？",
  ]) {
    const h = makeHarness("monday", "priority", {
      failed: false,
      outOfTokens: false,
      resultText: JSON.stringify({ context }),
    });
    const result = await h.execute();
    assert.equal(result.ok, true);
    assert.doesNotMatch(h.state.email[0]!.body, /Private|First sentence|Second sentence|第二文/);
    assert.match(h.state.email[0]!.body, /Another week begins/);
  }
});

test("model context rejects C1 controls with no-context generation and identical deterministic output", async () => {
  const expectedBody = `Hi Alex — ${composeMondayBody(null)}`;
  for (const control of ["\u0080", "\u0085", "\u009f"]) {
    const h = makeHarness("monday", "priority", {
      failed: false,
      outOfTokens: false,
      resultText: JSON.stringify({ context: `Private${control}context.` }),
    });
    const result = await h.execute();
    assert.equal(result.ok, true);
    assert.match(result.detail ?? "", /generation=no-context/);
    assert.equal(h.state.email[0]!.body, expectedBody);
  }
});

test("model context accepts one sentence without a terminator or with trailing closing punctuation", async () => {
  for (const context of [
    "A known priority may be worth revisiting",
    "A known priority may be worth revisiting.",
    "“A known priority may be worth revisiting.”",
    "A known priority may be worth revisiting.)",
    "「以前の優先事項を見直してもよいでしょう。」",
  ]) {
    const h = makeHarness("monday", "priority", {
      failed: false,
      outOfTokens: false,
      resultText: JSON.stringify({ context }),
    });
    const result = await h.execute();
    assert.equal(result.ok, true);
    assert.match(h.state.email[0]!.body, new RegExp(context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Friday omits malformed own and refreshed/cache family entries individually while retaining valid plans", async () => {
  const ownPlan: StoredEvent = {
    uid: "own-valid",
    title: "Own valid plan",
    start: "2026-08-22T17:00:00Z",
    end: "2026-08-22T18:00:00Z",
    created: "",
    updated: "",
  };
  const familyPlan: VEvent = {
    uid: "family-valid",
    title: "Family valid plan",
    location: null,
    startMs: Date.parse("2026-08-23T17:00:00Z"),
    endMs: Date.parse("2026-08-23T18:00:00Z"),
    allDay: false,
    rrule: null,
    url: null,
  };

  for (const source of ["refresh", "cache"] as const) {
    const familyWithMalformed = [null, familyPlan] as unknown as VEvent[];
    const h = makeHarness("friday", "", undefined, {
      readOwnEventsImpl: () => [null, ownPlan] as unknown as StoredEvent[],
      refreshImpl: source === "refresh"
        ? async () => ({ urls: ["https://feed.test/x.ics"], ok: true, events: familyWithMalformed, errors: [], wroteCache: true, familySnapshot: familyWithMalformed })
        : async () => { throw new Error("refresh unavailable"); },
      readFamilyCacheImpl: () => familyWithMalformed,
      feedUrlsImpl: () => ["https://feed.test/x.ics"],
    });
    const result = await h.execute();
    assert.equal(result.ok, true, `${source} malformed entries do not abort Friday`);
    assert.match(h.state.email[0]!.body, /Own valid plan/);
    assert.match(h.state.email[0]!.body, /Family valid plan/);
    assert.ok(h.state.logs.some((line) => line === "friday check-in: omitted 1 malformed own event(s), 1 malformed family event(s)"));
    assert.ok(h.state.logs.every((line) => !line.includes("refresh unavailable")));
  }
});

test("calendar diagnostics stay in operational logs and never enter persisted result detail", async () => {
  const failed = makeHarness("friday", "", undefined, {
    readOwnEventsImpl: () => { throw new Error("calendar secret"); },
  });
  const failedResult = await failed.execute();
  assert.equal(failedResult.detail, "mode=friday, generation=not-started, delivered=0sms+0email/0, failed=0");
  assert.ok(failed.state.logs.some((line) => line.includes("own calendar read failed")));
  assert.doesNotMatch(failedResult.detail ?? "", /calendar|refresh/i);

  const degraded = makeHarness("friday", "", undefined, {
    refreshImpl: async () => ({
      urls: ["https://feed.test/x.ics"],
      ok: false,
      events: [],
      errors: ["private"],
      wroteCache: true,
      familySnapshot: [],
    }),
  });
  const degradedResult = await degraded.execute();
  assert.equal(degradedResult.ok, true);
  assert.ok(degraded.state.logs.includes("friday check-in: calendar refresh degraded (1 feed error(s))"));
  assert.doesNotMatch(degradedResult.detail ?? "", /calendar|refresh/i);

  const partiallyDegraded = makeHarness("friday", "", undefined, {
    refreshImpl: async () => ({
      urls: ["https://feed.test/ok.ics", "https://feed.test/private-failure.ics"],
      ok: true,
      events: [],
      errors: ["private feed failure"],
      wroteCache: true,
      familySnapshot: [],
    }),
  });
  const partiallyDegradedResult = await partiallyDegraded.execute();
  assert.equal(partiallyDegradedResult.ok, true);
  assert.ok(partiallyDegraded.state.logs.includes("friday check-in: calendar refresh degraded (1 feed error(s))"));
  assert.ok(partiallyDegraded.state.logs.every((line) => !line.includes("private feed failure")));
  assert.doesNotMatch(partiallyDegradedResult.detail ?? "", /calendar|refresh/i);
});

test("weekend selection uses exact timezone boundaries after at-least-three-day expansion across spring-forward and fall-back, including late Sunday but excluding Monday", () => {
  for (const fixture of [
    { now: new Date("2026-03-06T14:00:00Z"), late: "2026-03-09T03:30:00Z", monday: "2026-03-09T04:00:00Z" },
    { now: new Date("2026-10-30T13:00:00Z"), late: "2026-11-02T04:30:00Z", monday: "2026-11-02T05:00:00Z" },
  ]) {
    const family: VEvent[] = [
      { uid: "late", title: "Late Sunday", location: null, startMs: Date.parse(fixture.late), endMs: null, allDay: false, rrule: null, url: null },
      { uid: "monday", title: "Monday", location: null, startMs: Date.parse(fixture.monday), endMs: null, allDay: false, rrule: null, url: null },
    ];
    const selected = selectWeekendEvents([], family, { now: fixture.now, tz: "America/New_York", familyEligible: true });
    assert.deepEqual(selected.map((event) => event.title), ["Late Sunday"]);
    assert.match(projectWeekendEvents(selected, { tz: "America/New_York" }).events[0]!.when, /Sunday/);
  }
});
