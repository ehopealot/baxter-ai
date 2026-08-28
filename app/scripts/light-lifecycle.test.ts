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

test("final-only resources remain live through intake drain and close at permitted exit", () => {
  const lifecycle = new LightLifecycle();
  const events: string[] = [];
  lifecycle.resource("retry-scheduler", () => events.push("resource"));
  lifecycle.closeIntake();
  assert.deepEqual(events, []);
  lifecycle.closeSources();
  assert.deepEqual(events, ["resource"]);
});
