import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginDrain,
  clearDrain,
  drainStatus,
  releaseRunLease,
  recoverDrain,
  tryAcquireRunLease,
} from "./drain.ts";

function withDrainPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "drain-"));
  return { dir, path: join(dir, "drain-state.json") };
}

test("a run lease is persisted with its own random key and released idempotently", async () => {
  const { dir, path } = withDrainPath();
  try {
    const acquired = await tryAcquireRunLease({ surface: "mail" }, path);
    assert.equal(acquired.accepted, true);
    if (!acquired.accepted) throw new Error("expected lease");
    assert.equal(acquired.lease.surface, "mail");
    assert.equal(acquired.lease.pid, process.pid);
    assert.ok(acquired.lease.hostname);
    assert.ok(acquired.lease.startedAt);

    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(persisted.leases), [acquired.lease.id]);
    assert.equal(persisted.leases[acquired.lease.id].id, undefined);

    await releaseRunLease(acquired.lease.id, path);
    await releaseRunLease(acquired.lease.id, path);
    assert.deepEqual((await drainStatus(path)).leases, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent acquisition preserves every individually keyed lease", async () => {
  const { dir, path } = withDrainPath();
  try {
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => tryAcquireRunLease({ surface: `surface-${i}` }, path)));
    assert.ok(attempts.every((attempt) => attempt.accepted));
    const status = await drainStatus(path);
    assert.equal(Object.keys(status.leases).length, attempts.length);
    assert.equal(new Set(Object.keys(status.leases)).size, attempts.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draining rejects new leases and clear refuses while leases remain unless forced", async () => {
  const { dir, path } = withDrainPath();
  try {
    const acquired = await tryAcquireRunLease({ surface: "discord" }, path);
    assert.equal(acquired.accepted, true);
    if (!acquired.accepted) throw new Error("expected lease");
    await beginDrain(path);
    assert.deepEqual(await tryAcquireRunLease({ surface: "sms" }, path), { accepted: false });

    await assert.rejects(clearDrain({}, path), /active leases/i);
    assert.equal((await drainStatus(path)).draining, true);
    await clearDrain({ force: true }, path);
    const forced = await drainStatus(path);
    assert.equal(forced.draining, false);
    assert.deepEqual(Object.keys(forced.leases), [acquired.lease.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit recovery clears durable stranded leases and the drain marker", async () => {
  const { dir, path } = withDrainPath();
  try {
    const acquired = await tryAcquireRunLease({ surface: "light" }, path);
    assert.equal(acquired.accepted, true);
    await beginDrain(path);
    assert.equal(Object.keys((await drainStatus(path)).leases).length, 1);
    assert.deepEqual(await recoverDrain(path), { draining: false, leases: {} });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { draining: false, leases: {}, startupAlertClaimed: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt state fails closed without overwriting the durable file", async () => {
  const { dir, path } = withDrainPath();
  try {
    writeFileSync(path, "not json");
    assert.deepEqual(await tryAcquireRunLease({ surface: "mail" }, path), { accepted: false });
    await assert.rejects(beginDrain(path), /corrupt/i);
    await assert.rejects(clearDrain({}, path), /corrupt/i);
    assert.deepEqual(await drainStatus(path), { draining: true, leases: {} });
    assert.equal(readFileSync(path, "utf8"), "not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
