import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncDataKeysFromEnv } from "./data-keys.ts";

test("merges YOUTUBE_API_KEY from env, preserving existing keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    writeFileSync(p, JSON.stringify({ OTHER_KEY: "keep" }));
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "AIzaXYZ" } as NodeJS.ProcessEnv, p);
    const out = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(out.YOUTUBE_API_KEY, "AIzaXYZ");
    assert.equal(out.OTHER_KEY, "keep");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no-op when the env var is unset — does not create the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    syncDataKeysFromEnv({} as NodeJS.ProcessEnv, p);
    assert.throws(() => statSync(p)); // file never created
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("creates the file 0600 when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p);
    assert.equal(statSync(p).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("idempotent: already-synced value doesn't rewrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p);
    const m1 = statSync(p).mtimeMs;
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p);
    assert.equal(readFileSync(p, "utf8").includes("\"k\""), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
