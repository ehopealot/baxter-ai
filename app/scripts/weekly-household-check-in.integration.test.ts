import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { weeklyHouseholdCheckInDefinition } from "./weekly-household-check-in.ts";
import { reconcileSystemTasks } from "./system-reconcile.ts";
import { applyOnSuccess, readTasks, type Task } from "./schedule-store.ts";
import { tick } from "./heartbeat.ts";
import type { SystemTaskContext, SystemTaskDefinition, SystemTaskResult } from "./system-tasks.ts";
import type { StoredEvent } from "./calendar-store.ts";

const TZ = "America/Los_Angeles";
const FRIDAY = new Date("2026-08-21T16:00:00Z");
const MONDAY = new Date("2026-08-24T16:00:00Z");

async function withScheduleDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const savedDir = process.env.SCHEDULE_DIR_OVERRIDE;
  const savedTz = process.env.BAXTER_TZ;
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  process.env.BAXTER_TZ = TZ;
  try { return await fn(); }
  finally {
    if (savedDir === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE; else process.env.SCHEDULE_DIR_OVERRIDE = savedDir;
    if (savedTz === undefined) delete process.env.BAXTER_TZ; else process.env.BAXTER_TZ = savedTz;
  }
}

function byKey(tasks: Task[], key: string): Task {
  const task = tasks.find((candidate) => candidate.system?.key === key);
  assert.ok(task, `missing ${key}`);
  return task;
}

