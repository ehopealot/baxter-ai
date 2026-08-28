import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMailRunFn, type MailDispatchEnvelope } from "./mail-bot.ts";
import { makeSmsRunFn, type SmsDispatchItem } from "./sms-bot.ts";
import { makeChatRunFn, type ChatDispatchIntent } from "./chat-bot.ts";

const workId = "d".repeat(64);
const mail: MailDispatchEnvelope = {
  workId, threadId: "thread", from: "a@example.com", subject: "s", content: "c",
  messageId: "message", emailId: "email", attachments: [], at: "2026-01-01T00:00:00.000Z",
};
const sms: SmsDispatchItem = {
  workId, id: 1, from: "+15551234567", content: "hello", at: "2026-01-01T00:00:00.000Z",
  group_id: "family", group_name: "Family", participants: [],
};
const chat: ChatDispatchIntent = {
  workId, id: 1, kind: "send-message", chatId: "wc-1", text: "hello",
  authorId: "member:a", authorName: "A", at: "2026-01-01T00:00:00.000Z",
};

function agent(resolution: "delivered" | "no-reply" | "unresolved") {
  return async () => ({ failed: false, outOfTokens: false, resetsAt: null, resolution });
}

test("mail/SMS/chat reject structured delivered success without a completed work-ID delivery receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-resolution-delivery-"));
  const previousSms = process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE;
  const previousChat = process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE;
  process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE = join(dir, "sms");
  process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE = join(dir, "chat");
  try {
    const mailRun = makeMailRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, runAgent: agent("delivered"),
      reconcileProviderDelivery: async () => null, providerReceiptsForWork: () => [] });
    const smsRun = makeSmsRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, runAgent: agent("delivered") });
    const chatRun = makeChatRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, onFinished: () => {}, runAgentImpl: agent("delivered"),
      introDecisionImpl: () => ({ explain: false, card: false }), buildPromptImpl: () => "prompt" });
    assert.deepEqual(await mailRun(mail.from, mail), { kind: "retry", source: "mail", reason: "agent-failed" });
    assert.deepEqual(await smsRun("group:family", sms), { kind: "retry", source: "sms", reason: "agent-failed" });
    assert.deepEqual(await chatRun(chat.chatId, chat), { kind: "retry", source: "chat", reason: "agent-failed" });
  } finally {
    if (previousSms === undefined) delete process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE; else process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE = previousSms;
    if (previousChat === undefined) delete process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE; else process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE = previousChat;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mail/SMS/chat reconcile a durable no-reply receipt before rerunning the model", async () => {
  let modelRuns = 0;
  let deliveryReplays = 0;
  const noReply = (surface: "mail" | "sms" | "chat", candidate: string) => ({
    version: 1 as const, kind: "no-reply" as const, surface, workId: candidate, completedAt: "durable-no-reply",
  });
  const mailRun = makeMailRunFn({
    env: {}, runEnv: {}, model: "test", logErr: () => {}, runAgent: async () => { modelRuns++; return agent("delivered")(); },
    noReplyOutcomeForWork: noReply, providerDeliveryForWork: () => null,
    reconcileProviderDelivery: async () => { deliveryReplays++; return null; },
  });
  const smsRun = makeSmsRunFn({
    env: {}, runEnv: {}, model: "test", logErr: () => {}, runAgent: async () => { modelRuns++; return agent("delivered")(); },
    noReplyOutcomeForWork: noReply, outputReceiptsForWork: () => [],
    replayDeliveries: async () => { deliveryReplays++; return []; },
  });
  const chatRun = makeChatRunFn({
    env: {}, runEnv: {}, model: "test", logErr: () => {}, onFinished: () => {},
    runAgentImpl: async () => { modelRuns++; return agent("delivered")(); },
    introDecisionImpl: () => ({ explain: false, card: false }), buildPromptImpl: () => "prompt",
    noReplyOutcomeForWork: noReply, outputReceiptsForWork: () => [],
    replayOutputs: async () => { deliveryReplays++; return []; },
  });
  for (const outcome of [await mailRun(mail.from, mail), await smsRun("group:family", sms), await chatRun(chat.chatId, chat)]) {
    assert.deepEqual(outcome, { kind: "succeeded", source: outcome.source, resolution: "no-reply", completedAt: "durable-no-reply", providerReceipts: [] });
  }
  assert.equal(modelRuns, 0);
  assert.equal(deliveryReplays, 0);
});

test("mail/SMS/chat fail closed when delivery and no-reply receipts conflict", async () => {
  let modelRuns = 0;
  const noReply = (surface: "mail" | "sms" | "chat", candidate: string) => ({
    version: 1 as const, kind: "no-reply" as const, surface, workId: candidate, completedAt: "durable-no-reply",
  });
  const run = async () => { modelRuns++; return agent("delivered")(); };
  const mailRun = makeMailRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, runAgent: run,
    noReplyOutcomeForWork: noReply, providerDeliveryForWork: () => ({ state: "completed" } as any) });
  const smsRun = makeSmsRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, runAgent: run,
    noReplyOutcomeForWork: noReply, outputReceiptsForWork: () => ([{ state: "completed" }] as any) });
  const chatRun = makeChatRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, onFinished: () => {}, runAgentImpl: run,
    introDecisionImpl: () => ({ explain: false, card: false }), buildPromptImpl: () => "prompt",
    noReplyOutcomeForWork: noReply, outputReceiptsForWork: () => ([{ state: "completed" }] as any) });
  await assert.rejects(mailRun(mail.from, mail), /conflicting delivery and no-reply/);
  await assert.rejects(smsRun("group:family", sms), /conflicting delivery and no-reply/);
  await assert.rejects(chatRun(chat.chatId, chat), /conflicting delivery and no-reply/);
  assert.equal(modelRuns, 0);
});

test("mail/SMS/chat accept structured no-reply only after the durable receipt verifier succeeds", async () => {
  let verified = 0;
  const requireNoReply = (_surface: "mail" | "sms" | "chat", candidate: string) => {
    assert.equal(candidate, workId); verified++;
    return { version: 1, kind: "no-reply", surface: _surface, workId, completedAt: "done" } as const;
  };
  const mailRun = makeMailRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, runAgent: agent("no-reply"),
    reconcileProviderDelivery: async () => null, providerReceiptsForWork: () => [], requireNoReplyOutcome: requireNoReply });
  const smsRun = makeSmsRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, runAgent: agent("no-reply"), requireNoReplyOutcome: requireNoReply });
  const chatRun = makeChatRunFn({ env: {}, runEnv: {}, model: "test", logErr: () => {}, onFinished: () => {}, runAgentImpl: agent("no-reply"),
    introDecisionImpl: () => ({ explain: false, card: false }), buildPromptImpl: () => "prompt", requireNoReplyOutcome: requireNoReply });
  for (const outcome of [await mailRun(mail.from, mail), await smsRun("group:family", sms), await chatRun(chat.chatId, chat)]) {
    assert.equal(outcome.kind, "succeeded");
    if (outcome.kind === "succeeded") { assert.equal(outcome.resolution, "no-reply"); assert.deepEqual(outcome.providerReceipts, []); }
  }
  assert.equal(verified, 3);
});
