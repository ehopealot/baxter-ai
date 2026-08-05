#!/usr/bin/env node
// Workspace-confined list/search CLI -- Baxter's read-only window into his own
// working directory. It is the boundary-CLI analog of `ls`/`grep` (which the
// run isn't granted): the run reaches it only through `Bash(files-cli *)`, and
// it can NEVER escape MEMORY_DIR. That confinement is the whole point -- the
// agentmail/discord key files live in the PARENT dir (~/.mail-agent), OUTSIDE
// MEMORY_DIR, so a scoped search/list can't discover or read them the way an
// unconfined native Grep/Glob could. No secret lives here; no deps; no shell.
import { readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, sep, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MEMORY_DIR } from "./paths.ts";
import { readSummaries, compactIfLarge } from "./access-log.ts";
import type { AccessSummary } from "./access-log.ts";

// Caps -- keep a run's output (and this process's work) bounded even if the
// workspace grows or a pattern matches everything.
const MAX_ENTRIES = 2000;               // list: total files printed
const MAX_MATCHES = 300;                // grep: total match lines printed
const MAX_LINE = 500;                   // grep: truncate a long printed line
const MAX_FILE_BYTES = 5 * 1024 * 1024; // grep: skip files bigger than this
const SKIP_DIRS = new Set([".git"]);    // never descend into these
const CHUNK_WINDOW = 40;                 // search: max lines per chunk (long sections split)
const K1 = 1.2, B = 0.75;               // search: BM25 tuning constants
const DEFAULT_LIMIT = 5;                 // search: default number of results
const MAX_LIMIT = 20;                    // search: hard cap on -n
const MAX_CHUNKS = 20000;               // search: total chunks scored before truncating

// Split text into normalized search tokens: lowercase, split on non-alphanumerics,
// drop empties, and strip a trailing plural `s` on longer tokens so "scores"/"score"
// collapse. Deliberately minimal (no external stemmer/stopwords); the query and the
// documents run through the SAME function, so recall is preserved.
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    out.push(raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
  }
  return out;
}

// Split a file's text into retrievable chunks: one per markdown section (heading
// boundary), with any section longer than CHUNK_WINDOW lines further split into
// fixed-line windows so every chunk stays line-anchored and one huge section can't
// dominate BM25 length normalization. The heading text rides on the chunk (searchable
// via rankChunks) but the heading line isn't in the body.
export interface Chunk {
  startLine: number;
  heading: string;
  text: string;
}

export interface RankableChunk extends Chunk {
  file: string;
}

export interface ScoredChunk extends RankableChunk {
  score: number;
}

export function chunkText(text: string): Chunk[] {
  const lines = String(text).split("\n");
  const chunks: Chunk[] = [];
  let heading = "";
  let buf: string[] = [];
  let bufStart = 0; // 1-based line of buf[0]
  const flush = () => {
    for (let off = 0; off < buf.length; off += CHUNK_WINDOW) {
      const slice = buf.slice(off, off + CHUNK_WINDOW);
      if (slice.join("").trim()) {
        chunks.push({ startLine: bufStart + off, heading, text: slice.join("\n") });
      }
    }
    buf = [];
    bufStart = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (m) {
      flush();
      heading = m[1].trim();
    } else {
      if (buf.length === 0) bufStart = i + 1; // 1-based line number
      buf.push(lines[i]);
    }
  }
  flush();
  return chunks;
}

// BM25 ranking over a set of chunks. Each chunk's searchable tokens include its
// heading (so a query matching a section title ranks that section). Deterministic
// tie-break (score, then file, then startLine) keeps output stable for tests and for
// a run comparing two searches.
export function rankChunks(chunks: RankableChunk[], queryTerms: string[], limit: number): ScoredChunk[] {
  const N = chunks.length;
  const qset = [...new Set(queryTerms)];
  if (N === 0 || qset.length === 0) return [];
  const docs = chunks.map((c) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(`${c.heading}\n${c.text}`)) tf.set(t, (tf.get(t) || 0) + 1);
    let len = 0;
    for (const n of tf.values()) len += n;
    return { tf, len };
  });
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of qset) {
    let n = 0;
    for (const d of docs) if (d.tf.has(t)) n++;
    df.set(t, n);
  }
  const scored: ScoredChunk[] = [];
  for (let i = 0; i < N; i++) {
    const { tf, len } = docs[i];
    let score = 0;
    for (const t of qset) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const dft = df.get(t) as number;
      const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (len / avgLen)));
    }
    if (score > 0) scored.push({ ...chunks[i], score });
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.startLine - b.startLine
  );
  return scored.slice(0, limit);
}

