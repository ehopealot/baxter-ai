# Ranked memory retrieval — `files-cli search`

## Motivation

Baxter's memory is never dumped into a run's prompt — the daemons inject only
*path strings* (`{{MEMORY_PATH}}`, `{{CHANNEL_MEMORY_PATH}}`, …) and the run reads
the files itself with native `Read` and searches them with `files-cli grep`. `grep`
is a fixed-string `includes` scan: single term, unranked, presence-only. As memory
grows (a long shared `memory.md`, many per-channel `discord/<id>.md` notes, projects),
the run burns turns and tokens `Read`-ing whole files or grepping blindly to find the
few relevant lines.

Goal: let Baxter **retrieve the relevant slices** of its own memory instead of
scanning. A ranked, multi-term search exposed as a new **subcommand on the existing
`files-cli`** — the interface the operator asked for — that is "clever under the hood"
without dragging in a vector DB or a native dependency (we just cut ~1GB from the
image; heavy deps cut against the grain, and the whole memory layer is deliberately
offline/keyless).

**Chosen shape (hybrid, phased):** a pure-Node lexical retriever (BM25 over section
chunks) as the always-on, offline default (Phase 1, built now), with an opt-in
embedding reranker specified but deferred (Phase 2). This matches the offline/keyless
ethos: the default needs no key and no network, and semantic search is a graceful
upgrade only when an operator configures an embedding backend.

## Architecture

A new `search` subcommand on `app/scripts/files-cli.mjs`. No new CLI, no new grant, no
Dockerfile change: `Bash(files-cli *)` is a wildcard already in `grants.mjs`'s
`CORE_TOOLS` and already shimmed, so every surface (mail/discord/heartbeat/voice/tui)
gets `search` the moment it lands.

```
files-cli search [-n <count>] [--paths-only] [--] <query> [subpath]
  1. walk     reuse walkFiles() over MEMORY_DIR (confined; skips .git/binaries/
              symlinks; <=5MB files; <=2000 files) -- the same jail as grep, so the
              parent-dir 0600 key files stay unreachable.
  2. chunk    split each file into retrievable units by markdown heading, long
              sections further split into ~N-line windows; each chunk keeps its
              {file, startLine, heading, text}.
  3. score    BM25 (k1=1.2, b=0.75) over chunk term-frequencies + corpus doc-
              frequencies; rank chunks best-first.
  4. render   top-N chunks as `path:line (score)` + heading + a trimmed snippet
              window (or bare headers under --paths-only); total output capped.
```

Recompute per query — **no persistent index in Phase 1**. At memory scale (a few MB,
low thousands of chunks) a full walk + tokenize + score is single-digit milliseconds.
A persistent inverted index is a clean later add *only if* the corpus ever grows to
hundreds of MB; it is explicitly out of scope now (YAGNI).

### Interface

- `<query>` — free text, **multi-term** (the key difference from `grep`'s single fixed
  string). Tokenized: lowercased, split on non-alphanumerics, empty tokens dropped.
  Optional light normalization (trailing-`s` strip) — kept minimal and documented; no
  external stemmer/stopword dependency.
- `[subpath]` — optional subtree restriction (e.g. `discord/`), resolved through the
  same `confine(MEMORY_DIR, subpath)` as `grep`.
- `-n <count>` — number of results (default **5**, hard cap **20**).
- `--paths-only` — ranked `path:line (score)` headers with no snippet body, for a
  token-lean first pass; the run then `Read`s what it wants.
