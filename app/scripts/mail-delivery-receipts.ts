// Crash-safe reconciliation between one admitted mail work ID and Resend delivery.
// The CLI sends the deterministic idempotency key first; if it crashes after
// provider acceptance but before local completion, the dispatcher reconciles the
// stored accepted operation before another model run (and a repeated CLI invocation
// follows the same path) rather than sending twice.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { MAIL_DELIVERY_RECEIPTS_DIR } from "./paths.ts";
import { appendMailTranscript, type MailTranscriptEntry } from "./mail-transcript.ts";

export interface MailDeliveryOperation {
  kind: "reply" | "send" | "send-calendar";
  address: string;
  transcript: MailTranscriptEntry;
}
export interface MailDeliveryReceipt {
  version: 1;
  workId: string;
  idempotencyKey: string;
  providerId: string;
  state: "provider-accepted" | "completed";
  acceptedAt: string;
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

function durableWrite(path: string, value: MailDeliveryReceipt): void {
  const createdFrom = mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  if (createdFrom !== undefined) {
    const parentFd = openSync(dirname(createdFrom), "r");
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  }
}

export function readMailDeliveryReceipt(workId: string): MailDeliveryReceipt | null {
  try {
    const receipt = JSON.parse(readFileSync(fileFor(workId), "utf8")) as MailDeliveryReceipt;
    if (receipt.version !== 1 || receipt.workId !== workId || receipt.idempotencyKey !== mailDeliveryIdempotencyKey(workId)
      || (receipt.state !== "provider-accepted" && receipt.state !== "completed") || typeof receipt.providerId !== "string" || receipt.providerId === "") {
      throw new Error("invalid mail delivery receipt");
    }
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function recordMailProviderAcceptance(
  workId: string,
  providerId: string,
  operation: MailDeliveryOperation,
  acceptedAt = new Date().toISOString(),
): MailDeliveryReceipt {
  if (!providerId) throw new Error("mail provider response is missing an id");
  const existing = readMailDeliveryReceipt(workId);
  if (existing) return existing;
  const receipt: MailDeliveryReceipt = {
    version: 1,
    workId,
    idempotencyKey: mailDeliveryIdempotencyKey(workId),
    providerId,
    state: "provider-accepted",
    acceptedAt,
    operation,
  };
  durableWrite(fileFor(workId), receipt);
  return receipt;
}

export function completeMailDelivery(workId: string, completedAt = new Date().toISOString()): MailDeliveryReceipt {
  const receipt = readMailDeliveryReceipt(workId);
  if (!receipt) throw new Error("provider acceptance receipt is missing");
  if (receipt.state === "completed") return receipt;
  const completed: MailDeliveryReceipt = { ...receipt, state: "completed", completedAt };
  durableWrite(fileFor(workId), completed);
  return completed;
}

/** Finish a provider-accepted delivery without requiring another model/tool send. */
export async function reconcileMailDelivery(
  workId: string,
  append: (address: string, entry: MailTranscriptEntry) => Promise<void> = appendMailTranscript,
): Promise<MailDeliveryReceipt | null> {
  const receipt = readMailDeliveryReceipt(workId);
  if (!receipt) return null;
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
  if (receipt?.state === "provider-accepted") {
    throw new Error("mail provider delivery is not locally reconciled");
  }
  return receipt ? [{ idempotencyKey: receipt.idempotencyKey, providerId: receipt.providerId }] : [];
}

// Useful in tests/operator diagnostics without retaining the message body in an
// outbox terminal outcome.
export function mailDeliveryOperationDigest(operation: MailDeliveryOperation): string {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}
