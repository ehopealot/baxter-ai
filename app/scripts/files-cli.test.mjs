import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine, listWorkspace, grepWorkspace, parseGrepArgs, tokenize, chunkText, rankChunks, bestSnippet, searchWorkspace } from "./files-cli.mjs";

// Build a throwaway workspace with a sibling "outside" dir (stands in for the
// parent ~/.mail-agent where the tokens live) and a symlink escaping into it.
function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "files-cli-"));
  const root = join(tmp, "workspace");
  const outside = join(tmp, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(root, "discord"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "memory.md"), "remember: the API key is in CREDENTIALS\nsecond line\n");
  writeFileSync(join(root, "discord", "123.md"), "channel note: Baxter said hi\n");
  writeFileSync(join(root, ".git", "config"), "should-not-be-searched\n");
  writeFileSync(join(outside, "secret.txt"), "TOKEN=super-secret\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "escape-link")); // symlink out
  return { tmp, root, outside };
}

test("confine accepts paths inside the workspace, rejects escapes", () => {
  const { root } = fixture();
  assert.equal(confine(root, ".").target, confine(root, ".").base);
  assert.equal(confine(root, "discord").target, join(confine(root, ".").base, "discord"));
  assert.throws(() => confine(root, "../outside"), /escapes the workspace/);
  assert.throws(() => confine(root, "/etc"), /escapes the workspace/);
  // A symlink pointing outside is rejected when targeted directly (realpath
  // resolves it out of the tree).
  assert.throws(() => confine(root, "escape-link"), /escapes the workspace/);
});

test("listWorkspace lists files sorted, skips symlinks and .git, never leaks outside", () => {
  const { root } = fixture();
  const { files } = listWorkspace(root, ".");
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, ["discord/123.md", "memory.md"]);
  // The escaping symlink's target is never listed...
  assert.ok(!paths.some((p) => p.includes("secret")));
  // ...and .git is not descended into.
  assert.ok(!paths.some((p) => p.startsWith(".git")));
});

test("grepWorkspace finds matches with file+line, relative to the workspace", () => {
  const { root } = fixture();
  const { results } = grepWorkspace(root, "Baxter");
  assert.equal(results.length, 1);
  assert.equal(results[0].file, "discord/123.md");
  assert.equal(results[0].line, 1);
  assert.match(results[0].text, /Baxter said hi/);
});

test("grepWorkspace -i is case-insensitive; default is case-sensitive", () => {
  const { root } = fixture();
  assert.equal(grepWorkspace(root, "baxter").results.length, 0);
  assert.equal(grepWorkspace(root, "baxter", { ignoreCase: true }).results.length, 1);
});

test("grepWorkspace cannot reach a file outside the workspace via a symlink", () => {
  const { root } = fixture();
  // The secret lives outside; the only pointer to it is the escaping symlink,
  // which the walk skips -- so a search for its content finds nothing.
  assert.equal(grepWorkspace(root, "super-secret").results.length, 0);
  // And targeting the symlink directly is refused.
  assert.throws(() => grepWorkspace(root, "TOKEN", { sub: "escape-link" }), /escapes the workspace/);
});

test("grepWorkspace skips binary files (NUL byte) and rejects an empty pattern", () => {
  const { root } = fixture();
  writeFileSync(join(root, "blob.bin"), Buffer.from([0x42, 0x00, 0x42, 0x41, 0x58])); // contains NUL
  assert.equal(grepWorkspace(root, "BAX").results.length, 0);
  assert.throws(() => grepWorkspace(root, ""), /non-empty pattern/);
});

test("parseGrepArgs handles -i, pattern, optional subpath, and rejects misuse", () => {
  assert.deepEqual(parseGrepArgs(["needle"]), { pattern: "needle", sub: ".", ignoreCase: false });
  assert.deepEqual(parseGrepArgs(["-i", "needle", "discord"]), { pattern: "needle", sub: "discord", ignoreCase: true });
  assert.throws(() => parseGrepArgs([]), /usage/);
  assert.throws(() => parseGrepArgs(["a", "b", "c"]), /usage/);
  assert.throws(() => parseGrepArgs(["--bogus", "x"]), /unknown flag/);
});

test("parseGrepArgs `--` ends flags so a dash-leading pattern is searchable", () => {
  assert.deepEqual(parseGrepArgs(["--", "--file"]), { pattern: "--file", sub: ".", ignoreCase: false });
  assert.deepEqual(parseGrepArgs(["-i", "--", "-x", "discord"]), { pattern: "-x", sub: "discord", ignoreCase: true });
});

test("grepWorkspace finds a pattern that starts with a dash (through `--`)", () => {
  const { root } = fixture();
  writeFileSync(join(root, "notes.md"), "run it with --file scan.py\n");
  const { pattern, sub, ignoreCase } = parseGrepArgs(["--", "--file"]);
  const { results } = grepWorkspace(root, pattern, { sub, ignoreCase });
  assert.equal(results.length, 1);
  assert.equal(results[0].file, "notes.md");
});

test("grepWorkspace yields matches in ascending path order within a directory", () => {
  const { root } = fixture();
  writeFileSync(join(root, "a.md"), "zzz\n");
  writeFileSync(join(root, "z.md"), "zzz\n");
  const files = grepWorkspace(root, "zzz").results.map((r) => r.file);
  assert.deepEqual(files, ["a.md", "z.md"]); // not reverse-sorted
});

test("grepWorkspace flags truncation when the match cap (300) is exceeded", () => {
  const { root } = fixture();
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i} needle`).join("\n");
  writeFileSync(join(root, "many.md"), lines + "\n");
  const { results, truncated } = grepWorkspace(root, "needle");
  assert.equal(results.length, 300);
  assert.equal(truncated, true);
});

test("tokenize lowercases, splits on non-alphanumerics, drops empties, strips plural s", () => {
  assert.deepEqual(tokenize("Final Scores!!"), ["final", "score"]);
  assert.deepEqual(tokenize("  a,b--c  "), ["a", "b", "c"]); // short tokens keep their s-less selves
  assert.deepEqual(tokenize("keys APIs notes"), ["key", "api", "note"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("is as"), ["is", "as"]); // len<=3 not stripped -> "as" stays "as"
});

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
  const { root } = fixture();
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
