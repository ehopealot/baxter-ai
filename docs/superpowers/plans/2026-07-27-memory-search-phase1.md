# Memory Search (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `files-cli search` subcommand that ranks Baxter's memory by relevance (BM25 over markdown section-chunks) instead of the fixed-string `grep` scan.

**Architecture:** Pure-Node functions added to `app/scripts/files-cli.mjs`, reusing its existing `confine()`/`walkFiles()` jail and caps. A query is tokenized; every workspace file is chunked by markdown heading (long sections windowed); chunks are BM25-scored; the top-N are returned as `file:line (score) [heading]` + a one-line snippet. No new dependency, no persistent index (recompute per query), no grant/Dockerfile change (the `Bash(files-cli *)` wildcard already covers a new subcommand).

**Tech Stack:** Node.js (built-in `node:test`), no external libraries.

## Global Constraints

- **Zero new dependencies.** Pure Node only (spec: "no vector DB, no native addon"; the image was just slimmed).
- **Confinement is the security boundary.** Every filesystem walk goes through `confine(MEMORY_DIR, sub)` + `walkFiles`; the search must never reach the parent `~/.mail-agent/` key files, never follow a symlink, skip `.git` and binaries (NUL-byte heuristic), and honor the existing caps.
- **No regex evaluation of the query.** The query is the model's own (attacker-influenceable) text — tokenize with split/`includes` only; never build a `RegExp` from it (no ReDoS). This is why `grep` is fixed-string; `search` stays token-based.
- **Reuse existing constants** in `files-cli.mjs`: `MAX_ENTRIES = 2000`, `MAX_FILE_BYTES = 5*1024*1024`, `MAX_LINE = 500`.
- **All output ASCII-safe and bounded** — snippets trimmed to `MAX_LINE`, result count capped.
- **Tests:** extend `app/scripts/files-cli.test.mjs`; run with `node --test` from `app/`. Follow the existing pure-core + `import.meta.url` dispatch-guard pattern (pure functions are exported and unit-tested without spawning the CLI).

---

## File Structure

- **Modify** `app/scripts/files-cli.mjs` — add constants, the pure functions (`tokenize`, `chunkText`, `rankChunks`, `bestSnippet`, `searchWorkspace`, `parseSearchArgs`), a `search` branch in the CLI dispatch, and a `search` line in `USAGE`.
- **Modify** `app/scripts/files-cli.test.mjs` — add unit tests for each pure function + confinement.
- **Modify** `app/prompt.md`, `app/discord-prompt.md`, `app/heartbeat-prompt.md` — extend the existing `files-cli grep` hint with a `search` line.
- **Modify** `app/tui-prompt.md` — add a fresh `files-cli` hint (it has none today).

Constants to add near the existing caps block (top of `files-cli.mjs`, after line 20):

```js
const DEFAULT_LIMIT = 5;                 // search: default number of results
const MAX_LIMIT = 20;                    // search: hard cap on -n
const CHUNK_WINDOW = 40;                 // search: max lines per chunk (long sections split)
const MAX_CHUNKS = 20000;               // search: total chunks scored before truncating
const K1 = 1.2, B = 0.75;               // BM25 tuning constants
```

---

## Task 1: Tokenizer

**Files:**
- Modify: `app/scripts/files-cli.mjs` (add `tokenize`)
- Test: `app/scripts/files-cli.test.mjs`

**Interfaces:**
- Produces: `tokenize(text: string): string[]` — lowercased alphanumeric tokens, empty tokens dropped, a trailing plural `s` stripped on tokens longer than 3 chars (minimal normalization so `scores`/`score` collapse; both query and docs run through it, so recall is preserved).

- [ ] **Step 1: Write the failing test**

Add to `app/scripts/files-cli.test.mjs` (import `tokenize` from `./files-cli.mjs` — extend the existing import line):

