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
  // Fixed (not Date.now()-at-call-time) so the two sequential run() calls --
  // one per adapter -- produce byte-identical queue entries to deepEqual.
  const FAR_FUTURE = Date.now() + 10_000_000;
  const mkEntry = (i: number) => ({ enqueuedAt: 1000 + i, expiresAt: FAR_FUTURE, message: { i } });
  const run = async (a: any) => {
    const out: unknown[] = [];
    await a.subscribe("t1"); out.push(await a.isSubscribed("t1"), await a.isSubscribed("t2"));
    out.push(await a.setIfNotExists("c", 1), await a.setIfNotExists("c", 2), await a.get("c"));
    await a.appendToList("L", "x", { maxLength: 2 }); await a.appendToList("L", "y", { maxLength: 2 });
    await a.appendToList("L", "z", { maxLength: 2 }); out.push(await a.getList("L"));
    const lock = await a.acquireLock("t1", 10_000); out.push(!!lock, await a.acquireLock("t1", 10_000));
    out.push(await a.extendLock(lock, 10_000), await a.extendLock({ ...lock, token: "bad" }, 10_000));
    await a.releaseLock(lock); out.push(!!(await a.acquireLock("t1", 10_000)));

    // queue: FIFO + maxSize trim (keeps newest), all far-future expiresAt so
    // this adapter's opportunistic TTL sweep and the oracle's no-op agree.
    out.push(await a.enqueue("q1", mkEntry(1), 2));
    out.push(await a.enqueue("q1", mkEntry(2), 2));
    out.push(await a.enqueue("q1", mkEntry(3), 2)); // trims entry 1, keeps 2 & 3
    out.push(await a.queueDepth("q1"));
    out.push(await a.dequeue("q1")); // entry 2
    out.push(await a.dequeue("q1")); // entry 3
    out.push(await a.dequeue("q1")); // empty -> null
    out.push(await a.queueDepth("q1"));

    // forceReleaseLock: unconditional, even after a stale-token releaseLock no-op
    const lock3 = await a.acquireLock("t3", 10_000); out.push(!!lock3);
    await a.releaseLock({ ...lock3, token: "bad" }); // no-op, lock still held
    out.push(!!(await a.acquireLock("t3", 10_000))); // still locked -> false
    await a.forceReleaseLock("t3");
    out.push(!!(await a.acquireLock("t3", 10_000))); // freed -> true

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

test("dequeue/queueDepth drop expired queue entries (sqlite-only; oracle does not sweep queue TTLs)", async () => {
  // Per the QueueEntry doc comment ("Stale entries are discarded on
  // dequeue") and the production ChatStateDO source this file is ported
  // from, expired queue entries should not be returned. But
  // @chat-adapter/state-memory's dequeue()/queueDepth() never check
  // entry.expiresAt at all (verified by reading
  // node_modules/@chat-adapter/state-memory/dist/index.js) -- so this is an
  // intentional, documented divergence from the oracle, not a bug to align
  // (modeled on the extendLock pin test above).
  // `as any`: a minimal fake is enough for both adapters (they only read
  // enqueuedAt/expiresAt off the entry; message just round-trips opaquely),
  // no need to construct a full Message.
  const staleEntry = { enqueuedAt: Date.now(), expiresAt: Date.now() - 1, message: {} } as any;

  const sql = createMailState(tmpDb());
  await sql.connect();
  await sql.enqueue("t1", staleEntry, 10);
  assert.equal(await sql.queueDepth("t1"), 0);
  assert.equal(await sql.dequeue("t1"), null);
  await sql.disconnect();

  const { createMemoryState } = await import("@chat-adapter/state-memory");
  const mem = createMemoryState();
  await mem.connect();
  await mem.enqueue("t1", staleEntry, 10);
  assert.equal(await mem.queueDepth("t1"), 1);
  assert.notEqual(await mem.dequeue("t1"), null);
  await mem.disconnect();
});

test("appendToList sweeps already-expired rows before refreshing the list TTL (matches oracle)", async () => {
  // Repro: append "a" with a short ttl, let it actually expire, then append
  // "b" with a fresh ttl. Without a sweep() at the top of appendToList, the
  // whole-list TTL-refresh UPDATE resurrects "a" (its row's expires_at gets
  // bumped to the new, future value before it's ever deleted for having
  // expired). The oracle (a single cache entry holding the whole array)
  // drops "a" as soon as it notices the cached list itself has expired,
  // regardless of the next append's ttl.
  const { createMemoryState } = await import("@chat-adapter/state-memory");
  const mem = createMemoryState(); await mem.connect();
  const sql = createMailState(tmpDb()); await sql.connect();
  const run = async (a: any) => {
    await a.appendToList("L", "a", { ttlMs: 20 });
    await new Promise((r) => setTimeout(r, 30));
    await a.appendToList("L", "b", { ttlMs: 100_000 });
    return await a.getList("L");
  };
  const sqlOut = await run(sql);
  const memOut = await run(mem);
  assert.deepEqual(sqlOut, memOut);
  assert.deepEqual(memOut, ["b"]);
  for (const a of [mem, sql]) await a.disconnect();
});

test("appendToList without ttlMs clears the whole list's expiry (matches oracle)", async () => {
  // Repro: append "a" with a short ttl, immediately append "b" with NO ttl,
  // then wait past "a"'s original ttl. The oracle re-derives the whole
  // list's expiry from every append -- including clearing it to
  // null/never-expire when ttlMs is absent -- so both "a" and "b" survive.
  // The buggy version only ran the refresh UPDATE `if (exp !== null)`, so a
  // ttlMs-less append silently left the list's prior (now-passed) expiry in
  // place and it got swept away.
  const { createMemoryState } = await import("@chat-adapter/state-memory");
  const mem = createMemoryState(); await mem.connect();
  const sql = createMailState(tmpDb()); await sql.connect();
  const run = async (a: any) => {
    await a.appendToList("N", "a", { ttlMs: 200 });
    await a.appendToList("N", "b"); // no ttlMs
    await new Promise((r) => setTimeout(r, 250));
    return await a.getList("N");
  };
  const sqlOut = await run(sql);
  const memOut = await run(mem);
  assert.deepEqual(sqlOut, memOut);
  assert.deepEqual(memOut, ["a", "b"]);
  for (const a of [mem, sql]) await a.disconnect();
});
