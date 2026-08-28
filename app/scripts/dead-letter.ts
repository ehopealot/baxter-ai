// Durable source/agent failure log. Callers advance their durable outcome only
// after this returns, so each append (or idempotent replay) crosses file and
// directory barriers. Agent outcomes are keyed by workId; source outcomes use
// outcomeId. Legacy records without either identity retain append-only behavior.
import { openSync, writeSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEAD_LETTER_DIR } from "./paths.ts";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";

function baseDir(): string {
  return process.env.DEAD_LETTER_DIR_OVERRIDE || DEAD_LETTER_DIR;
}

function identity(record: Record<string, unknown>): string | null {
  if (typeof record.workId === "string" && record.workId !== "") return `work:${record.workId}`;
  if (typeof record.outcomeId === "string" && record.outcomeId !== "") return `outcome:${record.outcomeId}`;
  return null;
}

function hasIdentity(path: string, expected: string): boolean {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return raw.split("\n").some(line => {
    if (!line) return false;
    try { return identity(JSON.parse(line) as Record<string, unknown>) === expected; }
    catch { return false; }
  });
}

export function deadLetter(surface: string, record: Record<string, unknown>): void {
  const dir = baseDir();
  ensureDurableDirectory(dir);
  const filePath = join(dir, `${surface}.jsonl`);
  const id = identity(record);

  if (id && hasIdentity(filePath, id)) {
    // The previous attempt may have exposed the row before its final barrier
    // completed. Reconciliation is idempotent but never visibility-only.
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
}