```js
test("tokenize lowercases, splits on non-alphanumerics, drops empties, strips plural s", () => {
  assert.deepEqual(tokenize("Final Scores!!"), ["final", "score"]);
  assert.deepEqual(tokenize("  a,b--c  "), ["a", "b", "c"]); // short tokens keep their s-less selves
  assert.deepEqual(tokenize("keys APIs notes"), ["key", "api", "note"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("is as"), ["is", "as"]); // len<=3 not stripped -> "as" stays "as"
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test --test-name-pattern="tokenize lowercases"`
Expected: FAIL — `tokenize is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `app/scripts/files-cli.mjs` (after the constants):

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && node --test --test-name-pattern="tokenize lowercases"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/files-cli.mjs app/scripts/files-cli.test.mjs
git commit -m "feat(files-cli): add search tokenizer"
```

---

## Task 2: Markdown chunker

**Files:**
- Modify: `app/scripts/files-cli.mjs` (add `chunkText`)
- Test: `app/scripts/files-cli.test.mjs`

**Interfaces:**
- Consumes: `CHUNK_WINDOW` constant.
- Produces: `chunkText(text: string): Array<{ startLine: number, heading: string, text: string }>` — splits on markdown headings (`^#{1,6}\s+`); text before the first heading is a leading chunk with `heading: ""`; a section longer than `CHUNK_WINDOW` lines is split into successive windows (same heading, advancing `startLine`); a chunk whose lines are all blank is dropped; `startLine` is the 1-based line number of the chunk's first line. The heading line itself is NOT included in any chunk's `text` (it is carried in `heading`).

- [ ] **Step 1: Write the failing test**

```js
test("chunkText splits by heading, windows long sections, tracks 1-based start lines", () => {
  const md = [
    "intro line one",          // 1
    "intro line two",          // 2
    "## Scores",               // 3
    "sox won 5-2",             // 4
    "jays lost",               // 5
  ].join("\n");
  const chunks = chunkText(md);
  assert.equal(chunks.length, 2);
  assert.deepEqual({ startLine: chunks[0].startLine, heading: chunks[0].heading }, { startLine: 1, heading: "" });
  assert.match(chunks[0].text, /intro line one/);
  assert.deepEqual({ startLine: chunks[1].startLine, heading: chunks[1].heading }, { startLine: 4, heading: "Scores" });
  assert.match(chunks[1].text, /sox won/);

  // long section splits into CHUNK_WINDOW-line windows
  const long = ["# H", ...Array.from({ length: 90 }, (_, i) => `line ${i}`)].join("\n");
  const lc = chunkText(long);
  assert.equal(lc.length, 3);                 // 90 lines / 40 = 3 windows
  assert.equal(lc[0].startLine, 2);            // content starts line 2 (after the heading on line 1)
  assert.equal(lc[1].startLine, 42);
  assert.equal(lc.every((c) => c.heading === "H"), true);

  // all-blank input yields no chunks
  assert.deepEqual(chunkText("\n\n  \n"), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test --test-name-pattern="chunkText splits"`
Expected: FAIL — `chunkText is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && node --test --test-name-pattern="chunkText splits"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/files-cli.mjs app/scripts/files-cli.test.mjs
git commit -m "feat(files-cli): add markdown chunker for search"
```

---

## Task 3: BM25 ranker

**Files:**
- Modify: `app/scripts/files-cli.mjs` (add `rankChunks`)
- Test: `app/scripts/files-cli.test.mjs`

