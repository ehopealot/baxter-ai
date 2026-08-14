import { test } from "node:test";
import assert from "node:assert/strict";
import { loggerFor, flushLogs, _resetLogShippersForTests, log, logEvent } from "./runtime.ts";

type Call = { url: string; body: string };
function spyFetch(calls: Call[]) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return { status: 200 };
  };
}
function cleanEnv() {
  delete process.env.DISCORD_LOG_WEBHOOK_SMS;
  delete process.env.DISCORD_LOG_WEBHOOK_CHAT;
  delete process.env.DISCORD_LOG_WEBHOOK;
}

test("loggerFor routes each surface to DISCORD_LOG_WEBHOOK_<SURFACE>", async () => {
  const calls: Call[] = [];
  _resetLogShippersForTests(spyFetch(calls));
  process.env.DISCORD_LOG_WEBHOOK_SMS = "https://discord.test/sms";
  process.env.DISCORD_LOG_WEBHOOK_CHAT = "https://discord.test/chat";
  loggerFor("sms").log("hello sms");
  loggerFor("chat").logErr("hello chat");
  await flushLogs();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://discord.test/sms");
  assert.match(calls[0].body, /hello sms/);
  assert.equal(calls[1].url, "https://discord.test/chat");
  assert.match(calls[1].body, /hello chat/);
  cleanEnv();
  _resetLogShippersForTests();
});

test("loggerFor caches one shipper per surface (one POST for two lines)", async () => {
  const calls: Call[] = [];
  _resetLogShippersForTests(spyFetch(calls));
  process.env.DISCORD_LOG_WEBHOOK_SMS = "https://discord.test/sms";
  loggerFor("sms").log("one");
  loggerFor("sms").log("two");
  await flushLogs();
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /one/);
  assert.match(calls[0].body, /two/);
  cleanEnv();
  _resetLogShippersForTests();
});

test("loggerFor falls back to bare DISCORD_LOG_WEBHOOK, then to no-op", async () => {
  const calls: Call[] = [];
  _resetLogShippersForTests(spyFetch(calls));
  process.env.DISCORD_LOG_WEBHOOK = "https://discord.test/bare";
  loggerFor("heartbeat").log("via fallback");
  await flushLogs();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.test/bare");
  cleanEnv();
  _resetLogShippersForTests();

  // no webhooks anywhere -> no fetch, no throw
  const calls2: Call[] = [];
  _resetLogShippersForTests(spyFetch(calls2));
  loggerFor("sms").log("nowhere");
  await flushLogs();
  assert.equal(calls2.length, 0);
  _resetLogShippersForTests();
});

test("module-level log() still works with no webhook configured", () => {
  _resetLogShippersForTests();
  log("plain console line");
});

test("logEvent routes through the provided surface logger", async () => {
  const calls: Call[] = [];
  _resetLogShippersForTests(spyFetch(calls));
  process.env.DISCORD_LOG_WEBHOOK_SMS = "https://discord.test/sms";
  logEvent("abc123", { kind: "note", text: "routed" }, loggerFor("sms"));
  await flushLogs();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.test/sms");
  assert.match(calls[0].body, /\[abc123\] note: routed/);
  cleanEnv();
  _resetLogShippersForTests();
});

test("logEvent without a logger uses the process default (no-op here)", () => {
  _resetLogShippersForTests();
  logEvent("abc123", { kind: "note", text: "default" }); // no throw, no fetch
});
