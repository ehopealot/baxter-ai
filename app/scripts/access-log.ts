// File-access log for LRU tracking (see paths.ts ACCESS_LOG_PATH). Records when the agent
// reads/writes each workspace file, so `files-cli lru` can surface stale files for cleanup.
//
// Design: an append-only JSONL. The HOT PATH -- recordFileAccess, called from the structured
// harness's read_file/write_file/edit_file on every file op -- is a single lock-free append
// (O_APPEND small-line writes are atomic across concurrent runs), and it is BEST-EFFORT: a
// failure here must never break the file operation it instruments. The log is folded to a
// per-path summary on read, and compacted (one summary line per path, under a lock) when it
// grows past a cap. Two line shapes coexist and both fold: raw events {t,k,p} and, after a
// compaction, summaries {s:1,p,lastRead,lastWrite,reads,writes}.
//
// This is ADVISORY data (which files look stale), not a correctness-critical store -- so it
// tolerates junk lines, a missing file, and the rare lost append during a compaction rewrite.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { ACCESS_LOG_PATH } from "./paths.ts";

export type AccessKind = "r" | "w";
export interface AccessEvent { t: number; k: AccessKind; p: string; }
export interface AccessSummary { path: string; lastRead: number | null; lastWrite: number | null; reads: number; writes: number; }

// Record one file access, keyed by the path relative to `cwd` (== MEMORY_DIR at run time).
// No-op when `logPath` is unset (unit tests / disabled) so instrumentation stays opt-in.
// Skips paths outside cwd (`..`) and the ephemeral per-run `.claude/` staging dir. Never throws.
export function recordFileAccess(logPath: string | undefined, cwd: string, abs: string, kind: AccessKind, now: number = Date.now()): void {
  if (!logPath) return;
  try {
    const rel = relative(cwd, abs);
    if (!rel || rel === "." || rel.startsWith("..") || rel.split(sep)[0] === ".claude") return;
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ t: now, k: kind, p: rel } satisfies AccessEvent) + "\n");
  } catch { /* best-effort instrumentation -- never break the file op */ }
}

// Fold raw JSONL (events and/or compacted summaries) into a per-path summary. Tolerates blank
// and unparseable lines.
export function foldEvents(text: string): Map<string, AccessSummary> {
  const map = new Map<string, AccessSummary>();
  const get = (p: string): AccessSummary => {
    let s = map.get(p);
    if (!s) { s = { path: p, lastRead: null, lastWrite: null, reads: 0, writes: 0 }; map.set(p, s); }
    return s;
  };
  const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!rec || typeof rec.p !== "string") continue;
    if (rec.s === 1) {
      // compacted summary line
      const s = get(rec.p);
      s.lastRead = later(s.lastRead, typeof rec.lastRead === "number" ? rec.lastRead : null);
      s.lastWrite = later(s.lastWrite, typeof rec.lastWrite === "number" ? rec.lastWrite : null);
      if (typeof rec.reads === "number") s.reads += rec.reads;
      if (typeof rec.writes === "number") s.writes += rec.writes;
      continue;
    }
    if (typeof rec.t !== "number") continue;
    const s = get(rec.p);
    if (rec.k === "r") { s.reads++; s.lastRead = later(s.lastRead, rec.t); }
    else if (rec.k === "w") { s.writes++; s.lastWrite = later(s.lastWrite, rec.t); }
  }
  return map;
}

// Read + fold the log; a missing log is an empty summary (not an error).
export function readSummaries(logPath: string = ACCESS_LOG_PATH): Map<string, AccessSummary> {
  try { return foldEvents(readFileSync(logPath, "utf8")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw err; }
}

// Serialize a folded summary back to compacted JSONL (one {s:1,...} line per path).
export function serializeSummaries(map: Map<string, AccessSummary>): string {
  const lines: string[] = [];
  for (const s of map.values()) lines.push(JSON.stringify({ s: 1, p: s.path, lastRead: s.lastRead, lastWrite: s.lastWrite, reads: s.reads, writes: s.writes }));
  return lines.length ? lines.join("\n") + "\n" : "";
}

// Compact the log to one summary line per path when it exceeds `maxLines`. Synchronous and
// best-effort (never throws). Called from the query path (files-cli lru), NEVER the hot append.
// Not locked: an append landing between the read and the atomic rename may be lost, which for
// advisory LRU data is acceptable (a file's last-access is at worst slightly stale), and the
// rename itself is atomic so the log is never corrupt -- last writer wins. Returns whether it ran.
export function compactIfLarge(logPath: string = ACCESS_LOG_PATH, maxLines = 50000): boolean {
  let text: string;
  try {
    if (statSync(logPath).size === 0) return false;
    text = readFileSync(logPath, "utf8");
  } catch { return false; }
  if (text.split("\n").length <= maxLines) return false;
  try {
    const tmp = `${logPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeSummaries(foldEvents(text)));
    renameSync(tmp, logPath);
    return true;
  } catch { return false; }
}