- `--` — ends flags so a `-`-leading query is searchable (mirrors `grep`'s parser).
- **Default output** (no `--paths-only`): ranked best-first; each hit is
  `path:line (score)`, the markdown heading the chunk lives under, and a trimmed
  snippet window around the best-matching line — enough context that the run often
  needs no follow-up `Read`, while total output stays under the existing caps.

### Chunking

- Split on markdown headings (`^#{1,6}\s`). Text before the first heading is its own
  leading chunk. Each chunk records the file, the 1-based start line of its content,
  and the heading text (for the result label).
- A section longer than a window threshold (~40 lines, tunable const) is further split
  into fixed-line windows so a single huge section still yields line-anchored chunks
  and one giant section can't dominate BM25 length normalization.
- Non-markdown files (rare under MEMORY_DIR) chunk by blank-line paragraphs into the
  same window size — the chunker degrades to paragraph windows when there are no
  headings.

### Ranking (BM25)

- Per chunk: term frequencies over its tokens. Across all chunks: document frequency
  per term → `idf = ln(1 + (N - df + 0.5)/(df + 0.5))`.
- `score(chunk) = Σ_term idf(term) · (tf·(k1+1)) / (tf + k1·(1 - b + b·|chunk|/avgLen))`
  with `k1=1.2`, `b=0.75`, `|chunk|` = chunk token count, `avgLen` = mean over the
  corpus. Chunks with zero query-term hits score 0 and are dropped.
- Deterministic tie-break: higher score, then file path, then start line — so output
  is stable across runs (important for tests and for a run comparing two searches).

### Security / confinement

Identical jail to `grep`, reusing the same primitives:
- `confine()` + `walkFiles()` — MEMORY_DIR only; the `~/.mail-agent/` parent (holding
  `agentmail-key.json`, `discord-token.json`, `data-keys.json`, send-state) is
  unreachable, symlinks are never followed, binaries (NUL-byte heuristic) skipped,
  file/entry/line caps enforced.
- **Offline** — no network in Phase 1.
- The query is the model's own text: passed as an execFile arg (no shell), and
  tokenized with `includes`/split, **never regex-evaluated** — so there is no ReDoS
  surface on a model-supplied query (the same reason `grep` is fixed-string; regex
  stays `code-cli`'s job).
- `CREDENTIALS.md` is in search scope exactly as it is for `grep` today — same trust
  boundary, offline, no new exposure.

## Phase 2 — embedding reranker (specified, NOT built)

Deferred, but the Phase-1 seams are chosen so it drops in without rework:

- **Hybrid rerank**: `search` computes BM25 candidates (top ~50), and **only when an
  embedding backend is configured** embeds the query + candidate chunks and reranks by
  `α·bm25_norm + β·cosine`. Absent config → pure BM25 (the Phase-1 default), unchanged.
- **Key handling**: a 0600 config file mirroring `DATA_KEYS_PATH`
  (`~/.mail-agent/embed-config.json`: `{provider, model, baseUrl, key}`), read at
  runtime, **never in the run's env** — so the offline default holds and the existing
  credential boundary is preserved. No embedding config = no network, no key.
- **Vector cache**: a content-hash-keyed sidecar under MEMORY_DIR, **one file per
  chunk** (`.search-index/vectors/<content-hash>.json`) so an incremental rebuild is a
  `stat`, not a parse — only new or changed chunks are re-embedded (cost control).
  Brute-force cosine in JS over a few thousand vectors is
  adequate — **no vector DB, no HNSW/faiss, no sqlite, no native addon.** `walkFiles`
  currently skips only `.git` (`SKIP_DIRS`), so `.search-index` **must join
  `SKIP_DIRS`** — otherwise `list`/`grep`/`search` would walk the cache, chunk its
  text (JSON has no NUL byte, so the binary heuristic won't skip it), pollute results
  with vector garbage, skew the corpus `df`/`avgLen` BM25 depends on, and burn the
  2000-file cap as it grows one entry per chunk. The cache lives in the run's writable
  cwd, so a run can corrupt or poison it — acceptable **only** because a poisoned cache
  can affect *ranking*, never *confinement*; the reranker must therefore tolerate a
  corrupt/missing cache by falling back to pure BM25.
- **Privacy**: the embed path sends chunk text — on a cache rebuild, the **whole**
  non-denylisted corpus, not just the slices a given run happens to `Read` — to the
  operator's **independently configured** embedding provider (`embed-config.json` has
  its own `provider`/`baseUrl`, which **may differ** from the chat-model provider).
  Enabling it is thus an explicit operator decision to extend the memory trust boundary
  to that provider; it is not automatically covered by the chat provider already seeing
  read memory. `CREDENTIALS.md` plus a configurable denylist are excluded from the
  embedded set by default.
- **Explicitly rejected** for Phase 2: a bundled local embedding model (native
  onnxruntime + ~100MB weights + cross-arch build cost directly contradicts the
  offline/lightweight ethos and the image-slimming just done). Noted only as a
  further-deferred alternative if a fully-keyless semantic path is ever wanted.

## Wiring

- **Grants/Dockerfile**: none. `Bash(files-cli *)` already grants `search` everywhere;
  the PATH shim already exists.
- **Prompt docs**: the three prompts that already carry a `files-cli grep` hint
  (`prompt.md`, `discord-prompt.md`, `heartbeat-prompt.md`) gain a line: use
  `files-cli search <query>` to find relevant memory by ranked relevance; use `grep`
  for an exact known string. `tui-prompt.md` (which grants `files-cli` via `TUI_TOOLS`
  but has no such hint today) gets the hint added fresh. `discord-reaction-prompt.md`
  is deliberately left untouched — it's the lean, no-op-biased reaction template and
  shouldn't grow retrieval nudges. This wiring is what drives adoption — the tool is
  inert if the run never reaches for it.

## Testing

Extend `app/scripts/files-cli.test.mjs`, following the existing pure-core + dispatch-
guard pattern (`import.meta.url` guard already lets the pure functions be imported
without triggering the CLI):
- **Chunker**: heading splits, leading pre-heading chunk, long-section windowing,
  correct 1-based start lines, non-markdown paragraph fallback.
- **Tokenizer**: lowercasing, non-alphanumeric splitting, empty-token drop, the
  documented trailing-`s` normalization.
- **BM25**: a rarer query term outranks a common one; a chunk matching two query terms
  outranks one matching a single term; zero-hit chunks are excluded; deterministic
  tie-break.
- **Formatter**: default snippet vs `--paths-only`, `-n` cap, output truncation caps.
- **Confinement**: `search foo ../` and a symlink-escape both refused, reusing the
  existing `confine()` cases; subpath restriction limits the corpus.

## Out of scope (this spec)

- The Phase-2 embedding reranker (specified above, built later).
- Any persistent lexical index (recompute-per-query is sufficient at current scale).
- A `memory-cli` with write-side CAS for `memory.md`/channel notes — a separate,
  already-noted follow-up (`CLAUDE.md`: "a future `memory-cli` would reuse this exact
  pattern"); this spec is read/retrieval only.
