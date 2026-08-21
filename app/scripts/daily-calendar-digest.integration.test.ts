// End-to-end integration test for the daily calendar digest (2026-08-20 system
// scheduled tasks plan, T15): ties the whole substrate together against temp
// stores. One tick RECONCILES system:daily-calendar-digest into the store and
// fires it through the real dispatch path -- the REAL T8 refresh (proper-lockfile
// refresh lock + atomic cache write) against a fake feed fetch, the REAL T6
// fire-quota functions wired exactly as main() wires them (reserveAgentRunFor ->
// reserveAgentRunSlot(now, cap, taskId)), fake generation/delivery -- then a
// second scenario proves the no-event short circuit completes agent_run:false
// with NO reservation while the cap window is pre-filled FULL, and a third pins
// ONE resolved timezone across the gate's cron anchor, digest selection's
// local-day boundary, buildCalendarView (explicit temp deps, tz OMITTED), and
// buildScheduleView when BAXTER_TZ is invalid and HEARTBEAT_TZ carries the zone.
//
// HERMETICITY: every state path is a fresh temp dir -- SCHEDULE_DIR_OVERRIDE
// moves schedule.json + task-log.jsonl + fire-quota.json together, and the
// calendar/allowlist paths are injected explicitly into the definition (the
// calendar deps are always EXPLICIT temp paths; default deps -- which resolve
// the production CALENDAR_*_PATH -- are never used here). The suite must pass
// with unrelated production data present and never touch it; the production
// schedule/calendar/allowlist files are existence+mtime-pinned unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick, runReconcileGate } from "./heartbeat.ts";
import { dailyCalendarDigestDefinition } from "./daily-calendar-digest.ts";
import { reserveAgentRunSlot, releaseAgentRunSlot } from "./fire-quota.ts";
import type { QuotaState } from "./fire-quota.ts";
import { readTasks } from "./schedule-store.ts";
import type { Task } from "./schedule-store.ts";
import { buildCalendarView } from "./calendar-mirror.ts";
import { buildScheduleView } from "./schedule-mirror.ts";
import { refreshLockTarget } from "./calendar-refresh.ts";
import { stubFetch } from "./calendar-refresh.testkit.ts";
import { ALLOWLIST_PATH, CALENDAR_CACHE_PATH, CALENDAR_EVENTS_PATH, SCHEDULE_PATH } from "./paths.ts";
import type { Allowlist } from "./allowlist.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";
import type { RunAgentOptions } from "./runtime.ts";
import type { SystemTaskContext } from "./system-tasks.ts";

// A public-looking feed host so fetchFeed's SSRF guardUrl admits the URL (the
// fetch itself is a stub -- no network).
const FEED_URL = "https://feed.example.com/family.ics";

// One scenario = one temp root with separate store/ and cal/ dirs, mirroring the
// production layout split (schedule state vs calendar state). Setting
// SCHEDULE_DIR_OVERRIDE to storeDir moves schedule.json, task-log.jsonl, AND
// fire-quota.json together (they share the override), while every calendar read
// is an explicit temp path injected into the digest definition.
interface Scenario {
  storeDir: string;
  ownEventsPath: string;
  cachePath: string;
  feedsPath: string;
  allowlistPath: string;
  runsDir: string;
}
function freshScenario(prefix: string): Scenario {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const storeDir = join(root, "store");
  const calDir = join(root, "cal");
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(calDir, { recursive: true });
  return {
    storeDir,
    ownEventsPath: join(calDir, "events.json"),
    cachePath: join(calDir, "family-cache.json"),
    feedsPath: join(calDir, "feeds.json"),
    allowlistPath: join(calDir, "allowlist.json"),
    runsDir: join(calDir, "runs"),
  };
}

