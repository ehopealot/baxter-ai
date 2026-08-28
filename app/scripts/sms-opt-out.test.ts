import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSmsOptedOut, setSmsOptOut } from "./sms-opt-out.ts";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";

function fixture(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "sms-opt-out-"));
  return { dir, env: { SMS_OPT_OUT_PATH_OVERRIDE: join(dir, "opt-outs.json") } };
}

test("opt-out state round-trips both E.164 digit-count boundaries accepted by the shared phone predicate", async () => {
  const { dir, env } = fixture();
  try {
    await setSmsOptOut("+1234567", true, env);
    await setSmsOptOut("+123456789012345", true, env);
    assert.equal(await isSmsOptedOut("+1234567", env), true);
    assert.equal(await isSmsOptedOut("+123456789012345", env), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an uncertain STOP directory barrier is re-fsynced on idempotent redelivery", async () => {
  const { dir, env } = fixture();
  await setSmsOptOut("+15551234567", false, env);
  let restore = setDurableDirectorySyncForTest(() => { throw new Error("injected STOP directory fsync failure"); });
  try {
    await assert.rejects(setSmsOptOut("+15551234567", true, env), /directory fsync failure/);
    restore();
    const synced: string[] = [];
    restore = setDurableDirectorySyncForTest(path => { synced.push(path); });
    await setSmsOptOut("+15551234567", true, env);
    assert.ok(synced.includes(dir), "redelivery repeats the parent directory durability barrier");
    assert.equal(isSmsOptedOut("+15551234567", env), true);
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("opt-out state rejects persisted numbers outside the shared strict E.164 shape", async () => {
  for (const invalid of ["+123456", "+1234567890123456", "+0234567", "1234567"]) {
    const { dir, env } = fixture();
    try {
      writeFileSync(env.SMS_OPT_OUT_PATH_OVERRIDE!, JSON.stringify({ version: 1, numbers: [invalid] }));
      await assert.rejects(async () => isSmsOptedOut("+1234567", env), /opt-out state invalid/i, invalid);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