// The most informative line within a chunk: the one containing the most distinct
// query terms (fallback to the first non-empty line when the match was on the heading
// only). Returns its absolute (1-based) line number and the trimmed line as a snippet.
export function bestSnippet(text: string, startLine: number, queryTerms: string[]): { line: number; snippet: string } {
  const qset = new Set(queryTerms);
  const lines = text.split("\n");
  let bestOff = -1, bestHits = 0;
  for (let i = 0; i < lines.length; i++) {
    const toks = new Set(tokenize(lines[i]));
    let hits = 0;
    for (const t of qset) if (toks.has(t)) hits++;
    if (hits > bestHits) { bestHits = hits; bestOff = i; }
  }
  if (bestOff === -1) {
    bestOff = lines.findIndex((l) => l.trim());
    if (bestOff === -1) bestOff = 0;
  }
  let snippet = lines[bestOff].trim();
  if (snippet.length > MAX_LINE) snippet = snippet.slice(0, MAX_LINE) + "…";
  return { line: startLine + bestOff, snippet };
}

// Ranked relevance search over the workspace: same confined walk + binary/oversize
// skips as grep, then chunk every text file, BM25-rank the chunks, and return the
// top-N with a snippet. No persistent index -- recomputed per query (fast at memory
// scale). Throws on an empty query. Never reaches outside MEMORY_DIR (confine()).
export interface SearchResult {
  file: string;
  line: number;
  heading: string;
  score: number;
  snippet: string;
}

export interface WalkState {
  count: number;
  truncated: boolean;
}

export function searchWorkspace(root: string, query: string, { sub = ".", limit = DEFAULT_LIMIT }: { sub?: string; limit?: number | string } = {}): { results: SearchResult[]; truncated: boolean } {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) throw new Error("search needs a non-empty query");
  // Clamp uniformly: a real number floors to [1, MAX_LIMIT]; only a non-number
  // (NaN) falls back to the default (so limit:0 -> 1, not silently the default 5).
  const n = Math.floor(Number(limit));
  const lim = Number.isNaN(n) ? DEFAULT_LIMIT : Math.max(1, Math.min(n, MAX_LIMIT));
  const { base, target } = confine(root, sub);
  const state: WalkState = { count: 0, truncated: false };
  const chunks: RankableChunk[] = [];
  let truncated = false;
  outer: for (const { rel, text } of readTextFiles(base, target, state)) {
    for (const c of chunkText(text)) {
      chunks.push({ file: rel, startLine: c.startLine, heading: c.heading, text: c.text });
      if (chunks.length >= MAX_CHUNKS) { truncated = true; break outer; }
    }
  }
  const results = rankChunks(chunks, queryTerms, lim).map((c) => {
    const { line, snippet } = bestSnippet(c.text, c.startLine, queryTerms);
    return { file: c.file, line, heading: c.heading, score: c.score, snippet };
  });
  return { results, truncated: truncated || state.truncated };
}

// Resolve `sub` under `root` and refuse anything that -- after symlink
// resolution -- lands outside the workspace. This is the security boundary:
// `..` traversal and a symlink escaping the tree both get rejected here.
// Returns the canonical workspace root (`base`) and the confined target.
export function confine(root: string, sub?: string): { base: string; target: string } {
  const base = realpathSync(root);
  const target = resolve(base, String(sub ?? "."));
  let real: string;
  // A not-yet-existing target can't be realpath'd; fall back to its lexical
  // form (already `..`-resolved by resolve()) so the containment check still
  // runs -- the walk then simply finds nothing there.
  try { real = realpathSync(target); } catch { real = target; }
  if (real !== base && !real.startsWith(base + sep)) {
    throw new Error(`path escapes the workspace: ${sub}`);
  }
  return { base, target: real };
}

