import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";
import { QueueAdmissionOutbox, admissionWorkId } from "./queue-admission-outbox.ts";
import { mailDeliveryIdempotencyKey } from "./mail-delivery-receipts.ts";

function fullAncestry(path: string): string[] {
  const ancestry: string[] = [];
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    ancestry.push(cursor);
    if (dirname(cursor) === cursor) return ancestry.reverse();
  }
}

test("first admission retries its full directory barrier before becoming ACK-eligible", () => {
  const root = mkdtempSync(join(tmpdir(), "admission-bootstrap-"));
  const directory = join(root, "state", "queue");
  const file = join(directory, "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const workId = admissionWorkId("mail", 1, "tenant-bootstrap");
  const record = { tenantId: "tenant-bootstrap", queue: "mail" as const, sequence: 1, workId, admittedAt: "2026-01-01T00:00:00.000Z", variant: "agent-dispatch" as const, input: { durable: true }, state: "pending" as const, attempts: 0, nextAttemptAt: 0 };
  const faultAt = resolve(root, "state");
  let restore = setDurableDirectorySyncForTest(path => {
    if (resolve(path) === faultAt) throw new Error("injected admission ancestry fsync failure");
  });
  try {
    assert.throws(() => outbox.admit(record), /injected admission ancestry fsync failure/);
    assert.equal(existsSync(file), false, "no envelope is published after a failed ancestry barrier");
    assert.deepEqual(outbox.records(), [], "the failed envelope is not ACK-eligible in memory");

    restore();
    const retried: string[] = [];
    restore = setDurableDirectorySyncForTest(path => { retried.push(resolve(path)); });
    outbox.admit(record);
    assert.deepEqual(retried, [...fullAncestry(directory), resolve(directory)], "retry fsyncs existing ancestry before the outbox rename directory");
    assert.equal(existsSync(file), true);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping mail sequences in two tenants have distinct work and Resend idempotency identities", () => {
  const tenantA = admissionWorkId("mail", 17, "tenant-a");
  const tenantB = admissionWorkId("mail", 17, "tenant-b");
  assert.notEqual(tenantA, tenantB);
  assert.notEqual(mailDeliveryIdempotencyKey(tenantA), mailDeliveryIdempotencyKey(tenantB));
  assert.equal(admissionWorkId("mail", 17, "tenant-a"), tenantA, "redelivery in one tenant remains stable");
});

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
  assert.throws(() => outbox.update(agent.workId, { input: { prompt: "changed through update" } }), /immutable/);
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
  outbox.beginAttempt(workId);
  assert.equal(outbox.succeed(workId, { kind: "succeeded", source: "mail", completedAt: "2026-01-01T00:00:02.000Z", providerReceipts: [] }).state, "succeeded");
  assert.throws(() => outbox.retry(workId, 200), /terminal/);
  assert.deepEqual(outbox.dueAgents(1000), []);
});

test("closed persisted union rejects unknown variants and permanent failure requires DLQ evidence", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-")), "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const workId = admissionWorkId("mail", 9);
  outbox.admit({ queue: "mail", sequence: 9, workId, admittedAt: "2026-01-01T00:00:00.000Z", variant: "agent-dispatch", input: { complete: true }, state: "pending", attempts: 0, nextAttemptAt: 0 });
  assert.throws(() => outbox.permanentFailure(workId, { kind: "permanent-failure", source: "mail", message: "bad" } as any), /DLQ/);
  writeFileSync(file, JSON.stringify({ version: 1, records: [{ queue: "mail", sequence: 9, workId, admittedAt: "t", variant: "unknown" }] }));
  assert.throws(() => new QueueAdmissionOutbox(file), /invalid outbox/);
});

test("an interrupted running envelope is durably made replayable exactly once", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-")), "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const workId = admissionWorkId("mail", 8);
  outbox.admit({ queue: "mail", sequence: 8, workId, admittedAt: "2026-01-01T00:00:00.000Z", variant: "agent-dispatch", input: { complete: true }, state: "pending", attempts: 0, nextAttemptAt: 0 });
  outbox.beginAttempt(workId);
  assert.deepEqual(outbox.recoverInterrupted(200).map(record => record.workId), [workId]);
  assert.equal(new QueueAdmissionOutbox(file).dueAgents(200)[0].workId, workId);
  assert.deepEqual(outbox.recoverInterrupted(200), []);
});
