import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyAccum, addTurnUsage, finalizeUsage } from "./openrouter-usage.ts";

test("sums three turns exactly once each (no double-count), keeps cost null until a turn has one", () => {
  const acc = emptyAccum();
  assert.equal(finalizeUsage(acc, "m").cost, null); // nothing seen yet
  addTurnUsage(acc, { cost: 0.01, inputTokens: 100, outputTokens: 10 });
  addTurnUsage(acc, { cost: 0.02, inputTokens: 200, outputTokens: 20 });
  addTurnUsage(acc, { cost: 0.03, inputTokens: 50, outputTokens: 5 });
  const r = finalizeUsage(acc, "big-model");
  assert.ok(Math.abs(r.cost! - 0.06) < 1e-9); // each round counted once
  assert.equal(r.inTok, 350);
  assert.equal(r.outTok, 35);
  assert.equal(r.src, "openrouter");
  assert.equal(r.model, "big-model");
});

test("a turn with no usage is ignored; token-only turns keep cost null", () => {
  const acc = emptyAccum();
  addTurnUsage(acc, undefined);
  addTurnUsage(acc, { inputTokens: 10, outputTokens: 2 }); // no cost
  const r = finalizeUsage(acc, "m");
  assert.equal(r.cost, null);
  assert.equal(r.inTok, 10);
  assert.equal(r.outTok, 2);
});

test("a genuine $0.00 cost is preserved (not turned to null)", () => {
  const acc = emptyAccum();
  addTurnUsage(acc, { cost: 0, inputTokens: 5, outputTokens: 1 });
  assert.equal(finalizeUsage(acc, "m").cost, 0);
});

test("non-finite cost is ignored (JSON can carry it as null downstream anyway)", () => {
  const acc = emptyAccum();
  addTurnUsage(acc, { cost: NaN, inputTokens: 5, outputTokens: 1 });
  assert.equal(finalizeUsage(acc, "m").cost, null);
});