test("integration: reconcile both weekly modes, provide bounded knowledge/calendar context, preserve model bodies, and advance independently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weekly-integration-"));
  const memoryPath = join(dir, "memory.md");
  const collectionsDir = join(dir, "collections");
  const ownEventsPath = join(dir, "events.json");
  const allowlistPath = join(dir, "allowlist.json");
  mkdirSync(collectionsDir);
  writeFileSync(memoryPath, "Hugo and Selina enjoyed the science museum. Current priority: organize school forms.");
  writeFileSync(join(collectionsDir, "activities.md"), "Visible idea: revisit the museum.\n<comment>PRIVATE PLAN</comment>");
  const own: StoredEvent[] = [{ uid: "picnic", title: "Saturday picnic", start: "2026-08-22T19:00:00Z", end: "2026-08-22T21:00:00Z", created: "", updated: "" }];
  writeFileSync(ownEventsPath, JSON.stringify(own));
  writeFileSync(allowlistPath, JSON.stringify({
    version: 1,
    senders: ["+15550001111"],
    recipients: ["dana@example.com", "+15550001111"],
    names: { "dana@example.com": "Dana", "+15550001111": "Dana" },
  }));

  const modelPrompts: string[] = [];
  const modelLogIds: string[] = [];
  const smsBodies: string[] = [];
  const emails: Array<{ subject: string; body: string }> = [];
  let refreshCalls = 0;
  let ownReads = 0;
  const shared = {
    env: { BAXTER_TZ: TZ }, memoryPath, collectionsDir, ownEventsPath, allowlistPath,
    refreshImpl: async () => { refreshCalls++; return { urls: [], ok: false, events: [], errors: [], wroteCache: false, familySnapshot: [] }; },
    readOwnEventsImpl: (path: string) => { ownReads++; return JSON.parse(readFileSync(path, "utf8")) as StoredEvent[]; },
    runAgentImpl: async (options: Parameters<typeof import("./runtime.ts").runAgent>[0]) => {
      modelPrompts.push(options.prompt);
      modelLogIds.push(options.logId);
      return {
        failed: false,
        outOfTokens: false,
        resetsAt: null,
        resultText: options.logId.includes("friday")
          ? JSON.stringify({
            subject: "A few thoughts for the weekend",
            body: "Friday is here — the weekend is close behind!\n\n• Saturday: Saturday picnic.\n• One new idea could be another museum visit with Hugo and Selina.\n\nJust let me know if you’d like me to help with anything!",
          })
          : JSON.stringify({
            subject: "A gentle start to the week",
            body: "It’s Monday — hope the week is starting smoothly! Would you like to carry the school forms priority forward? Just let me know if you’d like me to help with anything this week!",
          }),
      };
    },
    sendSmsImpl: async (_phone: string, body: string) => { smsBodies.push(body); throw new Error("provider unavailable"); },
    sendNewImpl: async (_to: string, subject: string, body: string) => { emails.push({ subject, body }); },
  };
  const friday = weeklyHouseholdCheckInDefinition("friday", shared);
  const monday = weeklyHouseholdCheckInDefinition("monday", shared);
  const digest: SystemTaskDefinition<"daily-calendar-digest"> = {
    key: "daily-calendar-digest", desc: "Here’s what’s on the calendar", cron: "0 8 * * *", execute: async () => ({ ok: true }),
  };
  const registry: readonly SystemTaskDefinition<string>[] = [digest, friday, monday];
  const reconciled = reconcileSystemTasks([], registry, FRIDAY, TZ, () => {});
  assert.deepEqual(reconciled.tasks.map((task) => task.id), [
    "system:daily-calendar-digest",
    "system:friday-weekend-check-in",
    "system:monday-weekly-check-in",
  ]);
  assert.ok(reconciled.tasks.every((task) => task.system?.enabled === true));

  let reservations = 0;
  const context = (now: Date): SystemTaskContext => ({
    now,
    reserveAgentRun: async () => { reservations++; return { token: `slot-${reservations}` }; },
    releaseAgentRun: async () => {},
    log: () => {},
  });
  const fridayResult = await friday.execute(byKey(reconciled.tasks, friday.key), context(FRIDAY));
  const mondayResult = await monday.execute(byKey(reconciled.tasks, monday.key), context(MONDAY));
  assert.equal(fridayResult.ok, true);
  assert.equal(mondayResult.ok, true);
  assert.equal(reservations, 2, "one reservation per attempted contact (one contact in each occurrence)");
  assert.equal(modelPrompts.length, 2);
  assert.deepEqual(modelLogIds, [
    `system:friday-weekend-check-in-${FRIDAY.getTime()}-0`,
    `system:monday-weekly-check-in-${MONDAY.getTime()}-0`,
  ]);
  assert.ok(modelPrompts[0]!.includes("Saturday picnic"), "Friday receives the sanitized weekend projection");
  assert.ok(modelPrompts[0]!.includes("Hugo and Selina"), "Friday receives shared household memory");
  assert.ok(!modelPrompts[0]!.includes("PRIVATE PLAN"));
  assert.ok(!modelPrompts[1]!.includes("Saturday picnic"), "Monday prompt contains no calendar data");
  assert.ok(modelPrompts[1]!.includes("Hugo and Selina"), "Monday receives shared household memory");
  assert.equal(refreshCalls, 1, "only Friday refreshes calendars");
  assert.equal(ownReads, 1, "only Friday reads calendars");
  assert.equal(emails.length, 2);
  assert.equal(smsBodies[0], emails[0]!.body);
  assert.equal(smsBodies[1], emails[1]!.body);
  assert.match(emails[0]!.body, /^Hi Dana — Friday is here.*Saturday picnic.*Hugo and Selina.*Just let me know/s);
  assert.equal((emails[0]!.body.match(/Saturday picnic/g) ?? []).length, 1);
  assert.match(emails[1]!.body, /^Hi Dana — It’s Monday.*school forms.*Just let me know if you’d like me to help with anything this week!$/s);
  assert.equal(emails[0]!.subject, "A few thoughts for the weekend");
  assert.equal(emails[1]!.subject, "A gentle start to the week");

  const afterFriday = applyOnSuccess(reconciled.tasks, byKey(reconciled.tasks, friday.key).id, FRIDAY.getTime(), TZ);
  const afterBoth = applyOnSuccess(afterFriday, byKey(afterFriday, monday.key).id, MONDAY.getTime(), TZ);
  assert.equal(byKey(afterBoth, friday.key).next_run_at, "2026-08-28T16:00:00.000Z");
  assert.equal(byKey(afterBoth, monday.key).next_run_at, "2026-08-31T16:00:00.000Z");
});

