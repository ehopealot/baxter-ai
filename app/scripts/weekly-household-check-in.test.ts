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
const fullGeneratedCopy = (subject: string, body: string): string => JSON.stringify({ subject, body });
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
    resultText: JSON.stringify({ invalid: true }),
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

test("the model owns Friday's complete subject and body while receiving calendar plans and generous household knowledge", async () => {
  const body = [
    "Happy Friday — the weekend’s almost here!",
    "",
    "• Saturday: Picnic at Park.",
    "• One new idea could be a relaxed outing with Hugo and Selina.",
    "",
    "Just let me know if you’d like me to help with anything!",
  ].join("\n");
  const h = makeHarness("friday", "Hugo and Selina enjoy relaxed family outings.", {
    failed: false,
    outOfTokens: false,
    resultText: fullGeneratedCopy("A few thoughts for the weekend", body),
  });

  const result = await h.execute();

  assert.equal(result.ok, true);
  assert.equal(result.agentRun, true);
  assert.equal(h.state.runs.length, 1);
  assert.equal(h.state.runs[0]!.allowedTools, "");
  assert.equal(h.state.runs[0]!.surface, "heartbeat");
  assert.equal(h.state.runs[0]!.suppressContent, true);
  assert.equal(h.state.email[0]!.subject, "A few thoughts for the weekend");
  assert.equal(h.state.email[0]!.body, `Hi Alex — ${body}`);
  assert.equal(h.state.sms[0]!.body, h.state.email[0]!.body);
  assert.match(h.state.runs[0]!.prompt, /Hugo and Selina enjoy relaxed family outings/);
  assert.match(h.state.runs[0]!.prompt, /"title":"Picnic"/);
  assert.match(h.state.runs[0]!.prompt, /JSON object with exactly two keys: subject and body/);
  assert.equal((h.state.email[0]!.body.match(/Picnic/g) ?? []).length, 1, "runtime does not append a duplicate calendar summary");
});

test("the model owns Monday's complete prose, receives household knowledge, and receives no calendar data", async () => {
  const body = "It’s Monday — hope the week is starting smoothly! Would you like help making school forms easier this week?";
  const h = makeHarness("monday", "Hugo and Selina have school forms to organize.", {
    failed: false,
    outOfTokens: false,
    resultText: fullGeneratedCopy("A gentle start to the week", body),
  });

  const result = await h.execute();

  assert.equal(result.ok, true);
  assert.equal(h.state.email[0]!.subject, "A gentle start to the week");
  assert.equal(h.state.email[0]!.body, `Hi Alex — ${body}`);
  assert.match(h.state.runs[0]!.prompt, /Hugo and Selina have school forms to organize/);
  assert.doesNotMatch(h.state.runs[0]!.prompt, /WEEKEND CALENDAR DATA|Picnic/);
  assert.equal(h.state.refresh, 0);
  assert.equal(h.state.ownReads, 0);
});

test("quota denial and model out-of-tokens degrade to timely deterministic delivery; only out-of-tokens releases its slot", async () => {
  const denied = makeHarness("monday", "priority");
  const deniedResult = await denied.execute({ reserveAgentRun: async () => null });
  assert.equal(deniedResult.ok, true);
  assert.equal(deniedResult.agentRun, false);
  assert.equal(denied.state.email[0]!.subject, "Monday check-in from Baxter");
  assert.match(denied.state.email[0]!.body, /Hope your Monday is off to a good start/);
  assert.match(denied.state.email[0]!.body, /Just let me know if you’d like me to help with anything this week!$/);
  assert.deepEqual(denied.state.releases, []);

  const outage = makeHarness("monday", "priority", { failed: false, outOfTokens: true });
  const outageResult = await outage.execute();
  assert.equal(outageResult.ok, true);
  assert.equal(outageResult.agentRun, true);
  assert.deepEqual(outage.state.releases, ["slot"]);
  assert.match(outage.state.email[0]!.body, /Hope your Monday is off to a good start/);
});

