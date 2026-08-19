// Tests for the file-access log: recording (path relativization + skips), folding events to a
// per-path summary, folding compacted summary lines, and size-triggered compaction. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFileAccess, foldEvents, readSummaries, serializeSummaries, compactIfLarge } from "./access-log.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "al-"));

test("recordFileAccess is a no-op when logPath is unset (instrumentation stays opt-in)", () => {
  const cwd = tmp();
  recordFileAccess(undefined, cwd, join(cwd, "a.txt"), "r"); // must not throw, nothing to assert but the no-throw
});

test("recordFileAccess keys by cwd-relative path and appends one JSONL event", () => {
  const cwd = tmp();
  const log = join(cwd, "log.jsonl");
  recordFileAccess(log, cwd, join(cwd, "collections", "kx.md"), "r", 1000);
  recordFileAccess(log, cwd, join(cwd, "collections", "kx.md"), "w", 2000);
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ t: 1000, k: "r", p: "collections/kx.md" }, { t: 2000, k: "w", p: "collections/kx.md" }]);
});

test("recordFileAccess skips paths outside cwd and the ephemeral .claude/ staging dir", () => {
  const cwd = tmp();
  const log = join(cwd, "log.jsonl");
  recordFileAccess(log, cwd, join(cwd, "..", "secret.json"), "r"); // escapes cwd
  recordFileAccess(log, cwd, join(cwd, ".claude", "skills", "x", "SKILL.md"), "r"); // ephemeral
  recordFileAccess(log, cwd, cwd, "r"); // cwd itself (rel ".")
  assert.equal(existsSync(log), false); // nothing recorded
});

test("foldEvents reduces to per-path last-read/last-write + counts, keeping the latest timestamp", () => {
  const text = [
    { t: 100, k: "r", p: "a.md" },
    { t: 300, k: "r", p: "a.md" },
    { t: 200, k: "w", p: "a.md" },
    { t: 50, k: "r", p: "b.md" },
  ].map((e) => JSON.stringify(e)).join("\n");
  const m = foldEvents(text);
  assert.deepEqual(m.get("a.md"), { path: "a.md", lastRead: 300, lastWrite: 200, reads: 2, writes: 1 });
  assert.deepEqual(m.get("b.md"), { path: "b.md", lastRead: 50, lastWrite: null, reads: 1, writes: 0 });
});

test("foldEvents tolerates blank and unparseable lines", () => {
  const text = `\n{bad json\n${JSON.stringify({ t: 5, k: "r", p: "a" })}\n{"p":"x"}\n`; // missing t on last
  const m = foldEvents(text);
  assert.equal(m.size, 1);
  assert.equal(m.get("a")?.reads, 1);
});

test("foldEvents merges compacted summary lines (round-trips through serializeSummaries)", () => {
  const events = foldEvents([{ t: 100, k: "r", p: "a" }, { t: 200, k: "w", p: "a" }].map((e) => JSON.stringify(e)).join("\n"));
  const compacted = serializeSummaries(events);
  // A later raw event on top of the compacted summary keeps accumulating.
  const merged = foldEvents(compacted + JSON.stringify({ t: 300, k: "r", p: "a" }) + "\n");
  assert.deepEqual(merged.get("a"), { path: "a", lastRead: 300, lastWrite: 200, reads: 2, writes: 1 });
});

test("readSummaries on a missing log is an empty map (not a throw)", () => {
  assert.equal(readSummaries(join(tmp(), "nope.jsonl")).size, 0);
});

test("compactIfLarge rewrites to one summary line per path past the cap; preserves the fold", () => {
  const log = join(tmp(), "log.jsonl");
  // 5 events across 2 paths.
  const raw = [
    { t: 1, k: "r", p: "a" }, { t: 2, k: "r", p: "a" }, { t: 3, k: "w", p: "a" },
    { t: 4, k: "r", p: "b" }, { t: 5, k: "r", p: "b" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(log, raw);
  assert.equal(compactIfLarge(log, 100), false); // under the cap -> untouched
  assert.equal(readFileSync(log, "utf8"), raw);
  assert.equal(compactIfLarge(log, 3), true); // over the cap -> compacted
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 2); // one summary per path
  const folded = readSummaries(log);
  assert.deepEqual(folded.get("a"), { path: "a", lastRead: 2, lastWrite: 3, reads: 2, writes: 1 });
  assert.deepEqual(folded.get("b"), { path: "b", lastRead: 5, lastWrite: null, reads: 2, writes: 0 });
});

test("compactIfLarge on a missing log is a no-op", () => {
  assert.equal(compactIfLarge(join(tmp(), "nope.jsonl")), false);
});
