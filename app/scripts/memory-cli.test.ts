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
function runAsync(home: string, args: string[], input: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home } });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stderr }));
    child.stdin.end(input);
  });
}

test("a misinvocation (no subcommand -- e.g. the command piped to stdin instead of args) EXITS NONZERO, so run_cli reports failure and a model self-corrects instead of looping on an exit-0 usage dump", () => {
  const { home } = homeDir();
  // No args at all (bare) -- what run_cli produces when the model sends {cli:"memory-cli"}.
  const bare = run(home, []);
  assert.notEqual(bare.status, 0, "bare memory-cli must exit nonzero (was exit 0, which read as ok:true)");
  assert.match(bare.stderr, /usage:/, "usage goes to stderr as a diagnostic, not stdout");
  assert.equal(bare.stdout, "", "no usage on stdout -- an exit-0-looking success is what caused the loop");
  // The exact incident shape: the subcommand piped to STDIN with no args -> still no argv command.
  const stdinMisuse = run(home, [], "read memory");
  assert.notEqual(stdinMisuse.status, 0, "command-in-stdin (no args) must also fail, not return usage as success");
  // A genuinely unknown subcommand stays nonzero too.
  assert.notEqual(run(home, ["bogus"]).status, 0);
});

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

test("write --expect is a cross-process CAS: two racers on one base -> exactly one wins", async () => {
  const { home, memPath } = homeDir();
  mkdirSync(dirname(memPath), { recursive: true });
  writeFileSync(memPath, "# base\n");
  const base = versionToken(Buffer.from("# base\n")); // both start from this version
  const [a, b] = await Promise.all([
    runAsync(home, ["write", "memory", "--expect", base], "AAA\n"),
    runAsync(home, ["write", "memory", "--expect", base], "BBB\n"),
  ]);
  assert.deepEqual([a.code, b.code].sort(), [0, 1], "exactly one winner (exit 0) and one CAS reject (exit 1)");
  // the loser must fail *because of* the stale-version reject, not a lock timeout / other error
  const loser = [a, b].find((r) => r.code === 1)!;
  assert.match(loser.stderr, /changed since you read it/i);
  const final = readFileSync(memPath, "utf8");
  assert.ok(final === "AAA\n" || final === "BBB\n", `file holds one winner's whole body, got ${JSON.stringify(final)}`);
});

test("append is lossless across concurrent PROCESSES (the lock holds)", async () => {
  const { home, memPath } = homeDir();
  mkdirSync(dirname(memPath), { recursive: true });
  writeFileSync(memPath, "# Memory\n"); // shared base both children append onto
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => runAsync(home, ["append", "memory"], `- fact ${i}`)),
  );
  assert.deepEqual(results.map((r) => r.code), Array(N).fill(0), "every concurrent append exited 0");
  const final = readFileSync(memPath, "utf8");
  for (let i = 0; i < N; i++) {
    assert.match(final, new RegExp(`- fact ${i}(\\n|$)`), `lost fact ${i} (a lock failure)`);
  }
});
