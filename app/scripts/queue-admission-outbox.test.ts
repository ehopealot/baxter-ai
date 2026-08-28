import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueAdmissionOutbox, admissionWorkId } from "./queue-admission-outbox.ts";

test("admission records are deterministic, immutable, and replay-selective", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-")), "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const stop = { queue: "sms" as const, sequence: 4, workId: admissionWorkId("sms", 4), admittedAt: "2026-01-01T00:00:00.000Z", variant: "non-agent-terminal" as const, outcomeType: "sms-stop", outcomeVersion: 1, outcome: { phone: "+15551234567" }, idempotencyKey: "sms-stop:+15551234567:4", state: "pending-side-effects" as const };
  outbox.admit(stop);
  outbox.update(stop.workId, { state: "terminal", receipt: { persisted: true } });
  const agent = { queue: "sms" as const, sequence: 5, workId: admissionWorkId("sms", 5), admittedAt: "2026-01-01T00:00:01.000Z", variant: "agent-dispatch" as const, input: { prompt: "later message" }, state: "pending" as const, attempts: 0, nextAttemptAt: 0 };
  outbox.admit(agent);
  assert.deepEqual(outbox.pending().map((r) => r.workId), [agent.workId]);
  assert.throws(() => outbox.admit({ ...agent, input: { prompt: "changed" } }));
  const restarted = new QueueAdmissionOutbox(file);
  assert.deepEqual(restarted.pending().map((r) => r.workId), [agent.workId]);
});

test("agent envelopes retain identity through retry and terminal outcomes", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-")), "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const workId = admissionWorkId("mail", 7);
  outbox.admit({ queue: "mail", sequence: 7, workId, admittedAt: "2026-01-01T00:00:00.000Z", variant: "agent-dispatch", input: { complete: true }, state: "pending", attempts: 0, nextAttemptAt: 0 });
  assert.equal(outbox.beginAttempt(workId).state, "running");
  assert.equal(outbox.retry(workId, 100).attempts, 1);
  assert.deepEqual(outbox.dueAgents(99), []);
  assert.equal(outbox.dueAgents(100)[0].workId, workId);
  assert.equal(outbox.succeed(workId, { delivered: true }).state, "succeeded");
  assert.deepEqual(outbox.dueAgents(1000), []);
});
