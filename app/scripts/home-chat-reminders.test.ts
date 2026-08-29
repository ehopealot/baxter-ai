import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHomeChatReminderRoute } from "./home-chat-reminders.ts";

test("a Home Chat sender-only email resolves to that person's SMS and recipient-only email fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-chat-reminder-route-"));
  const allowlistPath = join(dir, "allow.json");
  try {
    writeFileSync(allowlistPath, JSON.stringify({
      version: 1,
      senders: ["+15550000001", "ari+chat@example.test"],
      recipients: ["+15550000001", "ari@example.test"],
      names: { "+15550000001": "Ari", "ari@example.test": "Ari", "ari+chat@example.test": "Ari" },
    }));
    assert.deepEqual(
      resolveHomeChatReminderRoute("member:ari+chat@example.test", {}, allowlistPath),
      { sms: "+15550000001", email: "ari@example.test" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a phone-authenticated Home Chat author keeps that exact direct SMS alias", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-chat-reminder-phone-"));
  const allowlistPath = join(dir, "allow.json");
  try {
    writeFileSync(allowlistPath, JSON.stringify({
      version: 1,
      senders: ["+15550000001", "+15550000002"],
      recipients: ["+15550000001", "+15550000002", "ari@example.test"],
      names: { "+15550000001": "Ari", "+15550000002": "Ari", "ari@example.test": "Ari" },
    }));
    assert.deepEqual(
      resolveHomeChatReminderRoute("member:+15550000002", {}, allowlistPath),
      { sms: "+15550000002", email: "ari@example.test" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Home Chat member without a resolved fallback route never borrows another household member's target", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-chat-reminder-route-"));
  const allowlistPath = join(dir, "allow.json");
  try {
    writeFileSync(allowlistPath, JSON.stringify({
      version: 1,
      senders: ["+15550000001", "unknown@example.test"],
      recipients: ["+15550000001", "ari@example.test"],
      names: { "+15550000001": "Ari", "ari@example.test": "Ari", "unknown@example.test": "Unknown" },
    }));
    assert.deepEqual(
      resolveHomeChatReminderRoute("member:unknown@example.test", {}, allowlistPath),
      { sms: null, email: null },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
