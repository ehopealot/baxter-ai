import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUsage, spentThisPeriod, summary, creditBudgetUsd, evaluateCap, firstTimeThisPeriod, periodKey, creditAnchorDay, anchoredMonthStart } from "./usage-store.ts";

// The store reads USAGE_DIR_OVERRIDE at CALL time (not import), so a plain static
// import + setting the override here (before any test body runs) is enough. (A
// top-level `await import` hangs node --test in this repo -- use static imports.)
// One shared ledger dir for the file: the record/sum/summary tests run in node's
// default in-file order and intentionally accumulate into it (test 2's run count
// reflects test 1's writes; the period-rollover test writes an August entry, and
// firstTimeThisPeriod writes markers, into the same dir). Kept simple
// deliberately; only the pure evaluateCap/creditBudgetUsd tests are ledger-free.
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

test("creditAnchorDay: unset/blank/invalid/out-of-range -> 1; a valid 1..31 passes", () => {
  const saved = process.env.BAXTER_CREDIT_ANCHOR_DAY;
  for (const bad of [undefined, "", "abc", "0", "32", "-3", "15.5"]) {
    if (bad === undefined) delete process.env.BAXTER_CREDIT_ANCHOR_DAY;
    else process.env.BAXTER_CREDIT_ANCHOR_DAY = bad;
    assert.equal(creditAnchorDay(), 1, `"${bad}" -> 1`);
  }
  process.env.BAXTER_CREDIT_ANCHOR_DAY = "15";
  assert.equal(creditAnchorDay(), 15);
  if (saved === undefined) delete process.env.BAXTER_CREDIT_ANCHOR_DAY;
  else process.env.BAXTER_CREDIT_ANCHOR_DAY = saved;
});

test("periodKey: an anchored month keys off the period START date, signup-relative", () => {
  const saved = process.env.BAXTER_CREDIT_ANCHOR_DAY;
  try {
    // Default (anchor 1) is unchanged -- a plain calendar-month key.
    delete process.env.BAXTER_CREDIT_ANCHOR_DAY;
    assert.equal(periodKey(Date.UTC(2026, 7, 20), "month"), "2026-08");

    // Signup on the 15th: Aug 15..Sep 15..Oct 15. A timestamp on/after the anchor is in this
    // month's period; one before it belongs to the previous month's period.
    process.env.BAXTER_CREDIT_ANCHOR_DAY = "15";
    assert.equal(periodKey(Date.UTC(2026, 7, 15, 0), "month"), "2026-08-15", "exactly the anchor -> new period");
    assert.equal(periodKey(Date.UTC(2026, 7, 20, 23), "month"), "2026-08-15");
    assert.equal(periodKey(Date.UTC(2026, 8, 14, 23), "month"), "2026-08-15", "Sep 14 is still in the Aug 15 period");
    assert.equal(periodKey(Date.UTC(2026, 8, 15, 0), "month"), "2026-09-15", "Sep 15 rolls to the next period");
    assert.equal(periodKey(Date.UTC(2026, 7, 10), "month"), "2026-07-15", "Aug 10 (before the anchor) is the Jul 15 period");
    // The "day" period ignores the anchor entirely.
    assert.equal(periodKey(Date.UTC(2026, 7, 20), "day"), "2026-08-20");
  } finally {
    if (saved === undefined) delete process.env.BAXTER_CREDIT_ANCHOR_DAY;
    else process.env.BAXTER_CREDIT_ANCHOR_DAY = saved;
  }
});

test("anchoredMonthStart clamps an anchor past the month's length (no gap or overlap)", () => {
  // Anchor 31: January bills the 31st, but February has no 31st -> clamp to Feb 28, and the period
  // before Feb 28 belongs to the Jan 31 period; Mar 30 (< Mar 31 anchor) is still the Feb 28 period.
  const key = (ms: number) => new Date(anchoredMonthStart(ms, 31)).toISOString().slice(0, 10);
  assert.equal(key(Date.UTC(2026, 1, 15)), "2026-01-31", "Feb 15 -> Jan 31 period");
  assert.equal(key(Date.UTC(2026, 1, 28)), "2026-02-28", "Feb 28 (clamped anchor) opens the next period");
  assert.equal(key(Date.UTC(2026, 2, 30)), "2026-02-28", "Mar 30 is still the Feb 28 period");
  assert.equal(key(Date.UTC(2026, 2, 31)), "2026-03-31", "Mar 31 opens its own period");
});

test("ledger + spend rotate on the anchored boundary", () => {
  const saved = process.env.BAXTER_CREDIT_ANCHOR_DAY;
  process.env.BAXTER_CREDIT_ANCHOR_DAY = "15";
  try {
    const before = Date.UTC(2026, 10, 5, 9);  // Nov 5  -> Oct 15 period
    const after = Date.UTC(2026, 10, 20, 9);   // Nov 20 -> Nov 15 period (a different file)
    recordUsage(entry({ t: before, cost: 1.5 }));
    recordUsage(entry({ t: after, cost: 4.0 }));
    assert.ok(Math.abs(spentThisPeriod(after) - 4.0) < 1e-9, "Nov 20 sees only the Nov 15 period");
    assert.ok(Math.abs(spentThisPeriod(before) - 1.5) < 1e-9, "Nov 5 sees only the Oct 15 period");
  } finally {
    if (saved === undefined) delete process.env.BAXTER_CREDIT_ANCHOR_DAY;
    else process.env.BAXTER_CREDIT_ANCHOR_DAY = saved;
  }
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
