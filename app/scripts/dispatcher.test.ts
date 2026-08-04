import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelDispatcher } from "./dispatcher.ts";

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