// Yield absolute paths of regular files at/under `start` (a file or dir),
// sorted, NEVER following symlinks (a symlink inside the workspace pointing out
// must not leak a file outside it), skipping SKIP_DIRS, stopping after `cap`
// files. Sets `state.truncated` when the cap is hit.
export function* walkFiles(start: string, cap: number, state: WalkState): Generator<string> {
  let root;
  try { root = statSync(start); } catch { return; } // missing path -> nothing
  if (root.isFile()) { yield start; return; }
  if (!root.isDirectory()) return;
  const stack: string[] = [start];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    // Ascending sort: yield this dir's files in order, and collect its subdirs
    // to push in REVERSE so the LIFO stack pops them ascending too -- so the
    // overall output is alphabetical (a dir's files, then its subdirs' files).
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirs: string[] = [];
    for (const d of entries) {
      if (d.isSymbolicLink()) continue; // never traverse or emit a symlink
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) dirs.push(abs);
      } else if (d.isFile()) {
        if (state.count >= cap) { state.truncated = true; return; }
        state.count++;
        yield abs;
      }
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
  }
}

// The single "which files do we read, and how" policy shared by grep + search:
// walk the confined tree and yield each readable file's workspace-relative path and
// decoded text, skipping oversized and binary (NUL-byte) files. Keeping this in one
// place stops grep and search from silently diverging on what they scan.
function* readTextFiles(base: string, target: string, state: WalkState): Generator<{ rel: string; text: string }> {
  for (const abs of walkFiles(target, MAX_ENTRIES, state)) {
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    if (buf.includes(0)) continue; // binary heuristic: contains a NUL byte
    yield { rel: relative(base, abs) || ".", text: buf.toString("utf8") };
  }
}

// Sorted list of workspace files (relative to the workspace root) with sizes.
export function listWorkspace(root: string, sub?: string): { files: Array<{ path: string; size: number }>; truncated: boolean } {
  const { base, target } = confine(root, sub);
  const state: WalkState = { count: 0, truncated: false };
  const files: Array<{ path: string; size: number }> = [];
  for (const abs of walkFiles(target, MAX_ENTRIES, state)) {
    let size = 0;
    try { size = statSync(abs).size; } catch { /* raced away; report 0 */ }
    files.push({ path: relative(base, abs) || ".", size });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, truncated: state.truncated };
}

// Fixed-string (optionally case-insensitive) content search. NOT regex: avoids
// ReDoS on a model-supplied pattern and matches the common "where did I write
// X" need; code-cli covers real regex. Skips binary (a NUL byte) and oversized
// files. Returns match lines relative to the workspace root.
export function grepWorkspace(root: string, pattern: string, { sub = ".", ignoreCase = false }: { sub?: string; ignoreCase?: boolean } = {}): { results: Array<{ file: string; line: number; text: string }>; truncated: boolean } {
  if (!pattern) throw new Error("grep needs a non-empty pattern");
  const { base, target } = confine(root, sub);
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const state: WalkState = { count: 0, truncated: false };
  const results: Array<{ file: string; line: number; text: string }> = [];
  let truncated = false;
  outer: for (const { rel, text } of readTextFiles(base, target, state)) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
      if (hay.includes(needle)) {
        let line = lines[i];
        if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE) + "…";
        results.push({ file: rel, line: i + 1, text: line });
        if (results.length >= MAX_MATCHES) { truncated = true; break outer; }
      }
    }
  }
  return { results, truncated: truncated || state.truncated };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// A coarse human age for a duration in ms (used by `lru`). Whole units, biggest that fits.
export function formatAge(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 365) return `${d}d`;
  return `${(d / 365).toFixed(1)}y`;
}

// One workspace file's access facts. `lastUsed` = the most recent of mtime, last-read and
// last-write -- the staleness key `lru` sorts on (a file written recently but never read is
// NOT stale). mtime is the filesystem's own last-write, so it's authoritative even for writes
// the access log never saw (a restore, a git checkout, or a `claude`-harness run).
export interface LruRow {
  path: string; size: number; mtimeMs: number;
  lastRead: number | null; lastWrite: number | null; reads: number; writes: number;
  lastUsed: number;
}

// Pure: compute lastUsed and sort. Oldest-first by default (stale files at the top, the
// cleanup lever); `newest` reverses. Ties break by path for a stable order.
export function rankByLru(rows: Array<Omit<LruRow, "lastUsed">>, newest = false): LruRow[] {
  const out = rows.map((r) => ({ ...r, lastUsed: Math.max(r.mtimeMs, r.lastRead ?? 0, r.lastWrite ?? 0) }));
  out.sort((a, b) => (a.lastUsed !== b.lastUsed ? (newest ? b.lastUsed - a.lastUsed : a.lastUsed - b.lastUsed) : a.path < b.path ? -1 : 1));
  return out;
}

