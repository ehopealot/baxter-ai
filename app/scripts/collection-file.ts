// Bounded descriptor reader shared by every Collection consumer. Collections can be
// written through native file grants as well as collections-cli, so no reader may trust
// the save-time cap alone. It refuses symlinks/identity races, checks the on-disk size
// before allocation, and reads at most one byte past the cap to catch growth races.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";

export const MAX_COLLECTION_BYTES = 1024 * 1024;

export interface CollectionReadOps {
  lstat(path: string): Stats;
  open(path: string): number;
  fstat(fd: number): Stats;
  read(fd: number, buffer: Buffer): number;
  close(fd: number): void;
}

export type BoundedCollectionReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "missing" | "nonregular" | "symlink" | "mismatch" | "oversized" | "unreadable" };

export const defaultCollectionReadOps: CollectionReadOps = {
  lstat: (path) => lstatSync(path),
  // O_NOFOLLOW closes the lstat→open symlink swap where the platform supports it;
  // the identity checks below remain the portable defense and cover rename races.
  open: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer) => readSync(fd, buffer, 0, buffer.length, null),
  close: (fd) => closeSync(fd),
};

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function readCollectionFileBounded(
  path: string,
  ops: CollectionReadOps = defaultCollectionReadOps,
): BoundedCollectionReadResult {
  let before: Stats;
  try {
    before = ops.lstat(path);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (before.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!before.isFile()) return { ok: false, reason: "nonregular" };
  if (before.size > MAX_COLLECTION_BYTES) return { ok: false, reason: "oversized" };

  let fd: number;
  try {
    fd = ops.open(path);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  let result: BoundedCollectionReadResult;
  try {
    const opened = ops.fstat(fd);
    if (!sameIdentity(before, opened)) {
      result = { ok: false, reason: "mismatch" };
    } else if (opened.size > MAX_COLLECTION_BYTES) {
      result = { ok: false, reason: "oversized" };
    } else {
      const chunks: Buffer[] = [];
      let total = 0;
      let overflow = false;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_COLLECTION_BYTES + 1 - total));
        const count = ops.read(fd, chunk);
        if (count === 0) break;
        total += count;
        if (total > MAX_COLLECTION_BYTES) {
          overflow = true;
          break;
        }
        chunks.push(chunk.subarray(0, count));
      }
      const after = ops.fstat(fd);
      if (overflow || after.size > MAX_COLLECTION_BYTES) {
        result = { ok: false, reason: "oversized" };
      } else if (!sameIdentity(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
        result = { ok: false, reason: "mismatch" };
      } else {
        result = { ok: true, bytes: Buffer.concat(chunks, total) };
      }
    }
  } catch {
    result = { ok: false, reason: "unreadable" };
  }

  try {
    ops.close(fd);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return result;
}