test("generic runtime compositions are warm and context insertion never removes the friendly closing", () => {
  assert.equal(composeFridayBody([], null), "Happy Friday — the weekend’s almost here! Just let me know if you’d like me to help with anything!");
  assert.equal(composeMondayBody(null), "Hope your Monday is off to a good start! Just let me know if you’d like me to help with anything this week!");
  assert.match(composeFridayBody([{ when: "Saturday 12:00 PM", title: "Picnic", allDay: false, ongoing: false }], "One new idea could be a museum visit."), /On the calendar.*Picnic.*One new idea.*Just let me know/s);
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
  assert.match(body, /Just let me know if you’d like me to help with anything!$/);
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

test("generated subjects stay generic and a model-authored body never addresses the recipient", async () => {
  const fixtures = [
    {
      h: makeHarness("friday", "Family prefers science museums.", {
        failed: false,
        outOfTokens: false,
        resultText: fullGeneratedCopy("Picnic this Saturday", "The weekend is nearly here!"),
      }),
      fallbackSubject: "It's almost the weekend!",
      fallbackOpening: /Happy Friday — the weekend’s almost here!/,
    },
    {
      h: makeHarness("monday", "Current priority: school forms this week.", {
        failed: false,
        outOfTokens: false,
        resultText: fullGeneratedCopy("School forms this week", "Hope the week is starting smoothly!"),
      }),
      fallbackSubject: "Monday check-in from Baxter",
      fallbackOpening: /Hope your Monday is off to a good start!/,
    },
    {
      h: makeHarness("monday", "", {
        failed: false,
        outOfTokens: false,
        resultText: fullGeneratedCopy("A friendly start to the week", "Hi Alex — Monday is here!"),
      }),
      fallbackSubject: "Monday check-in from Baxter",
      fallbackOpening: /Hope your Monday is off to a good start!/,
    },
  ];

  for (const { h, fallbackSubject, fallbackOpening } of fixtures) {
    const result = await h.execute();
    assert.equal(result.ok, true);
    assert.match(result.detail ?? "", /generation=model-fallback/);
    assert.equal(h.state.email[0]!.subject, fallbackSubject);
    assert.match(h.state.email[0]!.body, fallbackOpening);
    assert.doesNotMatch(h.state.email[0]!.subject, /Picnic|school forms|Alex/i);
  }
});

test("unsafe generated subjects or bodies fall back without leaking model copy into delivery", async () => {
  for (const generated of [
    fullGeneratedCopy("Private\nsubject", "A safe body."),
    fullGeneratedCopy("A safe subject", "Private\u0000body."),
    fullGeneratedCopy("A safe subject", "Private\u0085body."),
    fullGeneratedCopy("A safe subject", "# Private heading\nBody"),
    fullGeneratedCopy("A safe subject", "<b>Private body</b>"),
    fullGeneratedCopy("x".repeat(101), "A safe body."),
    fullGeneratedCopy("A safe subject", "x".repeat(1201)),
  ]) {
    const h = makeHarness("friday", "private knowledge", { failed: false, outOfTokens: false, resultText: generated });
    const result = await h.execute();
    assert.equal(result.ok, true);
    assert.match(result.detail ?? "", /generation=model-fallback/);
    assert.equal(h.state.email[0]!.subject, "It's almost the weekend!");
    assert.match(h.state.email[0]!.body, /Happy Friday — the weekend’s almost here!/);
    assert.match(h.state.email[0]!.body, /On the calendar, you’ve got .*Picnic/);
    assert.doesNotMatch(h.state.email[0]!.body, /Private/);
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

test("calendar diagnostics stay in operational logs while read/selection failures still run the model and deliver without calendar claims", async () => {
  const failed = makeHarness("friday", "", undefined, {
    readOwnEventsImpl: () => { throw new Error("calendar secret"); },
  });
  const failedResult = await failed.execute();
  assert.equal(failedResult.ok, true);
  assert.equal(failedResult.agentRun, true);
  assert.equal(failed.state.reserve, 1);
  assert.equal(failed.state.runs.length, 1);
  assert.equal(failed.state.email.length, 1);
  assert.doesNotMatch(failed.state.email[0]!.body, /On the calendar/);
  assert.ok(failed.state.logs.some((line) => line.includes("own calendar read failed")));
  assert.doesNotMatch(failedResult.detail ?? "", /calendar|refresh/i);

  const poisonedFamily = new Proxy([] as VEvent[], {
    get(target, key, receiver) {
      if (key === "filter") throw new Error("selection secret");
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const selectionFailed = makeHarness("friday", "", undefined, {
    refreshImpl: async () => ({ urls: ["https://feed.test/x.ics"], ok: true, events: poisonedFamily, errors: [], wroteCache: true, familySnapshot: poisonedFamily }),
  });
  const selectionResult = await selectionFailed.execute();
  assert.equal(selectionResult.ok, true);
  assert.equal(selectionResult.agentRun, true);
  assert.equal(selectionFailed.state.runs.length, 1);
  assert.equal(selectionFailed.state.email.length, 1);
  assert.doesNotMatch(selectionFailed.state.email[0]!.body, /On the calendar/);
  assert.ok(selectionFailed.state.logs.some((line) => line.includes("calendar selection failed")));
  assert.doesNotMatch(selectionResult.detail ?? "", /calendar|selection/i);

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
