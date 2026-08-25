import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "./schedule-store.ts";
import { appendMailTranscript } from "./mail-transcript.ts";
import { createChat } from "./chat-transcript.ts";
import {
  FOLLOW_UP_TASK_MARKER,
  currentFollowUpAuthority,
  isFeatureShapedTask,
  validateFollowUpTask,
  validateStoredFollowUp,
  type FollowUpAuthority,
} from "./followup-types.ts";

const allowAll: FollowUpAuthority = {
  directSms: () => true,
  groupSms: () => true,
  mailThread: () => true,
  homeChat: () => true,
};

function direct(): Task {
  return {
    id: "feedbeef", task: FOLLOW_UP_TASK_MARKER, desc: "Check back about the store trip",
    cron: null, at: "2026-08-28T16:00:00.000Z", tz: "America/Los_Angeles",
    next_run_at: "2026-08-28T16:00:00.000Z", invisible_until: null, attempts: 0,
    created_at: "2026-08-27T18:00:00.000Z", deliver: { surface: "sms", target: "+15551234567" },
    follow_up: {
      version: 1, subject: "the store trip", subject_key: "the store trip", plan_date: "2026-08-28",
      turn_token: "0123456789abcdef0123456789abcdef",
      origin: { surface: "sms", id: "+15551234567" },
    },
  };
}

function routeTask(route: "sms-group" | "mail-thread" | "home-chat"): Task {
  const base = direct();
  if (route === "sms-group") return {
    ...base,
    deliver: { surface: "sms-group", target: "grp_family" },
    follow_up: { ...base.follow_up!, origin: { surface: "sms-group", id: "grp_family" } },
  };
  if (route === "mail-thread") return {
    ...base,
    deliver: { surface: "mail-thread", target: "resend:member@example.com:abc" },
    follow_up: { ...base.follow_up!, origin: { surface: "mail-thread", id: "resend:member@example.com:abc" } },
  };
  return {
    ...base,
    deliver: { surface: "home-chat-email", target: "member@example.com", chat_id: "wc-7" },
    follow_up: { ...base.follow_up!, origin: { surface: "home-chat", id: "wc-7", email: "member@example.com" } },
  };
}

test("strict validator accepts all four exact persisted routes", () => {
  for (const task of [direct(), routeTask("sms-group"), routeTask("mail-thread"), routeTask("home-chat")]) {
    assert.equal(validateStoredFollowUp(task).followUp.plan_date, "2026-08-28");
    assert.equal(validateFollowUpTask(task, allowAll).nextRunAt, task.next_run_at);
  }
});

test("feature classifier routes every feature-shaped or unknown delivery record to strict handling", () => {
  const ownUndefined = { ...direct(), follow_up: undefined };
  assert.equal(isFeatureShapedTask(ownUndefined), true);
  assert.equal(isFeatureShapedTask({ ...ownUndefined, deliver: { surface: "mail-thread", target: "resend:a@example.com:x" } } as Task), true);
  assert.equal(isFeatureShapedTask({ ...ownUndefined, deliver: { surface: "future-provider", target: "x" } } as unknown as Task), true);
  const legacy = direct();
  delete legacy.follow_up;
  legacy.task = "ordinary";
  legacy.deliver = { surface: "sms", target: "+15551234567" };
  assert.equal(isFeatureShapedTask(legacy), false);
});

test("strict validator refuses malformed metadata, scheduler shape, route agreement, and authority", () => {
  const cases: Task[] = [
    { ...direct(), task: "model chosen" },
    { ...direct(), desc: "wrong" },
    { ...direct(), cron: "0 9 * * *" },
    { ...direct(), at: "2026-08-28T16:01:00.000Z" },
    { ...direct(), tz: "Not/AZone" },
    { ...direct(), next_run_at: "2026-08-28T15:59:00.000Z", at: "2026-08-28T15:59:00.000Z" },
    { ...direct(), follow_up: { ...direct().follow_up!, version: 2 as 1 } },
    { ...direct(), follow_up: { ...direct().follow_up!, subject_key: "STORE" } },
    { ...direct(), follow_up: { ...direct().follow_up!, plan_date: "2026-02-29" } },
    { ...direct(), follow_up: { ...direct().follow_up!, turn_token: "weak" } },
    { ...direct(), follow_up: { ...direct().follow_up!, origin: { surface: "sms", id: "+15550000000" } } },
    { ...direct(), follow_up: { ...direct().follow_up!, origin: { surface: "mail-thread", id: "resend:not-an-email:abc" } }, deliver: { surface: "mail-thread", target: "resend:not-an-email:abc" } },
    { ...direct(), follow_up: { ...direct().follow_up!, extra: true } as never },
    { ...direct(), deliver: { surface: "sms", target: "+15551234567", extra: "route" } as never },
    { ...direct(), attempts: -1 },
    { ...direct(), invisible_until: "not-an-instant" },
    { ...direct(), system: { key: "x", enabled: true } },
  ];
  for (const task of cases) assert.throws(() => validateStoredFollowUp(task));
  assert.throws(() => validateFollowUpTask(direct(), { ...allowAll, directSms: () => false }), /not currently authorized/);
});