// Join a workspace file listing with the access summaries into LruRows. `statMtimeMs` is
// injected (fs at the call site, a stub in tests); a file that fails to stat (vanished) is
// dropped. Kept separate from the fs walk + printing so the join is unit-testable.
export function buildLruRows(
  files: Array<{ path: string; size: number }>,
  summaries: Map<string, AccessSummary>,
  statMtimeMs: (relPath: string) => number | null,
): Array<Omit<LruRow, "lastUsed">> {
  const rows: Array<Omit<LruRow, "lastUsed">> = [];
  for (const f of files) {
    const mtimeMs = statMtimeMs(f.path);
    if (mtimeMs === null) continue;
    const s = summaries.get(f.path);
    rows.push({ path: f.path, size: f.size, mtimeMs, lastRead: s?.lastRead ?? null, lastWrite: s?.lastWrite ?? null, reads: s?.reads ?? 0, writes: s?.writes ?? 0 });
  }
  return rows;
}

// Strict positive-int value for the `-n/--limit` flag, shared by `lru` and `search` so the two
// sibling parsers can't diverge on the same flag (a lenient parseInt would accept "5x"->5).
export function parseLimitFlag(v: string | undefined): number {
  if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1) throw new Error("-n needs a positive integer");
  return Number(v);
}

// Parse `lru` args: an optional [subpath], -n/--limit N, --newest. Rejects unknown flags.
export interface LruArgs { sub: string; limit: number; newest: boolean; }
export function parseLruArgs(rest: string[]): LruArgs {
  let sub = "."; let limit = 40; let newest = false; const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--newest") newest = true;
    else if (a === "-n" || a === "--limit") limit = parseLimitFlag(rest[++i]);
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown flag: ${a}`);
    else pos.push(a);
  }
  if (pos.length > 1) throw new Error("usage: files-cli lru [subpath] [-n N] [--newest]");
  if (pos[0]) sub = pos[0];
  return { sub, limit, newest };
}

// Parse `grep` args: optional -i/--ignore-case flag, then <pattern>, then an
// optional [subpath]. Rejects extra positionals so a stray arg isn't silently
// treated as a second (ignored) subpath.
export interface GrepArgs {
  pattern: string;
  sub: string;
  ignoreCase: boolean;
}

export function parseGrepArgs(rest: string[]): GrepArgs {
  let ignoreCase = false;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    // `--` ends flag parsing: everything after is literal, so a needle that
    // starts with `-` (e.g. `files-cli grep -- --file`) is searchable.
    if (a === "--") { pos.push(...rest.slice(i + 1)); break; }
    if (a === "-i" || a === "--ignore-case") ignoreCase = true;
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown flag: ${a}`);
    else pos.push(a);
  }
  if (pos.length === 0) throw new Error("usage: files-cli grep [-i] [--] <pattern> [subpath]");
  if (pos.length > 2) throw new Error("usage: files-cli grep [-i] [--] <pattern> [subpath]");
  return { pattern: pos[0], sub: pos[1] ?? ".", ignoreCase };
}

// Parse `search` args. Unlike grep's single <pattern>, a search query is naturally
// multi-word, so ALL positionals join into the query and the subpath is the explicit
// `--sub` flag (avoids an unquoted "final scores" being read as pattern+subpath).
export interface SearchArgs {
  query: string;
  sub: string;
  limit: number;
  pathsOnly: boolean;
}

export function parseSearchArgs(rest: string[]): SearchArgs {
  let pathsOnly = false;
  let sub = ".";
  let limit = DEFAULT_LIMIT;
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { words.push(...rest.slice(i + 1)); break; }
    else if (a === "--paths-only") pathsOnly = true;
    else if (a === "-n" || a === "--limit") limit = parseLimitFlag(rest[++i]);
    else if (a === "--sub") {
      const v = rest[++i];
      if (v === undefined) throw new Error("--sub needs a path");
      sub = v;
    } else if (a.startsWith("-") && a !== "-") throw new Error(`unknown flag: ${a}`);
    else words.push(a);
  }
  const query = words.join(" ").trim();
  if (!query) throw new Error("usage: files-cli search [-n N] [--paths-only] [--sub <path>] [--] <query...>");
  return { query, sub, limit, pathsOnly };
}

