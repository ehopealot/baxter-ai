// Durable, privacy-preserving suppression ledger for the natural morning handoff.
// This module deliberately knows nothing about calendars, prompts, or providers.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { MORNING_HANDOFF_PATH } from "./paths.ts";
import type { ResolvedContact } from "./recipients.ts";

const MAX_BYTES = 64 * 1024;
const MAX_OCCURRENCES = 8;
const MAX_TOKENS = 256;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const ISO = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export type HandoffDecision = "direct-consumed" | "shared-closed" | "already-consumed" | "automatic-consumed" | "state-unavailable";
export type HandoffInspection = { state: "open"; consumed: readonly string[] } | { state: "closed" | "state-unavailable" };
interface Occurrence { closed: boolean; consumed: string[]; updated_at: string; }
interface Ledger { version: 1; occurrences: Record<string, Occurrence>; }
// Public callback contract shared by the chat dispatcher and injected integrations.
// `sharedClose` returns only shared-close outcomes, but legacy implementations may
// report any handoff decision and the dispatcher must continue accepting them.
export type SharedResult = { decision: HandoffDecision; contextEligible: boolean };

type LockRelease = () => Promise<void>;
type StoreFs = {
  mkdirSync: typeof mkdirSync; lstatSync: typeof lstatSync; openSync: typeof openSync;
  fstatSync: typeof fstatSync; readSync: typeof readSync; closeSync: typeof closeSync;
  writeSync: typeof writeSync; renameSync: typeof renameSync; unlinkSync: typeof unlinkSync;
  linkSync: typeof linkSync;
  lock: (path: string) => Promise<LockRelease>;
  temporaryPath?: (path: string) => string;
};
const nativeFs: StoreFs = {
  mkdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, writeSync, renameSync, unlinkSync, linkSync,
  lock: path => lockfile.lock(path, { realpath: false, stale: 10_000, retries: { retries: 30, minTimeout: 30, maxTimeout: 300 } }),
};
let storeFs: StoreFs = nativeFs;
/** Test-only fault seam; production always uses the native descriptor and lock operations. */
export function setMorningHandoffStoreTestSeam(overrides: Partial<StoreFs>): () => void {
  const previous = storeFs;
  storeFs = { ...nativeFs, ...overrides };
  return () => { storeFs = previous; };
}

/** Resolve test isolation at call time; MORNING_HANDOFF_PATH is production-only. */
export function morningHandoffPath(): string {
  const override = process.env.SCHEDULE_DIR_OVERRIDE;
  return override ? join(override, "morning-handoff.json") : MORNING_HANDOFF_PATH;
}

/** Hash only admitted, canonical addresses supplied by the caller. */
export function addressToken(canonicalAddress: string): string {
  return createHash("sha256").update("baxter-morning-handoff:v1\0" + canonicalAddress).digest("hex");
}
export function contactTokens(contact: Pick<ResolvedContact, "phones" | "emails">): string[] {
  return [...new Set([...contact.emails, ...contact.phones].map(addressToken))].sort();
}

function empty(): Ledger { return { version: 1, occurrences: {} }; }
function canonicalNow(now: Date): string | null {
  try { const value = now.toISOString(); return ISO(value) ? value : null; } catch { return null; }
}
function validOccurrence(value: unknown): value is Occurrence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const occurrence = value as Record<string, unknown>;
  if (Object.keys(occurrence).length !== 3 || !("closed" in occurrence) || !("consumed" in occurrence) || !("updated_at" in occurrence)) return false;
  return typeof occurrence.closed === "boolean" && ISO(occurrence.updated_at) && Array.isArray(occurrence.consumed)
    && occurrence.consumed.length <= MAX_TOKENS
    && occurrence.consumed.every(token => typeof token === "string" && TOKEN_RE.test(token))
    && new Set(occurrence.consumed).size === occurrence.consumed.length
    && occurrence.consumed.every((token, index, all) => index === 0 || all[index - 1]! < token);
}
function decode(text: string): Ledger | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const ledger = parsed as Record<string, unknown>;
  if (Object.keys(ledger).length !== 2 || ledger.version !== 1 || !ledger.occurrences || typeof ledger.occurrences !== "object" || Array.isArray(ledger.occurrences)) return null;
  const entries = Object.entries(ledger.occurrences as Record<string, unknown>);
  if (entries.length > MAX_OCCURRENCES || !entries.every(([key, occurrence]) => ISO(key) && validOccurrence(occurrence))) return null;
  return parsed as Ledger;
}

/**
 * Read a regular file through one descriptor.  The lstat/fstat identity fence
 * prevents a pre-open path swap, while the second fstat catches replacement or
 * growth during the bounded read.  Nothing malformed is interpreted as open.
 */