test("follow-up-only delivery without valid metadata and unknown variants fail closed", () => {
  const mailOnly = routeTask("mail-thread");
  delete mailOnly.follow_up;
  assert.equal(isFeatureShapedTask(mailOnly), true);
  assert.throws(() => validateStoredFollowUp(mailOnly));
  const unknown = { ...direct(), deliver: { surface: "future-provider", target: "x" } } as unknown as Task;
  assert.equal(isFeatureShapedTask(unknown), true);
  assert.throws(() => validateStoredFollowUp(unknown));
});

test("missing durable allowlist denies seeded SMS, Mail, and Home authority before any prior check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "followup-authority-missing-"));
  const allowlistPath = join(dir, "allowlist.json");
  const oldMail = process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE; const oldChats = process.env.CHATS_DIR_OVERRIDE;
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = join(dir, "mail"); process.env.CHATS_DIR_OVERRIDE = join(dir, "chats");
  const email = "member@example.com"; const phone = "+15551234567"; const thread = `resend:${email}:missing`;
  const seed = { ALLOWED_SENDERS: `${phone},${email}`, ALLOWED_RECIPIENTS: email, OPERATOR_EMAIL: email };
  try {
    await appendMailTranscript(email, { direction: "in", at: new Date().toISOString(), subject: "Plan", content: "x", threadId: thread, messageId: "<missing@example.com>" });
    await createChat("wc-77", new Date().toISOString());
    writeFileSync(allowlistPath, JSON.stringify({ senders: [phone, email], recipients: [email], version: 1 }));
    rmSync(allowlistPath);

    const denied = currentFollowUpAuthority(seed, allowlistPath);
    assert.equal(denied.directSms(phone), false);
    assert.equal(denied.mailThread(thread), false);
    assert.equal(denied.homeChat("wc-77", email), false);
  } finally {
    if (oldMail === undefined) delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE; else process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = oldMail;
    if (oldChats === undefined) delete process.env.CHATS_DIR_OVERRIDE; else process.env.CHATS_DIR_OVERRIDE = oldChats;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proactive authority treats valid durable state as authoritative and unavailable state as deny-all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "followup-authority-"));
  const allowlistPath = join(dir, "allowlist.json");
  const mailDir = join(dir, "mail"); const chatsDir = join(dir, "chats");
  const oldMail = process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE; const oldChats = process.env.CHATS_DIR_OVERRIDE;
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = mailDir; process.env.CHATS_DIR_OVERRIDE = chatsDir;
  const email = "member@example.com"; const phone = "+15551234567"; const thread = `resend:${email}:abc`;
  const env = { ALLOWED_SENDERS: `${phone},${email}`, ALLOWED_RECIPIENTS: email, OPERATOR_EMAIL: email };
  try {
    await appendMailTranscript(email, { direction: "in", at: new Date().toISOString(), subject: "Plan", content: "x", threadId: thread, messageId: "<m1@example.com>" });
    await createChat("wc-7", new Date().toISOString());

    const missing = currentFollowUpAuthority(env, allowlistPath);
    assert.equal(missing.directSms(phone), false, "an absent durable file cannot use the environment seed");
    assert.equal(missing.mailThread(thread), false);
    assert.equal(missing.homeChat("wc-7", email), false);

    writeFileSync(allowlistPath, JSON.stringify({ senders: [phone, email], recipients: [email], version: 1 }));
    const durable = currentFollowUpAuthority({}, allowlistPath);
    assert.equal(durable.directSms(phone), true, "valid durable snapshot is authoritative without env");
    assert.equal(durable.mailThread(thread), true);
    assert.equal(durable.homeChat("wc-7", email), true);

    for (const corrupt of ["{", JSON.stringify({ senders: "not-an-array", recipients: [email], version: 1 })]) {
      writeFileSync(allowlistPath, corrupt);
      const denied = currentFollowUpAuthority(env, allowlistPath);
      assert.equal(denied.directSms(phone), false);
      assert.equal(denied.mailThread(thread), false, "operator fallback cannot bypass corrupt durable authority");
      assert.equal(denied.homeChat("wc-7", email), false);
      assert.throws(() => validateFollowUpTask(direct(), denied), /not currently authorized/);
    }

    rmSync(allowlistPath, { force: true }); mkdirSync(allowlistPath);
    const unreadable = currentFollowUpAuthority(env, allowlistPath);
    assert.equal(unreadable.directSms(phone), false);
    assert.equal(unreadable.mailThread(thread), false);
    assert.equal(unreadable.homeChat("wc-7", email), false);
  } finally {
    if (oldMail === undefined) delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE; else process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = oldMail;
    if (oldChats === undefined) delete process.env.CHATS_DIR_OVERRIDE; else process.env.CHATS_DIR_OVERRIDE = oldChats;
    rmSync(dir, { recursive: true, force: true });
  }
});