test("integration: Friday snapshots multiple recipients and preserves deterministic prompt, model, and delivery isolation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-per-recipient-integration-"));
  const allowlistPath = join(dir, "allowlist.json");
  const ownEventsPath = join(dir, "events.json");
  writeFileSync(allowlistPath, JSON.stringify({
    version: 1, senders: [], recipients: ["zoe@example.com", "amy@example.com", "mila@example.com"],
    names: { "zoe@example.com": "Zoe", "amy@example.com": "Amy", "mila@example.com": "Mila" },
  }));
  writeFileSync(ownEventsPath, JSON.stringify([
    { uid: "weekend", title: "Saturday picnic", start: "2026-08-22T19:00:00Z", end: "2026-08-22T20:00:00Z", created: "", updated: "" },
  ]));
  const promptNames: string[] = [];
  const logIds: string[] = [];
  const deliveries: Array<{ to: string; subject: string; body: string }> = [];
  const definition = weeklyHouseholdCheckInDefinition("friday", {
    env: { BAXTER_TZ: TZ }, allowlistPath, ownEventsPath,
    refreshImpl: async () => ({ urls: [], ok: false, events: [], errors: [], wroteCache: false, familySnapshot: [] }),
    loadKnowledgeImpl: () => ({ text: "Shared household fact.", empty: false, includedCollections: 0, omittedCollections: 0, truncatedSources: 0 }),
    runAgentImpl: async (options) => {
      const match = options.prompt.match(/"currentRecipientDisplayName":"([^"]+)"/u);
      assert.ok(match);
      const name = match[1]!;
      promptNames.push(name);
      logIds.push(options.logId);
      return {
        failed: false, outOfTokens: false, resetsAt: null,
        resultText: JSON.stringify({ subject: `A gentle note ${promptNames.length}`, body: `Generated only for recipient index ${promptNames.length - 1} (${name}).` }),
      };
    },
    sendSmsImpl: async () => { throw new Error("email only"); },
    sendNewImpl: async (to, subject, body) => { deliveries.push({ to, subject, body }); },
  });
  let reservations = 0;
  const result = await definition.execute({
    id: "system:friday-weekend-check-in", cron: "0 9 * * 5", next_run_at: FRIDAY.toISOString(),
    system: { key: "friday-weekend-check-in", enabled: true },
  }, {
    now: FRIDAY,
    reserveAgentRun: async () => ({ token: `slot-${++reservations}` }),
    releaseAgentRun: async () => {},
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(reservations, 3);
  assert.deepEqual(promptNames, ["Amy", "Mila", "Zoe"]);
  assert.deepEqual(logIds, [0, 1, 2].map((index) => `system:friday-weekend-check-in-${FRIDAY.getTime()}-${index}`));
  assert.deepEqual(deliveries.map(({ to, body }) => ({ to, body })), [
    { to: "amy@example.com", body: "Hi Amy — Generated only for recipient index 0 (Amy)." },
    { to: "mila@example.com", body: "Hi Mila — Generated only for recipient index 1 (Mila)." },
    { to: "zoe@example.com", body: "Hi Zoe — Generated only for recipient index 2 (Zoe)." },
  ]);
  assert.equal(new Set(deliveries.map((delivery) => delivery.subject)).size, 3);
});

