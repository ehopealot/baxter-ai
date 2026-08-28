import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";

let syncFile = fsyncSync;

/** Atomically publish JSON only after file and containing-directory barriers. */
export function writeDurableJson(path: string, value: unknown): void {
  const directory = dirname(path);
  ensureDurableDirectory(directory);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    syncFile(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

/** Narrow file-fsync fault seam used by cursor durability tests. */
export function setDurableJsonFsyncForTest(replacement: (fd: number) => void): () => void {
  const previous = syncFile;
  syncFile = replacement;
  return () => { syncFile = previous; };
}
