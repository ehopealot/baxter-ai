import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdd } from "./schedule-cli.ts";

test("parseAdd requires exactly one of --cron/--at and at most one delivery", () => {
  assert.deepEqual(parseAdd(["do X", "--desc", "Do X", "--cron", "0 9 * * 1-5", "--discord", "123"]),
    { task: "do X", desc: "Do X", cron: "0 9 * * 1-5", at: null, tz: null, deliver: { surface: "discord", target: "123" } });
  assert.deepEqual(parseAdd(["ping", "--desc", "Ping", "--at", "2026-07-20T14:00:00Z", "--email", "e@x.com", "--tz", "America/New_York"]),
    { task: "ping", desc: "Ping", at: "2026-07-20T14:00:00Z", cron: null, tz: "America/New_York", deliver: { surface: "mail", target: "e@x.com" } });
  assert.throws(() => parseAdd(["x"]), /exactly one of --cron or --at/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--at", "2026-07-20T14:00:00Z"]), /exactly one of --cron or --at/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--discord", "1", "--email", "e@x"]), /one delivery/);
  assert.throws(() => parseAdd(["--cron", "0 9 * * *"]), /task description/); // empty description
});

test("parseAdd: --sms parses to an sms deliver target, and is mutually exclusive with --discord/--email", () => {
  assert.deepEqual(parseAdd(["text them", "--desc", "Text them", "--at", "2026-07-20T14:00:00Z", "--sms", "+15551234567"]),
    { task: "text them", desc: "Text them", at: "2026-07-20T14:00:00Z", cron: null, tz: null, deliver: { surface: "sms", target: "+15551234567" } });
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--sms", "+1555", "--discord", "1"]), /one delivery/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--sms", "+1555", "--email", "e@x"]), /one delivery/);
});

test("parseAdd requires --desc", () => {
  assert.throws(() => parseAdd(["do a thing", "--cron", "0 9 * * *"]), /--desc/);
  assert.throws(() => parseAdd(["do a thing", "--desc", "", "--cron", "0 9 * * *"]), /--desc/);
  assert.throws(() => parseAdd(["do a thing", "--desc", "   ", "--cron", "0 9 * * *"]), /--desc/);
});

test("parseAdd accepts --desc and returns it trimmed alongside task", () => {
  const p = parseAdd(["check weather then message family", "--desc", "  Morning weather check  ", "--cron", "0 8 * * *"]);
  assert.equal(p.task, "check weather then message family");
  assert.equal(p.desc, "Morning weather check");
  assert.equal(p.cron, "0 8 * * *");
});
