import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelDispatcher } from "./dispatcher.ts";
import { LightLifecycle } from "./light-lifecycle.ts";

test("serializes runs per key and coalesces to the latest within the debounce window", async () => {
  const runs: string[] = [];
  // The extracted base _coalesce is latest-wins, so a plain string T is valid here.
  const d = new ChannelDispatcher<string>({ debounceMs: 5, maxConcurrent: 4, runFn: async (k, item) => { runs.push(`${k}:${item}`); await new Promise(r => setTimeout(r, 5)); } });
  d.notify("a", "1"); d.notify("a", "2"); // latest wins → "2"
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(runs, ["a:2"]);
});

test("enforces the per-key hourly budget", async () => {
  const runs: string[] = [];
  const d = new ChannelDispatcher<string>({ debounceMs: 1, maxConcurrent: 4, maxRunsPerWindow: 1, windowMs: 60_000, runFn: async (k, item) => { runs.push(item); } });
  d.notify("a", "1"); await new Promise(r => setTimeout(r, 10));
  d.notify("a", "2"); await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(runs, ["1"]); // second over budget, dropped
});

test("lifecycle ownership is uninterrupted through debounce, global waiting, active run, and completion", async () => {
  const lifecycle = new LightLifecycle();
  let finish!: () => void;
  const first = new Promise<void>(resolve => { finish = resolve; });
  const d = new ChannelDispatcher<string>({ debounceMs: 1, maxConcurrent: 1, lifecycle, runFn: async (key) => { if (key === "a") await first; } });
  d.notify("a", "one"); d.notify("b", "two");
  assert.equal(lifecycle.snapshot()["dispatcher:owned"], 2, "debouncing notifications are admitted");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(d.inventory().active, 1); assert.equal(d.inventory().waiting, 1);
  assert.equal(lifecycle.snapshot()["dispatcher:owned"], 2, "active and waiting ownership remain held");
  lifecycle.closeIntake();
  finish();
  await lifecycle.drain();
  assert.equal(d.inventory().active, 0);
  assert.equal(lifecycle.snapshot()["dispatcher:owned"], undefined);
});

test("a failed owned run releases its key before a retry is scheduled", async () => {
  const starts: string[] = [];
  const d = new ChannelDispatcher<string>({ debounceMs: 1, maxConcurrent: 1, runFn: async (_key, item) => {
    starts.push(item);
    if (item === "first") throw new Error("transient");
  } });
  d.notify("mail-thread", "first");
  await new Promise(r => setTimeout(r, 10));
  d.notify("mail-thread", "retry");
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(starts, ["first", "retry"]);
  assert.equal(d.inventory().active, 0);
});
