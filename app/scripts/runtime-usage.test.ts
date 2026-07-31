// Task 3: runAgent records a usage-ledger entry (with the caller's surface and
// the runner-reported usage) and threads the required `surface` field. The pure
// soft-cap decision is unit-tested in usage-store.test.ts; here we prove the
// wiring -- an injected fake harness returns a chosen usage, and we assert the
// ledger line. Static import + USAGE_DIR_OVERRIDE (a top-level `await import`
// hangs node --test in this repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./runtime.ts";
import type { Harness } from "./runtime.ts";

const DIR = mkdtempSync(join(tmpdir(), "runusage-"));
process.env.USAGE_DIR_OVERRIDE = DIR;
const RUNS = mkdtempSync(join(tmpdir(), "runs-"));

// A fake harness: `true` exits 0 immediately; detectOutcome returns our usage.
function fakeHarness(usage: unknown): Harness {
  return {
    name: "fake",
    describe: () => "fake",
    buildInvocation: () => ({ command: "true", args: [] }),
    parseEvents: () => [],
    detectOutcome: () => ({ outOfTokens: false, resetsAt: null, succeeded: true, resultText: "", usage } as ReturnType<Harness["detectOutcome"]>),
  };
}

function ledgerRow(logId: string): Record<string, unknown> {
  const file = readdirSync(DIR).find((f) => f.startsWith("ledger-"))!;
  return readFileSync(join(DIR, file), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.logId === logId);
}

test("runAgent records a ledger entry with the caller's surface + the runner-reported usage", async () => {
  await runAgent({
    prompt: "hi", logId: "t1", cwd: DIR, runsDir: RUNS, surface: "heartbeat",
    harness: fakeHarness({ cost: 0.02, inTok: 10, outTok: 5, src: "openrouter", model: "big-model" }),
  });
  const row = ledgerRow("t1");
  assert.equal(row.surface, "heartbeat");
  assert.equal(row.model, "big-model");
  assert.equal(row.cost, 0.02);
  assert.equal(row.src, "openrouter");
});

test("a no-usage outcome still records an entry (cost null, model '')", async () => {
  await runAgent({
    prompt: "hi", logId: "t2", cwd: DIR, runsDir: RUNS, surface: "tui",
    harness: fakeHarness(undefined),
  });
  const row = ledgerRow("t2");
  assert.equal(row.cost, null);
  assert.equal(row.model, "");
  assert.equal(row.surface, "tui");
});

test.after(() => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(RUNS, { recursive: true, force: true });
});