test("heartbeat completes an out-of-tokens weekly check-in via fallback, clears the claim, advances cron, burns zero attempts, and does not retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weekly-heartbeat-oot-"));
  const allowlistPath = join(dir, "allowlist.json");
  writeFileSync(allowlistPath, JSON.stringify({ version: 1, senders: [], recipients: ["a@x.com", "b@x.com", "c@x.com"], names: {} }));
  let modelCalls = 0;
  const deliveries: Array<{ to: string; body: string }> = [];
  let completionResult: SystemTaskResult | undefined;
  const definition = weeklyHouseholdCheckInDefinition("monday", {
    env: { BAXTER_TZ: TZ }, allowlistPath,
    loadKnowledgeImpl: () => ({ text: "", empty: true, includedCollections: 0, omittedCollections: 0, truncatedSources: 0 }),
    runAgentImpl: async () => {
      modelCalls++;
      return modelCalls === 1
        ? { failed: false, outOfTokens: false, resetsAt: null, resultText: JSON.stringify({ subject: "A gentle note", body: "First generated contact copy." }) }
        : { failed: false, outOfTokens: true, resetsAt: null };
    },
    sendSmsImpl: async () => { throw new Error("email only"); },
    sendNewImpl: async (to, _subject, body) => { deliveries.push({ to, body }); },
  });
  const completingHandler = async (claimed: Task, context: SystemTaskContext): Promise<SystemTaskResult> => {
    completionResult = await definition.execute(claimed, context);
    return completionResult;
  };
  await withScheduleDir(dir, async () => {
    let reservations = 0;
    let releases = 0;
    const options = {
      runFn: async () => ({ ok: true }),
      reserveAgentRunFor: async () => ({ token: `slot-${++reservations}` }),
      releaseAgentRun: async () => { releases++; },
      visibilityMs: 1_000,
      maxAttempts: 3,
      fallbackTz: TZ,
      registry: [definition],
      systemHandlerResolver: () => completingHandler,
      log: () => {},
    };
    await tick(MONDAY.getTime(), options);
    await tick(MONDAY.getTime() + 2_000, options);
    assert.equal(modelCalls, 2, "one generated delivery precedes out-of-tokens, which stops later model attempts; the advanced task does not retry");
    assert.equal(reservations, 2);
    assert.equal(releases, 1);
    assert.equal(completionResult?.ok, true);
    assert.equal(completionResult?.outOfTokens ?? false, false);
    assert.equal(completionResult?.deferredByCap ?? false, false);
    assert.deepEqual(deliveries.map((delivery) => delivery.to), ["a@x.com", "b@x.com", "c@x.com"]);
    assert.equal(new Set(deliveries.map((delivery) => delivery.to)).size, 3);
    assert.match(deliveries[0]!.body, /First generated contact copy/);
    assert.match(deliveries[1]!.body, /Hope your Monday/);
    assert.match(deliveries[2]!.body, /Hope your Monday/);
    const record = (await readTasks()).find((candidate) => candidate.id === "system:monday-weekly-check-in")!;
    assert.equal(record.next_run_at, "2026-08-31T16:00:00.000Z");
    assert.equal(record.invisible_until, null);
    assert.equal(record.attempts, 0);
    const logs = readFileSync(join(dir, "task-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].outcome, "completed");
    assert.equal(logs[0].agent_run, true);
  });
});

