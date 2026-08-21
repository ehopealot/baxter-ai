import { test, mock } from "node:test";
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
import { isWellFormedString } from "./check-in-context.ts";

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
  return { state, def, allowlistPath, execute: (over: Partial<SystemTaskContext> = {}) => def.execute(task(mode), ctx(over)) };
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

test("corrupt initial and fresh weekly admission uses fixed diagnostics and documented seed fallback without console leakage", async () => {
  const secret = "WEEKLY-SECRET-PARSER";
  let h!: ReturnType<typeof makeHarness>;
  h = makeHarness("monday", "priority", {
    failed: false,
    outOfTokens: false,
    resultText: fullGeneratedCopy("A gentle note", "A useful note for this week."),
  }, {
    env: { ALLOWED_RECIPIENTS: "seed@x.com" },
    sendNewImpl: async (to, subject, body, deps) => {
      writeFileSync(h.allowlistPath, `{ ${secret}`);
      const canonical = deps.resolveRecipient!(to);
      h.state.email.push({ target: canonical, subject, body });
    },
  });
  writeFileSync(h.allowlistPath, `{ ${secret}`);
  const consoleSpy = mock.method(console, "error", () => {});
  try {
    const result = await h.execute();
    assert.equal(result.ok, true);
    assert.deepEqual(h.state.email.map((call) => call.target), ["seed@x.com"]);
    assert.ok(h.state.logs.filter((line) => line.includes("category=corrupt-json")).length >= 2, "initial and fresh admission both diagnose the fixed category");
    assert.equal(consoleSpy.mock.calls.length, 0);
    const channels = [...h.state.logs, ...consoleSpy.mock.calls.flatMap((call) => call.arguments.map(String))].join("\n");
    assert.doesNotMatch(channels, /WEEKLY-SECRET-PARSER|allowlist\.json|seed@x\.com|A useful note/);
  } finally {
    consoleSpy.mock.restore();
  }
});

test("multi-contact quota denial, invalid output, and hard model failure each leave later contacts with exactly one fallback delivery chain", async () => {
  for (const scenario of ["quota", "invalid", "hard"] as const) {
    const runResult = scenario === "hard"
      ? { failed: true, outOfTokens: false }
      : { failed: false, outOfTokens: false, resultText: "{invalid-json" };
    const h = makeHarness("monday", "priority", runResult);
    writeFileSync(h.allowlistPath, JSON.stringify({
      version: 1,
      senders: [],
      recipients: ["a@x.com", "b@x.com", "c@x.com"],
      names: { "a@x.com": "Ari", "b@x.com": "Bea", "c@x.com": "Cy" },
    }));
    const result = await h.execute(scenario === "quota" ? { reserveAgentRun: async () => null } : {});
    assert.equal(result.ok, true, scenario);
    assert.deepEqual(h.state.email.map((call) => call.target), ["a@x.com", "b@x.com", "c@x.com"], scenario);
    assert.equal(new Set(h.state.email.map((call) => call.target)).size, 3, scenario);
    assert.ok(h.state.email.every((call) => call.subject === "Monday check-in from Baxter"), scenario);
    assert.equal(h.state.runs.length, scenario === "quota" ? 0 : 3, scenario);
  }
});

test("generic runtime fallbacks are warm and retain calendar plans and friendly closings", () => {
  assert.equal(composeFridayBody([]), "Happy Friday — the weekend’s almost here! Just let me know if you’d like me to help with anything!");
  assert.equal(composeMondayBody(), "Hope your Monday is off to a good start! Just let me know if you’d like me to help with anything this week!");
  assert.match(composeFridayBody([{ when: "Saturday 12:00 PM", title: "Picnic", allDay: false, ongoing: false }]), /On the calendar.*Picnic.*Just let me know/s);
});

test("Friday fallback stays bounded and retains a representative plan, recomputed omitted count, and closing", () => {
  const events = Array.from({ length: 5 }, (_, index) => ({
    when: `Sunday ${index + 1}:00 PM`,
    title: `Plan-${index}-${"x".repeat(190)}`,
    location: `Location-${index}-${"y".repeat(145)}`,
    allDay: false,
    ongoing: false,
  }));
  const body = composeFridayBody(events, 7);
  assert.ok(body.length <= 1200);
  assert.match(body, /Plan-0/);
  assert.match(body, /and \d+ more/);
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
    assert.match(result.detail ?? "", /generated=0, fallbacks=1/);
    assert.equal(h.state.email[0]!.subject, fallbackSubject);
    assert.match(h.state.email[0]!.body, fallbackOpening);
    assert.doesNotMatch(h.state.email[0]!.subject, /Picnic|school forms|Alex/i);
  }
});

