import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailState } from "./mail-state-sqlite.ts";

function tmpDb() { return join(mkdtempSync(join(tmpdir(), "mailstate-")), "s.db"); }

test("subscriptions persist across reopen", async () => {
  const db = tmpDb();
  const a = createMailState(db);
  await a.connect();
  await a.subscribe("resend:x@bax.bot:abc");
  assert.equal(await a.isSubscribed("resend:x@bax.bot:abc"), true);
  await a.disconnect();

  const b = createMailState(db);           // reopen same file
  await b.connect();
  assert.equal(await b.isSubscribed("resend:x@bax.bot:abc"), true);
  await b.unsubscribe("resend:x@bax.bot:abc");
  assert.equal(await b.isSubscribed("resend:x@bax.bot:abc"), false);
  await b.disconnect();
});

test("cache get/set/setIfNotExists/delete + TTL expiry", async () => {
  const a = createMailState(tmpDb());
  await a.connect();
  await a.set("k", { v: 1 });
  assert.deepEqual(await a.get("k"), { v: 1 });
  assert.equal(await a.setIfNotExists("k", { v: 2 }), false);
  assert.equal(await a.setIfNotExists("k2", { v: 2 }), true);
  await a.set("ttl", "gone", 1);           // 1ms ttl
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await a.get("ttl"), null);
  await a.delete("k");
  assert.equal(await a.get("k"), null);
  await a.disconnect();
});

test("matches in-memory adapter across the full op sequence", async () => {
  const { createMemoryState } = await import("@chat-adapter/state-memory");
  const mem = createMemoryState(); const sql = createMailState(tmpDb());
  for (const a of [mem, sql]) await a.connect();
  const run = async (a: any) => {
    const out: unknown[] = [];
    await a.subscribe("t1"); out.push(await a.isSubscribed("t1"), await a.isSubscribed("t2"));
    out.push(await a.setIfNotExists("c", 1), await a.setIfNotExists("c", 2), await a.get("c"));
    await a.appendToList("L", "x", { maxLength: 2 }); await a.appendToList("L", "y", { maxLength: 2 });
    await a.appendToList("L", "z", { maxLength: 2 }); out.push(await a.getList("L"));
    const lock = await a.acquireLock("t1", 10_000); out.push(!!lock, await a.acquireLock("t1", 10_000));
    out.push(await a.extendLock(lock, 10_000), await a.extendLock({ ...lock, token: "bad" }, 10_000));
    await a.releaseLock(lock); out.push(!!(await a.acquireLock("t1", 10_000)));
    return out;
  };
  assert.deepEqual(await run(sql), await run(mem));
  for (const a of [mem, sql]) await a.disconnect();
});

test("extendLock on an already-expired lock matches the oracle (returns false)", async () => {
  // Discovered via direct read of @chat-adapter/state-memory's dist/index.js:
  // extendLock checks `existingLock.expiresAt < Date.now()` and returns false
  // (even for the correct token) if the lock has already expired. A negative
  // ttlMs at acquire time creates an already-expired lock with no need to
  // sleep, so both adapters can be compared deterministically.
  const { createMemoryState } = await import("@chat-adapter/state-memory");
  const mem = createMemoryState(); const sql = createMailState(tmpDb());
  for (const a of [mem, sql]) await a.connect();
  const run = async (a: any) => {
    const lock = await a.acquireLock("t2", -1); // already expired
    return await a.extendLock(lock, 10_000);
  };
  assert.equal(await run(sql), await run(mem));
  assert.equal(await run(mem), false);
  for (const a of [mem, sql]) await a.disconnect();
});
