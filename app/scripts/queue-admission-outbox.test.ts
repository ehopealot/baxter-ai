import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";
import { QueueAdmissionOutbox, admissionWorkId } from "./queue-admission-outbox.ts";
import { mailDeliveryIdempotencyKey } from "./mail-delivery-receipts.ts";
import { LightLifecycle } from "./light-lifecycle.ts";

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

test("a loaded outbox must repair its existing file/directory publication barrier before records are exposed", () => {
  const root = mkdtempSync(join(tmpdir(), "admission-loaded-barrier-"));
  const file = join(root, "state", "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const workId = admissionWorkId("chat", 3, "tenant-loaded");
  outbox.admit({ tenantId: "tenant-loaded", queue: "chat", sequence: 3, workId, admittedAt: "t", variant: "agent-dispatch", input: {}, state: "pending", attempts: 0, nextAttemptAt: 0 });
  const restore = setDurableDirectorySyncForTest(path => {
    if (resolve(path) === resolve(dirname(file))) throw new Error("injected loaded outbox barrier failure");
  });
  try { assert.throws(() => new QueueAdmissionOutbox(file), /loaded outbox barrier failure/); }
  finally { restore(); }
  assert.equal(new QueueAdmissionOutbox(file).records()[0].workId, workId);
  rmSync(root, { recursive: true, force: true });
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
  const stop = { queue: "sms" as const, sequence: 4, workId: admissionWorkId("sms", 4), admittedAt: "2026-01-01T00:00:00.000Z", variant: "non-agent-terminal" as const, outcomeType: "sms-stop" as const, outcomeVersion: 1 as const, outcome: { from: "+15551234567", content: "STOP" }, idempotencyKey: `sms-stop:${admissionWorkId("sms", 4)}`, state: "pending-side-effects" as const };
  outbox.admit(stop);
  outbox.completeNonAgent(stop.workId, { kind: "sms-opt-out", phone: "+15551234567" }, "2026-01-01T00:00:00.500Z");
  const agent = { queue: "sms" as const, sequence: 5, workId: admissionWorkId("sms", 5), admittedAt: "2026-01-01T00:00:01.000Z", variant: "agent-dispatch" as const, input: { prompt: "later message" }, state: "pending" as const, attempts: 0, nextAttemptAt: 0 };
  outbox.admit(agent);
  assert.deepEqual(outbox.pending().map((r) => r.workId), [agent.workId]);
  assert.throws(() => outbox.admit({ ...agent, input: { prompt: "changed" } }));
  assert.throws(() => outbox.update(agent.workId, { input: { prompt: "changed through update" } }), /immutable/);
  const restarted = new QueueAdmissionOutbox(file);
  assert.deepEqual(restarted.pending().map((r) => r.workId), [agent.workId]);
});

test("a bound shared outbox blocks lifecycle drain for every nonterminal durable record", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-lifecycle-")), "outbox.json");
  const lifecycle = new LightLifecycle();
  const outbox = new QueueAdmissionOutbox(file);
  outbox.bindLifecycle(lifecycle);
  const parent = lifecycle.admit("sms:inbound"); assert.ok(parent);
  lifecycle.closeIntake();
  const workId = admissionWorkId("sms", 6, "tenant-a");
  outbox.admit({ tenantId: "tenant-a", queue: "sms", sequence: 6, workId, admittedAt: "t", variant: "agent-dispatch", input: {}, state: "pending", attempts: 0, nextAttemptAt: 0 });
  parent!();
  assert.equal(lifecycle.snapshot()["queue-outbox:sms:nonterminal"], 1);
  outbox.beginAttempt(workId);
  outbox.retry(workId, 100);
  assert.equal(lifecycle.snapshot()["queue-outbox:sms:nonterminal"], 1, "waiting retry keeps the same blocker");
  outbox.beginAttempt(workId);
  outbox.succeed(workId, { kind: "succeeded", source: "sms", completedAt: "done", providerReceipts: [] });
  await lifecycle.drain();
  assert.equal(lifecycle.snapshot()["queue-outbox:sms:nonterminal"], undefined);
});

