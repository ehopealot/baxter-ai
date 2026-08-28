// Durable local admission records. Complete envelopes are retained individually:
// scheduling may batch/coalesce execution, but admission identity and outcomes may not.
import { openSync, closeSync, readFileSync, renameSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";
import type { LightLifecycle } from "./light-lifecycle.ts";

export type QueueName = "mail" | "sms" | "chat";
export interface AdmissionBase {
  queue: QueueName;
  sequence: number;
  workId: string;
  admittedAt: string;
  /** Present for fleet work whose provider idempotency domain spans tenants. */
  tenantId?: string;
}

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
  /** Surface-owned, JSON-safe progress needed to resume a running envelope. */
  receipt?: unknown;
  outcome?: AgentTerminalOutcome;
}
export type NonAgentDurableEvidence =
  | { kind: "source-applied"; surface: QueueName; detail: string }
  | { kind: "source-dead-letter"; surface: QueueName; recordedAt: string }
  | { kind: "sms-opt-out"; phone: string };

export interface NonAgentCompletionReceipt {
  version: 1;
  kind: "non-agent-side-effects-complete";
  outcomeType: string;
  outcomeVersion: number;
  completedAt: string;
  evidence: NonAgentDurableEvidence;
}

interface NonAgentBase<Q extends QueueName, T extends string, V extends number, O> extends AdmissionBase {
  queue: Q;
  variant: "non-agent-terminal";
  outcomeType: T;
  outcomeVersion: V;
  outcome: O;
  idempotencyKey: string;
  state: "pending-side-effects" | "terminal";
  receipt?: NonAgentCompletionReceipt;
}

export interface StoredMailSourceDeadLetter {
  id: number;
  workId: string;
  at: string;
  error: string;
  payload: { kind: "mail"; id: number; raw: string; svixHeaders: Record<string, string>; at: string };
}
export interface StoredSmsPayload {
  id: number; from: string; content: string; media_url?: string; at: string;
  group_id?: string; group_name?: string; participants?: string[];
}
export interface StoredSmsSourceDeadLetter {
  outcomeId: string; id: number; at: string; from: string; error: string; payload: StoredSmsPayload;
}
export type StoredChatIntent =
  | { id: number; kind: "create-chat"; at: string }
  | { id: number; kind: "delete-chat"; chatId: string; at: string }
  | { id: number; kind: "send-message"; chatId: string; text: string; authorId: string; authorName: string; at: string };
export interface StoredChatSourceDeadLetter {
  outcomeId: string; id: number; at: string; kind: StoredChatIntent["kind"]; error: string; intent: StoredChatIntent;
}

export type NonAgentTerminalRecord =
  | NonAgentBase<"mail", "mail-no-agent-dispatch", 1, { reason: "handled-without-agent-dispatch" }>
  | NonAgentBase<"mail", "mail-source-dead-letter", 2, StoredMailSourceDeadLetter>
  | NonAgentBase<"sms", "sms-stop", 1, { from: string; content: string }>
  | NonAgentBase<"sms", "sms-transcript-poison", 1, StoredSmsSourceDeadLetter>
  | NonAgentBase<"chat", "chat-create", 1, { kind: "create-chat" }>
  | NonAgentBase<"chat", "chat-delete", 1, { kind: "delete-chat"; chatId: string }>
  | NonAgentBase<"chat", "chat-transcript-poison", 1, StoredChatSourceDeadLetter>;
export type AdmissionRecord = AgentDispatchRecord | NonAgentTerminalRecord;
interface Disk { version: 1; records: AdmissionRecord[]; }

export function admissionWorkId(queue: QueueName, sequence: number, tenantId?: string): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid queue sequence");
  if (tenantId !== undefined && (!tenantId || tenantId.length > 128)) throw new Error("invalid tenant id");
  const identity = tenantId === undefined ? `${queue}:${sequence}` : `${tenantId}:${queue}:${sequence}`;
  return createHash("sha256").update(identity).digest("hex");
}