test("unsafe generated subjects or bodies fall back without leaking model copy into delivery", async () => {
  for (const generated of [
    fullGeneratedCopy("Private\nsubject", "A safe body."),
    fullGeneratedCopy("\ud800", "A safe body."),
    fullGeneratedCopy("\udc00", "A safe body."),
    fullGeneratedCopy("A safe subject", "\ud800"),
    fullGeneratedCopy("A safe subject", "\udc00"),
    fullGeneratedCopy("A safe subject", "Private\u0000body."),
    fullGeneratedCopy("A safe subject", "Private\u0085body."),
    fullGeneratedCopy("A safe subject", "# Private heading\nBody"),
    fullGeneratedCopy("A safe subject", "```text\nPrivate body\n```"),
    fullGeneratedCopy("A safe subject", "~~~text\nPrivate body\n~~~"),
    fullGeneratedCopy("A safe subject", "Private heading\n==="),
    fullGeneratedCopy("A safe subject", "Private heading\n---"),
    fullGeneratedCopy("A safe subject", "<b>Private body</b>"),
    fullGeneratedCopy("x".repeat(101), "A safe body."),
    fullGeneratedCopy("A safe subject", "x".repeat(1201)),
  ]) {
    const h = makeHarness("friday", "private knowledge", { failed: false, outOfTokens: false, resultText: generated });
    const result = await h.execute();
    assert.equal(result.ok, true);
    assert.match(result.detail ?? "", /generated=0, fallbacks=1/);
    assert.equal(h.state.email[0]!.subject, "It's almost the weekend!");
    assert.match(h.state.email[0]!.body, /Happy Friday — the weekend’s almost here!/);
    assert.match(h.state.email[0]!.body, /On the calendar, you’ve got .*Picnic/);
    assert.doesNotMatch(h.state.email[0]!.body, /Private/);
  }
});

test("weekly Markdown heading and fence output falls back only for the affected recipient while ordinary list lines remain generated", async () => {
  for (const unsafe of ["```text\nprivate\n```", "~~~text\nprivate\n~~~", "Private heading\n===", "Private heading\n---", "Agenda\n   # Private heading\nDetails", "Agenda\n   ######\nDetails"]) {
    let modelCall = 0;
    const h = makeHarness("monday", "", undefined, {
      runAgentImpl: async () => ({
        failed: false, outOfTokens: false, resetsAt: null,
        resultText: modelCall++ === 0
          ? fullGeneratedCopy("A gentle note", unsafe)
          : fullGeneratedCopy("Another gentle note", "- ordinary generated list line"),
      }),
    });
    writeFileSync(h.allowlistPath, JSON.stringify({
      version: 1, senders: [], recipients: ["a@x.com", "b@x.com"], names: { "a@x.com": "Ari", "b@x.com": "Bea" },
    }));
    const result = await h.execute();
    assert.match(result.detail ?? "", /generated=1, fallbacks=1/, unsafe);
    assert.match(h.state.email[0]!.body, /^Hi Ari — Hope your Monday/, unsafe);
    assert.equal(h.state.email[1]!.body, "Hi Bea — - ordinary generated list line", unsafe);
    assert.ok(h.state.email.every((call) => !call.body.includes("private") && !call.body.includes("Private heading")), unsafe);
  }
});

test("every required weekly salutation and name-bearing-subject variant falls back only for its affected contact", async () => {
  const variants = [
    fullGeneratedCopy("A gentle note", "Dear Ari, here is a thought."),
    fullGeneratedCopy("A gentle note", "Good morning, Ari"),
    fullGeneratedCopy("A gentle note", "Ari, here is a thought."),
    fullGeneratedCopy("A gentle note", "Hi there"),
    fullGeneratedCopy("A gentle note", "Hello everyone"),
    fullGeneratedCopy("A gentle note", "Hey folks"),
    fullGeneratedCopy("ARI weekly update", "A useful thought for the week."),
  ];
  for (const invalid of variants) {
    let modelCall = 0;
    const h = makeHarness("monday", "", undefined, {
      runAgentImpl: async () => ({
        failed: false, outOfTokens: false, resetsAt: null,
        resultText: modelCall++ === 0 ? invalid : fullGeneratedCopy("A separate gentle note", "A useful generated thought."),
      }),
    });
    writeFileSync(h.allowlistPath, JSON.stringify({
      version: 1, senders: [], recipients: ["a@x.com", "b@x.com"], names: { "a@x.com": "Ari", "b@x.com": "Bea" },
    }));
    const result = await h.execute();
    assert.match(result.detail ?? "", /generated=1, fallbacks=1/, invalid);
    assert.equal(h.state.email[0]!.subject, "Monday check-in from Baxter", invalid);
    assert.match(h.state.email[0]!.body, /^Hi Ari — Hope your Monday/, invalid);
    assert.equal(h.state.email[1]!.subject, "A separate gentle note", invalid);
    assert.equal(h.state.email[1]!.body, "Hi Bea — A useful generated thought.", invalid);
  }
});

