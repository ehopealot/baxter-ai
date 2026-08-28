import { test } from "node:test";
import assert from "node:assert/strict";
import { LightLifecycle } from "./light-lifecycle.ts";

test("finite lifecycle refuses new intake after close and drains admitted work", async () => {
  const lifecycle = new LightLifecycle();
  const releaseMail = lifecycle.admit("mail:queue-admission");
  const releaseProvider = lifecycle.admit("chat:title-provider");
  assert.ok(releaseMail); assert.ok(releaseProvider); assert.equal(lifecycle.idle, false);
  lifecycle.closeIntake();
  assert.equal(lifecycle.admit("sms:link-callback"), null);
  const draining = lifecycle.drain();
  releaseMail!(); assert.equal(lifecycle.idle, false);
  releaseProvider!(); await draining; assert.equal(lifecycle.idle, true);
});

test("closing intake closes registered links, watches, and timers exactly once", () => {
  const lifecycle = new LightLifecycle();
  const closed: string[] = [];
  lifecycle.source("link", () => closed.push("link"));
  lifecycle.source("watch", () => closed.push("watch"));
  lifecycle.source("timer", () => closed.push("timer"));
  lifecycle.closeIntake(); lifecycle.closeIntake(); lifecycle.closeSources();
  assert.deepEqual(closed.sort(), ["link", "timer", "watch"]);
  assert.deepEqual(lifecycle.sourceSnapshot(), {});
});

test("a denied exit truly reopens sources before admitting the racing wake", () => {
  const lifecycle = new LightLifecycle();
  const events: string[] = [];
  lifecycle.source("link", () => events.push("close"), () => events.push("reopen"));
  lifecycle.closeIntake(); lifecycle.reopenIntake();
  const release = lifecycle.admit("worker-control:final-exit-check");
  assert.ok(release); release!();
  assert.deepEqual(events, ["close", "reopen"]);
});

test("a partial source reopen fails closed, rolls back opened sources, and retries", async () => {
  const lifecycle = new LightLifecycle(1);
  const events: string[] = [];
  let attempts = 0;
  lifecycle.source("first", () => events.push("close-first"), () => events.push("open-first"));
  lifecycle.source("second", () => events.push("close-second"), () => {
    attempts++;
    events.push(`open-second-${attempts}`);
    if (attempts === 1) throw new Error("not ready");
  });
  lifecycle.closeIntake();
  assert.equal(lifecycle.reopenIntake(), false);
  assert.equal(lifecycle.intakeClosed, true);
  assert.equal(lifecycle.admit("must-stay-closed"), null);
  assert.deepEqual(events, ["close-first", "close-second", "open-first", "open-second-1", "close-second", "close-first"]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lifecycle.intakeClosed, false);
  assert.ok(lifecycle.admit("after-retry"));
  assert.deepEqual(events.slice(-2), ["open-first", "open-second-2"]);
});

test("final-only resources remain live through intake drain and close at permitted exit", () => {
  const lifecycle = new LightLifecycle();
  const events: string[] = [];
  lifecycle.resource("retry-scheduler", () => events.push("resource"));
  lifecycle.closeIntake();
  assert.deepEqual(events, []);
  lifecycle.closeSources();
  assert.deepEqual(events, ["resource"]);
});
