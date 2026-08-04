import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdd } from "./schedule-cli.ts";

test("parseAdd requires exactly one of --cron/--at and at most one delivery", () => {
  assert.deepEqual(parseAdd(["do X", "--cron", "0 9 * * 1-5", "--discord", "123"]),
    { task: "do X", cron: "0 9 * * 1-5", at: null, tz: null, deliver: { surface: "discord", target: "123" } });
  assert.deepEqual(parseAdd(["ping", "--at", "2026-07-20T14:00:00Z", "--email", "e@x.com", "--tz", "America/New_York"]),
    { task: "ping", at: "2026-07-20T14:00:00Z", cron: null, tz: "America/New_York", deliver: { surface: "mail", target: "e@x.com" } });
  assert.throws(() => parseAdd(["x"]), /exactly one of --cron or --at/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--at", "2026-07-20T14:00:00Z"]), /exactly one of --cron or --at/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--discord", "1", "--email", "e@x"]), /one delivery/);
  assert.throws(() => parseAdd(["--cron", "0 9 * * *"]), /task description/); // empty description
});

test("parseAdd: --sms parses to an sms deliver target, and is mutually exclusive with --discord/--email", () => {
  assert.deepEqual(parseAdd(["text them", "--at", "2026-07-20T14:00:00Z", "--sms", "+15551234567"]),
    { task: "text them", at: "2026-07-20T14:00:00Z", cron: null, tz: null, deliver: { surface: "sms", target: "+15551234567" } });
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--sms", "+1555", "--discord", "1"]), /one delivery/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--sms", "+1555", "--email", "e@x"]), /one delivery/);
});