test("weekly named en/em-dash salutations fall back only for the affected contact while an unnamed time-of-day opening remains generated", async () => {
  for (const salutation of [
    "Ari – here is a thought.",
    "Ari — here is a thought.",
    "Good morning – Ari, here is a thought.",
    "Good morning — Ari, here is a thought.",
    "Good morning – Ari",
    "Good morning – Ari.",
    "Good morning — Ari",
    "Good morning — Ari.",
    "Good afternoon – Ari",
    "Good afternoon – Ari.",
    "Good afternoon — Ari",
    "Good afternoon — Ari.",
    "Good evening – Ari",
    "Good evening – Ari.",
    "Good evening — Ari",
    "Good evening — Ari.",
  ]) {
    let modelCall = 0;
    const h = makeHarness("monday", "", undefined, {
      runAgentImpl: async () => ({
        failed: false, outOfTokens: false, resetsAt: null,
        resultText: modelCall++ === 0
          ? fullGeneratedCopy("A gentle note", salutation)
          : fullGeneratedCopy("A separate gentle note", "Good morning — here’s your Tuesday calendar"),
      }),
    });
    writeFileSync(h.allowlistPath, JSON.stringify({
      version: 1, senders: [], recipients: ["a@x.com", "b@x.com"], names: { "a@x.com": "Ari", "b@x.com": "Bea" },
    }));
    const result = await h.execute();
    assert.match(result.detail ?? "", /generated=1, fallbacks=1/, salutation);
    assert.equal(h.state.email[0]!.subject, "Monday check-in from Baxter", salutation);
    assert.match(h.state.email[0]!.body, /^Hi Ari — Hope your Monday/, salutation);
    assert.equal(h.state.email[1]!.subject, "A separate gentle note", salutation);
    assert.equal(h.state.email[1]!.body, "Hi Bea — Good morning — here’s your Tuesday calendar", salutation);
  }
});

test("a name-bearing subject using an NFKC/case variant omitted beyond the 20-name prompt cap falls back only for that contact", async () => {
  const recipients = Array.from({ length: 22 }, (_, index) => `person-${String(index).padStart(2, "0")}@x.com`);
  const names = Object.fromEntries(recipients.map((recipient, index) => [recipient, `Person ${index}`]));
  const prompts: string[] = [];
  let modelCall = 0;
  const h = makeHarness("monday", "", undefined, {
    runAgentImpl: async (options) => {
      prompts.push(options.prompt);
      const first = modelCall++ === 0;
      return {
        failed: false, outOfTokens: false, resetsAt: null,
        resultText: first
          ? fullGeneratedCopy("ＰＥＲＳＯＮ 9 update", "A useful thought for the week.")
          : fullGeneratedCopy("A gentle household note", "A separate useful generated thought."),
      };
    },
  });
  writeFileSync(h.allowlistPath, JSON.stringify({ version: 1, senders: [], recipients, names }));
  const result = await h.execute();
  assert.match(result.detail ?? "", /generated=21, fallbacks=1/);
  assert.match(prompts[0]!, /"omittedOtherNamedRecipientCount":1/);
  assert.doesNotMatch(prompts[0]!, /Person 9/);
  assert.equal(h.state.email[0]!.subject, "Monday check-in from Baxter");
  assert.match(h.state.email[0]!.body, /^Hi Person 0 — Hope your Monday/);
  assert.ok(h.state.email.slice(1).every((call) => call.subject === "A gentle household note"));
});