test("agent envelopes retain identity through retry and terminal outcomes", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-")), "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const workId = admissionWorkId("mail", 7);
  outbox.admit({ queue: "mail", sequence: 7, workId, admittedAt: "2026-01-01T00:00:00.000Z", variant: "agent-dispatch", input: { complete: true }, state: "pending", attempts: 0, nextAttemptAt: 0 });
  assert.equal(outbox.beginAttempt(workId).state, "running");
  assert.deepEqual(outbox.recordAgentReceipt(workId, { version: 1, stage: "prepared" }).receipt, { version: 1, stage: "prepared" });
  assert.deepEqual(new QueueAdmissionOutbox(file).agent(workId)?.receipt, { version: 1, stage: "prepared" }, "surface progress survives dispatcher restart");
  assert.equal(outbox.retry(workId, 100).attempts, 1);
  assert.deepEqual(outbox.dueAgents(99), []);
  assert.equal(outbox.dueAgents(100)[0].workId, workId);
  outbox.beginAttempt(workId);
  assert.throws(() => outbox.succeed(workId, { kind: "succeeded", source: "mail", resolution: "no-reply", completedAt: "2026-01-01T00:00:02.000Z", providerReceipts: [] } as any), /invalid success outcome/, "runtime-only fields cannot enter the durable terminal schema");
  assert.equal(outbox.succeed(workId, { kind: "succeeded", source: "mail", completedAt: "2026-01-01T00:00:02.000Z", providerReceipts: [{ idempotencyKey: "mail-key", providerId: "provider-id" }] }).state, "succeeded");
  assert.deepEqual(new QueueAdmissionOutbox(file).agent(workId)?.outcome, { kind: "succeeded", source: "mail", completedAt: "2026-01-01T00:00:02.000Z", providerReceipts: [{ idempotencyKey: "mail-key", providerId: "provider-id" }] });
  assert.throws(() => outbox.retry(workId, 200), /terminal/);
  assert.deepEqual(outbox.dueAgents(1000), []);
});

