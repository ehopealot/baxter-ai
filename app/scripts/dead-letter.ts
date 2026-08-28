// Durable source/agent failure log. Callers advance their durable outcome only
// after this returns, so each append (or idempotent replay) crosses file and
// directory barriers. Agent outcomes are keyed by workId; source outcomes use
// outcomeId. Legacy records without either identity retain append-only behavior.
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { DEAD_LETTER_DIR } from "./paths.ts";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";
import { repairPartialJsonlTail } from "./jsonl-tail.ts";

function baseDir(): string {
  return process.env.DEAD_LETTER_DIR_OVERRIDE || DEAD_LETTER_DIR;
}

function identity(record: Record<string, unknown>): string | null {
  if (typeof record.workId === "string" && record.workId !== "") return `work:${record.workId}`;
  if (typeof record.outcomeId === "string" && record.outcomeId !== "") return `outcome:${record.outcomeId}`;
  return null;
}

function hasIdentity(raw: string, expected: string): boolean {
  return raw.split("\n").some(line => {
    if (!line) return false;
    try { return identity(JSON.parse(line) as Record<string, unknown>) === expected; }
    catch { return false; }
  });
}

function ensureFile(path: string, dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function deadLetter(surface: string, record: Record<string, unknown>): void {
  const dir = baseDir();
  ensureDurableDirectory(dir);
  const filePath = join(dir, `${surface}.jsonl`);
  ensureFile(filePath, dir);
  // Deduplication, crash-tail repair, and append are one critical section. A
  // read-before-lock can race two dispatchers into duplicate terminal rows; an
  // append-before-repair can merge a partial old row with the new outcome.
  const release = (lockfile as unknown as { lockSync(path: string, options: { realpath: boolean; stale: number }): () => void })
    .lockSync(filePath, { realpath: false, stale: 10_000 });
  try {
    const raw = repairPartialJsonlTail(filePath);
    const id = identity(record);
    if (id && hasIdentity(raw, id)) {
      const fd = openSync(filePath, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(dir);
      return;
    }

    const line = JSON.stringify({ surface, deadLetteredAt: new Date().toISOString(), ...record }) + "\n";
    const fd = openSync(filePath, "a", 0o600);
    try {
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) throw new Error("dead-letter write made no progress");
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(dir);
  } finally { release(); }
}