test("weekly real prompts and fallback greetings repair NUL, ESC, C1, lone-high, and lone-low surrogate names", async () => {
  const prompts: string[] = [];
  const h = makeHarness("monday", "", undefined, {
    runAgentImpl: async (options) => {
      prompts.push(options.prompt);
      return { failed: false, outOfTokens: false, resetsAt: null, resultText: "{invalid" };
    },
  });
  writeFileSync(h.allowlistPath, JSON.stringify({
    version: 1, senders: [], recipients: ["nul@x.com", "esc@x.com", "c1@x.com", "high@x.com", "low@x.com"],
    names: {
      "nul@x.com": "Nul\u0000Name", "esc@x.com": "Esc\u001bName", "c1@x.com": "C1\u0085Name",
      "high@x.com": "High\ud800Name", "low@x.com": "Low\udc00Name",
    },
  }));
  const result = await h.execute();
  assert.match(result.detail ?? "", /generated=0, fallbacks=5/);
  assert.equal(prompts.length, 5);
  assert.equal(h.state.email.length, 5);
  const promptText = prompts.join("\n");
  const deliveredText = h.state.email.map((call) => call.body).join("\n");
  for (const repaired of ["Nul Name", "Esc Name", "C1 Name", "High�Name", "Low�Name"]) {
    assert.ok(promptText.includes(repaired), repaired);
    assert.ok(deliveredText.includes(`Hi ${repaired} — Hope your Monday`), repaired);
  }
  for (const value of [...prompts, ...h.state.email.map((call) => call.body)]) {
    assert.ok(isWellFormedString(value));
    assert.doesNotMatch(value, /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u);
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
    assert.ok(h.state.logs.some((line) => line === "friday check-in: calendar event category=malformed-shape own-count=1 family-count=1"));
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
  assert.ok(failed.state.logs.some((line) => line.includes("own calendar read category=unreadable")));
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
  assert.ok(selectionFailed.state.logs.some((line) => line.includes("calendar selection category=invalid-type")));
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
  assert.ok(degraded.state.logs.includes("friday check-in: calendar refresh category=feed-failure count=1"));
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
  assert.ok(partiallyDegraded.state.logs.includes("friday check-in: calendar refresh category=feed-failure count=1"));
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

test("weekly generation runs once per resolved recipient with bounded routing-free context and preserves named fact ownership", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const knowledge = "Erik prefers quiet mornings. Laura likes afternoon walks.";
  const h = makeHarness("monday", knowledge, undefined, {
    runAgentImpl: async (options) => {
      prompts.push(options.prompt);
      const body = calls++ === 0
        ? "Erik prefers quiet mornings; Laura likes afternoon walks. Here is a gentle option for your week."
        : "Erik prefers quiet mornings, while an afternoon walk could be a useful option for you this week.";
      return { failed: false, outOfTokens: false, resetsAt: null, resultText: fullGeneratedCopy("A gentle week-start note", body) };
    },
  });
  writeFileSync(h.allowlistPath, JSON.stringify({
    version: 1, senders: [], recipients: ["erik@x.com", "laura@x.com"],
    names: { "erik@x.com": "Erik", "laura@x.com": "Laura" },
  }));
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /"currentRecipientDisplayName":"Erik"/);
  assert.match(prompts[1]!, /"currentRecipientDisplayName":"Laura"/);
  assert.ok(prompts.every((prompt) => prompt.includes(knowledge)));
  assert.ok(prompts.every((prompt) => prompt.includes("You decide which supplied durable facts are relevant")));
  assert.ok(prompts.every((prompt) => prompt.includes("never rewrite one person’s fact as the recipient’s fact")));
  assert.ok(prompts.every((prompt) => !prompt.includes("@x.com") && !prompt.includes("phones") && !prompt.includes("emails")));
  assert.deepEqual(h.state.email.map(({ target, body }) => ({ target, body })), [
    { target: "erik@x.com", body: "Hi Erik — Erik prefers quiet mornings; Laura likes afternoon walks. Here is a gentle option for your week." },
    { target: "laura@x.com", body: "Hi Laura — Erik prefers quiet mornings, while an afternoon walk could be a useful option for you this week." },
  ]);
});

test("weekly out-of-tokens stops later reservations while fallback completes every contact exactly once", async () => {
  let modelCalls = 0;
  const h = makeHarness("monday", "Shared fact", undefined, {
    runAgentImpl: async () => {
      modelCalls++;
      return modelCalls === 1
        ? { failed: false, outOfTokens: false, resetsAt: null, resultText: fullGeneratedCopy("A gentle note", "A generated first-contact note.") }
        : { failed: false, outOfTokens: true, resetsAt: null };
    },
  });
  writeFileSync(h.allowlistPath, JSON.stringify({
    version: 1, senders: [], recipients: ["a@x.com", "b@x.com", "c@x.com"],
    names: { "a@x.com": "Ari", "b@x.com": "Bea", "c@x.com": "Cy" },
  }));
  let reservations = 0;
  const result = await h.execute({
    reserveAgentRun: async () => ({ token: `slot-${++reservations}` }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outOfTokens ?? false, false);
  assert.equal(result.deferredByCap ?? false, false);
  assert.equal(modelCalls, 2);
  assert.equal(reservations, 2);
  assert.deepEqual(h.state.releases, ["slot-2"]);
  assert.deepEqual(h.state.email.map((call) => call.target), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.match(h.state.email[0]!.body, /generated first-contact/);
  assert.match(h.state.email[1]!.body, /Hope your Monday/);
  assert.match(h.state.email[2]!.body, /Hope your Monday/);
});

test("Friday projection repairs calendar surrogates and controls before code-point caps used by prompt and fallback", () => {
  const projection = projectWeekendEvents([{
    uid: "unsafe", startMs: Date.parse("2026-08-22T19:00:00Z"), endMs: null,
    title: `Plan\ud800\u0085 ${"😀".repeat(210)}`,
    location: `Place\udc00\u009f ${"😀".repeat(170)}`,
    allDay: false, recurring: false, url: null, source: "family",
  }], { tz: "America/Los_Angeles" });
  const event = projection.events[0]!;
  assert.ok(isWellFormedString(event.title));
  assert.ok(isWellFormedString(event.location!));
  assert.equal([...event.title].length, 200);
  assert.equal([...event.location!].length, 160);
  assert.doesNotMatch(event.title + event.location, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  const fallback = composeFridayBody(projection.events);
  assert.ok(isWellFormedString(fallback));
  assert.doesNotMatch(fallback, /[\ud800-\udfff]/u);
});

test("null and duplicate display-name contacts receive the same knowledge and relevance contract without ambiguity classification", async () => {
  const prompts: string[] = [];
  const knowledge = "Erik prefers quiet mornings; keep that fact attributed to Erik.";
  const h = makeHarness("monday", knowledge, undefined, {
    runAgentImpl: async (options) => {
      prompts.push(options.prompt);
      return { failed: false, outOfTokens: false, resetsAt: null, resultText: fullGeneratedCopy("A gentle note", "A useful low-pressure option for the week.") };
    },
  });
  writeFileSync(h.allowlistPath, JSON.stringify({
    version: 1, senders: [], recipients: ["laura1@x.com", "laura2@x.com", "unnamed@x.com"],
    names: { "laura1@x.com": "Laura", "laura2@x.com": "Laura" },
  }));
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 3);
  assert.equal(prompts.filter((prompt) => prompt.includes('"currentRecipientDisplayName":"Laura"')).length, 2);
  assert.equal(prompts.filter((prompt) => prompt.includes('"currentRecipientDisplayName":null')).length, 1);
  assert.ok(prompts.every((prompt) => prompt.includes(knowledge)));
  assert.ok(prompts.every((prompt) => prompt.includes("You decide which supplied durable facts are relevant")));
  assert.ok(prompts.every((prompt) => !/ambigu|equivalence|generic-only|unique name/i.test(prompt)));
  assert.deepEqual(h.state.email.map((call) => call.target), ["unnamed@x.com", "laura1@x.com", "laura2@x.com"]);
  assert.equal(h.state.email[0]!.body.startsWith("Hi there — "), true);
});

test("Friday zero resolved contacts may complete calendar work but performs no knowledge load, reservation, model call, fallback, or provider send", async () => {
  let knowledgeLoads = 0;
  const h = makeHarness("friday", "", undefined, {
    loadKnowledgeImpl: () => { knowledgeLoads++; return { text: "", empty: true, includedCollections: 0, omittedCollections: 0, truncatedSources: 0 }; },
  });
  writeFileSync(h.allowlistPath, JSON.stringify({ version: 1, senders: [], recipients: [], names: {} }));
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(result.agentRun, false);
  assert.equal(h.state.refresh, 1, "Friday calendar refresh may occur before recipient resolution");
  assert.equal(h.state.ownReads, 1, "Friday calendar selection may occur before recipient resolution");
  assert.equal(h.state.reserve, 0);
  assert.equal(h.state.runs.length, 0);
  assert.equal(h.state.sms.length + h.state.email.length, 0);
  assert.equal(knowledgeLoads, 0);
  assert.match(result.detail ?? "", /contacts=0/);
});
