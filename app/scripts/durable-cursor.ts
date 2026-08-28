import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";

const uncertainCeilings = new Map<string, number>();
let tempSequence = 0;

function parsedCursor(path: string): number {
  const candidate = JSON.parse(readFileSync(path, "utf8")).appliedThrough;
  return Number.isSafeInteger(candidate) && candidate >= -1 ? candidate : -1;
}

/**
 * Re-establish the visible cursor inode and directory barrier before trusting a
 * value loaded by a new process. A failed repair replays from the beginning.
 */
export function loadDurableCursor(path: string): number {
  let stored: number;
  try {
    stored = parsedCursor(path);
    if (stored >= 0) {
      ensureDurableDirectory(dirname(path));
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(dirname(path));
    }
  } catch {
    return -1;
  }
  const ceiling = uncertainCeilings.get(path);
  return ceiling === undefined ? stored : Math.min(stored, ceiling);
}

/** Atomic cursor replacement with a live-process replay floor on uncertainty. */
export function storeDurableCursor(path: string, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid cursor");
  const prior = loadDurableCursor(path);
  const next = Math.max(prior, n);
  const directory = dirname(path);
  let tmp: string | undefined;
  try {
    ensureDurableDirectory(directory);
    tmp = `${path}.${process.pid}.${++tempSequence}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ appliedThrough: next })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
    tmp = undefined;
    syncDirectory(directory);
    uncertainCeilings.delete(path);
  } catch (error) {
    // The rename can be visible even though its directory barrier failed. The
    // current process must replay; a restarted process repairs that barrier in
    // loadDurableCursor before trusting whichever inode survived.
    uncertainCeilings.set(path, prior);
    if (tmp) {
      try { unlinkSync(tmp); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
    throw error;
  }
}

/** Test-only process-restart seam. */
export function clearDurableCursorProcessStateForTest(path?: string): void {
  if (path === undefined) uncertainCeilings.clear(); else uncertainCeilings.delete(path);
}
