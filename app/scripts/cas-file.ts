// Shared compare-and-swap file primitive, extracted from collections-cli so
// collections-cli and memory-cli share ONE tested implementation of the subtle
// concurrency core instead of two copies. A `version:` token (8 hex of sha256 over
// the RAW bytes) is vended on read/write; a whole-file write (`casSave`) or delete
// (`casDelete`) must present the current token, so a mutation built on a stale read is
// rejected instead of silently clobbering a concurrent mutation. `casAppend` is the
// additive path (no token): a lock serializes it, and re-reading inside the lock makes
// concurrent appends lossless. Whole-file writes are atomic (pid-named temp sibling +
// rename), and deletes unlink only after the same locked version comparison. The lock is
// proper-lockfile (shared with schedule-store), so contention across processes/surfaces
// serializes rather than racing.
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

// The same lock parameters collections-cli has always used. realpath:false so a
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
    // Verb-neutral: this helper is shared (collections-cli vends via open/make/save,
    // memory-cli via read/write), so don't name one CLI's verbs here.
    throw new Error(`--expect must be an 8-character hex version (got ${JSON.stringify(String(expected))}) -- it's the \`version:\` vended when you last read or wrote the file`);
  }
  return supplied;
}

export interface CasResult { path: string; bytes: number; version: string; }

// Current bytes, ENOENT -> empty, so a create-on-write flow (memory-cli) treats a
// not-yet-existing file as the empty-buffer version.
function readCurrentOrEmpty(path: string): Buffer {
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
// parameterize the reject message for the calling CLI. A caller that needs a
// stricter trust boundary (Collections) can replace the default raw reader with a
// bounded descriptor reader. It still runs INSIDE the lock, so the CAS token remains
// based on the current committed bytes.
export interface CasSaveOptions {
  readCurrent?: (path: string) => Buffer;
}

export async function casSave(
  path: string,
  body: Buffer,
  expected: string,
  staleLabel: string,
  reopenHint: string,
  options: CasSaveOptions = {},
): Promise<CasResult> {
  const release = await lockfile.lock(path, LOCK_OPTS);
  try {
    const currentBuf = (options.readCurrent ?? readCurrentOrEmpty)(path);
    if (expected !== versionToken(currentBuf)) {
      throw new Error(`${staleLabel} changed since you read it (your version ${expected} is stale) -- ${reopenHint}`);
    }
    atomicWrite(path, body);
    return { path, bytes: body.length, version: versionToken(body) };
  } finally {
    await release();
  }
}

// Compare-and-unlink. This is the destructive counterpart to casSave: lock, re-read the
// current bytes inside that lock, reject a stale token without leaking the fresh one, then
// remove exactly that path. Callers with a stricter source boundary (Collections) pass their
// bounded reader just as they do for casSave.
export async function casDelete(
  path: string,
  expected: string,
  staleLabel: string,
  reopenHint: string,
  options: CasSaveOptions = {},
): Promise<{ path: string; bytes: number }> {
  const release = await lockfile.lock(path, LOCK_OPTS);
  try {
    // Unlike casSave, delete has no create-on-missing mode: a missing target is an error,
    // never a version-matching empty file that proceeds to an unlink attempt.
    const currentBuf = options.readCurrent ? options.readCurrent(path) : readFileSync(path);
    if (expected !== versionToken(currentBuf)) {
      throw new Error(`${staleLabel} changed since you read it (your version ${expected} is stale) -- ${reopenHint}`);
    }
    unlinkSync(path);
    return { path, bytes: currentBuf.length };
  } finally {
    await release();
  }
}

// Lock-serialized atomic append (no CAS). Reads current INSIDE the lock, so two
// concurrent appends both survive (lossless -- this is why "add a fact" needs no
// token). Ensures exactly one newline between the existing tail and the appended
// body. `maxBytes`, if given, caps the MERGED size and is enforced inside the lock
// (the merged size isn't knowable before the lock, and a pre-lock check would race),
// so an over-cap append is rejected with nothing written.
export async function casAppend(path: string, body: Buffer, maxBytes?: number): Promise<CasResult> {
  const release = await lockfile.lock(path, LOCK_OPTS);
  try {
    const currentBuf = readCurrentOrEmpty(path);
    // An empty append is a no-op: don't touch the bytes/version (which would
    // spuriously reject a concurrent writer holding the previously-valid token) and
    // don't create a missing file just to leave it empty.
    if (body.length === 0) return { path, bytes: currentBuf.length, version: versionToken(currentBuf) };
    const needsNL = currentBuf.length > 0 && currentBuf[currentBuf.length - 1] !== 0x0a;
    const merged = needsNL ? Buffer.concat([currentBuf, Buffer.from("\n"), body]) : Buffer.concat([currentBuf, body]);
    if (maxBytes !== undefined && merged.length > maxBytes) {
      throw new Error(`append would exceed the ${Math.round(maxBytes / 1024)} KB cap -- read + prune it first, then write`);
    }
    atomicWrite(path, merged);
    return { path, bytes: merged.length, version: versionToken(merged) };
  } finally {
    await release();
  }
}
