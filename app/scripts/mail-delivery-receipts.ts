// Crash-safe reconciliation between one admitted mail work ID and Resend delivery.
// The exact provider payload and deterministic idempotency key are durable before
// the first send. A crash replay sends that stored operation before another model
// run, then converges provider acceptance, transcript append, and completion.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { MAIL_DELIVERY_RECEIPTS_DIR } from "./paths.ts";
import { appendMailTranscript, type MailTranscriptEntry } from "./mail-transcript.ts";

export interface MailDeliveryOperation {
  kind: "reply" | "send" | "send-calendar";
  address: string;
  transcript: MailTranscriptEntry;
  /** Exact JSON-safe object passed to Resend's emails.send. */
  providerPayload?: Record<string, unknown>;
}
export interface MailDeliveryReceipt {
  version: 1;
  workId: string;
  idempotencyKey: string;
  providerId?: string;
  state: "prepared" | "provider-accepted" | "completed";
  preparedAt?: string;
  acceptedAt?: string;
  completedAt?: string;
  operation: MailDeliveryOperation;
}

function baseDir(): string {
  return process.env.MAIL_DELIVERY_RECEIPTS_DIR_OVERRIDE || MAIL_DELIVERY_RECEIPTS_DIR;
}
function validWorkId(workId: string): boolean { return /^[a-f0-9]{64}$/.test(workId); }
function fileFor(workId: string): string {
  if (!validWorkId(workId)) throw new Error("invalid BAXTER_WORK_ID");
  return join(baseDir(), `${workId}.json`);
}

export function mailDeliveryWorkId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.BAXTER_WORK_ID;
  if (!value) return null;
  if (!validWorkId(value)) throw new Error("invalid BAXTER_WORK_ID");
  return value;
}

