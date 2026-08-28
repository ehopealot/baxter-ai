import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { takeMorningRemindersForContact } from "./morning-reminder-fold.ts";
import { tzDateToken } from "./tz.ts";

const contact = { phones: ["+15551234567"], emails: ["ari@example.test"] };
const monday = new Date("2026-08-24T15:00:00.000Z"); // 08:00 PDT

test("takes only direct one-shot reminders still pending before local noon on Monday or Friday", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morning-reminder-fold-"));
  const prior = process.env.SCHEDULE_DIR_OVERRIDE;
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  try {
    writeFileSync(join(dir, "schedule.json"), JSON.stringify([
      { id: "deadbeef", desc: "Send the Verizon phone back", at: "2026-08-24T16:00:00.000Z", next_run_at: "2026-08-24T16:00:00.000Z", deliver: { surface: "sms", target: "(555) 123-4567" } },
      { id: "cafebabe", desc: "Email the school", at: "2026-08-24T18:59:00.000Z", next_run_at: "2026-08-24T18:59:00.000Z", deliver: { surface: "mail", target: " ARI@EXAMPLE.TEST " } },
      { id: "facefeed", desc: "Afternoon", at: "2026-08-24T19:00:00.000Z", next_run_at: "2026-08-24T19:00:00.000Z", deliver: { surface: "sms", target: "+15551234567" } },
      { id: "00000000", desc: "Recurring", cron: "0 9 * * *", next_run_at: "2026-08-24T16:00:00.000Z", deliver: { surface: "sms", target: "+15551234567" } },
      { id: "11111111", desc: "Claimed", at: "2026-08-24T16:00:00.000Z", next_run_at: "2026-08-24T16:00:00.000Z", invisible_until: "2026-08-24T16:05:00.000Z", deliver: { surface: "sms", target: "+15551234567" } },
      { id: "22222222", desc: "Group", at: "2026-08-24T16:00:00.000Z", next_run_at: "2026-08-24T16:00:00.000Z", deliver: { surface: "sms-group", target: "family" } },
      { id: "deadbeef", desc: "Duplicate recurring", cron: "0 9 * * *", next_run_at: "2026-08-24T16:00:00.000Z", deliver: { surface: "sms", target: "+15551234567" } },
    ]));

    assert.deepEqual(await takeMorningRemindersForContact(contact, () => monday, "America/Los_Angeles", 1400, tzDateToken(monday, "America/Los_Angeles")), [
      { id: "deadbeef", description: "Send the Verizon phone back" },
      { id: "cafebabe", description: "Email the school" },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "schedule.json"), "utf8")).map((task: any) => task.id), ["facefeed", "00000000", "11111111", "22222222", "deadbeef"]);
  } finally {
    if (prior === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE; else process.env.SCHEDULE_DIR_OVERRIDE = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retains descriptions that would exceed the folded delivery limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morning-reminder-fold-"));
  const prior = process.env.SCHEDULE_DIR_OVERRIDE;
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  try {
    writeFileSync(join(dir, "schedule.json"), JSON.stringify([
      { id: "deadbeef", desc: "x".repeat(100), at: "2026-08-24T16:00:00.000Z", next_run_at: "2026-08-24T16:00:00.000Z", deliver: { surface: "sms", target: "+15551234567" } },
      { id: "cafebabe", desc: "Fits", at: "2026-08-24T16:01:00.000Z", next_run_at: "2026-08-24T16:01:00.000Z", deliver: { surface: "sms", target: "+15551234567" } },
    ]));
    assert.deepEqual(await takeMorningRemindersForContact(contact, () => monday, "America/Los_Angeles", 30, tzDateToken(monday, "America/Los_Angeles")), [{ id: "cafebabe", description: "Fits" }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "schedule.json"), "utf8")).map((task: any) => task.id), ["deadbeef"]);
  } finally {
    if (prior === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE; else process.env.SCHEDULE_DIR_OVERRIDE = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves reminders alone when delivery moved to a different local date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morning-reminder-fold-"));
  const prior = process.env.SCHEDULE_DIR_OVERRIDE;
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  try {
    writeFileSync(join(dir, "schedule.json"), JSON.stringify([{ id: "deadbeef", desc: "Keep", at: "2026-08-28T16:00:00.000Z", next_run_at: "2026-08-28T16:00:00.000Z", deliver: { surface: "sms", target: "+15551234567" } }]));
    const friday = new Date("2026-08-28T15:00:00.000Z");
    assert.deepEqual(await takeMorningRemindersForContact(contact, () => friday, "America/Los_Angeles", 1400, tzDateToken(monday, "America/Los_Angeles")), []);
    assert.equal(JSON.parse(readFileSync(join(dir, "schedule.json"), "utf8")).length, 1);
  } finally {
    if (prior === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE; else process.env.SCHEDULE_DIR_OVERRIDE = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves reminders alone outside Monday and Friday", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morning-reminder-fold-"));
  const prior = process.env.SCHEDULE_DIR_OVERRIDE;
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  try {
    writeFileSync(join(dir, "schedule.json"), JSON.stringify([{ id: "deadbeef", desc: "Keep", at: "2026-08-25T16:00:00.000Z", next_run_at: "2026-08-25T16:00:00.000Z", deliver: { surface: "sms", target: "+15551234567" } }]));
    assert.deepEqual(await takeMorningRemindersForContact(contact, () => new Date("2026-08-25T15:00:00.000Z"), "America/Los_Angeles", 1400, tzDateToken(new Date("2026-08-25T15:00:00.000Z"), "America/Los_Angeles")), []);
    assert.equal(JSON.parse(readFileSync(join(dir, "schedule.json"), "utf8")).length, 1);
  } finally {
    if (prior === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE; else process.env.SCHEDULE_DIR_OVERRIDE = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