function sameRegularFile(left: { isFile(): boolean; dev: number; ino: number }, right: { isFile(): boolean; dev: number; ino: number }): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function readLedger(path: string): Ledger | null | "absent" {
  let fd: number | undefined;
  try {
    let expected;
    try { expected = storeFs.lstatSync(path); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      return null;
    }
    if (!expected.isFile()) return null;
    fd = storeFs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = storeFs.fstatSync(fd);
    const openedPath = storeFs.lstatSync(path);
    if (!sameRegularFile(expected, before) || !sameRegularFile(before, openedPath) || before.size > MAX_BYTES) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    // Deliberately attempt one byte past the cap: a growing file never becomes
    // a valid prefix merely because its pre-read size was below the cap.
    while (total <= MAX_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, MAX_BYTES + 1 - total));
      const read = storeFs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_BYTES) return null;
      chunks.push(buffer.subarray(0, read));
    }
    const after = storeFs.fstatSync(fd);
    const finalPath = storeFs.lstatSync(path);
    if (!sameRegularFile(before, after) || !sameRegularFile(after, finalPath)
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.size !== finalPath.size || after.mtimeMs !== finalPath.mtimeMs || after.ctimeMs !== finalPath.ctimeMs) return null;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { return null; }
    return decode(text);
  } catch { return null; } finally { if (fd !== undefined) try { storeFs.closeSync(fd); } catch {} }
}

