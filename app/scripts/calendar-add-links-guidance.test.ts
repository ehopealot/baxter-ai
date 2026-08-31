// The agent-facing contract is deliberately pinned in every runtime prompt and the
// calendar skill: event creation must return both expiring public links verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt as buildMailPrompt, CALENDAR_LINK_GUIDANCE } from "./mail-bot.ts";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const GETTER = "calendar-cli get-add-to-calendar-link <uid>";

function assertCalendarLinkGuidance(text: string, label: string): void {
  assert.ok(text.includes(GETTER), `${label}: names the public-link getter`);
  assert.match(text, /Add to google calendar -/i, `${label}: preserves the Google output label`);
  assert.match(text, /Add to device calendar -/i, `${label}: preserves the device output label`);
  assert.match(text, /verbatim|exact(?:ly)?/i, `${label}: requires exact copied output`);
  assert.match(text, /(?:bare|short).*link|\/a\//i, `${label}: identifies the direct short-link contract`);
  assert.match(text, /after.*(?:successfully )?(?:creat|add).*event|(?:creat|add).*event.*then/is, `${label}: runs only after event creation`);
}

test("production calendar-link guidance describes a three-hour lifetime", () => {
  assert.match(CALENDAR_LINK_GUIDANCE, /3 hours/);
  assert.doesNotMatch(CALENDAR_LINK_GUIDANCE, /24 hours/);
});

test("calendar skill and static mail/direct-SMS prompts describe a three-hour link lifetime", () => {
  for (const [path, label] of [
    [join(APP_DIR, "skills", "calendar", "SKILL.md"), "calendar skill"],
    [join(APP_DIR, "prompt.md"), "email eval prompt"],
    [join(APP_DIR, "sms-prompt.md"), "SMS prompt"],
  ]) {
    const text = readFileSync(path, "utf8");
    assert.match(text, /3 hours/, `${label}: describes the three-hour lifetime`);
    assert.doesNotMatch(text, /24 hours/, `${label}: does not retain the old lifetime`);
  }
});

test("calendar skill and every mail/direct-SMS prompt require both public add links after event creation", () => {
  assertCalendarLinkGuidance(readFileSync(join(APP_DIR, "skills", "calendar", "SKILL.md"), "utf8"), "calendar skill");
  assertCalendarLinkGuidance(readFileSync(join(APP_DIR, "prompt.md"), "utf8"), "email eval prompt");
  assertCalendarLinkGuidance(readFileSync(join(APP_DIR, "sms-prompt.md"), "utf8"), "SMS prompt");
  assertCalendarLinkGuidance(buildMailPrompt({
    threadId: "thread-1", from: "parent@example.test", subject: "Calendar", content: "Please add it",
    messageId: "message-1", emailId: "email-1", attachments: [], at: "2026-08-30T00:00:00.000Z",
  }), "production mail prompt");
});
