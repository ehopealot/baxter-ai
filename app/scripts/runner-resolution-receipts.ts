import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";
import { RUNNER_RESOLUTION_RECEIPTS_DIR } from "./paths.ts";

export type ReplySurface = "mail" | "sms" | "chat";
export interface NoReplyReceipt {
  version: 1;
  kind: "no-reply";
  surface: ReplySurface;
  workId: string;
  completedAt: string;
  reason?: string;
}

function baseDir(): string {
  return process.env.RUNNER_RESOLUTION_RECEIPTS_DIR_OVERRIDE || RUNNER_RESOLUTION_RECEIPTS_DIR;
}
function validWorkId(workId: string): boolean { return /^[a-f0-9]{64}$/.test(workId); }
function pathFor(surface: ReplySurface, workId: string): string {
  if (!validWorkId(workId)) throw new Error("invalid BAXTER_WORK_ID");
  return join(baseDir(), `${surface}-${workId}.json`);
}
function valid(value: unknown, surface: ReplySurface, workId: string): value is NoReplyReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const allowed = receipt.reason === undefined
    ? ["version", "kind", "surface", "workId", "completedAt"]
    : ["version", "kind", "surface", "workId", "completedAt", "reason"];
  return Object.keys(receipt).length === allowed.length && allowed.every(key => Object.hasOwn(receipt, key))
    && receipt.version === 1 && receipt.kind === "no-reply" && receipt.surface === surface && receipt.workId === workId
    && typeof receipt.completedAt === "string" && (receipt.reason === undefined || typeof receipt.reason === "string");
}
function readReceipt(surface: ReplySurface, workId: string): NoReplyReceipt | null {
  const path = pathFor(surface, workId);
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!valid(value, surface, workId)) throw new Error("invalid no-reply receipt");
    ensureDurableDirectory(baseDir());
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(baseDir());
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function ensureLockTarget(path: string): void {
  ensureDurableDirectory(baseDir());
  const target = `${path}.lock-target`;
  try {
    const fd = openSync(target, "wx", 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(baseDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const fd = openSync(target, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(baseDir());
  }
}
function durableWrite(path: string, receipt: NoReplyReceipt): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    syncDirectory(baseDir());
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

export async function recordNoReplyOutcome(surface: ReplySurface, workId: string, reason?: string): Promise<NoReplyReceipt> {
  const path = pathFor(surface, workId);
  ensureLockTarget(path);
  const release = await lockfile.lock(`${path}.lock-target`, { realpath: false, stale: 10_000, retries: { retries: 30, minTimeout: 30, maxTimeout: 300 } });
  try {
    const existing = readReceipt(surface, workId);
    if (existing) return existing;
    const receipt: NoReplyReceipt = {
      version: 1, kind: "no-reply", surface, workId, completedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
    durableWrite(path, receipt);
    return readReceipt(surface, workId)!;
  } finally { await release(); }
}

export function requireNoReplyOutcome(surface: ReplySurface, workId: string): NoReplyReceipt {
  const receipt = readReceipt(surface, workId);
  if (!receipt) throw new Error(`${surface} no-reply outcome is not durable`);
  return receipt;
}