function canonical(value: unknown): string { return JSON.stringify(value); }
function immutableRecord(candidate: AdmissionRecord): unknown {
  return candidate.variant === "agent-dispatch"
    ? { tenantId: candidate.tenantId, queue: candidate.queue, sequence: candidate.sequence, workId: candidate.workId, admittedAt: candidate.admittedAt, variant: candidate.variant, input: candidate.input }
    : { tenantId: candidate.tenantId, queue: candidate.queue, sequence: candidate.sequence, workId: candidate.workId, admittedAt: candidate.admittedAt, variant: candidate.variant, outcomeType: candidate.outcomeType, outcomeVersion: candidate.outcomeVersion, outcome: candidate.outcome, idempotencyKey: candidate.idempotencyKey };
}
function durableWrite(path: string, value: Disk): void {
  // Admission makes a source sequence ACK-eligible, so the containing directory
  // must cross its full-ancestry durability barrier before envelope publication.
  ensureDurableDirectory(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  syncDirectory(dirname(path));
}

function isAgent(record: AdmissionRecord | undefined): record is AgentDispatchRecord {
  return record?.variant === "agent-dispatch";
}

function isTerminal(record: AdmissionRecord): boolean {
  return record.variant === "agent-dispatch"
    ? record.state === "succeeded" || record.state === "permanent-failure"
    : record.state === "terminal";
}

function cursorScopeKey(queue: QueueName, tenantId?: string): string {
  return JSON.stringify([queue, tenantId ?? null]);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function validProviderReceipt(value: unknown): value is AgentSucceededOutcome["providerReceipts"][number] {
  return hasExactKeys(value, ["idempotencyKey", "providerId"])
    && typeof value.idempotencyKey === "string" && value.idempotencyKey !== ""
    && typeof value.providerId === "string" && value.providerId !== "";
}

function validAgentSucceededOutcome(value: unknown, source: QueueName): value is AgentSucceededOutcome {
  return hasExactKeys(value, ["kind", "source", "completedAt", "providerReceipts"])
    && value.kind === "succeeded" && value.source === source
    && typeof value.completedAt === "string" && value.completedAt !== ""
    && Array.isArray(value.providerReceipts) && value.providerReceipts.every(validProviderReceipt);
}

function validAgentPermanentFailureOutcome(value: unknown, source: QueueName): value is AgentPermanentFailureOutcome {
  if (!hasExactKeys(value, ["kind", "source", "message", "sourceDlq"])
    || value.kind !== "permanent-failure" || value.source !== source
    || typeof value.message !== "string" || value.message === ""
    || !hasExactKeys(value.sourceDlq, ["surface", "recordedAt"])) return false;
  return value.sourceDlq.surface === source
    && typeof value.sourceDlq.recordedAt === "string" && value.sourceDlq.recordedAt !== "";
}

function exactStringMap(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === "string");
}

function validStoredSmsPayload(value: unknown, record: Record<string, unknown>): value is StoredSmsPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const allowed = ["id", "from", "content", "media_url", "at", "group_id", "group_name", "participants"];
  return Object.keys(payload).every(key => allowed.includes(key))
    && payload.id === record.sequence && payload.at === record.admittedAt
    && typeof payload.from === "string" && typeof payload.content === "string"
    && (payload.media_url === undefined || typeof payload.media_url === "string")
    && (payload.group_id === undefined || typeof payload.group_id === "string")
    && (payload.group_name === undefined || typeof payload.group_name === "string")
    && (payload.participants === undefined || (Array.isArray(payload.participants) && payload.participants.every(item => typeof item === "string")));
}

function validStoredChatIntent(value: unknown, record: Record<string, unknown>): value is StoredChatIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  if (intent.id !== record.sequence || intent.at !== record.admittedAt) return false;
  if (intent.kind === "create-chat") return hasExactKeys(intent, ["id", "kind", "at"]);
  if (intent.kind === "delete-chat") return hasExactKeys(intent, ["id", "kind", "chatId", "at"])
    && typeof intent.chatId === "string" && intent.chatId !== "";
  return intent.kind === "send-message" && hasExactKeys(intent, ["id", "kind", "chatId", "text", "authorId", "authorName", "at"])
    && typeof intent.chatId === "string" && intent.chatId !== ""
    && typeof intent.text === "string" && typeof intent.authorId === "string" && typeof intent.authorName === "string";
}