// Scoped process.env patch with exact save/restore (a saved undefined deletes
// the key), so the gate/mirrors (householdTz reads process.env) and the store
// override never leak between tests or into the ambient environment.
async function hermetic(patch: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const vevent = (o: { uid: string; summary: string; dtStart: string; dtEnd?: string; location?: string }): string[] => [
  "BEGIN:VEVENT",
  `UID:${o.uid}`,
  `SUMMARY:${o.summary}`,
  ...(o.location ? [`LOCATION:${o.location}`] : []),
  `DTSTART:${o.dtStart}`,
  ...(o.dtEnd ? [`DTEND:${o.dtEnd}`] : []),
  "END:VEVENT",
];
const ics = (...events: string[][]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//x//EN", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");

const ownEvent = (o: Partial<StoredEvent>): StoredEvent =>
  ({ uid: "own@baxter", title: "Own event", start: "2026-08-20T23:00:00Z", created: "", updated: "", ...o });

function writeAllowlist(path: string, list: Partial<Allowlist>): void {
  writeFileSync(path, JSON.stringify({ senders: [], recipients: [], version: 1, names: {}, ...list }, null, 2));
}

function logLines(storeDir: string): Array<Record<string, unknown>> {
  const p = join(storeDir, "task-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const readQuota = (storeDir: string): QuotaState =>
  JSON.parse(readFileSync(join(storeDir, "fire-quota.json"), "utf8")) as QuotaState;

const findDigest = (tasks: Task[]): Task => {
  const rec = tasks.find((t) => t.id === "system:daily-calendar-digest");
  assert.ok(rec, "the canonical system:daily-calendar-digest record exists");
  return rec;
};

// The hermeticity pin: the production state files must be untouched (existence
// and mtime unchanged) across the whole scenario.
const prodSnapshot = (): string[] =>
  [SCHEDULE_PATH, CALENDAR_EVENTS_PATH, CALENDAR_CACHE_PATH, ALLOWLIST_PATH].map((p) =>
    existsSync(p) ? `${p}:${statSync(p).mtimeMs}` : `${p}:-`);

// ---------- (1)-(4): reconcile, fire, fallback delivery, quota binding, advance ----------

test("e2e: one tick reconciles + fires the digest — real refresh lock, real quota task binding, SMS-to-email fallback, next-day cron advance", async () => {
  // 11:00 PDT Thu 2026-08-20 (18:00Z): today's 08:00 PDT anchor (15:00Z) has
  // passed, so the gate-created record is ALREADY DUE and this tick fires it.
  const NOW_MS = Date.parse("2026-08-20T18:00:00Z");
  const CAP = 5; // a normal daily cap, as main() wires it
  const DIGEST_TEXT = "Your day at a glance: one picnic and one dentist visit.";
  const s = freshScenario("digest-e2e-fire-");
  const order: string[] = [];
  const agentCalls: RunAgentOptions[] = [];
  const smsCalls: Array<{ phone: string; text: string }> = [];
  const mailCalls: Array<{ to: string; subject: string; text: string }> = [];
  let ordinaryFires = 0;

  await hermetic({ BAXTER_TZ: "America/Los_Angeles", SCHEDULE_DIR_OVERRIDE: s.storeDir }, async () => {
    const prodBefore = prodSnapshot();

    // Seeded state: one OWN event later today (16:30-17:30 PDT) + a family feed
    // whose fake fetch serves one ICS event later today (16:00-16:50 PDT), and a
    // one-contact allowlist (Dana Lee: phone + email) whose SMS will fail.
    writeFileSync(s.ownEventsPath, JSON.stringify([
      ownEvent({ uid: "own-dentist", title: "Dentist", start: "2026-08-20T23:30:00Z", end: "2026-08-21T00:30:00Z", location: "Office" }),
    ]));
    writeFileSync(s.feedsPath, JSON.stringify({ urls: [FEED_URL], version: 1 }));
    writeAllowlist(s.allowlistPath, {
      senders: ["+15550001111"],
      recipients: ["dana@x.com"],
      names: { "dana@x.com": "Dana Lee", "+15550001111": "Dana Lee" },
    });

    // The definition carries the INJECTED fakes; refreshImpl is deliberately NOT
    // injected -- the real T8 refresh runs (real lock, real cache write) against
    // the fake fetchFn, exactly what the handler does in production.
    const def = dailyCalendarDigestDefinition({
      fetchFn: stubFetch({ body: ics(vevent({ uid: "fam-picnic@family", summary: "Family picnic", location: "Park", dtStart: "20260820T230000Z", dtEnd: "20260820T235000Z" })) }),
      ownEventsPath: s.ownEventsPath,
      cachePath: s.cachePath,
      feedsPath: s.feedsPath,
      allowlistPath: s.allowlistPath,
      runsDir: s.runsDir,
      env: { BAXTER_TZ: "America/Los_Angeles" },
      runAgentImpl: async (opts) => {
        order.push("runAgent");
        agentCalls.push(opts);
        return { failed: false, outOfTokens: false, resetsAt: null, resultText: DIGEST_TEXT };
      },
      sendSmsImpl: async (phone, text) => {
        order.push(`sms ${phone}`);
        smsCalls.push({ phone, text });
        throw new Error("sendblue down"); // the failing channel
      },
      sendNewImpl: async (to, subject, text) => {
        order.push(`email ${to}`);
        mailCalls.push({ to, subject, text });
      },
      log: () => {},
    });

    // One tick: the gate creates the canonical record (already due at today's
    // 08:00 PDT), selects + claims it, dispatches the system handler, and the
    // quota wiring is EXACTLY main()'s (per-fire closure binding the claimed
    // task's id through the real reserveAgentRunSlot).
    await tick(NOW_MS, {
      runFn: async () => {
        ordinaryFires++;
        return { ok: true };
      },
      reserveAgentRunFor: (taskId) => reserveAgentRunSlot(new Date(NOW_MS), CAP, taskId),
      releaseAgentRun: releaseAgentRunSlot,
      visibilityMs: 900000,
      maxAttempts: 3,
      fallbackTz: "UTC",
      registry: [def],
      systemHandlerResolver: (key) => (key === "daily-calendar-digest" ? def.execute : undefined),
      log: () => {},
    });

    assert.deepEqual(prodSnapshot(), prodBefore, "production state paths were not modified");

    // (1) only the system task dispatched -- the ordinary runFn never ran.
    assert.equal(ordinaryFires, 0);

    // (2) SMS-to-email fallback, by call order: the generation ran once, the
    // contact's SMS was attempted and failed, then ONLY that contact's email.
    assert.deepEqual(order, ["runAgent", "sms +15550001111", "email dana@x.com"]);

    // (3) the merged agenda qualified BOTH the linked feed event and the seeded
    // own event, and the generation was the one tool-less run (allowedTools '').
    assert.equal(agentCalls.length, 1);
    assert.equal(agentCalls[0].allowedTools, "");
    assert.ok(agentCalls[0].prompt.includes("Family picnic"), "the linked feed event qualified");
    assert.ok(agentCalls[0].prompt.includes("Dentist"), "the seeded own event qualified");
    assert.ok(agentCalls[0].prompt.includes("2026-08-20"));
    assert.ok(agentCalls[0].prompt.includes("America/Los_Angeles"));

    // (4) the real refresh ran under the real lock: the cache was atomically
    // replaced with the feed's event and the lock file is released afterwards.
    const cache = JSON.parse(readFileSync(s.cachePath, "utf8")) as { events: VEvent[] };
    assert.ok(cache.events.some((e) => e.title === "Family picnic"));
    assert.equal(existsSync(`${refreshLockTarget(s.cachePath)}.lock`), false, "the refresh lock entry is released");

    // (5) the completed task-log entry carries the system audit fields.
    const entries = logLines(s.storeDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "completed");
    assert.equal(entries[0].id, "system:daily-calendar-digest");
    assert.equal(entries[0].system_key, "daily-calendar-digest");
    assert.equal(entries[0].agent_run, true);
    assert.ok(!String(entries[0].detail).includes("picnic"), "the logged detail is aggregate counts, never the digest body");

    // (6) fire-quota.json holds EXACTLY ONE consumed reservation bound to the
    // fired system task's id -- the per-fire task binding through the REAL quota
    // functions (a shared per-tick context would persist the wrong task field).
    const quota = readQuota(s.storeDir);
    assert.equal(quota.version, 1);
    assert.equal(quota.date, "2026-08-20"); // the injected instant's UTC day
    assert.equal(quota.reservations.length, 1);
    assert.equal(quota.reservations[0].task, "system:daily-calendar-digest");
    assert.equal(quota.reservations[0].ts, "2026-08-20T18:00:00.000Z");

    // (7) the record advanced to TOMORROW's 08:00 in the household tz, cleanly
    // (no attempt count, no lingering claim).
    const rec = findDigest(await readTasks());
    assert.equal(rec.next_run_at, "2026-08-21T15:00:00.000Z"); // tomorrow 08:00 PDT
    assert.equal(rec.tz, "America/Los_Angeles");
    assert.equal(rec.system?.key, "daily-calendar-digest");
    assert.equal(rec.system?.enabled, true);
    assert.equal(rec.attempts, 0);
    assert.equal(rec.invisible_until, null);

    // (8) the fallback email delivered the digest verbatim with the exact
    // literal subject (U+2019 + em dash, date localized in the digest tz).
    assert.equal(mailCalls.length, 1);
    assert.equal(mailCalls[0].to, "dana@x.com");
    assert.equal(mailCalls[0].subject, "What’s on the calendar today — 2026-08-20");
    assert.equal(mailCalls[0].text, DIGEST_TEXT);
    assert.equal(smsCalls.length, 1); // the failed SMS attempt is still recorded
  });
});

// ---------- (5): the no-event short circuit under a FULL cap window ----------

test("e2e: zero qualifying events with the cap window pre-filled FULL — completes agent_run:false, reserves nothing, still advances the cron", async () => {
  const NOW_MS = Date.parse("2026-08-20T18:00:00Z"); // 11:00 PDT
  const CAP = 2; // the pre-filled window holds exactly CAP same-day reservations
  const s = freshScenario("digest-e2e-none-");
  const agentCalls: RunAgentOptions[] = [];

  await hermetic({ BAXTER_TZ: "America/Los_Angeles", SCHEDULE_DIR_OVERRIDE: s.storeDir }, async () => {
    // Empty calendars but feeds CONFIGURED: the fake fetch serves a valid ICS
    // with no VEVENTs, so the refresh succeeds and caches an empty family set.
    writeFileSync(s.ownEventsPath, "[]");
    writeFileSync(s.feedsPath, JSON.stringify({ urls: [FEED_URL], version: 1 }));
    writeAllowlist(s.allowlistPath, { recipients: ["member@x.com"] });

    // Pre-fill the durable window to FULL at the injected instant's UTC day: any
    // reserve would be denied -- the no-event completion must never need one.
    writeFileSync(join(s.storeDir, "fire-quota.json"), JSON.stringify({
      version: 1,
      date: "2026-08-20",
      reservations: [
        { id: "pre-1", task: "ordinary-fire", ts: "2026-08-20T09:00:00.000Z" },
        { id: "pre-2", task: "ordinary-fire", ts: "2026-08-20T10:00:00.000Z" },
      ],
    }, null, 2));

    const def = dailyCalendarDigestDefinition({
      fetchFn: stubFetch({ body: ics() }),
      ownEventsPath: s.ownEventsPath,
      cachePath: s.cachePath,
      feedsPath: s.feedsPath,
      allowlistPath: s.allowlistPath,
      runsDir: s.runsDir,
      env: { BAXTER_TZ: "America/Los_Angeles" },
      runAgentImpl: async (opts) => {
        agentCalls.push(opts);
        return { failed: false, outOfTokens: false, resetsAt: null, resultText: "never generated" };
      },
      sendSmsImpl: async () => assert.fail("no SMS without a generation"),
      sendNewImpl: async () => assert.fail("no email without a generation"),
      log: () => {},
    });

    await tick(NOW_MS, {
      runFn: async () => ({ ok: true }),
      reserveAgentRunFor: (taskId) => reserveAgentRunSlot(new Date(NOW_MS), CAP, taskId),
      releaseAgentRun: releaseAgentRunSlot,
      visibilityMs: 900000,
      maxAttempts: 3,
      fallbackTz: "UTC",
      registry: [def],
      systemHandlerResolver: (key) => (key === "daily-calendar-digest" ? def.execute : undefined),
      log: () => {},
    });

    // No model run, no sends.
    assert.equal(agentCalls.length, 0);
    // The completion is a SUCCESS with agent_run:false (the short circuit), not a
    // deferral: heartbeat advanced the cron even though the window was full.
    const entries = logLines(s.storeDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "completed");
    assert.equal(entries[0].agent_run, false);
    assert.equal(entries[0].system_key, "daily-calendar-digest");
    // NO reservation was made or consumed: the pre-filled window is untouched.
    const quota = readQuota(s.storeDir);
    assert.deepEqual(quota.reservations.map((r) => r.id), ["pre-1", "pre-2"]);
    assert.ok(!quota.reservations.some((r) => r.task === "system:daily-calendar-digest"));
    // And the cron still advanced to tomorrow's 08:00 PDT.
    const rec = findDigest(await readTasks());
    assert.equal(rec.next_run_at, "2026-08-21T15:00:00.000Z");
    assert.equal(rec.attempts, 0);
    assert.equal(rec.invisible_until, null);
  });
});

// ---------- rejected generation: normal failure/retry path with truthful audit ----------

test("e2e: rejected generation persists its reservation, sends nothing, and logs failed agent_run:true", async () => {
  const NOW_MS = Date.parse("2026-08-20T18:00:00Z"); // 11:00 PDT, digest is due
  const CAP = 5;
  const s = freshScenario("digest-e2e-reject-");
  let agentCalls = 0;
  let deliveryCalls = 0;

  await hermetic({ BAXTER_TZ: "America/Los_Angeles", SCHEDULE_DIR_OVERRIDE: s.storeDir }, async () => {
    writeFileSync(s.ownEventsPath, "[]");
    writeFileSync(s.feedsPath, JSON.stringify({ urls: [FEED_URL], version: 1 }));
    writeAllowlist(s.allowlistPath, {
      senders: ["+15550001111"],
      recipients: ["dana@x.com"],
      names: { "dana@x.com": "Dana Lee", "+15550001111": "Dana Lee" },
    });

    const def = dailyCalendarDigestDefinition({
      fetchFn: stubFetch({ body: ics(vevent({ uid: "fam-reject@family", summary: "Generation rejection fixture", dtStart: "20260820T230000Z" })) }),
      ownEventsPath: s.ownEventsPath,
      cachePath: s.cachePath,
      feedsPath: s.feedsPath,
      allowlistPath: s.allowlistPath,
      runsDir: s.runsDir,
      env: { BAXTER_TZ: "America/Los_Angeles" },
      runAgentImpl: async () => {
        agentCalls++;
        throw new Error("provider transport rejected the invocation");
      },
      sendSmsImpl: async () => { deliveryCalls++; return { id: "unexpected" }; },
      sendNewImpl: async () => { deliveryCalls++; },
      log: () => {},
    });

    await tick(NOW_MS, {
      runFn: async () => ({ ok: true }),
      reserveAgentRunFor: (taskId) => reserveAgentRunSlot(new Date(NOW_MS), CAP, taskId),
      releaseAgentRun: releaseAgentRunSlot,
      visibilityMs: 900000,
      maxAttempts: 3,
      fallbackTz: "UTC",
      registry: [def],
      systemHandlerResolver: (key) => (key === "daily-calendar-digest" ? def.execute : undefined),
      log: () => {},
    });

    assert.equal(agentCalls, 1, "generation invocation occurred once");
    assert.equal(deliveryCalls, 0, "a rejected generation never reaches delivery");

    const quota = readQuota(s.storeDir);
    assert.equal(quota.reservations.length, 1, "the reservation remains consumed");
    assert.equal(quota.reservations[0].task, "system:daily-calendar-digest");

    const entries = logLines(s.storeDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, "failed");
    assert.equal(entries[0].system_key, "daily-calendar-digest");
    assert.equal(entries[0].agent_run, true);
    assert.equal(entries[0].detail, "generation failed");

    const rec = findDigest(await readTasks());
    assert.equal(rec.attempts, 1, "normal retry accounting applies");
    assert.equal(rec.next_run_at, "2026-08-20T15:00:00.000Z", "the due occurrence is retained for retry");
    assert.equal(rec.invisible_until, "2026-08-20T18:15:00.000Z", "the normal claim visibility window controls retry timing");
  });
});

// ---------- (6): one resolved zone everywhere, hermetically ----------

test("e2e one-zone: invalid BAXTER_TZ + HEARTBEAT_TZ America/New_York — gate anchor, digest day boundary, and both mirrors resolve ONE zone on temp paths only", async () => {
  const NOW = new Date("2026-08-20T18:00:00Z"); // 14:00 EDT Thu 2026-08-20
  const env6 = { BAXTER_TZ: "Not/AZone", HEARTBEAT_TZ: "America/New_York" };
  const s = freshScenario("digest-e2e-tz-");
  const agentCalls: RunAgentOptions[] = [];
  const mailCalls: Array<{ to: string; subject: string }> = [];
  let reserved = 0;

  await hermetic({ ...env6, SCHEDULE_DIR_OVERRIDE: s.storeDir }, async () => {
    const prodBefore = prodSnapshot();

    // Day-boundary probes around America/New_York's midnight (04:00Z Aug 21):
    // 23:00/23:30 EDT events are INSIDE today's NY local day; 00:30 EDT is
    // TOMORROW's and must never reach the digest.
    writeFileSync(s.ownEventsPath, JSON.stringify([
      ownEvent({ uid: "o-late", title: "NY own late evening", start: "2026-08-21T03:30:00Z", end: "2026-08-21T04:00:00Z" }),
      ownEvent({ uid: "o-tmrw", title: "NY tomorrow early", start: "2026-08-21T04:30:00Z", end: "2026-08-21T05:00:00Z" }),
    ]));
    writeFileSync(s.feedsPath, JSON.stringify({ urls: [FEED_URL], version: 1 }));
    writeAllowlist(s.allowlistPath, { recipients: ["member@x.com"] });

    const def = dailyCalendarDigestDefinition({
      fetchFn: stubFetch({ body: ics(vevent({ uid: "fam-ny@family", summary: "NY family evening", dtStart: "20260821T030000Z", dtEnd: "20260821T033000Z" })) }),
      ownEventsPath: s.ownEventsPath,
      cachePath: s.cachePath,
      feedsPath: s.feedsPath,
      allowlistPath: s.allowlistPath,
      runsDir: s.runsDir,
      env: env6, // the digest's OWN injected env resolves the same chain
      runAgentImpl: async (opts) => {
        agentCalls.push(opts);
        return { failed: false, outOfTokens: false, resetsAt: null, resultText: "Evening digest." };
      },
      sendSmsImpl: async () => assert.fail("the seeded contact is email-only"),
      sendNewImpl: async (to, subject) => {
        mailCalls.push({ to, subject });
      },
      log: () => {},
    });

    // (a) The gate creates the canonical record anchored at TODAY's 08:00 in the
    // RESOLVED zone (America/New_York via HEARTBEAT_TZ; the invalid BAXTER_TZ is
    // skipped, never thrown on).
    const gate = await runReconcileGate(NOW, { registry: [def], log: () => {} });
    assert.equal(gate.ok, true);
    const rec = findDigest(await readTasks());
    assert.equal(rec.next_run_at, "2026-08-20T12:00:00.000Z"); // today's 08:00 EDT
    assert.equal(rec.tz, "America/New_York");

    // (b) The digest's selection boundary is the NY local day: the 23:00/23:30
    // EDT events qualify, the 00:30 EDT one (after NY midnight) does not.
    const result = await def.execute(rec, {
      now: NOW,
      reserveAgentRun: async () => {
        reserved++;
        return { token: "tok-nys" };
      },
      releaseAgentRun: async () => {},
      log: () => {},
    } satisfies SystemTaskContext);
    assert.equal(result.ok, true);
    assert.equal(result.agentRun, true);
    assert.equal(reserved, 1);
    assert.equal(agentCalls.length, 1);
    const prompt = agentCalls[0].prompt;
    assert.ok(prompt.includes("NY family evening"), "23:00 EDT family event is inside the NY day");
    assert.ok(prompt.includes("NY own late evening"), "23:30 EDT own event is inside the NY day");
    assert.ok(!prompt.includes("NY tomorrow early"), "00:30 EDT is after NY midnight — excluded");
    assert.ok(prompt.includes("America/New_York"));
    assert.ok(prompt.includes("2026-08-20"));
    assert.equal(mailCalls.length, 1);
    assert.equal(mailCalls[0].subject, "What’s on the calendar today — 2026-08-20");

    // (c) Both mirrors report the SAME zone. buildCalendarView is called with
    // explicit temp deps and tz OMITTED (CalendarViewDeps.tz is optional), so its
    // unset path resolves through householdTz -- the real fallback chain; the
    // default deps (production calendar paths) are never used here.
    const cal = buildCalendarView(NOW, { ownEventsPath: s.ownEventsPath, cachePath: s.cachePath });
    assert.equal(cal.tz, "America/New_York");
    assert.ok(cal.items.some((i) => i.title === "NY family evening"), "the temp cache the refresh wrote feeds the view");
    const sched = await buildScheduleView();
    assert.equal(sched.tz, "America/New_York");
    const sysItem = sched.items.find((i) => i.system);
    assert.ok(sysItem, "the system task renders on /scheduled");
    assert.equal(sysItem?.enabled, true);
    assert.equal(sysItem?.nextRun, "2026-08-20T12:00:00.000Z");

    assert.deepEqual(prodSnapshot(), prodBefore, "production state paths were not modified");
  });
});
