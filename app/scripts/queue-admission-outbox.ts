// Durable local admission records. Complete envelopes are retained individually:
// scheduling may batch/coalesce execution, but admission identity and outcomes may not.
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export type QueueName = "mail" | "sms" | "chat";
export interface AdmissionBase { queue: QueueName; sequence: number; workId: string; admittedAt: string; }

export type AgentRetryReason = "transient-error" | "rate-limit" | "agent-failed" | "out-of-tokens" | "interrupted" | "dlq-write-failed";
export interface AgentRetryOutcome {
  kind: "retry";
  source: QueueName;
  reason: AgentRetryReason;
  message?: string;
}
export interface AgentSucceededOutcome {
  kind: "succeeded";
  source: QueueName;
  completedAt: string;
  providerReceipts: Array<{ idempotencyKey: string; providerId: string }>;
}
export interface AgentPermanentFailureOutcome {
  kind: "permanent-failure";
  source: QueueName;
  message: string;
  sourceDlq: { surface: QueueName; recordedAt: string };
}
export type AgentTerminalOutcome = AgentSucceededOutcome | AgentPermanentFailureOutcome;

export interface AgentDispatchRecord extends AdmissionBase {
  variant: "agent-dispatch";
  input: unknown;
  state: "pending" | "retry-wait" | "running" | "succeeded" | "permanent-failure";
  attempts: number;
  nextAttemptAt: number;
  lastRetry?: AgentRetryOutcome;
  outcome?: AgentTerminalOutcome;
}
export interface NonAgentTerminalRecord extends AdmissionBase {
  variant: "non-agent-terminal";
  outcomeType: string;
  outcomeVersion: number;
  outcome: unknown;
  idempotencyKey: string;
  state: "pending-side-effects" | "terminal";
  receipt?: unknown;
}
export type AdmissionRecord = AgentDispatchRecord | NonAgentTerminalRecord;
interface Disk { version: 1; records: AdmissionRecord[]; }

export function admissionWorkId(queue: QueueName, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid queue sequence");
  return createHash("sha256").update(`${queue}:${sequence}`).digest("hex");
}

function canonical(value: unknown): string { return JSON.stringify(value); }
function immutableRecord(candidate: AdmissionRecord): unknown {
  return candidate.variant === "agent-dispatch"
    ? { queue: candidate.queue, sequence: candidate.sequence, workId: candidate.workId, admittedAt: candidate.admittedAt, variant: candidate.variant, input: candidate.input }
    : { queue: candidate.queue, sequence: candidate.sequence, workId: candidate.workId, admittedAt: candidate.admittedAt, variant: candidate.variant, outcomeType: candidate.outcomeType, outcomeVersion: candidate.outcomeVersion, outcome: candidate.outcome, idempotencyKey: candidate.idempotencyKey };
}
function durableWrite(path: string, value: Disk): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function isAgent(record: AdmissionRecord | undefined): record is AgentDispatchRecord {
  return record?.variant === "agent-dispatch";
}

function validRecord(value: unknown): value is AdmissionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ((record.queue !== "mail" && record.queue !== "sms" && record.queue !== "chat")
    || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0
    || typeof record.workId !== "string" || record.workId !== admissionWorkId(record.queue, record.sequence as number)
    || typeof record.admittedAt !== "string") return false;
  if (record.variant === "non-agent-terminal") {
    const allowed = new Set(["queue", "sequence", "workId", "admittedAt", "variant", "outcomeType", "outcomeVersion", "outcome", "idempotencyKey", "state", "receipt"]);
    return Object.keys(record).every((key) => allowed.has(key)) && Object.hasOwn(record, "outcome")
      && typeof record.outcomeType === "string" && Number.isSafeInteger(record.outcomeVersion) && (record.outcomeVersion as number) > 0
      && typeof record.idempotencyKey === "string"
      && (record.state === "pending-side-effects" || record.state === "terminal");
  }
  const allowed = new Set(["queue", "sequence", "workId", "admittedAt", "variant", "input", "state", "attempts", "nextAttemptAt", "lastRetry", "outcome"]);
  if (record.variant !== "agent-dispatch" || !Object.keys(record).every((key) => allowed.has(key)) || !Object.hasOwn(record, "input")
    || !["pending", "retry-wait", "running", "succeeded", "permanent-failure"].includes(String(record.state))
    || !Number.isSafeInteger(record.attempts) || (record.attempts as number) < 0
    || typeof record.nextAttemptAt !== "number" || !Number.isFinite(record.nextAttemptAt)) return false;
  const lastRetry = record.lastRetry as Record<string, unknown> | undefined;
  if (lastRetry !== undefined && (lastRetry.kind !== "retry" || lastRetry.source !== record.queue
    || !["transient-error", "rate-limit", "agent-failed", "out-of-tokens", "interrupted", "dlq-write-failed"].includes(String(lastRetry.reason)))) return false;
  const outcome = record.outcome as Record<string, unknown> | undefined;
  if (record.state === "succeeded") return outcome?.kind === "succeeded" && outcome.source === record.queue;
  if (record.state === "permanent-failure") return outcome?.kind === "permanent-failure" && outcome.source === record.queue;
  return outcome === undefined;
}

