import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueAdmissionOutbox, admissionWorkId } from "./queue-admission-outbox.ts";
import { replayQueueBeforeAgents } from "./queue-non-agent-replay.ts";

function pending(outbox: QueueAdmissionOutbox, queue: "mail" | "sms" | "chat", sequence: number, outcomeType: string, outcome: unknown) {
  const workId = admissionWorkId(queue, sequence, "tenant-replay");
  outbox.admit({ tenantId: "tenant-replay", queue, sequence, workId, admittedAt: "2026-01-01T00:00:00.000Z",
    variant: "non-agent-terminal", outcomeType, outcomeVersion: 1, outcome,
    idempotencyKey: `${outcomeType}:${workId}`, state: "pending-side-effects" });
  return workId;
}

test("queue replay finishes every source side effect and durable cursor before agent scheduling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-source-replay-"));
  const outbox = new QueueAdmissionOutbox(join(dir, "outbox.json"));
  const mailId = pending(outbox, "mail", 4, "mail-no-agent-dispatch", { reason: "handled-without-agent-dispatch" });
  const smsId = pending(outbox, "sms", 5, "sms-stop", { from: "+15551234567", content: "STOP" });
  const chatId = pending(outbox, "chat", 6, "chat-create", { kind: "create-chat" });
  const cursors = new Map<string, number>();
  const events: string[] = [];
  const run = (queue: "mail" | "sms" | "chat", extra: Record<string, unknown> = {}) => replayQueueBeforeAgents({
    admissions: outbox, queue, tenantId: "tenant-replay",
    cursorLoad: () => cursors.get(queue) ?? -1,
    cursorStore: highWater => { events.push(`${queue}:cursor:${highWater}`); cursors.set(queue, highWater); },
    ...extra,
  });
  try {
    await run("mail");
    await run("sms", { setSmsOptOut: async (phone: string, optedOut: boolean) => { events.push(`sms:stop:${phone}:${optedOut}`); } });
    await run("chat");
    assert.deepEqual(events, ["mail:cursor:4", "sms:stop:+15551234567:true", "sms:cursor:5", "chat:cursor:6"]);
    for (const workId of [mailId, smsId, chatId]) {
      const record = outbox.records().find(candidate => candidate.workId === workId);
      assert.equal(record?.variant, "non-agent-terminal");
      assert.equal(record?.state, "terminal");
    }

    events.length = 0;
    await run("sms", { setSmsOptOut: async () => { events.push("unexpected duplicate STOP effect"); } });
    assert.deepEqual(events, ["sms:cursor:5"], "terminal replay repairs cursor publication without repeating the side effect");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mail source DLQ replay is deduplicable and completes before cursor publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-mail-dlq-replay-"));
  const outbox = new QueueAdmissionOutbox(join(dir, "outbox.json"));
  const workId = pending(outbox, "mail", 9, "mail-source-dead-letter", { reason: "permanent-source-failure" });
  const events: string[] = [];
  try {
    const highWater = await replayQueueBeforeAgents({
      admissions: outbox, queue: "mail", tenantId: "tenant-replay", cursorLoad: () => -1,
      cursorStore: value => { events.push(`cursor:${value}`); },
      deadLetter: (_surface, record) => { events.push(`dlq:${String(record.outcomeId)}`); },
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    assert.equal(highWater, 9);
    assert.deepEqual(events, [`dlq:${workId}`, "cursor:9"]);
    const record = outbox.records().find(candidate => candidate.workId === workId);
    assert.equal(record?.state, "terminal");
    assert.equal((record as any).receipt.evidence.recordedAt, "2026-01-02T00:00:00.000Z");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