test("an unhandled interruption may retry from contact zero after invisibility", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weekly-heartbeat-retry-zero-"));
  const allowlistPath = join(dir, "allowlist.json");
  writeFileSync(allowlistPath, JSON.stringify({ version: 1, senders: [], recipients: ["a@x.com", "b@x.com"], names: {} }));
  const deliveries: string[] = [];
  const definition = weeklyHouseholdCheckInDefinition("monday", {
    env: { BAXTER_TZ: TZ }, allowlistPath,
    loadKnowledgeImpl: () => ({ text: "", empty: true, includedCollections: 0, omittedCollections: 0, truncatedSources: 0 }),
    runAgentImpl: async () => ({ failed: false, outOfTokens: false, resetsAt: null, resultText: JSON.stringify({ subject: "A gentle note", body: "A useful note for the week." }) }),
    sendSmsImpl: async () => { throw new Error("email only"); },
    sendNewImpl: async (to) => { deliveries.push(to); },
  });
  await withScheduleDir(dir, async () => {
    let reservationCalls = 0;
    const options = {
      runFn: async () => ({ ok: true }),
      reserveAgentRunFor: async () => {
        reservationCalls++;
        if (reservationCalls === 2) throw new Error("unhandled interruption after contact zero");
        return { token: `slot-${reservationCalls}` };
      },
      releaseAgentRun: async () => {},
      visibilityMs: 1_000,
      maxAttempts: 3,
      fallbackTz: TZ,
      registry: [definition],
      systemHandlerResolver: () => definition.execute,
      log: () => {},
    };
    await tick(MONDAY.getTime(), options);
    let record = (await readTasks()).find((candidate) => candidate.id === "system:monday-weekly-check-in")!;
    assert.equal(record.attempts, 1);
    assert.equal(record.invisible_until, new Date(MONDAY.getTime() + 1_000).toISOString());
    await tick(MONDAY.getTime() + 1_001, options);
    assert.deepEqual(deliveries, ["a@x.com", "a@x.com", "b@x.com"], "retry has no durable recipient checkpoint and restarts at contact zero");
    record = (await readTasks()).find((candidate) => candidate.id === "system:monday-weekly-check-in")!;
    assert.equal(record.attempts, 0);
    assert.equal(record.invisible_until, null);
    assert.equal(record.next_run_at, "2026-08-31T16:00:00.000Z");
    const outcomes = readFileSync(join(dir, "task-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).outcome);
    assert.deepEqual(outcomes, ["failed", "completed"]);
  });
});

test("integration: Monday snapshots two contacts and keeps per-recipient prompts, reservations, and deliveries isolated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weekly-per-recipient-integration-"));
  const memoryPath = join(dir, "memory.md");
  const collectionsDir = join(dir, "collections");
  const allowlistPath = join(dir, "allowlist.json");
  mkdirSync(collectionsDir);
  writeFileSync(memoryPath, "Erik prefers quiet mornings. Laura enjoys afternoon walks.");
  writeFileSync(allowlistPath, JSON.stringify({
    version: 1, senders: [], recipients: ["erik@example.com", "laura@example.com"],
    names: { "erik@example.com": "Erik", "laura@example.com": "Laura" },
  }));
  const prompts: string[] = [];
  const deliveries: Array<{ to: string; subject: string; body: string }> = [];
  const definition = weeklyHouseholdCheckInDefinition("monday", {
    env: { BAXTER_TZ: TZ }, memoryPath, collectionsDir, allowlistPath,
    runAgentImpl: async (options) => {
      prompts.push(options.prompt);
      const current = options.prompt.includes('"currentRecipientDisplayName":"Erik"') ? "Erik" : "Laura";
      return {
        failed: false, outOfTokens: false, resetsAt: null,
        resultText: JSON.stringify({ subject: "A gentle week-start note", body: `A distinct useful note prepared for ${current}.` }),
      };
    },
    sendSmsImpl: async () => { throw new Error("no phone"); },
    sendNewImpl: async (to, subject, body) => { deliveries.push({ to, subject, body }); },
  });
  let reservations = 0;
  const result = await definition.execute({
    id: "system:monday-weekly-check-in", cron: "0 9 * * 1", next_run_at: MONDAY.toISOString(),
    system: { key: "monday-weekly-check-in", enabled: true },
  }, {
    now: MONDAY,
    reserveAgentRun: async () => ({ token: `slot-${++reservations}` }),
    releaseAgentRun: async () => {},
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(reservations, 2);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0]!.includes('"currentRecipientDisplayName":"Erik"'));
  assert.ok(prompts[1]!.includes('"currentRecipientDisplayName":"Laura"'));
  assert.ok(prompts.every((prompt) => !prompt.includes("@example.com")));
  assert.deepEqual(deliveries.map(({ to, body }) => ({ to, body })), [
    { to: "erik@example.com", body: "Hi Erik — A distinct useful note prepared for Erik." },
    { to: "laura@example.com", body: "Hi Laura — A distinct useful note prepared for Laura." },
  ]);
});