function validNonAgentOutcome(record: Record<string, unknown>): boolean {
  const outcome = record.outcome as Record<string, unknown> | undefined;
  const key = record.idempotencyKey;
  const workId = record.workId;
  switch (`${record.queue}:${record.outcomeType}@${record.outcomeVersion}`) {
    case "mail:mail-no-agent-dispatch@1":
      return hasExactKeys(outcome, ["reason"]) && outcome.reason === "handled-without-agent-dispatch"
        && key === `mail-terminal:${workId}`;
    case "mail:mail-source-dead-letter@2": {
      if (!hasExactKeys(outcome, ["id", "workId", "at", "error", "payload"]) || outcome.id !== record.sequence
        || outcome.workId !== workId || outcome.at !== record.admittedAt || typeof outcome.error !== "string" || outcome.error === ""
        || !hasExactKeys(outcome.payload, ["kind", "id", "raw", "svixHeaders", "at"])) return false;
      const payload = outcome.payload;
      return payload.kind === "mail" && payload.id === record.sequence && payload.at === record.admittedAt
        && typeof payload.raw === "string" && exactStringMap(payload.svixHeaders)
        && key === `mail-source-dlq:${workId}`;
    }
    case "sms:sms-stop@1":
      return hasExactKeys(outcome, ["from", "content"]) && typeof outcome.from === "string" && outcome.from !== ""
        && typeof outcome.content === "string" && key === `sms-stop:${workId}`;
    case "sms:sms-transcript-poison@1":
      return hasExactKeys(outcome, ["outcomeId", "id", "at", "from", "error", "payload"])
        && outcome.outcomeId === workId && outcome.id === record.sequence && outcome.at === record.admittedAt
        && typeof outcome.from === "string" && outcome.from !== "" && typeof outcome.error === "string" && outcome.error !== ""
        && validStoredSmsPayload(outcome.payload, record) && outcome.from === outcome.payload.from
        && key === `sms-transcript-poison:${workId}`;
    case "chat:chat-create@1":
      return hasExactKeys(outcome, ["kind"]) && outcome.kind === "create-chat" && key === `chat-create:${workId}`;
    case "chat:chat-delete@1":
      return hasExactKeys(outcome, ["kind", "chatId"]) && outcome.kind === "delete-chat"
        && typeof outcome.chatId === "string" && outcome.chatId !== "" && key === `chat-delete:${workId}`;
    case "chat:chat-transcript-poison@1":
      return hasExactKeys(outcome, ["outcomeId", "id", "at", "kind", "error", "intent"])
        && outcome.outcomeId === workId && outcome.id === record.sequence && outcome.at === record.admittedAt
        && typeof outcome.error === "string" && outcome.error !== "" && validStoredChatIntent(outcome.intent, record)
        && outcome.kind === outcome.intent.kind && key === `chat-transcript-poison:${workId}`;
    default:
      return false;
  }
}

function validNonAgentEvidence(value: unknown, record: Record<string, unknown>, completedAt: string): value is NonAgentDurableEvidence {
  const outcome = record.outcome as Record<string, unknown>;
  switch (`${record.queue}:${record.outcomeType}@${record.outcomeVersion}`) {
    case "mail:mail-no-agent-dispatch@1":
      return hasExactKeys(value, ["kind", "surface", "detail"]) && value.kind === "source-applied"
        && value.surface === "mail" && value.detail === "handled-without-agent-dispatch";
    case "mail:mail-source-dead-letter@2":
    case "sms:sms-transcript-poison@1":
    case "chat:chat-transcript-poison@1":
      return hasExactKeys(value, ["kind", "surface", "recordedAt"]) && value.kind === "source-dead-letter"
        && value.surface === record.queue && value.recordedAt === completedAt;
    case "sms:sms-stop@1":
      return hasExactKeys(value, ["kind", "phone"]) && value.kind === "sms-opt-out" && value.phone === outcome.from;
    case "chat:chat-create@1":
      return hasExactKeys(value, ["kind", "surface", "detail"]) && value.kind === "source-applied"
        && value.surface === "chat" && value.detail === "create-chat";
    case "chat:chat-delete@1":
      return hasExactKeys(value, ["kind", "surface", "detail"]) && value.kind === "source-applied"
        && value.surface === "chat" && value.detail === "delete-chat";
    default:
      return false;
  }
}

