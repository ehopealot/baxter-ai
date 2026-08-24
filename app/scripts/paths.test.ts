import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SMS_KEYS_PATH, SMS_STATE_PATH, SMS_SEND_STATE_PATH, SMS_TRANSCRIPT_DIR, MAIL_KEYS_PATH, MAIL_STATE_DB_PATH, MAIL_LINK_STATE_PATH, MAIL_SEND_STATE_PATH, MAIL_TRANSCRIPT_DIR, COLLECTIONS_DIR, COLLECTIONS_RENDERED_DIR, MORNING_HANDOFF_PATH } from "./paths.ts";
import { SMS_TOOLS } from "./grants.ts";

test("sms paths live under the state dir", () => {
  for (const p of [SMS_KEYS_PATH, SMS_STATE_PATH, SMS_SEND_STATE_PATH, SMS_TRANSCRIPT_DIR]) assert.match(p, /\.mail-agent/);
});

test("collections rendered dir lives directly under the collections dir", () => {
  assert.equal(COLLECTIONS_RENDERED_DIR, join(COLLECTIONS_DIR, "rendered"));
});

test("morning handoff path is the production schedule-side default", () => {
  assert.match(MORNING_HANDOFF_PATH, /\.mail-agent\/schedule\/morning-handoff\.json$/);
});

test("mail surface paths live under the mail-agent state dir", () => {
  for (const p of [MAIL_KEYS_PATH, MAIL_STATE_DB_PATH, MAIL_LINK_STATE_PATH, MAIL_SEND_STATE_PATH, MAIL_TRANSCRIPT_DIR])
    assert.match(p, /\.mail-agent\//);
  assert.match(MAIL_KEYS_PATH, /mail-keys\.json$/);
  assert.match(MAIL_STATE_DB_PATH, /chat-state\.db$/);
});

test("SMS_TOOLS grants the sms-cli and core tools, not the discord token surface", () => {
  assert.match(SMS_TOOLS, /sms-cli/);
  assert.match(SMS_TOOLS, /Bash\(memory-cli \*\)/);
});
