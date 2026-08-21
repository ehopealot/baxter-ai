import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { isCanonicalSlug } from "./collections-cli.ts";
import { stripCollectionComments } from "./collection-renderer.ts";
import { COLLECTIONS_DIR, MEMORY_PATH } from "./paths.ts";

export const RAW_SOURCE_MAX_BYTES = 1024 * 1024;
export const MEMORY_VISIBLE_MAX_BYTES = 96 * 1024;
export const COLLECTION_VISIBLE_MAX_BYTES = 16 * 1024;
export const KNOWLEDGE_VISIBLE_MAX_BYTES = 128 * 1024;
export const MAX_KNOWLEDGE_COLLECTIONS = 40;
const OMITTED_MARKER = "\n[… omitted …]\n";

export interface BoundedReadOps {
  lstat(path: string): Stats;
  open(path: string): number;
  fstat(fd: number): Stats;
  read(fd: number, buffer: Buffer): number;
  close(fd: number): void;
  openDirectory?(path: string): number;
  readdir?(path: string): Dirent[];
}

const defaultReadOps: BoundedReadOps = {
  lstat: (path) => lstatSync(path),
  open: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer) => readSync(fd, buffer, 0, buffer.length, null),
  close: (fd) => closeSync(fd),
  openDirectory: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY),
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
};

