import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { weeklyHouseholdCheckInDefinition } from "./weekly-household-check-in.ts";
import { reconcileSystemTasks } from "./system-reconcile.ts";
import { applyOnSuccess, type Task } from "./schedule-store.ts";
import type { SystemTaskContext, SystemTaskDefinition } from "./system-tasks.ts";
import type { StoredEvent } from "./calendar-store.ts";

const TZ = "America/Los_Angeles";
const FRIDAY = new Date("2026-08-21T16:00:00Z");
const MONDAY = new Date("2026-08-24T16:00:00Z");

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
  assert.equal(reservations, 2, "one household-level reservation per weekly occurrence");
  assert.equal(modelPrompts.length, 2);
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
