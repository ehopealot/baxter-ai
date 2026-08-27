import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consumeFoldedFollowUps, dueFollowUpsForContact } from "./followup-daily.ts";

const now = new Date("2026-08-31T15:00:00.000Z"); // Monday 08:00 PDT
const contact = { phones: ["+15551234567"], emails: ["a@example.com"] };

test("daily update selects only same-recipient direct follow-ups later on Monday or Friday", () => {
  const tasks: any[] = [
    { id: "deadbeef", next_run_at: "2026-08-31T20:00:00.000Z", deliver: { surface: "sms", target: "+15551234567" }, follow_up: { kind: "topic", subject: "School project" } },
    { id: "cafebabe", next_run_at: "2026-08-31T20:00:00.000Z", deliver: { surface: "sms-group", target: "grp_family" }, follow_up: { kind: "topic", subject: "Group topic" } },
    { id: "facefeed", next_run_at: "2026-08-31T20:00:00.000Z", deliver: { surface: "mail", target: "other@example.com" }, follow_up: { kind: "topic", subject: "Other person" } },
  ];
  assert.deepEqual(dueFollowUpsForContact(tasks, contact, now, "America/Los_Angeles"), [{ id: "deadbeef", subject: "School project" }]);
  assert.deepEqual(dueFollowUpsForContact(tasks, contact, new Date("2026-09-01T15:00:00.000Z"), "America/Los_Angeles"), []);
});

test("consuming folded records removes only the selected follow-ups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "followup-daily-"));
  const prior = process.env.SCHEDULE_DIR_OVERRIDE;
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  try {
    writeFileSync(join(dir, "schedule.json"), JSON.stringify([
      { id: "deadbeef", next_run_at: "2026-08-31T20:00:00.000Z", follow_up: { kind: "topic", subject: "School project" } },
      { id: "cafebabe", next_run_at: "2026-08-31T20:00:00.000Z", follow_up: { kind: "topic", subject: "Keep" } },
      { id: "ordinary", next_run_at: "2026-08-31T20:00:00.000Z" },
    ]));
    await consumeFoldedFollowUps(["deadbeef", "ordinary"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "schedule.json"), "utf8")).map((task: any) => task.id), ["cafebabe", "ordinary"]);
  } finally {
    if (prior === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE; else process.env.SCHEDULE_DIR_OVERRIDE = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
