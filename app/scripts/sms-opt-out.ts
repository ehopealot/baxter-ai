import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { admitPhone } from "./allowlist.ts";
import { normalizePhone } from "./normalize-phone.ts";
import { SMS_OPT_OUT_PATH } from "./paths.ts";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";

interface SmsOptOutState {
  version: 1;
  numbers: string[];
}

const EMPTY: SmsOptOutState = { version: 1, numbers: [] };

function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SMS_OPT_OUT_PATH_OVERRIDE || SMS_OPT_OUT_PATH;
}

function loadStateAt(path: string): SmsOptOutState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw new Error("sms opt-out state unreadable", { cause: err });
  }
  try {
    const value = JSON.parse(raw) as Partial<SmsOptOutState>;
    if (value.version !== 1 || !Array.isArray(value.numbers)
      || !value.numbers.every(n => typeof n === "string" && admitPhone(n) === n)
      || new Set(value.numbers).size !== value.numbers.length) throw new Error("invalid shape");
    return { version: 1, numbers: [...value.numbers].sort() };
  } catch (err) {
    throw new Error("sms opt-out state invalid", { cause: err });
  }
}

function saveStateAt(path: string, state: SmsOptOutState): void {
  const directory = dirname(path);
  ensureDurableDirectory(directory);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
  syncDirectory(directory);
}

// proper-lockfile needs an existing target. Create the valid empty document with wx so
// sms-bot and any sms-cli process racing on first use converge on one lock target.
function ensureStateFile(path: string): void {
  const directory = dirname(path);
  ensureDurableDirectory(directory);
  try {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(EMPTY)); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory(directory);
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
}

async function withStateLock<T>(env: NodeJS.ProcessEnv, fn: (path: string) => Promise<T> | T): Promise<T> {
  const path = statePath(env);
  ensureStateFile(path);
  const release = await lockfile.lock(path, {
    realpath: false, stale: 10_000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try { return await fn(path); }
  finally { await release(); }
}

function canonicalPhone(phone: string, action: string): string {
  const norm = normalizePhone(phone);
  if (!norm || admitPhone(norm) !== norm) throw new Error(`sms opt-out ${action} refused: ${phone} is not a valid phone number`);
  return norm;
}

export function isStopMessage(content: string): boolean {
  return content.trim().toUpperCase() === "STOP";
}

// Read-only diagnostics may inspect the atomically replaced state without taking the lock.
// Provider sends use withSmsOptOutGate below; that is the linearization boundary.
export function isSmsOptedOut(phone: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = canonicalPhone(phone, "check");
  return loadStateAt(statePath(env)).numbers.includes(norm);
}

export async function setSmsOptOut(phone: string, optedOut: boolean, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const norm = canonicalPhone(phone, "update");
  await withStateLock(env, path => {
    const state = loadStateAt(path);
    const numbers = new Set(state.numbers);
    if (optedOut) numbers.add(norm); else numbers.delete(norm);
    // Re-publish even when the logical value already matches. A prior rename may
    // be visible after its parent fsync failed; replay must execute a fresh inode
    // and directory barrier before the queue sequence becomes ACK-eligible.
    saveStateAt(path, { version: 1, numbers: [...numbers].sort() });
  });
}

// Hold the shared state lock from the final suppression check through ONE provider
// request. Thus that request linearizes before STOP (and may finish), or STOP persists
// first and this throws without starting it. Call separately for each retry so STOP can
// acquire the lock during backoff and preempt the next attempt.
export async function withSmsOptOutGate<T>(
  phone: string,
  operation: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const norm = canonicalPhone(phone, "check");
  return withStateLock(env, async path => {
    if (loadStateAt(path).numbers.includes(norm)) throw new Error(`sms send refused: ${norm} stopped messages`);
    return operation();
  });
}