test("non-agent records must be admitted pending and terminalize only through a typed durable receipt", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-non-agent-")), "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const workId = admissionWorkId("chat", 12);
  const base = { queue: "chat" as const, sequence: 12, workId, admittedAt: "t", variant: "non-agent-terminal" as const, outcomeType: "chat-create" as const, outcomeVersion: 1 as const, outcome: { kind: "create-chat" as const }, idempotencyKey: `chat-create:${workId}` };
  assert.throws(() => outbox.admit({ ...base, state: "terminal", receipt: { closed: true } } as any), /invalid admission/);
  outbox.admit({ ...base, state: "pending-side-effects" });
  assert.throws(() => outbox.update(workId, { state: "terminal", receipt: { closed: true } } as any), /invalid admission state/);
  assert.throws(() => outbox.completeNonAgent(workId, { kind: "source-applied", surface: "chat", detail: "delete-chat" }, "done"), /completion evidence/);
  assert.throws(() => outbox.completeNonAgent(workId, { kind: "source-dead-letter", surface: "chat", recordedAt: "done" }, "done"), /completion evidence/);
  const done = outbox.completeNonAgent(workId, { kind: "source-applied", surface: "chat", detail: "create-chat" }, "done");
  assert.equal(done.state, "terminal");
  assert.deepEqual(done.receipt, { version: 1, kind: "non-agent-side-effects-complete", outcomeType: "chat-create", outcomeVersion: 1, completedAt: "done", evidence: { kind: "source-applied", surface: "chat", detail: "create-chat" } });
  assert.deepEqual(outbox.completeNonAgent(workId, { kind: "source-applied", surface: "chat", detail: "create-chat" }, "later"), done, "completion is idempotent");
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

test("persisted agent terminal outcomes reject unknown and malformed closed-schema fields", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-terminal-corruption-")), "outbox.json");
  const workId = admissionWorkId("mail", 23);
  const base = { queue: "mail", sequence: 23, workId, admittedAt: "t", variant: "agent-dispatch", input: {}, attempts: 1, nextAttemptAt: 0 };
  const succeeded = { kind: "succeeded", source: "mail", completedAt: "done", providerReceipts: [{ idempotencyKey: "key", providerId: "provider" }] };
  const failed = { kind: "permanent-failure", source: "mail", message: "bad envelope", sourceDlq: { surface: "mail", recordedAt: "done" } };
  const corruptions: Array<{ name: string; state: "succeeded" | "permanent-failure"; outcome: unknown }> = [
    { name: "success unknown field", state: "succeeded", outcome: { ...succeeded, resolution: "delivered" } },
    { name: "success missing completedAt", state: "succeeded", outcome: { kind: "succeeded", source: "mail", providerReceipts: [] } },
    { name: "success malformed completedAt", state: "succeeded", outcome: { ...succeeded, completedAt: 7 } },
    { name: "success receipts are not an array", state: "succeeded", outcome: { ...succeeded, providerReceipts: {} } },
    { name: "success receipt missing provider id", state: "succeeded", outcome: { ...succeeded, providerReceipts: [{ idempotencyKey: "key" }] } },
    { name: "success receipt unknown field", state: "succeeded", outcome: { ...succeeded, providerReceipts: [{ idempotencyKey: "key", providerId: "provider", extra: true }] } },
    { name: "failure missing message", state: "permanent-failure", outcome: { kind: "permanent-failure", source: "mail", sourceDlq: failed.sourceDlq } },
    { name: "failure unknown field", state: "permanent-failure", outcome: { ...failed, retryable: false } },
    { name: "failure DLQ missing recordedAt", state: "permanent-failure", outcome: { ...failed, sourceDlq: { surface: "mail" } } },
    { name: "failure DLQ wrong source", state: "permanent-failure", outcome: { ...failed, sourceDlq: { surface: "sms", recordedAt: "done" } } },
    { name: "failure DLQ unknown field", state: "permanent-failure", outcome: { ...failed, sourceDlq: { ...failed.sourceDlq, path: "hidden" } } },
  ];
  for (const corruption of corruptions) {
    writeFileSync(file, JSON.stringify({ version: 1, records: [{ ...base, state: corruption.state, outcome: corruption.outcome }] }));
    assert.throws(() => new QueueAdmissionOutbox(file), /invalid outbox/, corruption.name);
  }
});

