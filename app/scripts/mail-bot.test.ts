import { test } from "node:test";
import assert from "node:assert/strict";
import { handleInbound, isMailPayload, makeRunEnv } from "./mail-bot.ts";

test("isMailPayload accepts the mail wire shape and rejects junk", () => {
  assert.ok(isMailPayload({ kind: "mail", id: 1, raw: "{}", svixHeaders: {}, at: "t" }));
  assert.ok(isMailPayload({ kind: "mail", id: 0, raw: "raw", svixHeaders: { "svix-id": "x" }, at: "2026-01-01" }));
  assert.equal(isMailPayload({ kind: "sms", id: 1, raw: "{}", svixHeaders: {}, at: "t" }), false);
  assert.equal(isMailPayload({ kind: "mail", id: "1", raw: "{}", svixHeaders: {}, at: "t" }), false);
  assert.equal(isMailPayload({ kind: "mail", id: 1, raw: "{}", svixHeaders: [], at: "t" }), false);
  assert.equal(isMailPayload(null), false);
});

test("redelivered id is re-acked and not re-processed", async () => {
  const calls: string[] = [];
  await handleInbound({ kind: "mail", id: 3, raw: "{}", svixHeaders: {}, at: "t" }, {
    cursorLoad: () => 5,
    cursorStore: () => calls.push("store"),
    sendAck: (n: number) => calls.push(`ack:${n}`),
    handleWebhook: async () => { calls.push("webhook"); },
    deadLetter: () => calls.push("dl"),
    logErr: () => {},
  });
  assert.deepEqual(calls, ["ack:5"]);
});

test("webhook throw dead-letters then advances once", async () => {
  const calls: string[] = [];
  await handleInbound({ kind: "mail", id: 6, raw: "{}", svixHeaders: {}, at: "t" }, {
    cursorLoad: () => 5,
    cursorStore: (n: number) => calls.push(`store:${n}`),
    sendAck: (n: number) => calls.push(`ack:${n}`),
    handleWebhook: async () => { throw new Error("boom"); },
    deadLetter: () => calls.push("dl"),
    logErr: () => {},
  });
  assert.deepEqual(calls, ["dl", "store:6", "ack:6"]);
});

test("makeRunEnv strips Resend secrets but preserves ordinary environment", () => {
  const saved = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    MAIL_BOT_TEST_CONTROL: process.env.MAIL_BOT_TEST_CONTROL,
  };
  try {
    process.env.RESEND_API_KEY = "secret-key";
    process.env.RESEND_WEBHOOK_SECRET = "secret-webhook";
    process.env.MAIL_BOT_TEST_CONTROL = "keepme";
    const env = makeRunEnv();
    assert.equal(env.RESEND_API_KEY, undefined);
    assert.equal(env.RESEND_WEBHOOK_SECRET, undefined);
    assert.equal(env.MAIL_BOT_TEST_CONTROL, "keepme");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
