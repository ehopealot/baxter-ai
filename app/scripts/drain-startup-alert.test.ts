import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginDrain, clearDrain, claimDrainStartupAlert, recoverDrain } from "./drain.ts";
import { alertOnDrainStartup } from "./drain-startup-alert.ts";

function withDrainPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "drain-startup-alert-"));
  return { dir, path: join(dir, "drain-state.json") };
}

test("a startup alert is atomically claimed once per drain generation", async () => {
  const { dir, path } = withDrainPath();
  try {
    await beginDrain(path);
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimDrainStartupAlert(path)));
    assert.equal(claims.filter(Boolean).length, 1);

    await clearDrain({ force: true }, path);
    await beginDrain(path);
    assert.equal(await claimDrainStartupAlert(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear and recovery reset a drain alert claim", async () => {
  const { dir, path } = withDrainPath();
  try {
    await beginDrain(path);
    assert.equal(await claimDrainStartupAlert(path), true);
    await clearDrain({ force: true }, path);
    assert.equal(await claimDrainStartupAlert(path), false);

    await beginDrain(path);
    assert.equal(await claimDrainStartupAlert(path), true);
    await recoverDrain(path);
    assert.equal(await claimDrainStartupAlert(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup alert posts once only while draining and only when configured", async () => {
  const { dir, path } = withDrainPath();
  try {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 204 };
    };
    const configured = { DISCORD_ALERT_WEBHOOK: "https://discord.test/alert" };

    await alertOnDrainStartup({ env: configured, path, fetchFn });
    assert.equal(calls.length, 0);
    await beginDrain(path);
    await Promise.all([
      alertOnDrainStartup({ env: configured, path, fetchFn }),
      alertOnDrainStartup({ env: configured, path, fetchFn }),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, configured.DISCORD_ALERT_WEBHOOK);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      content: "Baxter started while persistent drain state is active.",
    });

    await clearDrain({ force: true }, path);
    await beginDrain(path);
    await alertOnDrainStartup({ env: {}, path, fetchFn });
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup alert failures are best-effort and do not disclose the webhook URL", async () => {
  const { dir, path } = withDrainPath();
  try {
    await beginDrain(path);
    const errors: string[] = [];
    await alertOnDrainStartup({
      env: { DISCORD_ALERT_WEBHOOK: "https://discord.test/secret" },
      path,
      fetchFn: async () => { throw new Error("https://discord.test/secret unavailable"); },
      logErr: (message) => errors.push(message),
    });
    assert.deepEqual(errors, ["drain startup alert delivery failed"]);
    assert.equal(await claimDrainStartupAlert(path), false, "failed delivery remains a consumed best-effort attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
