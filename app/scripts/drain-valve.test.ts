import { test } from "node:test";
import assert from "node:assert/strict";
import { DrainValve } from "./drain-valve.ts";

test("DrainValve guards callback entry and closes intake exactly once", async () => {
  let closed = 0;
  const valve = new DrainValve(async () => { closed++; });
  assert.equal(valve.guard(() => "entered"), "entered");

  await Promise.all([valve.close(), valve.close()]);
  assert.equal(closed, 1);
  assert.equal(valve.isClosed, true);
  assert.equal(valve.guard(() => { throw new Error("must not enter"); }), undefined);
});
