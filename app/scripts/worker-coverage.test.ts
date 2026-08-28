import { test } from "node:test";
import assert from "node:assert/strict";
import { LightLifecycle } from "./light-lifecycle.ts";
import { WorkerCoverageCoordinator } from "./worker-coverage.ts";
import type { WorkerControlLifecycle } from "./worker-control.ts";

function control(calls: string[]): WorkerControlLifecycle {
  return {
    hello: async () => {}, renew: async () => {}, drain: async () => {}, exitPermitted: async () => true,
    coverage: async ({ queue, highWater }) => { calls.push(`${queue}:${highWater}`); },
  };
}

test("coverage is monotonic and serialized within each queue", async () => {
  const lifecycle = new LightLifecycle();
  const calls: string[] = [];
  const coordinator = new WorkerCoverageCoordinator(control(calls), lifecycle, () => {});
  coordinator.advance("mail", 3);
  coordinator.advance("mail", 2);
  coordinator.advance("mail", 7);
  await coordinator.flush();
  assert.deepEqual(calls, ["mail:3", "mail:7"]);
  assert.equal(lifecycle.snapshot()["worker-control:coverage:mail"], undefined);
  coordinator.close();
});

test("coverage replays durable queue high-waters after a denied-exit reopen", async () => {
  const lifecycle = new LightLifecycle();
  const calls: string[] = [];
  const coordinator = new WorkerCoverageCoordinator(control(calls), lifecycle, () => {});
  coordinator.advance("sms", 11);
  await coordinator.flush();
  lifecycle.closeIntake();
  lifecycle.reopenIntake();
  await coordinator.flush();
  assert.deepEqual(calls, ["sms:11", "sms:11"]);
  coordinator.close();
});