function validNonAgentReceipt(value: unknown, record: Record<string, unknown>): value is NonAgentCompletionReceipt {
  if (!hasExactKeys(value, ["version", "kind", "outcomeType", "outcomeVersion", "completedAt", "evidence"])) return false;
  return value.version === 1 && value.kind === "non-agent-side-effects-complete"
    && value.outcomeType === record.outcomeType && value.outcomeVersion === record.outcomeVersion
    && typeof value.completedAt === "string" && value.completedAt !== ""
    && validNonAgentEvidence(value.evidence, record, value.completedAt);
}

function validRecord(value: unknown): value is AdmissionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ((record.queue !== "mail" && record.queue !== "sms" && record.queue !== "chat")
    || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0
    || (record.tenantId !== undefined && (typeof record.tenantId !== "string" || record.tenantId === "" || record.tenantId.length > 128))
    || typeof record.workId !== "string" || record.workId !== admissionWorkId(record.queue, record.sequence as number, record.tenantId as string | undefined)
    || typeof record.admittedAt !== "string") return false;
  if (record.variant === "non-agent-terminal") {
    const allowed = new Set(["tenantId", "queue", "sequence", "workId", "admittedAt", "variant", "outcomeType", "outcomeVersion", "outcome", "idempotencyKey", "state", "receipt"]);
    const validState = record.state === "pending-side-effects"
      ? record.receipt === undefined
      : record.state === "terminal" && validNonAgentReceipt(record.receipt, record);
    return Object.keys(record).every((key) => allowed.has(key)) && Object.hasOwn(record, "outcome")
      && typeof record.outcomeType === "string" && record.outcomeType !== ""
      && Number.isSafeInteger(record.outcomeVersion) && (record.outcomeVersion as number) > 0
      && typeof record.idempotencyKey === "string" && record.idempotencyKey !== ""
      && validNonAgentOutcome(record) && validState;
  }
  const allowed = new Set(["tenantId", "queue", "sequence", "workId", "admittedAt", "variant", "input", "state", "attempts", "nextAttemptAt", "lastRetry", "receipt", "outcome"]);
  if (record.variant !== "agent-dispatch" || !Object.keys(record).every((key) => allowed.has(key)) || !Object.hasOwn(record, "input")
    || !["pending", "retry-wait", "running", "succeeded", "permanent-failure"].includes(String(record.state))
    || !Number.isSafeInteger(record.attempts) || (record.attempts as number) < 0
    || typeof record.nextAttemptAt !== "number" || !Number.isFinite(record.nextAttemptAt)) return false;
  const lastRetry = record.lastRetry as Record<string, unknown> | undefined;
  if (lastRetry !== undefined && (lastRetry.kind !== "retry" || lastRetry.source !== record.queue
    || !["transient-error", "rate-limit", "agent-failed", "out-of-tokens", "interrupted", "dlq-write-failed"].includes(String(lastRetry.reason)))) return false;
  if (record.state === "succeeded") return validAgentSucceededOutcome(record.outcome, record.queue);
  if (record.state === "permanent-failure") return validAgentPermanentFailureOutcome(record.outcome, record.queue);
  return record.outcome === undefined;
}

export class QueueAdmissionOutbox {
  private disk: Disk;
  private readonly path: string;
  private lifecycle?: LightLifecycle;
  private lifecycleReleases = new Map<string, () => void>();
  private readonly durableCursors = new Map<string, number>();

