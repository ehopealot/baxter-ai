import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "./normalize-phone.ts";

const CASES: Array<[string, string | null]> = [
  ["+15551234567", "+15551234567"],
  ["5551234567", "+15551234567"],
  ["(555) 123-4567", "+15551234567"],
  ["+44 20 7946 0958", "+442079460958"],
  ["", null],
  ["bad", null],
];
for (const [input, expected] of CASES) {
  test(`normalizePhone(${JSON.stringify(input)})`, () => assert.equal(normalizePhone(input), expected));
}
