import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEDULE_GUIDANCE } from "./mail-bot.ts";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const keys = ["daily-calendar-digest", "friday-weekend-check-in", "monday-weekly-check-in"];
const commands = [
  "system disable friday-weekend-check-in",
  "system enable friday-weekend-check-in",
  "system disable monday-weekly-check-in",
  "system enable monday-weekly-check-in",
];

function assertGuidance(label: string, text: string): void {
  for (const key of keys) assert.ok(text.includes(key), `${label} must document ${key}`);
  for (const command of commands) assert.ok(text.includes(command), `${label} must map natural toggles to schedule-cli ${command}`);
  assert.match(text, /Friday mentions known upcoming weekend plans/i, `${label} must explain Friday behavior`);
  assert.match(text, /Monday can revisit current or past priorities and never receives a calendar summary/i, `${label} must explain Monday behavior`);
  assert.match(text, /never [`\\]*cancel|never added or cancelled|cannot [`]*cancel/i, `${label} must distinguish system toggles from cancellation`);
}

test("every production scheduling surface documents all system keys and Friday/Monday enable-disable aliases", () => {
  assertGuidance("production mail", SCHEDULE_GUIDANCE);
  const paths = [
    "scripts/voice-bot.ts",
    "discord-prompt.md",
    "discord-reaction-prompt.md",
    "chat-prompt.md",
    "sms-prompt.md",
    "tui-prompt.md",
    "skills/schedule/SKILL.md",
  ];
  for (const relative of paths) assertGuidance(relative, readFileSync(join(appDir, relative), "utf8"));

  const reaction = readFileSync(join(appDir, "discord-reaction-prompt.md"), "utf8");
  assert.equal(reaction.match(/Runtime-owned/g)?.length, 1, "reaction guidance must not retain the stale duplicate system-task paragraph");

  const scheduleSkill = readFileSync(join(appDir, "skills/schedule/SKILL.md"), "utf8");
  assert.ok(scheduleSkill.includes("system enable daily-calendar-digest"), "schedule skill retains the natural daily-digest re-enable alias");
});

test("app/prompt.md remains the intentionally distinct eval-only mail template", () => {
  const evalTemplate = readFileSync(join(appDir, "prompt.md"), "utf8");
  assert.ok(!evalTemplate.includes("friday-weekend-check-in"));
  assert.ok(!evalTemplate.includes("monday-weekly-check-in"));
});
