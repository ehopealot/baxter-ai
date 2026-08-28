import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function child(code: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    processChild.stdout.on("data", data => { stdout += data; });
    processChild.stderr.on("data", data => { stderr += data; });
    processChild.on("error", reject);
    processChild.on("exit", status => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child ${status}`)));
  });
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; !existsSync(path) && attempt < 400; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(path), true, `expected ${path}`);
}

test("parallel processes serialize preparation so one immutable provider operation wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-receipt-lock-"));
  const workId = "e".repeat(64);
  const holderLocked = join(dir, "holder-locked");
  const releaseHolder = join(dir, "release-holder");
  const observerDone = join(dir, "observer-done");
  const moduleUrl = new URL("./mail-delivery-receipts.ts", import.meta.url).href;
  const receiptPath = join(dir, `${workId}.json`);
  const operation = (label: string) => ({
    kind: "send",
    address: `${label}@example.com`,
    providerPayload: { from: "Baxter <me@example.com>", to: `${label}@example.com`, subject: label, text: label },
    transcript: { direction: "out", at: "2026-08-27T00:00:00.000Z", subject: label, content: label, workId },
  });
  const attempt = `async (m, operation) => { try { const receipt = await m.recordMailDeliveryPreparation(${JSON.stringify(workId)}, operation); return { ok: true, subject: receipt.operation.transcript.subject }; } catch (error) { return { ok: false, error: String(error.message ?? error) }; } }`;

  try {
    const holder = child(`
      import { existsSync, writeFileSync } from "node:fs";
      import lockfile from "proper-lockfile";
      const m = await import(${JSON.stringify(moduleUrl)});
      const operation = ${JSON.stringify(operation("holder"))};
      const attempt = ${attempt};
      const release = await lockfile.lock(${JSON.stringify(receiptPath)}, { realpath: false, stale: 10000, retries: { retries: 30, minTimeout: 30, maxTimeout: 300 } });
      writeFileSync(process.env.HOLDER_LOCKED, "locked");
      while (!existsSync(process.env.RELEASE_HOLDER)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      await release();
      console.log(JSON.stringify(await attempt(m, operation)));
    `, {
      MAIL_DELIVERY_RECEIPTS_DIR_OVERRIDE: dir,
      HOLDER_LOCKED: holderLocked,
      RELEASE_HOLDER: releaseHolder,
    });
    await waitFor(holderLocked);

    const observer = child(`
      import { writeFileSync } from "node:fs";
      const m = await import(${JSON.stringify(moduleUrl)});
      const operation = ${JSON.stringify(operation("observer"))};
      const attempt = ${attempt};
      const result = await attempt(m, operation);
      writeFileSync(process.env.OBSERVER_DONE, "done");
      console.log(JSON.stringify(result));
    `, {
      MAIL_DELIVERY_RECEIPTS_DIR_OVERRIDE: dir,
      OBSERVER_DONE: observerDone,
    });

    await new Promise(resolve => setTimeout(resolve, 100));
    const observerFinishedWhileLocked = existsSync(observerDone);
    writeFileSync(releaseHolder, "go");
    assert.equal(observerFinishedWhileLocked, false, "preparation waits while the per-work-ID production lock is held");

    const results = [JSON.parse(await holder), JSON.parse(await observer)] as Array<{ ok: boolean; subject?: string; error?: string }>;
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.match(results.find(result => !result.ok)?.error ?? "", /operation changed after preparation/);
    const winner = results.find(result => result.ok)?.subject;
    const saved = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(saved.operation.transcript.subject, winner, "the serialized winner remains immutable on disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
