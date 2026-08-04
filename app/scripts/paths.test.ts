import { test } from "node:test";
import assert from "node:assert/strict";
import { SMS_KEYS_PATH, SMS_STATE_PATH, SMS_SEND_STATE_PATH, SMS_TRANSCRIPT_DIR } from "./paths.ts";
import { SMS_TOOLS } from "./grants.ts";

test("sms paths live under the state dir", () => {
  for (const p of [SMS_KEYS_PATH, SMS_STATE_PATH, SMS_SEND_STATE_PATH, SMS_TRANSCRIPT_DIR]) assert.match(p, /\.mail-agent/);
});

test("SMS_TOOLS grants the sms-cli and core tools, not the discord token surface", () => {
  assert.match(SMS_TOOLS, /sms-cli/);
  assert.match(SMS_TOOLS, /Bash\(memory-cli \*\)/);
});
