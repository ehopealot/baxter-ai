import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine, listWorkspace, grepWorkspace, parseGrepArgs } from "./files-cli.mjs";

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
