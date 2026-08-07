import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleInbound, isMailPayload, makeRunEnv, allowedSender, messageItem, buildPrompt } from "./mail-bot.ts";

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

test("allowedSender uses senders, not recipients, and unions the operator", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-bot-allowlist-"));
  const path = join(dir, "allowlist.json");
  writeFileSync(path, JSON.stringify({
    senders: ["sender-only@example.com"],
    recipients: ["recipient-only@example.com"],
    version: 1,
  }));
  try {
    const env = { BAXTER_EMAIL: "me@example.com", OPERATOR_EMAIL: "operator@example.com" } as NodeJS.ProcessEnv;
    assert.equal(allowedSender("sender-only@example.com", env, path), true);
    assert.equal(allowedSender("recipient-only@example.com", env, path), false);
    assert.equal(allowedSender("operator@example.com", env, path), true);
    assert.equal(allowedSender("me@example.com", env, path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("messageItem maps the Chat SDK inbound message shape", () => {
  const item = messageItem(
    { id: "resend:me@example.com:thread" },
    {
      author: { userId: "sender@example.com" },
      text: "Hello from email",
      raw: {
        id: "re_abc123",
        messageId: "<message-1@example.com>",
        subject: "Hello",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    },
  );
  assert.deepEqual(item, {
    threadId: "resend:me@example.com:thread",
    from: "sender@example.com",
    subject: "Hello",
    content: "Hello from email",
    messageId: "<message-1@example.com>",
    emailId: "re_abc123",
    attachments: [],
    at: "2026-08-07T00:00:00.000Z",
  });
});

test("messageItem preserves inbound attachment metadata and buildPrompt exposes get-attachment", () => {
  const item = messageItem(
    { id: "thread-1" },
    {
      author: { email: "sender@example.com" },
      text: "See the files attached.",
      raw: {
        id: "re_with_attachment",
        subject: "Files",
        messageId: "<message-2@example.com>",
        attachments: [
          { filename: "report.pdf", contentType: "application/pdf" },
          { filename: "photo.png", contentType: "image/png" },
        ],
      },
    },
  );
  assert.equal(item.emailId, "re_with_attachment");
  assert.deepEqual(item.attachments, [
    { filename: "report.pdf", contentType: "application/pdf" },
    { filename: "photo.png", contentType: "image/png" },
  ]);
  const prompt = buildPrompt(item);
  assert.match(prompt, /report\.pdf \(application\/pdf\)/);
  assert.match(prompt, /photo\.png \(image\/png\)/);
  assert.match(prompt, /get-attachment re_with_attachment <filename>/);
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