type BoundedReadResult =
  | { ok: true; text: string; mtimeMs: number }
  | { ok: false; reason: "missing" | "symlink" | "nonregular" | "mismatch" | "oversized" | "raced" | "unreadable" };

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// Opened-descriptor bounded read: the pre-open identity is verified, the opened
// size is checked before allocation, cumulative bytes are capped while reading,
// and post-read metadata must remain stable. No partial bytes escape on failure.
export function readDurableSourceBounded(path: string, ops: BoundedReadOps = defaultReadOps): BoundedReadResult {
  let before: Stats;
  try {
    before = ops.lstat(path);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (before.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!before.isFile()) return { ok: false, reason: "nonregular" };

  let fd: number;
  try {
    fd = ops.open(path);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  let result: BoundedReadResult;
  try {
    const opened = ops.fstat(fd);
    if (!sameIdentity(before, opened)) result = { ok: false, reason: "mismatch" };
    else if (opened.size > RAW_SOURCE_MAX_BYTES) result = { ok: false, reason: "oversized" };
    else {
      const chunks: Buffer[] = [];
      let total = 0;
      let overflow = false;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, RAW_SOURCE_MAX_BYTES + 1 - total));
        const count = ops.read(fd, chunk);
        if (count === 0) break;
        total += count;
        if (total > RAW_SOURCE_MAX_BYTES) {
          overflow = true;
          break;
        }
        chunks.push(Buffer.from(chunk.subarray(0, count)));
      }
      const after = ops.fstat(fd);
      if (overflow) result = { ok: false, reason: "oversized" };
      else if (!sameIdentity(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
        result = { ok: false, reason: "raced" };
      } else {
        try {
          result = { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), mtimeMs: opened.mtimeMs };
        } catch {
          result = { ok: false, reason: "unreadable" };
        }
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

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function prefixWithin(text: string, maxBytes: number): string {
  let result = "";
  let used = 0;
  for (const codePoint of text) {
    const bytes = utf8Bytes(codePoint);
    if (used + bytes > maxBytes) break;
    result += codePoint;
    used += bytes;
  }
  return result;
}

function suffixWithin(text: string, maxBytes: number): string {
  const points = [...text];
  let result = "";
  let used = 0;
  for (let index = points.length - 1; index >= 0; index--) {
    const codePoint = points[index]!;
    const bytes = utf8Bytes(codePoint);
    if (used + bytes > maxBytes) break;
    result = codePoint + result;
    used += bytes;
  }
  return result;
}

function truncateVisible(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  const markerBytes = utf8Bytes(OMITTED_MARKER);
  if (maxBytes < markerBytes) return { text: "", truncated: true };
  const payload = maxBytes - markerBytes;
  const headBudget = Math.ceil(payload / 2);
  const tailBudget = payload - headBudget;
  return { text: prefixWithin(text, headBudget) + OMITTED_MARKER + suffixWithin(text, tailBudget), truncated: true };
}

// Payloads are one JSON string per source. Escaping '=' keeps both outer and
// source sentinel spellings from becoming structural lines while preserving the
// content for a model that reads the explicitly data-only JSON string.
function encodePromptPayload(text: string): string {
  return JSON.stringify(text).replace(/=/g, "\\u003d");
}

export interface DurableKnowledgeSnapshot {
  text: string;
  empty: boolean;
  includedCollections: number;
  omittedCollections: number;
  truncatedSources: number;
}

export interface DurableKnowledgeOptions {
  memoryPath?: string;
  collectionsDir?: string;
  log(message: string): void;
  readOps?: BoundedReadOps;
}

interface Candidate { slug: string; anchoredPath: string; mtimeMs: number; }

type CollectionsRootResult =
  | { ok: true; stat: Stats }
  | { ok: false; reason: "missing" | "symlink" | "non-directory" | "unreadable" };

function inspectCollectionsRoot(path: string, ops: BoundedReadOps): CollectionsRootResult {
  let stat: Stats;
  try {
    stat = ops.lstat(path);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!stat.isDirectory()) return { ok: false, reason: "non-directory" };
  return { ok: true, stat };
}

function collectionsRootMatches(expected: Stats, current: CollectionsRootResult): boolean {
  return current.ok && sameIdentity(expected, current.stat);
}

export function loadDurableKnowledge(options: DurableKnowledgeOptions): DurableKnowledgeSnapshot {
  const memoryPath = options.memoryPath ?? MEMORY_PATH;
  const collectionsDir = options.collectionsDir ?? COLLECTIONS_DIR;
  const ops = options.readOps ?? defaultReadOps;
  const sections: string[] = [];
  let visibleBytes = 0;
  let truncatedSources = 0;
  let includedCollections = 0;
  let omittedCollections = 0;
  const diagnostics = new Map<string, number>();
  const report = (source: "memory" | "collections-root" | "collection-entry", rawReason: string): void => {
    const reason = rawReason === "nonregular" || rawReason === "non-directory" ? "invalid-type" : rawReason;
    const key = `${source}:${reason}`;
    diagnostics.set(key, (diagnostics.get(key) ?? 0) + 1);
  };

  const memory = readDurableSourceBounded(memoryPath, ops);
  if (memory.ok) {
    const normalized = memory.text.trim();
    if (normalized) {
      const remaining = Math.min(MEMORY_VISIBLE_MAX_BYTES, KNOWLEDGE_VISIBLE_MAX_BYTES - visibleBytes);
      const bounded = truncateVisible(normalized, remaining);
      if (bounded.text) {
        if (bounded.truncated) truncatedSources++;
        sections.push(`=== MEMORY DATA BEGIN ===\n${encodePromptPayload(bounded.text)}\n=== MEMORY DATA END ===`);
        visibleBytes += utf8Bytes(bounded.text);
      }
    }
  } else {
    report("memory", memory.reason);
  }

  const collectionSectionStart = sections.length;
  const collectionVisibleStart = visibleBytes;
  const collectionTruncatedStart = truncatedSources;
  let candidates: Candidate[] = [];
  let collectionsRootFd: number | null = null;
  let stableCollectionsRoot: Stats | null = null;
  let discardCollections = false;
  try {
    const collectionsRoot = inspectCollectionsRoot(collectionsDir, ops);
    if (!collectionsRoot.ok) {
      report("collections-root", collectionsRoot.reason);
    } else if (ops.openDirectory === undefined || ops.readdir === undefined) {
      report("collections-root", "unreadable");
    } else {
      try {
        collectionsRootFd = ops.openDirectory(collectionsDir);
        const openedRoot = ops.fstat(collectionsRootFd);
        if (!openedRoot.isDirectory() || !sameIdentity(collectionsRoot.stat, openedRoot)) {
          discardCollections = true;
          report("collections-root", "raced");
        } else {
          stableCollectionsRoot = openedRoot;
          // Linux exposes an already-open directory beneath this descriptor path.
          // Every child lookup stays relative to the held directory description;
          // failure to enumerate this anchor is fatal and never falls back to the
          // mutable Collections pathname.
          const anchoredRoot = `/proc/self/fd/${collectionsRootFd}`;
          for (const entry of ops.readdir(anchoredRoot)) {
            if (!entry.name.endsWith(".md")) continue;
            const slug = entry.name.slice(0, -3);
            if (!isCanonicalSlug(slug)) continue;
            const anchoredPath = join(anchoredRoot, entry.name);
            try {
              const stat = ops.lstat(anchoredPath);
              if (stat.isSymbolicLink()) {
                report("collection-entry", "symlink");
                continue;
              }
              if (!stat.isFile()) continue;
              candidates.push({ slug, anchoredPath, mtimeMs: stat.mtimeMs });
            } catch {
              report("collection-entry", "unreadable");
            }
          }
          if (!collectionsRootMatches(openedRoot, inspectCollectionsRoot(collectionsDir, ops))) {
            discardCollections = true;
            report("collections-root", "raced");
          }
        }
      } catch {
        discardCollections = true;
        report("collections-root", "unreadable");
      }
    }

    if (!discardCollections && stableCollectionsRoot !== null) {
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      if (candidates.length > MAX_KNOWLEDGE_COLLECTIONS) {
        omittedCollections += candidates.length - MAX_KNOWLEDGE_COLLECTIONS;
        candidates = candidates.slice(0, MAX_KNOWLEDGE_COLLECTIONS);
      }

      for (const candidate of candidates) {
        if (visibleBytes >= KNOWLEDGE_VISIBLE_MAX_BYTES) {
          omittedCollections++;
          continue;
        }
        const source = readDurableSourceBounded(candidate.anchoredPath, ops);
        if (!source.ok) {
          report("collection-entry", source.reason);
          continue;
        }
        const visible = stripCollectionComments(source.text).trim();
        if (!visible) continue;
        const remaining = Math.min(COLLECTION_VISIBLE_MAX_BYTES, KNOWLEDGE_VISIBLE_MAX_BYTES - visibleBytes);
        if (remaining <= 0) {
          omittedCollections++;
          continue;
        }
        const bounded = truncateVisible(visible, remaining);
        if (!bounded.text) {
          omittedCollections++;
          continue;
        }
        if (bounded.truncated) truncatedSources++;
        sections.push(`=== COLLECTION ${candidate.slug} DATA BEGIN ===\n${encodePromptPayload(bounded.text)}\n=== COLLECTION ${candidate.slug} DATA END ===`);
        visibleBytes += utf8Bytes(bounded.text);
        includedCollections++;
      }

      if (!collectionsRootMatches(stableCollectionsRoot, inspectCollectionsRoot(collectionsDir, ops))) {
        discardCollections = true;
        report("collections-root", "raced");
      }
    }
  } finally {
    if (collectionsRootFd !== null) {
      try {
        ops.close(collectionsRootFd);
      } catch {
        discardCollections = true;
        report("collections-root", "unreadable");
      }
    }
  }

  if (discardCollections) {
    sections.length = collectionSectionStart;
    visibleBytes = collectionVisibleStart;
    truncatedSources = collectionTruncatedStart;
    includedCollections = 0;
    omittedCollections = 0;
  }

  for (const [key, count] of [...diagnostics].sort(([a], [b]) => a.localeCompare(b))) {
    const [source, category] = key.split(":");
    options.log(`weekly knowledge: source=${source} category=${category} count=${count}`);
  }
  const text = sections.join("\n\n");
  return { text, empty: text.trim() === "", includedCollections, omittedCollections, truncatedSources };
}
