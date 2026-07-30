// Shared compare-and-swap file primitive, extracted from projects-cli so
// projects-cli and memory-cli share ONE tested implementation of the subtle
// concurrency core instead of two copies. A `version:` token (8 hex of sha256 over
// the RAW bytes) is vended on read/write; a whole-file write must present the
// current token (`casSave`), so a write built on a stale read is rejected instead
// of silently clobbering a concurrent write. `casAppend` is the additive path (no
// token): a lock serializes it, and re-reading inside the lock makes concurrent
// appends lossless. Both writes are atomic (pid-named temp sibling + rename). The
// lock is proper-lockfile (shared with schedule-store), so contention across
// processes/surfaces serializes rather than racing.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";

// 8 hex = 32 bits over the RAW Buffer (never a decoded-then-re-encoded string, so
// the token is identical on the read and write sides -- an odd byte can't cause a
// permanent spurious-reject livelock). The compare is always two versions of the
// SAME file (a 2-way collision, ~2^-32 per conflicting write), and the model carries
// 8 chars verbatim with ease.
export function versionToken(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 8);
}
export const VERSION_RE = /^[0-9a-f]{8}$/;

// The same lock parameters projects-cli has always used. realpath:false so a
// not-yet-created target (memory-cli's create-on-first-write) can still be locked
// (the lockfile is `<path>.lock` beside it; the parent dir must exist).
const LOCK_OPTS = { realpath: false as const, stale: 10000, retries: { retries: 30, minTimeout: 30, maxTimeout: 300 } };

// Validate a caller-supplied --expect token. Argument-only, so callers run this
// BEFORE taking any lock: a missing/garbage token shouldn't contend for the lock
// (masking the real usage error behind a "lock already held" after retries). `hint`
// completes the "missing token" usage error with the caller's read verb.
export function normalizeExpected(expected: unknown, hint: string): string {
  const supplied = String(expected ?? "").trim().toLowerCase();
  if (!supplied) throw new Error(`this write requires the current --expect <version>: ${hint}`);
  if (!VERSION_RE.test(supplied)) {
    throw new Error(`--expect must be an 8-character hex version (got ${JSON.stringify(String(expected))}) -- it's the \`version:\` printed on read/write`);
  }
  return supplied;
}

export interface CasResult { path: string; bytes: number; version: string; }

// Current bytes, ENOENT -> empty, so a create-on-write flow (memory-cli) treats a
// not-yet-existing file as the empty-buffer version.
function readCurrent(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw err;
  }
}

// Atomic replace: a pid-named temp sibling (so two processes writing different files
// can't collide on the temp) + rename (the atomic swap); unlink the temp on error.
function atomicWrite(path: string, body: Buffer): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created / already gone */ }
    throw err;
  }
}

// Whole-file compare-and-swap write. `expected` must already be format-valid (call
// normalizeExpected first). Locks path, re-reads current bytes INSIDE the lock (the
// token basis -- it must reflect any prior lock-holder's committed rename), rejects
// if the token moved (NEVER echoing the current token: handing back the valid token
// would let a stale body replay and pass the check -- a one-step bypass), else
// atomically writes `body` and vends the new token. `staleLabel`/`reopenHint`
// parameterize the reject message for the calling CLI.
export async function casSave(path: string, body: Buffer, expected: string, staleLabel: string, reopenHint: string): Promise<CasResult> {
  const release = await lockfile.lock(path, LOCK_OPTS);
  try {
    const currentBuf = readCurrent(path);
    if (expected !== versionToken(currentBuf)) {
      throw new Error(`${staleLabel} changed since you read it (your version ${expected} is stale) -- ${reopenHint}`);
    }
    atomicWrite(path, body);
    return { path, bytes: body.length, version: versionToken(body) };
  } finally {
    await release();
  }
}

// Lock-serialized atomic append (no CAS). Reads current INSIDE the lock, so two
// concurrent appends both survive (lossless -- this is why "add a fact" needs no
// token). Ensures exactly one newline between the existing tail and the appended
// body.
export async function casAppend(path: string, body: Buffer): Promise<CasResult> {
  const release = await lockfile.lock(path, LOCK_OPTS);
  try {
    const currentBuf = readCurrent(path);
    const needsNL = currentBuf.length > 0 && currentBuf[currentBuf.length - 1] !== 0x0a;
    const merged = needsNL ? Buffer.concat([currentBuf, Buffer.from("\n"), body]) : Buffer.concat([currentBuf, body]);
    atomicWrite(path, merged);
    return { path, bytes: merged.length, version: versionToken(merged) };
  } finally {
    await release();
  }
}
