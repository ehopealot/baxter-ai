// Durable cross-surface drain control. Every mutation and read takes the same
// cross-process lock, so a drain cannot race a run's lease acquisition.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { DRAIN_STATE_PATH } from "./paths.ts";

export interface RunLease {
  id: string;
  surface: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

interface StoredRunLease extends Omit<RunLease, "id"> {}

interface DrainState {
  draining: boolean;
  leases: Record<string, StoredRunLease>;
}

export interface DrainStatus {
  draining: boolean;
  leases: Record<string, RunLease>;
}

export type LeaseAcquisition =
  | { accepted: true; lease: RunLease }
  | { accepted: false };

export interface ClearDrainOptions { force?: boolean }

const EMPTY_STATE: DrainState = { draining: false, leases: {} };

// Test-only redirection follows the other durable-state modules while preserving
// DRAIN_STATE_PATH as the production source of truth.
export function drainStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DRAIN_STATE_PATH_OVERRIDE || DRAIN_STATE_PATH;
}

function ensureFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(EMPTY_STATE), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

function isStoredLease(value: unknown): value is StoredRunLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Partial<StoredRunLease>;
  return typeof lease.surface === "string" && lease.surface.length > 0 &&
    Number.isInteger(lease.pid) && (lease.pid as number) > 0 &&
    typeof lease.hostname === "string" && lease.hostname.length > 0 &&
    typeof lease.startedAt === "string" && Number.isFinite(Date.parse(lease.startedAt));
}

function loadState(path: string): DrainState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`drain state is corrupt or unreadable: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("drain state is corrupt");
  const state = parsed as Partial<DrainState>;
  if (typeof state.draining !== "boolean" || !state.leases || typeof state.leases !== "object" || Array.isArray(state.leases)) {
    throw new Error("drain state is corrupt");
  }
  for (const [id, lease] of Object.entries(state.leases)) {
    if (!id || !isStoredLease(lease)) throw new Error("drain state is corrupt");
  }
  return { draining: state.draining, leases: state.leases as Record<string, StoredRunLease> };
}

function writeState(path: string, state: DrainState): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // No cleanup is necessary for correctness: only the target is authoritative,
    // and a unique temporary file can never be mistaken for state.
    throw err;
  }
}

function toStatus(state: DrainState): DrainStatus {
  const leases: Record<string, RunLease> = {};
  for (const [id, lease] of Object.entries(state.leases)) leases[id] = { id, ...lease };
  return { draining: state.draining, leases };
}

async function locked<T>(path: string, operation: () => T): Promise<T> {
  ensureFile(path);
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 10_000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    return operation();
  } finally {
    await release();
  }
}

export async function tryAcquireRunLease(
  { surface }: { surface: string },
  path: string = drainStatePath(),
): Promise<LeaseAcquisition> {
  if (typeof surface !== "string" || surface.trim() === "") throw new Error("surface must be a non-empty string");
  return locked(path, () => {
    let state: DrainState;
    try {
      state = loadState(path);
    } catch {
      // A damaged state could represent a drain or active work. Do not admit a
      // new run and, crucially, do not replace evidence of the damaged state.
      return { accepted: false };
    }
    if (state.draining) return { accepted: false };
    const id = randomUUID();
    const lease: StoredRunLease = { surface, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
    state.leases[id] = lease;
    writeState(path, state);
    return { accepted: true, lease: { id, ...lease } };
  });
}

export async function releaseRunLease(leaseId: string, path: string = drainStatePath()): Promise<void> {
  if (typeof leaseId !== "string" || leaseId === "") throw new Error("lease id must be a non-empty string");
  await locked(path, () => {
    const state = loadState(path);
    if (!(leaseId in state.leases)) return;
    delete state.leases[leaseId];
    writeState(path, state);
  });
}

export async function beginDrain(path: string = drainStatePath()): Promise<DrainStatus> {
  return locked(path, () => {
    const state = loadState(path);
    if (!state.draining) {
      state.draining = true;
      writeState(path, state);
    }
    return toStatus(state);
  });
}

export async function clearDrain(options: ClearDrainOptions = {}, path: string = drainStatePath()): Promise<DrainStatus> {
  return locked(path, () => {
    const state = loadState(path);
    if (Object.keys(state.leases).length > 0 && options.force !== true) throw new Error("cannot clear drain while active leases remain");
    if (state.draining) {
      state.draining = false;
      // Force overrides the refusal only. Leases remain durable records until
      // their owners release their exact ids, so status never hides live work.
      writeState(path, state);
    }
    return toStatus(state);
  });
}

export async function drainStatus(path: string = drainStatePath()): Promise<DrainStatus> {
  return locked(path, () => {
    try {
      return toStatus(loadState(path));
    } catch {
      // Status is safe to use as an admission gate too: an unknown durable state
      // is represented as draining, never as permission to start work.
      return { draining: true, leases: {} };
    }
  });
}
