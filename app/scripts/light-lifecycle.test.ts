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

test("a wake can reopen intake during final exit check", () => {
  const lifecycle = new LightLifecycle();
  lifecycle.closeIntake(); lifecycle.reopenIntake();
  const release = lifecycle.admit("worker-control:final-exit-check");
  assert.ok(release); release!();
});
