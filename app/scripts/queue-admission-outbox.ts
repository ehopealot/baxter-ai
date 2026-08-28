// Durable local admission records.  This deliberately stores complete envelopes
// rather than a coalesced prompt: scheduling may coalesce, admission identity may not.
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export type QueueName = "mail" | "sms" | "chat";
export interface AdmissionBase { queue: QueueName; sequence: number; workId: string; admittedAt: string; }
export interface AgentDispatchRecord extends AdmissionBase {
  variant: "agent-dispatch"; input: unknown; state: "pending" | "retry-wait" | "running" | "succeeded" | "permanent-failure";
  attempts: number; nextAttemptAt: number; outcome?: unknown;
}
export interface NonAgentTerminalRecord extends AdmissionBase {
  variant: "non-agent-terminal"; outcomeType: string; outcomeVersion: number; outcome: unknown; idempotencyKey: string;
  state: "pending-side-effects" | "terminal"; receipt?: unknown;
}
export type AdmissionRecord = AgentDispatchRecord | NonAgentTerminalRecord;
interface Disk { version: 1; records: AdmissionRecord[]; }

export function admissionWorkId(queue: QueueName, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid queue sequence");
  return createHash("sha256").update(`${queue}:${sequence}`).digest("hex");
}
function canonical(value: unknown): string { return JSON.stringify(value); }
function durableWrite(path: string, value: Disk): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export class QueueAdmissionOutbox {
  private disk: Disk;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    try { const parsed = JSON.parse(readFileSync(path, "utf8")) as Disk; if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error("invalid outbox"); this.disk = parsed; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.disk = { version: 1, records: [] }; }
  }
  records(): readonly AdmissionRecord[] { return this.disk.records; }
  admit(record: AdmissionRecord): AdmissionRecord {
    if (record.workId !== admissionWorkId(record.queue, record.sequence)) throw new Error("invalid deterministic work id");
    const existing = this.disk.records.find((r) => r.workId === record.workId);
    if (existing) {
      // State/receipts are mutable; all admission identity fields are not.
      const immutable = (r: AdmissionRecord) => r.variant === "agent-dispatch"
        ? { queue: r.queue, sequence: r.sequence, workId: r.workId, admittedAt: r.admittedAt, variant: r.variant, input: r.input }
        : { queue: r.queue, sequence: r.sequence, workId: r.workId, admittedAt: r.admittedAt, variant: r.variant, outcomeType: r.outcomeType, outcomeVersion: r.outcomeVersion, outcome: r.outcome, idempotencyKey: r.idempotencyKey };
      if (canonical(immutable(existing)) !== canonical(immutable(record))) throw new Error("admission record changed immutable content");
      return existing;
    }
    this.disk.records.push(record); durableWrite(this.path, this.disk); return record;
  }
  update(workId: string, update: Partial<AgentDispatchRecord> | Partial<NonAgentTerminalRecord>): AdmissionRecord {
    const index = this.disk.records.findIndex((r) => r.workId === workId); if (index < 0) throw new Error("unknown admission record");
    const previous = this.disk.records[index];
    const next = { ...previous, ...update } as AdmissionRecord;
    if (next.variant !== previous.variant || next.queue !== previous.queue || next.sequence !== previous.sequence || next.workId !== previous.workId) throw new Error("admission identity is immutable");
    this.disk.records[index] = next; durableWrite(this.path, this.disk); return next;
  }
  pending(): AdmissionRecord[] { return this.disk.records.filter((r) => r.variant === "agent-dispatch" ? r.state !== "succeeded" && r.state !== "permanent-failure" : r.state === "pending-side-effects"); }
  /** Due envelopes are replayed individually; terminal non-agent records are inert. */
  dueAgents(now = Date.now()): AgentDispatchRecord[] {
    return this.disk.records.filter((r): r is AgentDispatchRecord => r.variant === "agent-dispatch" && (r.state === "pending" || r.state === "retry-wait") && r.nextAttemptAt <= now);
  }
  /** A process died while this envelope was owned by a dispatcher; replay it once. */
  recoverInterrupted(now = Date.now()): AgentDispatchRecord[] {
    const recovered: AgentDispatchRecord[] = [];
    for (const record of this.disk.records) {
      if (record.variant === "agent-dispatch" && record.state === "running") {
        record.state = "retry-wait";
        record.attempts++;
        record.nextAttemptAt = now;
        recovered.push(record);
      }
    }
    if (recovered.length) durableWrite(this.path, this.disk);
    return recovered;
  }
  beginAttempt(workId: string): AgentDispatchRecord {
    const record = this.update(workId, { state: "running" }) as AgentDispatchRecord;
    if (record.variant !== "agent-dispatch") throw new Error("non-agent record cannot be dispatched");
    return record;
  }
  retry(workId: string, nextAttemptAt: number): AgentDispatchRecord {
    const current = this.disk.records.find((r) => r.workId === workId);
    if (!current || current.variant !== "agent-dispatch") throw new Error("non-agent record cannot be retried");
    return this.update(workId, { state: "retry-wait", attempts: current.attempts + 1, nextAttemptAt }) as AgentDispatchRecord;
  }
  succeed(workId: string, outcome: unknown): AgentDispatchRecord {
    const current = this.disk.records.find((r) => r.workId === workId);
    if (!current || current.variant !== "agent-dispatch") throw new Error("non-agent record cannot succeed");
    return this.update(workId, { state: "succeeded", outcome }) as AgentDispatchRecord;
  }
  permanentFailure(workId: string, outcome: unknown): AgentDispatchRecord {
    const current = this.disk.records.find((r) => r.workId === workId);
    if (!current || current.variant !== "agent-dispatch") throw new Error("non-agent record cannot fail permanently");
    return this.update(workId, { state: "permanent-failure", outcome }) as AgentDispatchRecord;
  }
  compact(): void { this.disk.records = this.disk.records.filter((r) => r.variant === "agent-dispatch" ? r.state !== "succeeded" && r.state !== "permanent-failure" : r.state !== "terminal"); durableWrite(this.path, this.disk); }
}
export function defaultAdmissionOutboxPath(stateDir: string): string { return join(stateDir, "queue-admission-outbox.json"); }