export class QueueAdmissionOutbox {
  private disk: Disk;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Disk;
      if (parsed.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(validRecord)) throw new Error("invalid outbox");
      this.disk = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.disk = { version: 1, records: [] };
    }
  }

  records(): readonly AdmissionRecord[] { return this.disk.records; }
  agent(workId: string): AgentDispatchRecord | undefined {
    const record = this.disk.records.find((candidate) => candidate.workId === workId);
    return isAgent(record) ? record : undefined;
  }

  admit(record: AdmissionRecord): AdmissionRecord {
    if (!validRecord(record)) throw new Error("invalid admission record");
    if (record.workId !== admissionWorkId(record.queue, record.sequence)) throw new Error("invalid deterministic work id");
    const existing = this.disk.records.find((candidate) => candidate.workId === record.workId);
    if (existing) {
      if (canonical(immutableRecord(existing)) !== canonical(immutableRecord(record))) throw new Error("admission record changed immutable content");
      return existing;
    }
    this.disk.records.push(record);
    durableWrite(this.path, this.disk);
    return record;
  }

  update(workId: string, update: Partial<AgentDispatchRecord> | Partial<NonAgentTerminalRecord>): AdmissionRecord {
    const index = this.disk.records.findIndex((record) => record.workId === workId);
    if (index < 0) throw new Error("unknown admission record");
    const previous = this.disk.records[index];
    const next = { ...previous, ...update } as AdmissionRecord;
    if (canonical(immutableRecord(next)) !== canonical(immutableRecord(previous))) {
      throw new Error("admission identity is immutable");
    }
    if (!validRecord(next)) throw new Error("invalid admission state");
    this.disk.records[index] = next;
    durableWrite(this.path, this.disk);
    return next;
  }

  pending(): AdmissionRecord[] {
    return this.disk.records.filter((record) => record.variant === "agent-dispatch"
      ? record.state !== "succeeded" && record.state !== "permanent-failure"
      : record.state === "pending-side-effects");
  }

  dueAgents(now = Date.now()): AgentDispatchRecord[] {
    return this.disk.records
      .filter((record): record is AgentDispatchRecord => record.variant === "agent-dispatch"
        && (record.state === "pending" || record.state === "retry-wait")
        && record.nextAttemptAt <= now)
      .sort((left, right) => left.sequence - right.sequence);
  }

  earliestAgentAttempt(): number | null {
    let earliest: number | null = null;
    for (const record of this.disk.records) {
      if (record.variant !== "agent-dispatch" || (record.state !== "pending" && record.state !== "retry-wait")) continue;
      if (earliest === null || record.nextAttemptAt < earliest) earliest = record.nextAttemptAt;
    }
    return earliest;
  }

  /** A process died while this envelope was owned by a dispatcher. */
  recoverInterrupted(now = Date.now()): AgentDispatchRecord[] {
    const recovered: AgentDispatchRecord[] = [];
    for (const record of this.disk.records) {
      if (record.variant !== "agent-dispatch" || record.state !== "running") continue;
      record.state = "retry-wait";
      record.attempts++;
      record.nextAttemptAt = now;
      record.lastRetry = { kind: "retry", source: record.queue, reason: "interrupted" };
      recovered.push(record);
    }
    if (recovered.length) durableWrite(this.path, this.disk);
    return recovered;
  }

  beginAttempt(workId: string): AgentDispatchRecord {
    const current = this.agent(workId);
    if (!current) throw new Error("non-agent record cannot be dispatched");
    if (current.state !== "pending" && current.state !== "retry-wait") throw new Error(`agent record is not dispatchable (${current.state})`);
    return this.update(workId, { state: "running" }) as AgentDispatchRecord;
  }

  retry(workId: string, nextAttemptAt: number, retry: Omit<AgentRetryOutcome, "source"> = { kind: "retry", reason: "transient-error" }): AgentDispatchRecord {
    const current = this.agent(workId);
    if (!current) throw new Error("non-agent record cannot be retried");
    if (current.state === "succeeded" || current.state === "permanent-failure") throw new Error("terminal agent record cannot be retried");
    if (!Number.isFinite(nextAttemptAt)) throw new Error("invalid next attempt time");
    return this.update(workId, { state: "retry-wait", attempts: current.attempts + 1, nextAttemptAt, lastRetry: { ...retry, source: current.queue } }) as AgentDispatchRecord;
  }

  succeed(workId: string, outcome: AgentSucceededOutcome): AgentDispatchRecord {
    const current = this.agent(workId);
    if (!current) throw new Error("non-agent record cannot succeed");
    if (outcome.kind !== "succeeded") throw new Error("invalid success outcome");
    if (current.state === "succeeded") return current;
    if (current.state !== "running") throw new Error(`agent record cannot succeed from ${current.state}`);
    return this.update(workId, { state: "succeeded", outcome }) as AgentDispatchRecord;
  }

  permanentFailure(workId: string, outcome: AgentPermanentFailureOutcome): AgentDispatchRecord {
    const current = this.agent(workId);
    if (!current) throw new Error("non-agent record cannot fail permanently");
    if (outcome.kind !== "permanent-failure" || !outcome.sourceDlq) throw new Error("permanent failure requires source DLQ evidence");
    if (current.state === "permanent-failure") return current;
    if (current.state === "succeeded") throw new Error("successful agent record cannot fail permanently");
    return this.update(workId, { state: "permanent-failure", outcome }) as AgentDispatchRecord;
  }

  compact(): void {
    this.disk.records = this.disk.records.filter((record) => record.variant === "agent-dispatch"
      ? record.state !== "succeeded" && record.state !== "permanent-failure"
      : record.state !== "terminal");
    durableWrite(this.path, this.disk);
  }
}

export function defaultAdmissionOutboxPath(stateDir: string): string { return join(stateDir, "queue-admission-outbox.json"); }