/** Atomic same-directory replacement; best-effort temp cleanup never changes an outcome. */
function temporaryPath(path: string): string {
  return storeFs.temporaryPath?.(path) ?? `${path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
}
/** Write an exclusively-created owner-only temporary, including partial-write cleanup. */
function writeTemporary(temporary: string, bytes: string): boolean {
  let fd: number | undefined;
  let ownsTemporary = false;
  try {
    fd = storeFs.openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    // Ownership begins at successful exclusive creation, before any write can fail.
    ownsTemporary = true;
    const data = Buffer.from(bytes);
    let offset = 0;
    while (offset < data.length) {
      const written = storeFs.writeSync(fd, data, offset, data.length - offset, null);
      if (written <= 0) throw new Error("temporary write made no progress");
      offset += written;
    }
    storeFs.closeSync(fd);
    fd = undefined;
    return true;
  } catch {
    if (fd !== undefined) try { storeFs.closeSync(fd); } catch {}
    if (ownsTemporary) try { storeFs.unlinkSync(temporary); } catch {}
    return false;
  }
}
/** Replacement only removes a temporary inode successfully created by this invocation. */
function writeLedger(path: string, ledger: Ledger): boolean {
  const bytes = JSON.stringify(ledger);
  if (Buffer.byteLength(bytes) > MAX_BYTES) return false;
  const temporary = temporaryPath(path);
  try {
    storeFs.mkdirSync(dirname(path), { recursive: true });
    if (!writeTemporary(temporary, bytes)) return false;
    try {
      storeFs.renameSync(temporary, path);
      return true;
    } catch {
      try { storeFs.unlinkSync(temporary); } catch {}
      return false;
    }
  } catch { return false; }
}
function serializedSize(ledger: Ledger): number {
  return Buffer.byteLength(JSON.stringify(ledger));
}
function prune(ledger: Ledger, current: string): boolean {
  // Never remove current state. Discard oldest non-current occurrences until
  // both bounds fit, preserving a valid current mutation under byte pressure.
  const others = () => Object.keys(ledger.occurrences)
    .filter(key => key !== current)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  while ((Object.keys(ledger.occurrences).length > MAX_OCCURRENCES || serializedSize(ledger) > MAX_BYTES) && others().length > 0) {
    delete ledger.occurrences[others()[0]!];
  }
  return serializedSize(ledger) <= MAX_BYTES;
}
function repairClosed(path: string, occurrence: string, updatedAt: string): boolean {
  return writeLedger(path, { version: 1, occurrences: { [occurrence]: { closed: true, consumed: [], updated_at: updatedAt } } });
}

function bootstrap(path: string): boolean {
  const temporary = temporaryPath(path);
  try {
    // link() is atomic no-replace publication: observers see no pathname until
    // the complete owner-only temporary inode has been written.
    if (!writeTemporary(temporary, JSON.stringify(empty()))) return false;
    try {
      storeFs.linkSync(temporary, path);
      storeFs.unlinkSync(temporary);
      return true;
    } catch (error: unknown) {
      try { storeFs.unlinkSync(temporary); } catch {}
      return (error as NodeJS.ErrnoException).code === "EEXIST";
    }
  } catch { return false; }
}

const CLOSED_ONLY_REPAIR = Symbol("closed-only-repair");
async function operation<T>(occurrence: string, now: Date, mutate: (ledger: Ledger, current: Occurrence, updatedAt: string) => T | typeof CLOSED_ONLY_REPAIR): Promise<T | "state-unavailable"> {
  const updatedAt = canonicalNow(now);
  if (!ISO(occurrence) || updatedAt === null) return "state-unavailable";
  const path = morningHandoffPath();
  try {
    storeFs.mkdirSync(dirname(path), { recursive: true });
    const release = await storeFs.lock(path);
    try {
      // The lock serializes even first use: absence is not inspected or
      // published until this operation owns the sidecar lock.
      let ledger = readLedger(path);
      if (ledger === "absent") {
        if (!bootstrap(path)) return "state-unavailable";
        ledger = readLedger(path);
      }
      if (ledger === null || ledger === "absent") { repairClosed(path, occurrence, updatedAt); return "state-unavailable"; }
      const current = ledger.occurrences[occurrence] ?? { closed: false, consumed: [], updated_at: updatedAt };
      ledger.occurrences[occurrence] = current;
      const decision = mutate(ledger, current, updatedAt);
      // Token overflow is not normal retention: unrelated entries must not survive.
      if (decision === CLOSED_ONLY_REPAIR) {
        repairClosed(path, occurrence, updatedAt);
        return "state-unavailable";
      }
      // A mutation writes the complete bounded canonical ledger. If current
      // alone cannot fit, closed-only repair is the only fail-closed outcome.
      if (!prune(ledger, occurrence) || !writeLedger(path, ledger)) {
        repairClosed(path, occurrence, updatedAt);
        return "state-unavailable";
      }
      return decision;
    } finally { await release(); }
  } catch { return "state-unavailable"; }
}

function rosterComplete(tokens: Set<string>, roster: readonly ResolvedContact[]): boolean {
  return roster.every(contact => contactTokens(contact).some(token => tokens.has(token)));
}

export async function inspectMorningHandoff(occurrence: string, now = new Date()): Promise<HandoffInspection> {
  const updatedAt = canonicalNow(now);
  if (!ISO(occurrence) || updatedAt === null) return { state: "state-unavailable" };
  const path = morningHandoffPath();
  try {
    storeFs.mkdirSync(dirname(path), { recursive: true });
    const release = await storeFs.lock(path);
    try {
      // Inspection shares the same locked bootstrap path as mutations.
      let ledger = readLedger(path);
      if (ledger === "absent") {
        if (!bootstrap(path)) return { state: "state-unavailable" };
        ledger = readLedger(path);
      }
      if (ledger === null || ledger === "absent") { repairClosed(path, occurrence, updatedAt); return { state: "state-unavailable" }; }
      const current = ledger.occurrences[occurrence];
      // A valid inspection is read-only; a missing occurrence is semantically open.
      return !current || !current.closed ? { state: "open", consumed: current ? [...current.consumed] : [] } : { state: "closed" };
    } finally { await release(); }
  } catch { return { state: "state-unavailable" }; }
}

async function consume(kind: "direct" | "automatic", occurrence: string, tokens: readonly string[], roster: readonly ResolvedContact[], now: Date): Promise<HandoffDecision> {
  if (tokens.length === 0) return "state-unavailable";
  const result = await operation(occurrence, now, (_ledger, current, updatedAt) => {
    if (current.closed || tokens.some(token => current.consumed.includes(token))) return "already-consumed" as HandoffDecision;
    const merged = [...new Set([...current.consumed, ...tokens])].sort();
    if (merged.length > MAX_TOKENS) return CLOSED_ONLY_REPAIR;
    current.consumed = merged;
    current.closed = rosterComplete(new Set(merged), roster);
    current.updated_at = updatedAt;
    return kind === "direct" ? "direct-consumed" : "automatic-consumed";
  });
  return result === "state-unavailable" ? "state-unavailable" : result;
}

export function directConsume(occurrence: string, contact: ResolvedContact | null, triggeringAddress: string | null, roster: readonly ResolvedContact[], now = new Date()): Promise<HandoffDecision> {
  const tokens = contact ? contactTokens(contact) : triggeringAddress ? [addressToken(triggeringAddress)] : [];
  return consume("direct", occurrence, tokens, roster, now);
}
export function automaticConsume(occurrence: string, contact: ResolvedContact, roster: readonly ResolvedContact[], now = new Date()): Promise<HandoffDecision> {
  return consume("automatic", occurrence, contactTokens(contact), roster, now);
}
export async function sharedClose(occurrence: string, contextEligible: boolean, now = new Date()): Promise<SharedResult> {
  const result = await operation<SharedResult>(occurrence, now, (_ledger, current, updatedAt) => {
    if (current.closed) return { decision: "already-consumed", contextEligible: false };
    const eligible = contextEligible && current.consumed.length === 0;
    current.closed = true;
    current.updated_at = updatedAt;
    return { decision: "shared-closed", contextEligible: eligible };
  });
  return result === "state-unavailable" ? { decision: "state-unavailable", contextEligible: false } : result;
}
