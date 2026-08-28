// Process-local durability barrier for directories that may be created recursively.
// A path is remembered only after every directory in its absolute ancestry has
// been fsynced. Until then, callers repeat the full barrier even when mkdir sees
// an already-existing path (including after another process created it).
import { closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

const completedBarriers = new Set<string>();

function realSyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

let syncDirectoryImpl = realSyncDirectory;

export function syncDirectory(path: string): void {
  syncDirectoryImpl(resolve(path));
}

export function ensureDurableDirectory(path: string): void {
  const target = resolve(path);
  if (completedBarriers.has(target)) return;
  mkdirSync(target, { recursive: true });

  const ancestry: string[] = [];
  for (let cursor = target; ; cursor = dirname(cursor)) {
    ancestry.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
  }
  ancestry.reverse();
  for (const directory of ancestry) syncDirectory(directory);
  completedBarriers.add(target);
}

/** Narrow fault/ordering seam; production callers always use the real fsync. */
export function setDurableDirectorySyncForTest(replacement: (path: string) => void): () => void {
  const previous = syncDirectoryImpl;
  syncDirectoryImpl = replacement;
  return () => { syncDirectoryImpl = previous; };
}
