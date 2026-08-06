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
    const ino1 = statSync(p).ino;
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p);
    // Prove no rewrite happened: the atomic write path (writeFileSync tmp + renameSync)
    // would produce a NEW inode, so an unchanged inode is proof the second call was a
    // true no-op, not just a same-content rewrite.
    assert.equal(statSync(p).ino, ino1, "second identical call must not rewrite the file");
    assert.equal(readFileSync(p, "utf8").includes("\"k\""), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed keys file (valid JSON, wrong shape) throws and is not silently overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    writeFileSync(p, "[]");
    assert.throws(
      () => syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p),
      /data-keys file at .* is not a JSON object/,
    );
    // The file must not have been silently overwritten (dropping whatever was there).
    assert.equal(readFileSync(p, "utf8"), "[]");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("keys file with invalid JSON syntax still throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    writeFileSync(p, "not json");
    assert.throws(() => syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
