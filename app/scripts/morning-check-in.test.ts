import { test } from "node:test";
import assert from "node:assert/strict";
import { morningCheckInDefinition } from "./morning-check-in.ts";

test("morning check-in is the single daily ranged system definition", () => {
  const def = morningCheckInDefinition();
  assert.equal(def.key, "morning-check-in");
  assert.equal(def.cron, "0 8 * * *");
  assert.deepEqual(def.window, { startHour: 8, minuteSlots: 60, cutoffHour: 12 });
});