const USAGE = [
  "usage:",
  "  files-cli list [subpath]              list your workspace files (with sizes)",
  "  files-cli grep [-i] [--] <pattern> [subpath]  search file contents (fixed-string)",
  "  files-cli search [-n N] [--paths-only] [--sub <path>] [--] <query...>  ranked relevance search",
  "  files-cli lru [subpath] [-n N] [--newest]     files by last use (oldest first) -- find stale files to clean up",
  "",
  "Confined to your working directory -- paths are relative to it, and it can't",
  "reach outside. `grep` is a plain substring search (-i = case-insensitive; `--`",
  "ends flags, so a pattern starting with `-` is searchable); for regex or heavier",
  "parsing, use code-cli.",
].join("\n");

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === "list") {
      if (rest.length > 1) throw new Error("usage: files-cli list [subpath]");
      const { files, truncated } = listWorkspace(MEMORY_DIR, rest[0] ?? ".");
      if (files.length === 0) {
        console.log("(no files)");
      } else {
        for (const f of files) console.log(`${f.path}  (${formatBytes(f.size)})`);
        console.log(`\n${files.length} file(s)${truncated ? ` -- capped at ${MAX_ENTRIES}, list a subpath to narrow` : ""}`);
      }
    } else if (cmd === "grep") {
      const { pattern, sub, ignoreCase } = parseGrepArgs(rest);
      const { results, truncated } = grepWorkspace(MEMORY_DIR, pattern, { sub, ignoreCase });
      if (results.length === 0) console.log("(no matches)");
      else for (const r of results) console.log(`${r.file}:${r.line}: ${r.text}`);
      // Report truncation independently of the result count: a truncated walk
      // with zero results (the file-count cap was hit before any match) must NOT
      // read as a confident "not found" -- only part of the workspace was seen.
      if (truncated) console.log(`\n[search stopped early -- hit the match or file-count cap; narrow the pattern or pass a subpath]`);
    } else if (cmd === "search") {
      const { query, sub, limit, pathsOnly } = parseSearchArgs(rest);
      const { results, truncated } = searchWorkspace(MEMORY_DIR, query, { sub, limit });
      if (results.length === 0) console.log("(no matches)");
      else for (const r of results) {
        // --paths-only is the compact form its name implies: just file:line, no
        // score/heading/snippet (content), so it's clean to scan or pipe.
        if (pathsOnly) { console.log(`${r.file}:${r.line}`); continue; }
        console.log(`${r.file}:${r.line}  (${r.score.toFixed(2)})${r.heading ? `  [${r.heading}]` : ""}`);
        console.log(`    ${r.snippet}`);
      }
      if (truncated) console.log(`\n[search stopped early -- hit the file/chunk cap; pass --sub <path> to narrow]`);
    } else if (cmd === "lru") {
      const { sub, limit, newest } = parseLruArgs(rest);
      compactIfLarge(); // best-effort: keep the append log bounded (no-op unless it's large)
      const summaries = readSummaries();
      const { files, truncated } = listWorkspace(MEMORY_DIR, sub);
      const rows = buildLruRows(files, summaries, (rel) => {
        try { return statSync(join(MEMORY_DIR, rel)).mtimeMs; } catch { return null; }
      });
      const ranked = rankByLru(rows, newest);
      if (ranked.length === 0) { console.log("(no files)"); }
      else {
        const now = Date.now();
        for (const r of ranked.slice(0, limit)) {
          const read = r.lastRead ? `read ${formatAge(now - r.lastRead)} ago` : "never read";
          console.log(`${formatAge(now - r.lastUsed).padStart(5)}  ${formatBytes(r.size).padStart(9)}  ${r.path}  ·  ${read}  ·  r${r.reads}/w${r.writes}`);
        }
        const shown = Math.min(limit, ranked.length);
        console.log(`\n${shown} of ${ranked.length} file(s), ${newest ? "most" : "least"}-recently-used first${truncated ? " (workspace listing capped -- pass a subpath)" : ""}`);
      }
    } else {
      console.error(USAGE);
      process.exit(cmd ? 1 : 2); // nonzero even with NO subcommand: exit-0-with-usage made run_cli report ok:true, so a model that misinvoked (cmd in stdin, no args) looped on the success-looking usage instead of self-correcting
    }
  } catch (err) {
    console.error(`files-cli: ${(err as Error).message}`);
    process.exit(1);
  }
}
