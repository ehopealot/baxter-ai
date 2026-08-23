import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEDULE_GUIDANCE } from "./mail-bot.ts";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const retired = ["daily-calendar-digest", "friday-weekend-check-in", "monday-weekly-check-in"];
function assertGuidance(label: string, text: string): void {
  assert.ok(text.includes("morning-check-in"), `${label} must document the consolidated key`);
  for (const key of retired) assert.ok(!text.includes(key), `${label} must not expose retired key ${key}`);
  assert.match(text, /system (enable|disable|trigger) morning-check-in/, `${label} must show the consolidated controls`);
}

test("every production scheduling surface documents only morning-check-in", () => {
  assertGuidance("production mail", SCHEDULE_GUIDANCE);
  for (const relative of ["scripts/voice-bot.ts", "discord-prompt.md", "discord-reaction-prompt.md", "chat-prompt.md", "sms-prompt.md", "tui-prompt.md", "skills/schedule/SKILL.md"]) {
    assertGuidance(relative, readFileSync(join(appDir, relative), "utf8"));
  }
});

test("app/prompt.md remains the intentionally distinct eval-only mail template", () => {
  const evalTemplate = readFileSync(join(appDir, "prompt.md"), "utf8");
  assert.ok(!evalTemplate.includes("friday-weekend-check-in"));
  assert.ok(!evalTemplate.includes("monday-weekly-check-in"));
});