export function mailDeliveryIdempotencyKey(workId: string): string {
  // A fixed key per tenant-scoped admitted work means a crash/re-run cannot deliver
  // a second, differently-worded model reply. Resend permits keys up to 256 characters.
  return `baxter-mail-${workId}`;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureReceiptDirectory(): void {
  const target = resolve(baseDir());
  const firstCreated = mkdirSync(target, { recursive: true });
  if (firstCreated === undefined) return;
  const first = resolve(firstCreated);
  const remainder = relative(first, target);
  if (remainder.startsWith(`..${sep}`) || remainder === "..") throw new Error("invalid receipt directory creation result");
  const created = [first];
  let cursor = first;
  for (const part of remainder.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    created.push(cursor);
  }
  for (const directory of created) fsyncDirectory(dirname(directory));
}

async function withReceiptLock<T>(workId: string, fn: () => T): Promise<T> {
  ensureReceiptDirectory();
  const release = await lockfile.lock(fileFor(workId), {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try { return fn(); }
  finally { await release(); }
}

function durableWrite(path: string, value: MailDeliveryReceipt): void {
  ensureReceiptDirectory();
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

export function readMailDeliveryReceipt(workId: string): MailDeliveryReceipt | null {
  try {
    const receipt = JSON.parse(readFileSync(fileFor(workId), "utf8")) as MailDeliveryReceipt;
    const operation = receipt.operation;
    const validOperation = !!operation && typeof operation === "object"
      && (operation.kind === "reply" || operation.kind === "send" || operation.kind === "send-calendar")
      && typeof operation.address === "string" && !!operation.transcript && typeof operation.transcript === "object";
    const validPrepared = receipt.state !== "prepared"
      || (typeof receipt.preparedAt === "string" && !!operation.providerPayload && typeof operation.providerPayload === "object" && !Array.isArray(operation.providerPayload));
    const validAccepted = receipt.state === "prepared"
      || (typeof receipt.providerId === "string" && receipt.providerId !== "" && typeof receipt.acceptedAt === "string");
    if (receipt.version !== 1 || receipt.workId !== workId || receipt.idempotencyKey !== mailDeliveryIdempotencyKey(workId)
      || (receipt.state !== "prepared" && receipt.state !== "provider-accepted" && receipt.state !== "completed")
      || !validOperation || !validPrepared || !validAccepted) {
      throw new Error("invalid mail delivery receipt");
    }
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameOperation(left: MailDeliveryOperation, right: MailDeliveryOperation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function recordMailDeliveryPreparation(
  workId: string,
  operation: MailDeliveryOperation,
  preparedAt = new Date().toISOString(),
): Promise<MailDeliveryReceipt> {
  if (!operation.providerPayload || typeof operation.providerPayload !== "object" || Array.isArray(operation.providerPayload)) {
    throw new Error("mail provider payload is missing");
  }
  return withReceiptLock(workId, () => {
    const existing = readMailDeliveryReceipt(workId);
    if (existing) {
      if (!sameOperation(existing.operation, operation)) throw new Error("mail delivery operation changed after preparation");
      return existing;
    }
    const receipt: MailDeliveryReceipt = {
      version: 1,
      workId,
      idempotencyKey: mailDeliveryIdempotencyKey(workId),
      state: "prepared",
      preparedAt,
      operation,
    };
    durableWrite(fileFor(workId), receipt);
    // The caller sends this re-read representation, so the first attempt and any
    // crash replay use exactly the JSON-safe payload proven durable on disk.
    return readMailDeliveryReceipt(workId)!;
  });
}

export async function recordMailProviderAcceptance(
  workId: string,
  providerId: string,
  operation: MailDeliveryOperation,
  acceptedAt = new Date().toISOString(),
): Promise<MailDeliveryReceipt> {
  if (!providerId) throw new Error("mail provider response is missing an id");
  return withReceiptLock(workId, () => {
    const existing = readMailDeliveryReceipt(workId);
    if (!existing) {
      // Backward-compatible construction for an already-accepted legacy caller.
      const accepted: MailDeliveryReceipt = {
        version: 1, workId, idempotencyKey: mailDeliveryIdempotencyKey(workId), providerId,
        state: "provider-accepted", acceptedAt, operation,
      };
      durableWrite(fileFor(workId), accepted);
      return accepted;
    }
    if (existing.state !== "prepared") {
      if (!sameOperation(existing.operation, operation)) throw new Error("mail delivery operation changed after provider acceptance");
      return existing;
    }
    if (!sameOperation(existing.operation, operation)) throw new Error("mail delivery operation changed after preparation");
    const accepted: MailDeliveryReceipt = { ...existing, providerId, state: "provider-accepted", acceptedAt };
    durableWrite(fileFor(workId), accepted);
    return accepted;
  });
}

export async function completeMailDelivery(workId: string, completedAt = new Date().toISOString()): Promise<MailDeliveryReceipt> {
  return withReceiptLock(workId, () => {
    const receipt = readMailDeliveryReceipt(workId);
    if (!receipt || receipt.state === "prepared") throw new Error("provider acceptance receipt is missing");
    if (receipt.state === "completed") return receipt;
    const completed: MailDeliveryReceipt = { ...receipt, state: "completed", completedAt };
    durableWrite(fileFor(workId), completed);
    return completed;
  });
}

/** Finish a provider-accepted delivery without requiring another model/tool send. */
export async function reconcileMailDelivery(
  workId: string,
  append: (address: string, entry: MailTranscriptEntry) => Promise<void> = appendMailTranscript,
  sendPrepared?: (payload: Record<string, unknown>, idempotencyKey: string) => Promise<string>,
): Promise<MailDeliveryReceipt | null> {
  let receipt = readMailDeliveryReceipt(workId);
  if (!receipt) return null;
  if (receipt.state === "prepared") {
    if (!sendPrepared) throw new Error("prepared mail delivery requires provider replay");
    const providerId = await sendPrepared(receipt.operation.providerPayload!, receipt.idempotencyKey);
    receipt = await recordMailProviderAcceptance(workId, providerId, receipt.operation);
  }
  if (receipt.state === "provider-accepted") {
    // The stored operation is the provider-accepted output. The transcript append
    // deduplicates by work ID and fsyncs before completion becomes durable.
    await append(receipt.operation.address, receipt.operation.transcript);
    return completeMailDelivery(workId);
  }
  return receipt;
}

export function mailProviderReceiptsForWork(workId: string): Array<{ idempotencyKey: string; providerId: string }> {
  const receipt = readMailDeliveryReceipt(workId);
  if (receipt?.state === "prepared" || receipt?.state === "provider-accepted") {
    throw new Error("mail provider delivery is not locally reconciled");
  }
  return receipt ? [{ idempotencyKey: receipt.idempotencyKey, providerId: receipt.providerId! }] : [];
}

// Useful in tests/operator diagnostics without retaining the message body in an
// outbox terminal outcome.
export function mailDeliveryOperationDigest(operation: MailDeliveryOperation): string {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}