test("every supported non-agent discriminator has an exact outcome, idempotency, and evidence schema", () => {
  const root = mkdtempSync(join(tmpdir(), "admission-non-agent-schema-"));
  const at = "2026-01-01T00:00:00.000Z";
  const makeBase = (queue: "mail" | "sms" | "chat", sequence: number) => {
    const workId = admissionWorkId(queue, sequence, "tenant-schema");
    return { tenantId: "tenant-schema", queue, sequence, workId, admittedAt: at, variant: "non-agent-terminal", state: "pending-side-effects" };
  };
  const mailNo = makeBase("mail", 1);
  const mailDlq = makeBase("mail", 2);
  const smsStop = makeBase("sms", 3);
  const smsPoison = makeBase("sms", 4);
  const chatCreate = makeBase("chat", 5);
  const chatDelete = makeBase("chat", 6);
  const chatPoison = makeBase("chat", 7);
  const records: any[] = [
    { ...mailNo, outcomeType: "mail-no-agent-dispatch", outcomeVersion: 1, outcome: { reason: "handled-without-agent-dispatch" }, idempotencyKey: `mail-terminal:${mailNo.workId}` },
    { ...mailDlq, outcomeType: "mail-source-dead-letter", outcomeVersion: 2, outcome: { id: 2, workId: mailDlq.workId, at, error: "mail poison", payload: { kind: "mail", id: 2, raw: "{}", svixHeaders: { "svix-id": "m2" }, at } }, idempotencyKey: `mail-source-dlq:${mailDlq.workId}` },
    { ...smsStop, outcomeType: "sms-stop", outcomeVersion: 1, outcome: { from: "+15551234567", content: "STOP" }, idempotencyKey: `sms-stop:${smsStop.workId}` },
    { ...smsPoison, outcomeType: "sms-transcript-poison", outcomeVersion: 1, outcome: { outcomeId: smsPoison.workId, id: 4, at, from: "+15551234567", error: "SMS poison", payload: { id: 4, from: "+15551234567", content: "bad", at } }, idempotencyKey: `sms-transcript-poison:${smsPoison.workId}` },
    { ...chatCreate, outcomeType: "chat-create", outcomeVersion: 1, outcome: { kind: "create-chat" }, idempotencyKey: `chat-create:${chatCreate.workId}` },
    { ...chatDelete, outcomeType: "chat-delete", outcomeVersion: 1, outcome: { kind: "delete-chat", chatId: "wc-5" }, idempotencyKey: `chat-delete:${chatDelete.workId}` },
    { ...chatPoison, outcomeType: "chat-transcript-poison", outcomeVersion: 1, outcome: { outcomeId: chatPoison.workId, id: 7, at, kind: "send-message", error: "chat poison", intent: { id: 7, kind: "send-message", chatId: "wc-5", text: "bad", authorId: "member:a", authorName: "A", at } }, idempotencyKey: `chat-transcript-poison:${chatPoison.workId}` },
  ];
  try {
    for (const [index, record] of records.entries()) {
      const file = join(root, `${index}.json`);
      writeFileSync(file, JSON.stringify({ version: 1, records: [record] }));
      const loaded = new QueueAdmissionOutbox(file).records()[0];
      assert.equal(loaded.variant, "non-agent-terminal");
      assert.equal(loaded.variant === "non-agent-terminal" ? loaded.outcomeType : "", record.outcomeType);

      writeFileSync(file, JSON.stringify({ version: 1, records: [{ ...record, idempotencyKey: `wrong:${record.workId}` }] }));
      assert.throws(() => new QueueAdmissionOutbox(file), /invalid outbox/, `${record.outcomeType} rejects mismatched idempotency`);
      writeFileSync(file, JSON.stringify({ version: 1, records: [{ ...record, outcome: { ...record.outcome, extra: true } }] }));
      assert.throws(() => new QueueAdmissionOutbox(file), /invalid outbox/, `${record.outcomeType} rejects extended outcomes`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outbox load rejects duplicate deterministic work IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "admission-duplicate-work-"));
  const file = join(root, "outbox.json");
  const workId = admissionWorkId("chat", 8, "tenant-duplicate");
  const record = { tenantId: "tenant-duplicate", queue: "chat", sequence: 8, workId, admittedAt: "t", variant: "agent-dispatch", input: {}, state: "pending", attempts: 0, nextAttemptAt: 0 };
  try {
    writeFileSync(file, JSON.stringify({ version: 1, records: [record, record] }));
    assert.throws(() => new QueueAdmissionOutbox(file), /invalid outbox/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cursor-aware compaction removes only terminal records durably covered in the same queue and tenant", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-compaction-")), "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const terminal = (queue: "mail" | "sms" | "chat", sequence: number, tenantId: string) => {
    const workId = admissionWorkId(queue, sequence, tenantId);
    if (queue === "mail") {
      outbox.admit({ tenantId, queue, sequence, workId, admittedAt: "t", variant: "non-agent-terminal", outcomeType: "mail-no-agent-dispatch", outcomeVersion: 1,
        outcome: { reason: "handled-without-agent-dispatch" }, idempotencyKey: `mail-terminal:${workId}`, state: "pending-side-effects" });
      outbox.completeNonAgent(workId, { kind: "source-applied", surface: "mail", detail: "handled-without-agent-dispatch" });
    } else if (queue === "sms") {
      outbox.admit({ tenantId, queue, sequence, workId, admittedAt: "t", variant: "non-agent-terminal", outcomeType: "sms-stop", outcomeVersion: 1,
        outcome: { from: "+15551234567", content: "STOP" }, idempotencyKey: `sms-stop:${workId}`, state: "pending-side-effects" });
      outbox.completeNonAgent(workId, { kind: "sms-opt-out", phone: "+15551234567" });
    } else {
      outbox.admit({ tenantId, queue, sequence, workId, admittedAt: "t", variant: "non-agent-terminal", outcomeType: "chat-create", outcomeVersion: 1,
        outcome: { kind: "create-chat" }, idempotencyKey: `chat-create:${workId}`, state: "pending-side-effects" });
      outbox.completeNonAgent(workId, { kind: "source-applied", surface: "chat", detail: "create-chat" });
    }
    return workId;
  };
  const covered = terminal("sms", 4, "tenant-a");
  const above = terminal("sms", 8, "tenant-a");
  const otherTenant = terminal("sms", 3, "tenant-b");
  const otherQueue = terminal("mail", 2, "tenant-a");
  const pending = admissionWorkId("sms", 1, "tenant-a");
  outbox.admit({ tenantId: "tenant-a", queue: "sms", sequence: 1, workId: pending, admittedAt: "t", variant: "agent-dispatch", input: {}, state: "pending", attempts: 0, nextAttemptAt: 0 });

  assert.equal(outbox.noteDurableCursor("sms", 4, "tenant-a"), 1);
  assert.deepEqual(new Set(outbox.records().map(record => record.workId)), new Set([above, otherTenant, otherQueue, pending]));
  assert.equal(outbox.records().some(record => record.workId === covered), false);
});

