import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMaxSends } from "./send-state.mjs";

test("parseMaxSends returns default on unset/blank", () => {
  assert.equal(parseMaxSends(undefined, 500), 500);
  assert.equal(parseMaxSends("", 500), 500);
  assert.equal(parseMaxSends("   ", 500), 500);
});
test("parseMaxSends parses a valid number", () => {
  assert.equal(parseMaxSends("1000", 500), 1000);
  assert.equal(parseMaxSends("0", 500), 0);
});
test("parseMaxSends falls back on NaN or negative", () => {
  assert.equal(parseMaxSends("fifty", 500), 500);
  assert.equal(parseMaxSends("-3", 500), 500);
});