  constructor(path: string) {
    this.path = path;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Disk;
      const workIds = Array.isArray(parsed.records) ? parsed.records.map(record => record?.workId) : [];
      if (parsed.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(validRecord)
        || new Set(workIds).size !== workIds.length) throw new Error("invalid outbox");
      // A crash can expose a renamed outbox before its directory fsync reports
      // success. Every process re-establishes the loaded inode and ancestry
      // barriers before any record can become ACK-eligible in memory.
      ensureDurableDirectory(dirname(path));
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(dirname(path));
      this.disk = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.disk = { version: 1, records: [] };
    }
  }

  /** Hold one lifecycle admission for every durable nonterminal record. */
  bindLifecycle(lifecycle: LightLifecycle): void {
    if (this.lifecycle && this.lifecycle !== lifecycle) throw new Error("outbox lifecycle is already bound");
    this.lifecycle = lifecycle;
    this.syncLifecycleBlockers();
  }

  private syncLifecycleBlockers(): void {
    if (!this.lifecycle) return;
    const pending = new Set(this.pending().map(record => record.workId));
    for (const workId of pending) {
      if (this.lifecycleReleases.has(workId)) continue;
      const record = this.disk.records.find(candidate => candidate.workId === workId)!;
      const release = this.lifecycle.retain(`queue-outbox:${record.queue}:nonterminal`);
      this.lifecycleReleases.set(workId, release);
    }
    for (const [workId, release] of [...this.lifecycleReleases]) {
      if (pending.has(workId)) continue;
      release(); this.lifecycleReleases.delete(workId);
    }
  }

  records(): readonly AdmissionRecord[] { return this.disk.records; }
  agent(workId: string): AgentDispatchRecord | undefined {
    const record = this.disk.records.find((candidate) => candidate.workId === workId);
    return isAgent(record) ? record : undefined;
  }

  admit(record: AdmissionRecord): AdmissionRecord {
    if (!validRecord(record)) throw new Error("invalid admission record");
    if (record.workId !== admissionWorkId(record.queue, record.sequence, record.tenantId)) throw new Error("invalid deterministic work id");
    const existing = this.disk.records.find((candidate) => candidate.workId === record.workId);
    if (existing) {
      if (canonical(immutableRecord(existing)) !== canonical(immutableRecord(record))) throw new Error("admission record changed immutable content");
      return existing;
    }
    const next = { ...this.disk, records: [...this.disk.records, record] };
    durableWrite(this.path, next);
    this.disk = next;
    this.syncLifecycleBlockers();
    this.compactCoveredTerminals();
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
    const disk = { ...this.disk, records: this.disk.records.map((record, candidate) => candidate === index ? next : record) };
    durableWrite(this.path, disk);
    this.disk = disk;
    this.syncLifecycleBlockers();
    this.compactCoveredTerminals();
    return next;
  }

  pending(): AdmissionRecord[] {
    return this.disk.records.filter((record) => record.variant === "agent-dispatch"
      ? record.state !== "succeeded" && record.state !== "permanent-failure"
      : record.state === "pending-side-effects");
  }

  dueAgents(now = Date.now(), scope?: { queue: QueueName; tenantId?: string }): AgentDispatchRecord[] {
    return this.disk.records
      .filter((record): record is AgentDispatchRecord => record.variant === "agent-dispatch"
        && (!scope || (record.queue === scope.queue && record.tenantId === scope.tenantId))
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
  recoverInterrupted(now = Date.now(), scope?: { queue: QueueName; tenantId?: string }): AgentDispatchRecord[] {
    const recovered: AgentDispatchRecord[] = [];
    const records = this.disk.records.map((record) => {
      if (record.variant !== "agent-dispatch" || record.state !== "running"
        || (scope && (record.queue !== scope.queue || record.tenantId !== scope.tenantId))) return record;
      const next: AgentDispatchRecord = {
        ...record,
        state: "retry-wait",
        attempts: record.attempts + 1,
        nextAttemptAt: now,
        lastRetry: { kind: "retry", source: record.queue, reason: "interrupted" },
      };
      recovered.push(next);
      return next;
    });
    if (recovered.length) {
      const disk = { ...this.disk, records };
      durableWrite(this.path, disk);
      this.disk = disk;
      this.syncLifecycleBlockers();
    }
    return recovered;
  }

  beginAttempt(workId: string): AgentDispatchRecord {
    const current = this.agent(workId);
    if (!current) throw new Error("non-agent record cannot be dispatched");
    if (current.state !== "pending" && current.state !== "retry-wait") throw new Error(`agent record is not dispatchable (${current.state})`);
    return this.update(workId, { state: "running" }) as AgentDispatchRecord;
  }

  /** Complete a non-agent record only with source-typed durable side-effect evidence. */
  completeNonAgent(workId: string, evidence: NonAgentDurableEvidence, completedAt = new Date().toISOString()): NonAgentTerminalRecord {
    const current = this.disk.records.find(record => record.workId === workId);
    if (!current || current.variant !== "non-agent-terminal") throw new Error("agent record cannot complete non-agent side effects");
    if (current.state === "terminal") return current;
    const receipt: NonAgentCompletionReceipt = {
      version: 1,
      kind: "non-agent-side-effects-complete",
      outcomeType: current.outcomeType,
      outcomeVersion: current.outcomeVersion,
      completedAt,
      evidence,
    };
    if (!validNonAgentReceipt(receipt, current as unknown as Record<string, unknown>)) {
      throw new Error("invalid non-agent completion evidence");
    }
    return this.update(workId, { state: "terminal", receipt }) as NonAgentTerminalRecord;
  }

  /** Persist surface-owned resumable progress without changing envelope identity. */
  recordAgentReceipt(workId: string, receipt: unknown): AgentDispatchRecord {
    const current = this.agent(workId);
    if (!current) throw new Error("non-agent record cannot record a receipt");
    if (current.state === "succeeded" || current.state === "permanent-failure") throw new Error("terminal agent record cannot record a receipt");
    // Reject values that would silently change under the outbox's JSON round trip.
    if (receipt === undefined || JSON.stringify(receipt) === undefined) throw new Error("invalid agent receipt");
    return this.update(workId, { receipt }) as AgentDispatchRecord;
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
    if (!validAgentSucceededOutcome(outcome, current.queue)) throw new Error("invalid success outcome");
    if (current.state === "succeeded") return current;
    if (current.state !== "running") throw new Error(`agent record cannot succeed from ${current.state}`);
    return this.update(workId, { state: "succeeded", outcome }) as AgentDispatchRecord;
  }

  permanentFailure(workId: string, outcome: AgentPermanentFailureOutcome): AgentDispatchRecord {
    const current = this.agent(workId);
    if (!current) throw new Error("non-agent record cannot fail permanently");
    if (!validAgentPermanentFailureOutcome(outcome, current.queue)) throw new Error("invalid permanent failure outcome or source DLQ evidence");
    if (current.state === "permanent-failure") return current;
    if (current.state === "succeeded") throw new Error("successful agent record cannot fail permanently");
    return this.update(workId, { state: "permanent-failure", outcome }) as AgentDispatchRecord;
  }

  /**
   * Publish the cursor high-water that the surface has already made durable and
   * submitted for runner coverage. Terminal records at or below this exact
   * queue/tenant scope may then be removed; nonterminal or uncovered records are
   * always retained. The high-water is intentionally process-local: startup must
   * reload the durable cursor and submit coverage again before compaction resumes.
   */
  noteDurableCursor(queue: QueueName, highWater: number, tenantId?: string): number {
    if ((queue !== "mail" && queue !== "sms" && queue !== "chat")
      || !Number.isSafeInteger(highWater) || highWater < 0
      || (tenantId !== undefined && (!tenantId || tenantId.length > 128))) throw new Error("invalid durable queue cursor");
    const key = cursorScopeKey(queue, tenantId);
    this.durableCursors.set(key, Math.max(this.durableCursors.get(key) ?? -1, highWater));
    return this.compactCoveredTerminals();
  }

  private compactCoveredTerminals(): number {
    const records = this.disk.records.filter(record => {
      if (!isTerminal(record)) return true;
      const coveredThrough = this.durableCursors.get(cursorScopeKey(record.queue, record.tenantId));
      return coveredThrough === undefined || record.sequence > coveredThrough;
    });
    const removed = this.disk.records.length - records.length;
    if (removed === 0) return 0;
    const disk = { ...this.disk, records };
    durableWrite(this.path, disk);
    this.disk = disk;
    this.syncLifecycleBlockers();
    return removed;
  }
}

export function defaultAdmissionOutboxPath(stateDir: string): string { return join(stateDir, "queue-admission-outbox.json"); }
