import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUsage, spentThisPeriod, summary, creditBudgetUsd, evaluateCap, firstTimeThisPeriod, periodKey } from "./usage-store.ts";

// The store reads USAGE_DIR_OVERRIDE at CALL time (not import), so a plain static
// import + setting the override here (before any test body runs) is enough. (A
// top-level `await import` hangs node --test in this repo -- use static imports.)
// One shared ledger dir for the file: the record/sum/summary tests below run in
// node's default in-file order and intentionally accumulate into it (test 2's
// run count reflects test 1's writes). Kept simple deliberately; the pure
// evaluateCap/creditBudgetUsd/period tests don't touch the ledger.
const DIR = mkdtempSync(join(tmpdir(), "usage-"));
process.env.USAGE_DIR_OVERRIDE = DIR;

function entry(over: Record<string, unknown> = {}) {
  return {
    t: Date.UTC(2026, 6, 15, 12),
    surface: "discord",
    model: "m",
    cost: 0.01 as number | null,
    inTok: 100,
    outTok: 20,
    src: "openrouter" as const,
    logId: "x",
    ...over,
  };
}

test("recordUsage + spentThisPeriod sums cost; null contributes 0", () => {
  const now = Date.UTC(2026, 6, 15, 12);
  recordUsage(entry({ cost: 0.02 }));
  recordUsage(entry({ cost: 0.03 }));
  recordUsage(entry({ cost: null, src: "local" })); // still recorded, adds 0
  assert.ok(Math.abs(spentThisPeriod(now) - 0.05) < 1e-9);
});

test("summary breaks down by model and surface, counts runs+tokens incl. the null-cost run", () => {
  const now = Date.UTC(2026, 6, 15, 12);
  const s = summary(now, 1.0);
  assert.equal(s.runs, 3);
  assert.equal(s.budget, 1.0);
  assert.ok(Math.abs(s.remaining - 0.95) < 1e-9);
  assert.equal(s.tokens.in, 300);
  assert.equal(s.bySurface.discord.runs, 3);
});

test("period rollover: a run in a different month is a different file; spentThisPeriod ignores it", () => {
  const aug = Date.UTC(2026, 7, 3, 9);
  recordUsage(entry({ t: aug, cost: 9.0 }));
  assert.ok(Math.abs(spentThisPeriod(aug) - 9.0) < 1e-9); // August file only
  assert.ok(spentThisPeriod(Date.UTC(2026, 6, 15, 12)) < 1.0); // July unaffected
  assert.notEqual(periodKey(aug, "month"), periodKey(Date.UTC(2026, 6, 15), "month"));
});

test("recordUsage never throws when the dir can't be created", () => {
  const saved = process.env.USAGE_DIR_OVERRIDE;
  // Point at a path whose PARENT is a regular file -> mkdirSync fails fast with
  // ENOTDIR (a bogus /proc path can hang on some kernels, so don't use one).
  const notADir = join(DIR, "not-a-dir");
  writeFileSync(notADir, "x");
  process.env.USAGE_DIR_OVERRIDE = join(notADir, "sub");
  assert.doesNotThrow(() => recordUsage(entry()));
  process.env.USAGE_DIR_OVERRIDE = saved;
});

test("creditBudgetUsd: unset/blank/invalid/negative/zero -> 0; a positive number passes", () => {
  for (const bad of [undefined, "", "abc", "-5", "0"]) {
    if (bad === undefined) delete process.env.BAXTER_CREDIT_BUDGET_USD;
    else process.env.BAXTER_CREDIT_BUDGET_USD = bad;
    assert.equal(creditBudgetUsd(), 0);
  }
  process.env.BAXTER_CREDIT_BUDGET_USD = "12.5";
  assert.equal(creditBudgetUsd(), 12.5);
  delete process.env.BAXTER_CREDIT_BUDGET_USD;
});

test("evaluateCap: under budget -> nothing; over -> alert + creditsLow gated on softNote", () => {
  assert.deepEqual(evaluateCap({ budget: 0, spent: 100, softNote: true }), {
    overBudget: false,
    alertMsg: "",
    creditsLow: false,
  });
  assert.equal(evaluateCap({ budget: 10, spent: 5, softNote: true }).overBudget, false);
  const over = evaluateCap({ budget: 10, spent: 12, softNote: false });
  assert.equal(over.overBudget, true);
  assert.match(over.alertMsg, /over \$10/);
  assert.equal(over.creditsLow, false);
  assert.equal(evaluateCap({ budget: 10, spent: 12, softNote: true }).creditsLow, true);
  // boundary: spent === budget is "over" (the cap uses >=), the case the semantics hinge on
  assert.equal(evaluateCap({ budget: 10, spent: 10, softNote: false }).overBudget, true);
});

test("firstTimeThisPeriod returns true once per period then false", () => {
  const now = Date.UTC(2026, 6, 20, 0);
  assert.equal(firstTimeThisPeriod("alerted", now), true);
  assert.equal(firstTimeThisPeriod("alerted", now), false);
  assert.equal(firstTimeThisPeriod("null-cost", now), true); // distinct kind, distinct marker
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
