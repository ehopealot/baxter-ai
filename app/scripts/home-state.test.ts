// Tests for the home surface's durable sync state: round-trip, missing-file default, and a
// malformed file falling back to fresh rather than wedging the surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, freshState } from "./home-state.ts";

const statePath = (): string => join(mkdtempSync(join(tmpdir(), "home-")), "sync-state.json");

test("loadState on a missing file is the fresh state (not a throw)", () => {
  assert.deepEqual(loadState(statePath()), freshState());
});

test("saveState -> loadState round-trips every field", () => {
  const p = statePath();
  const s = { appliedThrough: 42, publishedVersion: "abc", oversizedProjectsDigest: "d", projectsLatchAt: 111, pubFatalVersion: "b", pubFatalAt: 222 };
  saveState(s, p);
  assert.deepEqual(loadState(p), s);
});

test("a malformed state file falls back to fresh (a corrupt cursor must not wedge the surface)", () => {
  const p = statePath();
  writeFileSync(p, "{ not json");
  assert.deepEqual(loadState(p), freshState());
});

test("an older on-disk shape (missing fields) upgrades cleanly from fresh defaults", () => {
  const p = statePath();
  writeFileSync(p, JSON.stringify({ appliedThrough: 7 }));
  const s = loadState(p);
  assert.equal(s.appliedThrough, 7);
  assert.equal(s.publishedVersion, null); // backfilled
  assert.equal(s.pubFatalVersion, null);
});
