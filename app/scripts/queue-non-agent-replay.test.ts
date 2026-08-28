import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueAdmissionOutbox, admissionWorkId } from "./queue-admission-outbox.ts";
import { replayQueueBeforeAgents } from "./queue-non-agent-replay.ts";

function pending(outbox: QueueAdmissionOutbox, queue: "mail" | "sms" | "chat", sequence: number, outcomeType: string, outcome: unknown, outcomeVersion = 1) {
  const workId = admissionWorkId(queue, sequence, "tenant-replay");
  const idempotencyKey = outcomeType === "mail-no-agent-dispatch" ? `mail-terminal:${workId}`
    : outcomeType === "mail-source-dead-letter" ? `mail-source-dlq:${workId}` : `${outcomeType}:${workId}`;
  outbox.admit({ tenantId: "tenant-replay", queue, sequence, workId, admittedAt: "2026-01-01T00:00:00.000Z",
    variant: "non-agent-terminal", outcomeType, outcomeVersion, outcome,
    idempotencyKey, state: "pending-side-effects" } as any);
  return workId;
}

test("queue replay finishes every source side effect and durable cursor before agent scheduling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-source-replay-"));
  const outbox = new QueueAdmissionOutbox(join(dir, "outbox.json"));
  const at = "2026-01-01T00:00:00.000Z";
  const mailId = pending(outbox, "mail", 4, "mail-no-agent-dispatch", { reason: "handled-without-agent-dispatch" });
  const smsId = pending(outbox, "sms", 5, "sms-stop", { from: "+15551234567", content: "STOP" });
  const smsPoisonId = admissionWorkId("sms", 6, "tenant-replay");
  pending(outbox, "sms", 6, "sms-transcript-poison", { outcomeId: smsPoisonId, id: 6, at, from: "+15557654321", error: "SMS poison", payload: { id: 6, from: "+15557654321", content: "bad", at } });
  const chatId = pending(outbox, "chat", 6, "chat-create", { kind: "create-chat" });
  const chatDeleteId = pending(outbox, "chat", 7, "chat-delete", { kind: "delete-chat", chatId: "wc-6" });
  const chatPoisonId = admissionWorkId("chat", 8, "tenant-replay");
  pending(outbox, "chat", 8, "chat-transcript-poison", { outcomeId: chatPoisonId, id: 8, at, kind: "send-message", error: "chat poison", intent: { id: 8, kind: "send-message", chatId: "wc-6", text: "bad", authorId: "member:a", authorName: "A", at } });
  const cursors = new Map<string, number>();
  const events: string[] = [];
  const run = (queue: "mail" | "sms" | "chat", extra: Record<string, unknown> = {}) => replayQueueBeforeAgents({
    admissions: outbox, queue, tenantId: "tenant-replay",
    cursorLoad: () => cursors.get(queue) ?? -1,
    cursorStore: highWater => { events.push(`${queue}:cursor:${highWater}`); cursors.set(queue, highWater); },
    ...extra,
  });
  try {
    const deadLetters: Array<{ surface: string; record: Record<string, unknown> }> = [];
    const appendDeadLetter = (surface: string, record: Record<string, unknown>) => { events.push(`${surface}:dead-letter`); deadLetters.push({ surface, record }); };
    await run("mail");
    await run("sms", { setSmsOptOut: async (phone: string, optedOut: boolean) => { events.push(`sms:stop:${phone}:${optedOut}`); }, deadLetter: appendDeadLetter });
    await run("chat", {
      createChat: async (id: string) => { events.push(`chat:create:${id}`); },
      deleteChat: async (id: string) => { events.push(`chat:delete:${id}`); },
      deadLetter: appendDeadLetter,
    });
    assert.deepEqual(events, ["mail:cursor:4", "sms:stop:+15551234567:true", "sms:dead-letter", "sms:cursor:6", "chat:create:wc-6", "chat:delete:wc-6", "chat:dead-letter", "chat:cursor:8"]);
    assert.deepEqual(deadLetters.map(item => [item.surface, item.record.outcomeId]), [["sms", smsPoisonId], ["chat", chatPoisonId]], "replay publishes the exact stored idempotency identities");
    for (const workId of [mailId, smsId, smsPoisonId, chatId, chatDeleteId, chatPoisonId]) {
      const record = outbox.records().find(candidate => candidate.workId === workId);
      assert.equal(record?.variant, "non-agent-terminal");
      assert.equal(record?.state, "terminal");
    }

    events.length = 0;
    await run("sms", { setSmsOptOut: async () => { events.push("unexpected duplicate STOP effect"); }, deadLetter: () => { events.push("unexpected duplicate SMS DLQ"); } });
    await run("chat", { createChat: async () => { events.push("unexpected duplicate create"); }, deleteChat: async () => { events.push("unexpected duplicate delete"); }, deadLetter: () => { events.push("unexpected duplicate chat DLQ"); } });
    assert.deepEqual(events, ["sms:cursor:6", "chat:cursor:8"], "terminal replay repairs cursor publication without repeating side effects");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mail source DLQ replay appends the exact stored record before cursor publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-mail-dlq-replay-"));
  const outbox = new QueueAdmissionOutbox(join(dir, "outbox.json"));
  const workId = admissionWorkId("mail", 9, "tenant-replay");
  const outcome = {
    id: 9,
    workId,
    at: "2026-01-01T00:00:00.000Z",
    error: "Error: rejected webhook\n    at adapter",
    payload: {
      kind: "mail", id: 9, raw: "{\"type\":\"email.received\"}",
      svixHeaders: { "svix-id": "msg_9", "svix-signature": "v1,secret" },
      at: "2026-01-01T00:00:00.000Z",
    },
  };
  pending(outbox, "mail", 9, "mail-source-dead-letter", outcome, 2);
  const events: string[] = [];
  const appended: Record<string, unknown>[] = [];
  try {
    const highWater = await replayQueueBeforeAgents({
      admissions: outbox, queue: "mail", tenantId: "tenant-replay", cursorLoad: () => -1,
      cursorStore: value => { events.push(`cursor:${value}`); },
      deadLetter: (_surface, record) => { events.push("dlq"); appended.push(record); },
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    assert.equal(highWater, 9);
    assert.deepEqual(events, ["dlq", "cursor:9"]);
    assert.deepEqual(appended, [outcome], "replay passes through raw, headers, error, and identity without reconstruction");
    const record = outbox.records().find(candidate => candidate.workId === workId);
    assert.equal(record?.state, "terminal");
    assert.equal((record as any).receipt.evidence.recordedAt, "2026-01-02T00:00:00.000Z");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