test("STOP terminal evidence survives both cursor crash windows and compacts only after cursor recovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "admission-stop-crash-"));
  const file = join(directory, "outbox.json");
  const workId = admissionWorkId("sms", 5, "tenant-stop");
  const outbox = new QueueAdmissionOutbox(file);
  outbox.admit({ tenantId: "tenant-stop", queue: "sms", sequence: 5, workId, admittedAt: "t", variant: "non-agent-terminal",
    outcomeType: "sms-stop", outcomeVersion: 1, outcome: { from: "+15551234567", content: "STOP" },
    idempotencyKey: `sms-stop:${workId}`, state: "pending-side-effects" });
  outbox.completeNonAgent(workId, { kind: "sms-opt-out", phone: "+15551234567" }, "done");

  const beforeCursorRestart = new QueueAdmissionOutbox(file);
  const stop = beforeCursorRestart.records().find(record => record.workId === workId);
  assert.equal(stop?.variant, "non-agent-terminal");
  assert.deepEqual(stop?.variant === "non-agent-terminal" ? stop.receipt?.evidence : null,
    { kind: "sms-opt-out", phone: "+15551234567" }, "a crash before cursor persistence keeps STOP evidence");

  // A crash after the cursor rename but before in-process compaction leaves the
  // same terminal record. Startup reloads that durable cursor, reports coverage,
  // then safely removes the already-applied STOP admission.
  const afterCursorRestart = new QueueAdmissionOutbox(file);
  assert.equal(afterCursorRestart.noteDurableCursor("sms", 5, "tenant-stop"), 1);
  assert.deepEqual(new QueueAdmissionOutbox(file).records(), []);
});

test("a terminal agent record compacts when its durable cursor was already observed", () => {
  const file = join(mkdtempSync(join(tmpdir(), "admission-terminal-after-cursor-")), "outbox.json");
  const outbox = new QueueAdmissionOutbox(file);
  const workId = admissionWorkId("chat", 9, "tenant-a");
  outbox.admit({ tenantId: "tenant-a", queue: "chat", sequence: 9, workId, admittedAt: "t", variant: "agent-dispatch", input: {}, state: "pending", attempts: 0, nextAttemptAt: 0 });
  assert.equal(outbox.noteDurableCursor("chat", 9, "tenant-a"), 0, "coverage alone never removes nonterminal ownership");
  outbox.beginAttempt(workId);
  outbox.succeed(workId, { kind: "succeeded", source: "chat", completedAt: "done", providerReceipts: [] });
  assert.deepEqual(outbox.records(), []);
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