**Interfaces:**
- Consumes: `tokenize` (Task 1), constants `K1`, `B`.
- Produces: `rankChunks(chunks: Array<{file: string, startLine: number, heading: string, text: string}>, queryTerms: string[], limit: number): Array<{file, startLine, heading, text, score: number}>` — BM25 over the chunk set (each chunk's tokens = `tokenize(heading + "\n" + text)`, so heading terms count), drops chunks scoring 0, sorts by score desc then `file` asc then `startLine` asc, returns the top `limit`. Returns `[]` when `chunks` or `queryTerms` is empty.

- [ ] **Step 1: Write the failing test**

```js
test("rankChunks scores by BM25: rarer term and more matches rank higher; zero-hit dropped", () => {
  const chunks = [
    { file: "a.md", startLine: 1, heading: "", text: "the cat sat" },        // common term "the" (df 2)
    { file: "b.md", startLine: 1, heading: "", text: "quantum flux here" },   // rare term "quantum" (df 1)
    { file: "c.md", startLine: 1, heading: "", text: "the dog ran" },         // common term "the" (df 2)
    { file: "d.md", startLine: 1, heading: "", text: "ordinary plain note" }, // no query term -> excluded
  ];
  // query "quantum the": "quantum" (1 doc) is idf-heavier than "the" (2 docs), so
  // b.md must outrank the "the"-only chunks; d.md scores 0 and is dropped.
  const ranked = rankChunks(chunks, tokenize("quantum the"), 5);
  assert.equal(ranked[0].file, "b.md");
  assert.equal(ranked.some((r) => r.file === "d.md"), false); // zero-hit chunk excluded
  assert.equal(ranked.every((r) => r.score > 0), true);
});

test("rankChunks honors limit and is deterministic on ties", () => {
  const chunks = [
    { file: "b.md", startLine: 2, heading: "", text: "match" },
    { file: "a.md", startLine: 9, heading: "", text: "match" },
    { file: "a.md", startLine: 1, heading: "", text: "match" },
  ];
  const ranked = rankChunks(chunks, tokenize("match"), 2);
  assert.equal(ranked.length, 2);                       // limit respected
  assert.deepEqual(ranked.map((r) => [r.file, r.startLine]), [["a.md", 1], ["a.md", 9]]); // file then line
});

test("rankChunks matches on heading text too", () => {
  const chunks = [{ file: "a.md", startLine: 2, heading: "Scores", text: "body without the word" }];
  assert.equal(rankChunks(chunks, tokenize("scores"), 5).length, 1);
});

test("rankChunks returns [] on empty input", () => {
  assert.deepEqual(rankChunks([], tokenize("x"), 5), []);
  assert.deepEqual(rankChunks([{ file: "a", startLine: 1, heading: "", text: "y" }], [], 5), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test --test-name-pattern="rankChunks"`
Expected: FAIL — `rankChunks is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && node --test --test-name-pattern="rankChunks"`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add app/scripts/files-cli.mjs app/scripts/files-cli.test.mjs
git commit -m "feat(files-cli): add BM25 ranker for search"
```

---

## Task 4: Snippet selection + `searchWorkspace`

**Files:**
- Modify: `app/scripts/files-cli.mjs` (add `bestSnippet`, `searchWorkspace`)
- Test: `app/scripts/files-cli.test.mjs`

**Interfaces:**
- Consumes: `tokenize`, `chunkText`, `rankChunks`; existing `confine`, `walkFiles`, `MEMORY_DIR`-style `root`, `statSync`, `readFileSync`, `relative`; constants `MAX_ENTRIES`, `MAX_FILE_BYTES`, `MAX_LINE`, `MAX_CHUNKS`, `DEFAULT_LIMIT`, `MAX_LIMIT`.
- Produces:
  - `bestSnippet(text: string, startLine: number, queryTerms: string[]): { line: number, snippet: string }` — picks the line in `text` with the most distinct query-term hits (fallback: first non-empty line, else line 0); `line` = `startLine` + that offset; `snippet` = that line trimmed to `MAX_LINE` (with a `…` marker).
  - `searchWorkspace(root: string, query: string, opts?: { sub?: string, limit?: number }): { results: Array<{file: string, line: number, heading: string, score: number, snippet: string}>, truncated: boolean }` — confined walk → chunk every text file → rank → snippet the top-N. Throws on an empty query. `limit` clamped to `[1, MAX_LIMIT]`, default `DEFAULT_LIMIT`.

- [ ] **Step 1: Write the failing test**

```js
test("bestSnippet picks the line with the most query terms; falls back to first non-empty", () => {
  const text = "\nalpha only here\nalpha beta both here\n";
  const { line, snippet } = bestSnippet(text, 10, tokenize("alpha beta"));
  assert.equal(line, 12);                       // startLine(10) + offset(2) of the 2-hit line
  assert.match(snippet, /both here/);
  // heading-only match: no body line has the term -> first non-empty line
  const f = bestSnippet("\n  \nfirst real line\n", 5, tokenize("nowhere"));
  assert.equal(f.line, 7);
  assert.match(f.snippet, /first real line/);
});

test("searchWorkspace ranks memory chunks, is confined, and clamps the limit", () => {
  const { root, outside } = fixture();
  writeFileSync(join(root, "memory.md"), "# Scores\nsox won the game 5-2\n# Misc\nunrelated note\n");
  writeFileSync(join(root, "discord", "123.md"), "the operator asked about final scores tonight\n");

  const { results } = searchWorkspace(root, "final scores", { limit: 5 });
  assert.equal(results.length > 0, true);
  assert.equal(results[0].file, "discord/123.md");     // best match tops
  assert.equal(typeof results[0].line, "number");
  assert.match(results[0].snippet, /final scores/);

  // confinement: cannot reach the sibling "outside" secret via a symlink or `..`
  assert.equal(searchWorkspace(root, "super-secret").results.length, 0);
  assert.throws(() => searchWorkspace(root, "TOKEN", { sub: "escape-link" }), /escapes the workspace/);

  // limit clamp: asking for 999 never throws and returns <= MAX_LIMIT
  assert.equal(searchWorkspace(root, "note", { limit: 999 }).results.length <= 20, true);

  // empty query rejected
  assert.throws(() => searchWorkspace(root, "   "), /non-empty query/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test --test-name-pattern="bestSnippet|searchWorkspace"`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Write minimal implementation**

```js
// The most informative line within a chunk: the one containing the most distinct
// query terms (fallback to the first non-empty line when the match was on the heading
// only). Returns its absolute (1-based) line number and the trimmed line as a snippet.
export function bestSnippet(text, startLine, queryTerms) {
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
export function searchWorkspace(root, query, { sub = ".", limit = DEFAULT_LIMIT } = {}) {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) throw new Error("search needs a non-empty query");
  const lim = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const { base, target } = confine(root, sub);
  const state = { count: 0, truncated: false };
  const chunks = [];
  let truncated = false;
  outer: for (const abs of walkFiles(target, MAX_ENTRIES, state)) {
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    if (buf.includes(0)) continue; // binary heuristic (matches grep)
    const rel = relative(base, abs) || ".";
    for (const c of chunkText(buf.toString("utf8"))) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && node --test --test-name-pattern="bestSnippet|searchWorkspace"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/files-cli.mjs app/scripts/files-cli.test.mjs
git commit -m "feat(files-cli): add searchWorkspace (confined BM25 memory search)"
```

---

## Task 5: Arg parsing + CLI dispatch + usage

**Files:**
- Modify: `app/scripts/files-cli.mjs` (add `parseSearchArgs`, a `search` branch in the dispatch block, a `search` line in `USAGE`)
- Test: `app/scripts/files-cli.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_LIMIT`, `searchWorkspace`, `MEMORY_DIR`.
- Produces: `parseSearchArgs(rest: string[]): { query: string, sub: string, limit: number, pathsOnly: boolean }` — flags `-n <int>` / `--limit <int>` (positive integer, else throw), `--paths-only`, `--sub <path>`, and `--` to end flags; ALL remaining positionals are joined by a space to form `query` (so an unquoted multi-word query works; subpath is the explicit `--sub` flag, not a positional — this refines the spec, which floated a positional `[subpath]`, to avoid the unquoted-multi-word footgun). Throws on an empty query or unknown flag.

- [ ] **Step 1: Write the failing test**

```js
test("parseSearchArgs: joins positionals as the query, parses flags, rejects misuse", () => {
  assert.deepEqual(parseSearchArgs(["final", "scores"]),
    { query: "final scores", sub: ".", limit: 5, pathsOnly: false });
  assert.deepEqual(parseSearchArgs(["-n", "3", "--paths-only", "--sub", "discord", "cat"]),
    { query: "cat", sub: "discord", limit: 3, pathsOnly: true });
  assert.deepEqual(parseSearchArgs(["--", "-weird", "query"]),
    { query: "-weird query", sub: ".", limit: 5, pathsOnly: false });
  assert.throws(() => parseSearchArgs([]), /non-empty|usage/);
  assert.throws(() => parseSearchArgs(["-n", "x", "q"]), /positive integer/);
  assert.throws(() => parseSearchArgs(["--bogus", "q"]), /unknown flag/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test --test-name-pattern="parseSearchArgs"`
Expected: FAIL — `parseSearchArgs is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the parser near `parseGrepArgs`:

```js
// Parse `search` args. Unlike grep's single <pattern>, a search query is naturally
// multi-word, so ALL positionals join into the query and the subpath is the explicit
// `--sub` flag (avoids an unquoted "final scores" being read as pattern+subpath).
export function parseSearchArgs(rest) {
  let pathsOnly = false;
  let sub = ".";
  let limit = DEFAULT_LIMIT;
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") { words.push(...rest.slice(i + 1)); break; }
    else if (a === "--paths-only") pathsOnly = true;
    else if (a === "-n" || a === "--limit") {
      const v = rest[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new Error("-n needs a positive integer");
      limit = Number(v);
    } else if (a === "--sub") {
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
```

Add a `search` branch in the dispatch block, immediately after the `grep` branch (before the `else` that prints `USAGE`):

```js
    } else if (cmd === "search") {
      const { query, sub, limit, pathsOnly } = parseSearchArgs(rest);
      const { results, truncated } = searchWorkspace(MEMORY_DIR, query, { sub, limit });
      if (results.length === 0) console.log("(no matches)");
      else for (const r of results) {
        console.log(`${r.file}:${r.line}  (${r.score.toFixed(2)})${r.heading ? `  [${r.heading}]` : ""}`);
        if (!pathsOnly) console.log(`    ${r.snippet}`);
      }
      if (truncated) console.log(`\n[search stopped early -- hit the file/chunk cap; pass --sub <path> to narrow]`);
```

Add a `search` line to the `USAGE` array (after the `grep` line):

```js
  "  files-cli search [-n N] [--paths-only] [--sub <path>] [--] <query...>  ranked relevance search",
```

- [ ] **Step 4: Run the parser test AND a live subprocess smoke test**

Run: `cd app && node --test --test-name-pattern="parseSearchArgs"`
Expected: PASS.

Smoke-test the wired CLI against a real temp workspace. `MEMORY_DIR` comes from
`paths.mjs` as `homedir()/.mail-agent/memory-workspace`, so override `HOME` and seed
that path:

```bash
cd app && H=$(mktemp -d) && mkdir -p "$H/.mail-agent/memory-workspace" && \
  printf '# Scores\nsox won the game 5-2\n# Misc\nunrelated\n' > "$H/.mail-agent/memory-workspace/memory.md" && \
  HOME="$H" node scripts/files-cli.mjs search sox
```
Expected: a ranked line like `memory.md:2  (1.xx)  [Scores]` followed by an indented
`    sox won the game 5-2`.

- [ ] **Step 5: Run the FULL suite (no regressions) and commit**

Run: `cd app && node --test`
Expected: all tests pass, `# fail 0`.

```bash
git add app/scripts/files-cli.mjs app/scripts/files-cli.test.mjs
git commit -m "feat(files-cli): wire the search subcommand + usage"
```

---

## Task 6: Prompt-doc nudges (drives adoption)

**Files:**
- Modify: `app/prompt.md` (line 44 — extend the existing `files-cli grep` hint)
- Modify: `app/discord-prompt.md` (line 8 — extend)
- Modify: `app/heartbeat-prompt.md` (line 3 — extend)
- Modify: `app/tui-prompt.md` (add a fresh hint — it has none today)
- (No test; verified by grep.)

**Interfaces:** none (documentation only). `discord-reaction-prompt.md` is deliberately left untouched (lean, no-op-biased template).

- [ ] **Step 1: Extend `app/prompt.md` line 44**

Find the sentence containing `files-cli grep [-i] <text> [subpath]` and insert, right after the `(file:line: match)` clause, this text (keep it inside the same bullet):

```
 -- and `files-cli search [-n N] [--sub <path>] <query...>` ranks your memory by relevance (best matches first, with the section heading) when you don't know the exact words, which beats grepping blindly; use `grep` when you DO know an exact string.
```

- [ ] **Step 2: Extend `app/discord-prompt.md` line 8**

After its `files-cli grep [-i] <text> [subpath]` clause (`searches their contents (file:line: match)`), insert the same idea:

```
 To find something by meaning/relevance when you don't recall the exact words, use `files-cli search <query...>` (ranked best-first, with headings); `grep` is for an exact known string.
```

- [ ] **Step 3: Extend `app/heartbeat-prompt.md` line 3**

In the `files-cli` parenthetical (`list/search your own workspace -- \`files-cli list\` / \`files-cli grep [-i] <text>\``), change it to also mention search:

```
`files-cli` (list/search your own workspace -- `files-cli list`, `files-cli search <query...>` for ranked relevance, `files-cli grep [-i] <text>` for an exact string)
```

- [ ] **Step 4: Add a fresh hint to `app/tui-prompt.md`**

`tui-prompt.md` has no `files-cli` mention today. Find where the terminal's tools are described (near the memory/working-directory guidance) and add a sentence:

```
Search your own memory/workspace with `files-cli search <query...>` (ranked by relevance, best first, with section headings), `files-cli grep [-i] <text>` for an exact string, and `files-cli list [subpath]` to see files.
```

Place it beside the existing memory/`{{MEMORY_PATH}}` guidance; if there is no natural tools list, add it as a short standalone line in the same section that tells the model where its memory lives.

- [ ] **Step 5: Verify and commit**

Run:
```bash
cd app && grep -l "files-cli search" prompt.md discord-prompt.md heartbeat-prompt.md tui-prompt.md
```
Expected: all four files listed. Confirm `discord-reaction-prompt.md` is NOT changed: `git status --short app/discord-reaction-prompt.md` shows nothing.

```bash
git add app/prompt.md app/discord-prompt.md app/heartbeat-prompt.md app/tui-prompt.md
git commit -m "docs(prompts): nudge files-cli search for ranked memory retrieval"
```

---

## Final verification

- [ ] Run the whole suite from `app/`: `node --test` → `# fail 0`.
- [ ] End-to-end in the container: `make app-shell`, then `files-cli search final scores` against the real (or a seeded) workspace returns ranked `file:line (score) [heading]` + snippet lines, and `files-cli search ../` / a symlink-escape are refused with "escapes the workspace".
- [ ] Confirm no grant/Dockerfile change was needed (the `Bash(files-cli *)` wildcard already covers `search`).

## Notes / spec deltas

- The spec floated a positional `[subpath]`; the plan uses an explicit `--sub <path>` flag instead so an unquoted multi-word query (`files-cli search final scores`) isn't misread as pattern + subpath. Update the spec's interface line to match when convenient.
- Phase 2 (embedding rerank) is out of scope here; the pure functions above are the seam it will extend (`rankChunks` becomes the candidate generator; a reranker sits between `rankChunks` and the snippet map in `searchWorkspace`).
