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
import { MEMORY_DIR } from "./paths.mjs";

// Caps -- keep a run's output (and this process's work) bounded even if the
// workspace grows or a pattern matches everything.
const MAX_ENTRIES = 2000;               // list: total files printed
const MAX_MATCHES = 300;                // grep: total match lines printed
const MAX_LINE = 500;                   // grep: truncate a long printed line
const MAX_FILE_BYTES = 5 * 1024 * 1024; // grep: skip files bigger than this
const SKIP_DIRS = new Set([".git"]);    // never descend into these
const CHUNK_WINDOW = 40;                 // search: max lines per chunk (long sections split)
const K1 = 1.2, B = 0.75;               // search: BM25 tuning constants

// Split text into normalized search tokens: lowercase, split on non-alphanumerics,
// drop empties, and strip a trailing plural `s` on longer tokens so "scores"/"score"
// collapse. Deliberately minimal (no external stemmer/stopwords); the query and the
// documents run through the SAME function, so recall is preserved.
export function tokenize(text) {
  const out = [];
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
export function chunkText(text) {
  const lines = String(text).split("\n");
  const chunks = [];
  let heading = "";
  let buf = [];
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
export function rankChunks(chunks, queryTerms, limit) {
  const N = chunks.length;
  const qset = [...new Set(queryTerms)];
  if (N === 0 || qset.length === 0) return [];
  const docs = chunks.map((c) => {
    const tf = new Map();
    for (const t of tokenize(`${c.heading}\n${c.text}`)) tf.set(t, (tf.get(t) || 0) + 1);
    let len = 0;
    for (const n of tf.values()) len += n;
    return { tf, len };
  });
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map();
  for (const t of qset) {
    let n = 0;
    for (const d of docs) if (d.tf.has(t)) n++;
    df.set(t, n);
  }
  const scored = [];
  for (let i = 0; i < N; i++) {
    const { tf, len } = docs[i];
    let score = 0;
    for (const t of qset) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const dft = df.get(t);
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

// Resolve `sub` under `root` and refuse anything that -- after symlink
// resolution -- lands outside the workspace. This is the security boundary:
// `..` traversal and a symlink escaping the tree both get rejected here.
// Returns the canonical workspace root (`base`) and the confined target.
export function confine(root, sub) {
  const base = realpathSync(root);
  const target = resolve(base, String(sub ?? "."));
  let real;
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
export function* walkFiles(start, cap, state) {
  let root;
  try { root = statSync(start); } catch { return; } // missing path -> nothing
  if (root.isFile()) { yield start; return; }
  if (!root.isDirectory()) return;
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    // Ascending sort: yield this dir's files in order, and collect its subdirs
    // to push in REVERSE so the LIFO stack pops them ascending too -- so the
    // overall output is alphabetical (a dir's files, then its subdirs' files).
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirs = [];
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

// Sorted list of workspace files (relative to the workspace root) with sizes.
export function listWorkspace(root, sub) {
  const { base, target } = confine(root, sub);
  const state = { count: 0, truncated: false };
  const files = [];
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
export function grepWorkspace(root, pattern, { sub = ".", ignoreCase = false } = {}) {
  if (!pattern) throw new Error("grep needs a non-empty pattern");
  const { base, target } = confine(root, sub);
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const state = { count: 0, truncated: false };
  const results = [];
  let truncated = false;
  outer: for (const abs of walkFiles(target, MAX_ENTRIES, state)) {
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    if (buf.includes(0)) continue; // binary heuristic: contains a NUL byte
    const rel = relative(base, abs) || ".";
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
      if (hay.includes(needle)) {
        let text = lines[i];
        if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + "…";
        results.push({ file: rel, line: i + 1, text });
        if (results.length >= MAX_MATCHES) { truncated = true; break outer; }
      }
    }
  }
  return { results, truncated: truncated || state.truncated };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Parse `grep` args: optional -i/--ignore-case flag, then <pattern>, then an
// optional [subpath]. Rejects extra positionals so a stray arg isn't silently
// treated as a second (ignored) subpath.
export function parseGrepArgs(rest) {
  let ignoreCase = false;
  const pos = [];
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

const USAGE = [
  "usage:",
  "  files-cli list [subpath]              list your workspace files (with sizes)",
  "  files-cli grep [-i] [--] <pattern> [subpath]  search file contents (fixed-string)",
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
    } else {
      console.log(USAGE);
      process.exit(cmd ? 1 : 0); // no command = help (0); bad command = error (1)
    }
  } catch (err) {
    console.error(`files-cli: ${err.message}`);
    process.exit(1);
  }
}
