import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRunnerOutcome } from "./runner-events.ts";

test("detectRunnerOutcome carries a usage object off the result line", () => {
  const lines = [
    JSON.stringify({ t: "text", text: "hi" }),
    JSON.stringify({
      t: "result",
      subtype: "success",
      text: "done",
      out_of_tokens: false,
      resets_at: null,
      usage: { cost: 0.014, inTok: 5100, outTok: 380, src: "openrouter", model: "claude-opus-4-8" },
    }),
  ];
  const o = detectRunnerOutcome(lines);
  assert.equal(o.succeeded, true);
  assert.deepEqual(o.usage, { cost: 0.014, inTok: 5100, outTok: 380, src: "openrouter", model: "claude-opus-4-8" });
});

test("no usage on the result line -> outcome.usage is undefined (a no-usage run)", () => {
  const o = detectRunnerOutcome([JSON.stringify({ t: "result", subtype: "success", text: "x" })]);
  assert.equal(o.usage, undefined);
});
