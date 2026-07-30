// Unit tests for the shared CAS core (cas-file.ts). projects-cli.test.ts already
// exercises casSave's reject + cross-process lock via saveProject; these cover the
// paths projects-cli never hits (it pre-checks existence): create-on-write (ENOENT
// current -> empty-buffer token) and casAppend. The memory-cli cross-process lock
// test proves the lock across processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionToken, normalizeExpected, casSave, casAppend } from "./cas-file.ts";

const EMPTY = versionToken(Buffer.alloc(0)); // the token a not-yet-created file reads as
const dir = (): string => mkdtempSync(join(tmpdir(), "cas-"));

test("versionToken is 8 hex of sha256 over raw bytes (empty -> e3b0c442)", () => {
  assert.match(versionToken(Buffer.from("hi")), /^[0-9a-f]{8}$/);
  assert.equal(versionToken(Buffer.alloc(0)), "e3b0c442");
});

test("normalizeExpected lowercases a valid token, rejects empty + malformed", () => {
  assert.equal(normalizeExpected("ABCDEF01", "hint"), "abcdef01");
  assert.throws(() => normalizeExpected("", "run read first"), /--expect[\s\S]*run read first/);
  assert.throws(() => normalizeExpected("   ", "h"), /--expect/);
  assert.throws(() => normalizeExpected("zzz", "h"), /8-character hex/);
});

test("casSave creates a missing file when --expect is the empty-buffer token (create-on-write)", async () => {
  const p = join(dir(), "memory.md");
  assert.equal(existsSync(p), false);
  const r = await casSave(p, Buffer.from("first\n"), EMPTY, "memory", "re-read it");
  assert.equal(readFileSync(p, "utf8"), "first\n");
  assert.equal(r.version, versionToken(Buffer.from("first\n")));
});

test("casSave on a missing file rejects a non-empty token (must match the empty version)", async () => {
  const p = join(dir(), "memory.md");
  await assert.rejects(casSave(p, Buffer.from("x"), "00000000", "memory", "re-read it"), /changed since you read it/i);
  assert.equal(existsSync(p), false); // nothing written
});

test("casSave rejects a stale token, leaves the file, never echoes the current token", async () => {
  const p = join(dir(), "m.md");
  writeFileSync(p, "current\n");
  const current = versionToken(Buffer.from("current\n"));
  await assert.rejects(
    casSave(p, Buffer.from("stale edit\n"), "00000000", "memory", "re-read it"),
    (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /changed since you read it/i);
      assert.ok(!m.includes(current), "reject leaked the current token");
      return true;
    },
  );
  assert.equal(readFileSync(p, "utf8"), "current\n"); // unchanged
});

test("casSave round-trips and vends the new token for a chained write", async () => {
  const p = join(dir(), "m.md");
  const r1 = await casSave(p, Buffer.from("one\n"), EMPTY, "m", "h");
  const r2 = await casSave(p, Buffer.from("two\n"), r1.version, "m", "h"); // no re-read needed
  assert.equal(readFileSync(p, "utf8"), "two\n");
  assert.equal(r2.version, versionToken(Buffer.from("two\n")));
});

test("casAppend creates a missing file, then separates with exactly one newline", async () => {
  const p = join(dir(), "m.md");
  await casAppend(p, Buffer.from("- fact one")); // creates (no leading newline)
  assert.equal(readFileSync(p, "utf8"), "- fact one");
  await casAppend(p, Buffer.from("- fact two")); // tail has no NL -> insert one
  assert.equal(readFileSync(p, "utf8"), "- fact one\n- fact two");
  writeFileSync(p, "a\n");
  await casAppend(p, Buffer.from("b")); // tail already ends in NL -> don't double it
  assert.equal(readFileSync(p, "utf8"), "a\nb");
});

test("casAppend with an empty body is a no-op (no bare newline, no file created, version unchanged)", async () => {
  const p = join(dir(), "m.md");
  // missing file: an empty append must NOT create it
  const r0 = await casAppend(p, Buffer.alloc(0));
  assert.equal(existsSync(p), false);
  assert.equal(r0.version, EMPTY);
  // existing file with no trailing newline: an empty append must not add a bare \n
  writeFileSync(p, "no newline");
  const before = versionToken(Buffer.from("no newline"));
  const r1 = await casAppend(p, Buffer.alloc(0));
  assert.equal(readFileSync(p, "utf8"), "no newline");
  assert.equal(r1.version, before);
});

test("casAppend enforces maxBytes on the MERGED size, writing nothing when over", async () => {
  const p = join(dir(), "m.md");
  await casAppend(p, Buffer.from("12345"), 10);            // 5 bytes, under 10 -> ok
  assert.equal(readFileSync(p, "utf8"), "12345");
  await assert.rejects(casAppend(p, Buffer.from("67890abc"), 10), /exceed the .* cap/); // 5+1+8 > 10
  assert.equal(readFileSync(p, "utf8"), "12345");          // unchanged -- nothing written
});

test("no temp file is left behind after a save or append", async () => {
  const d = dir();
  const p = join(d, "m.md");
  await casSave(p, Buffer.from("x"), EMPTY, "m", "h");
  await casAppend(p, Buffer.from("y"));
  assert.deepEqual(readdirSync(d).filter((f) => f.includes(".tmp")), []);
});
