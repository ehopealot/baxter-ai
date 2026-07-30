// Tests for memory-cli: the pure resolver/reader, plus end-to-end CLI runs with
// HOME pointed at a throwaway dir (so MEMORY_PATH, derived from homedir(), lives
// under it -- never the real workspace). The cross-process append test proves the
// lock holds across processes, the load-bearing half of the concurrency guarantee.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { targetPath, readMemory } from "./memory-cli.ts";
import { versionToken } from "./cas-file.ts";

const CLI = fileURLToPath(new URL("./memory-cli.ts", import.meta.url));
const EMPTY = versionToken(Buffer.alloc(0));

function homeDir(): { home: string; memPath: string } {
  const home = mkdtempSync(join(tmpdir(), "memcli-"));
  return { home, memPath: join(home, ".mail-agent", "memory-workspace", "memory.md") };
}
function run(home: string, args: string[], input = ""): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { ...process.env, HOME: home } });
  return { status: r.status ?? 0, stdout: r.stdout, stderr: r.stderr };
}
function runAsync(home: string, args: string[], input: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home } });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
    child.stdin.end(input);
  });
}

test("targetPath: default memory, case-insensitive, credentials, and unknown/traversal rejected", () => {
  const map = { memory: "/m/memory.md", credentials: "/m/CREDENTIALS.md" };
  assert.equal(targetPath(undefined, map).path, "/m/memory.md");
  assert.equal(targetPath("MEMORY", map).name, "memory");
  assert.equal(targetPath("credentials", map).path, "/m/CREDENTIALS.md");
  assert.throws(() => targetPath("../../etc/passwd", map), /unknown memory target/);
  assert.throws(() => targetPath("secrets", map), /unknown memory target/);
});

test("readMemory: missing -> empty + empty-version; existing -> buf + its version", () => {
  const d = mkdtempSync(join(tmpdir(), "mem-"));
  const p = join(d, "memory.md");
  const r0 = readMemory(p);
  assert.equal(r0.buf.length, 0);
  assert.equal(r0.version, EMPTY); // e3b0c442
  writeFileSync(p, "hello\n");
  const r1 = readMemory(p);
  assert.equal(r1.buf.toString(), "hello\n");
  assert.equal(r1.version, versionToken(Buffer.from("hello\n")));
});

test("CLI read vends the version on stderr, body on stdout; a not-yet-written file is empty", () => {
  const { home } = homeDir();
  const r = run(home, ["read", "memory"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, ""); // no file yet -> empty body
  assert.match(r.stderr, /version: e3b0c442/); // empty-buffer token
});

test("CLI append creates then adds; write --expect round-trips and rejects a stale token", () => {
  const { home, memPath } = homeDir();
  assert.equal(run(home, ["append", "memory"], "- fact one").status, 0); // creates
  assert.equal(readFileSync(memPath, "utf8"), "- fact one");
  const version = run(home, ["read", "memory"]).stderr.match(/version: ([0-9a-f]{8})/)![1];
  const w = run(home, ["write", "memory", "--expect", version], "# Memory\n- fact one\n- fact two\n");
  assert.equal(w.status, 0);
  assert.match(readFileSync(memPath, "utf8"), /fact two/);
  // a second write on the now-STALE token is rejected, file untouched
  const stale = run(home, ["write", "memory", "--expect", version], "clobber\n");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /changed since you read it/i);
  assert.doesNotMatch(readFileSync(memPath, "utf8"), /clobber/);
});

test("CLI rejects an unknown target and a missing --expect", () => {
  const { home } = homeDir();
  const bad = run(home, ["read", "secrets"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown memory target/);
  const noExpect = run(home, ["write", "memory"], "x");
  assert.equal(noExpect.status, 1);
  assert.match(noExpect.stderr, /--expect|read .*then write|version/i);
});

test("append is lossless across concurrent PROCESSES (the lock holds)", async () => {
  const { home, memPath } = homeDir();
  mkdirSync(dirname(memPath), { recursive: true });
  writeFileSync(memPath, "# Memory\n"); // shared base both children append onto
  const N = 8;
  const codes = await Promise.all(
    Array.from({ length: N }, (_, i) => runAsync(home, ["append", "memory"], `- fact ${i}`)),
  );
  assert.deepEqual(codes, Array(N).fill(0), "every concurrent append exited 0");
  const final = readFileSync(memPath, "utf8");
  for (let i = 0; i < N; i++) {
    assert.match(final, new RegExp(`- fact ${i}(\\n|$)`), `lost fact ${i} (a lock failure)`);
  }
});
