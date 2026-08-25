import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cancelWithFollowUpLinearization,
  markFollowUpSendStarted,
  withFollowUpDeliveryLock,
} from "./followup-delivery-lock.ts";
import { cmdCancel } from "./schedule-cli.ts";
import { mutate, readTasks, type Task } from "./schedule-store.ts";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "followup-lock-"));
  const old = process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE;
  process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE = dir;
  try { await run(dir); }
  finally {
    if (old === undefined) delete process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE; else process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE = old;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cancellation first removes before delivery reload and causes zero provider calls", async () => withDir(async () => {
  let present = true; let providers = 0;
  const removalEntered = deferred(); const allowRemoval = deferred();
  const cancel = cancelWithFollowUpLinearization("task-1", async () => {
    removalEntered.resolve(); await allowRemoval.promise; present = false; return true;
  });
  await removalEntered.promise;
  const send = withFollowUpDeliveryLock("task-1", async () => {
    if (!present) return;
    markFollowUpSendStarted("task-1"); providers++;
  });
  allowRemoval.resolve();
  assert.deepEqual(await cancel, { removed: true, status: "cancelled" });
  await send;
  assert.equal(providers, 0);
}));

test("send first hands send_already_started to the waiter after provider outcome", async () => withDir(async () => {
  const providerEntered = deferred(); const providerDone = deferred(); let removeCalls = 0;
  const send = withFollowUpDeliveryLock("task-2", async () => {
    markFollowUpSendStarted("task-2");
    providerEntered.resolve();
    await providerDone.promise;
  });
  await providerEntered.promise;
  let cancelResolved = false;
  const cancel = cancelWithFollowUpLinearization("task-2", async () => { removeCalls++; return true; }).then((value) => { cancelResolved = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelResolved, false, "cancel waits for provider and queue outcome under the delivery lock");
  providerDone.resolve();
  await send;
  assert.deepEqual(await cancel, { removed: true, status: "send_already_started" });
  assert.equal(removeCalls, 1);
}));

test("validator refusal without mark reports ordinary cancelled and coordination artifacts are cleaned", async () => withDir(async (dir) => {
  const entered = deferred(); const finish = deferred();
  const delivery = withFollowUpDeliveryLock("task-3", async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  const cancel = cancelWithFollowUpLinearization("task-3", async () => true);
  finish.resolve();
  await delivery;
  assert.deepEqual(await cancel, { removed: true, status: "cancelled" });
  const names = readdirSync(dir);
  assert.equal(names.some((name) => name.includes("waiter") || name.includes("status")), false);
}));

test("markFollowUpSendStarted fails closed outside the matching delivery lock", () => {
  assert.throws(() => markFollowUpSendStarted("not-locked"), /delivery lock/);
});

test("cancellation removes its waiter when delivery-lock acquisition fails", async () => withDir(async (dir) => {
  const entered = deferred(); const finish = deferred();
  const delivery = withFollowUpDeliveryLock("task-acquire-failure", async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  await assert.rejects(
    () => cancelWithFollowUpLinearization("task-acquire-failure", async () => true, { deliveryRetries: 0 }),
    /already being held|lock/i,
  );
  assert.equal(readdirSync(dir).some((name) => name.includes(".waiter.")), false, "failed acquisition strands no waiter");
  finish.resolve();
  await delivery;
}));

test("schedule-cli cancellation returns send_already_started and removes a retained retry", async () => withDir(async (dir) => {
  const oldSchedule = process.env.SCHEDULE_DIR_OVERRIDE;
  process.env.SCHEDULE_DIR_OVERRIDE = join(dir, "schedule");
  try {
    const task: Task = {
      id: "follow-1", task: "proactive-follow-up:v1", desc: "Check back about store", cron: null,
      at: "2026-08-28T16:00:00.000Z", tz: "America/Los_Angeles", next_run_at: "2026-08-28T16:00:00.000Z",
      invisible_until: "2026-08-28T16:15:00.000Z", attempts: 1, created_at: "2026-08-27T18:00:00.000Z",
      deliver: { surface: "sms", target: "+15551234567" },
      follow_up: { version: 1, subject: "store", subject_key: "store", plan_date: "2026-08-28", turn_token: "a".repeat(64), origin: { surface: "sms", id: "+15551234567" } },
    };
    await mutate(() => ({ tasks: [task], value: undefined }));
    const entered = deferred(); const finish = deferred();
    const send = withFollowUpDeliveryLock(task.id, async () => { markFollowUpSendStarted(task.id); entered.resolve(); await finish.promise; });
    await entered.promise;
    const cancel = cmdCancel(task.id);
    finish.resolve();
    await send;
    assert.equal(await cancel, "send_already_started");
    assert.equal((await readTasks()).length, 0);
  } finally {
    if (oldSchedule === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE; else process.env.SCHEDULE_DIR_OVERRIDE = oldSchedule;
  }
}));
