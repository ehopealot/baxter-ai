import { test } from "node:test";
import assert from "node:assert/strict";
import { packLines, createDiscordLogShipper } from "./log-shipper.ts";
import { LightLifecycle } from "./light-lifecycle.ts";
import { drainForExit } from "./light-bot.ts";
import type { WorkerControlLifecycle } from "./worker-control.ts";

test("packLines: joins lines under budget into one chunk, splits over budget", () => {
  assert.deepEqual(packLines(["a", "b", "c"], 100), ["a\nb\nc"]);
  // budget 5: "aa"(2) + "\n" + "bb"(2) = 5 ok; adding "cc" -> new chunk
  assert.deepEqual(packLines(["aa", "bb", "cc"], 5), ["aa\nbb", "cc"]);
});

test("packLines: truncates a single over-long line with an ellipsis (never drops the rest)", () => {
  const [chunk] = packLines(["x".repeat(50)], 10);
  assert.equal(chunk.length, 10);
  assert.ok(chunk.endsWith("…"));
});

test("createDiscordLogShipper: no webhook -> a no-op that never throws", async () => {
  const s = createDiscordLogShipper({ webhookUrl: "" });
  assert.doesNotThrow(() => s.ship("hello"));
  await s.flush();
  await s.stop();
});

test("createDiscordLogShipper: batches buffered lines into one fenced POST on flush", async () => {
  const posts: { url: string; body: { content: string } }[] = [];
  const fetchFn = async (url: string, opts: RequestInit) => {
    posts.push({ url, body: JSON.parse(opts.body as string) });
    return { status: 204 };
  };
  const s = createDiscordLogShipper({ webhookUrl: "https://wh", fetchFn, flushMs: 9999 });
  s.ship("line one");
  s.ship("line two");
  assert.equal(posts.length, 0, "nothing sent until flush");
  await s.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://wh");
  assert.equal(posts[0].body.content, "```\nline one\nline two\n```");
});

test("createDiscordLogShipper: maxBuffer forces a flush without waiting for the timer", async () => {
  const posts: string[] = [];
  const fetchFn = async (_u: string, o: RequestInit) => {
    posts.push(JSON.parse(o.body as string).content);
    return { status: 204 };
  };
  const s = createDiscordLogShipper({ webhookUrl: "https://wh", fetchFn, flushMs: 9999, maxBuffer: 3 });
  s.ship("1"); s.ship("2");
  assert.equal(posts.length, 0);
  s.ship("3"); // hits maxBuffer -> flush
  await s.flush(); // drain the send chain
  assert.equal(posts.length, 1);
  assert.match(posts[0], /1\n2\n3/);
});

test("createDiscordLogShipper: a failing webhook never throws out of ship/flush", async () => {
  const s = createDiscordLogShipper({ webhookUrl: "https://wh", fetchFn: async () => { throw new Error("network down"); }, flushMs: 9999 });
  s.ship("boom");
  await assert.doesNotReject(() => s.flush()); // swallowed -> console.error, not thrown
});

test("lifecycle-owned shipping drains its final provider fence before exit permission and rejects later work", async () => {
  const lifecycle = new LightLifecycle();
  const events: string[] = [];
  let releaseCancellation!: () => void;
  const cancellation = new Promise<void>(resolve => { releaseCancellation = resolve; });
  let posts = 0;
  const shipper = createDiscordLogShipper({
    webhookUrl: "https://wh",
    lifecycle,
    flushMs: 9999,
    fetchFn: async () => {
      posts++;
      events.push("provider");
      return { status: 204, body: { cancel: async () => { events.push("cancel"); await cancellation; } } };
    },
  });
  shipper.ship("owned before shutdown");
  const shipping = shipper.flush();
  const control: WorkerControlLifecycle = {
    hello: async () => {}, renew: async () => {}, coverage: async () => {},
    drain: async () => { events.push("control-drain"); },
    exitPermitted: async () => { events.push("exit-permitted"); return true; },
  };
  const draining = drainForExit(lifecycle, control, 1_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.includes("provider"), true);
  assert.equal(events.includes("cancel"), true);
  assert.equal(events.includes("exit-permitted"), false, "permission waits for response cancellation/fence");
  releaseCancellation();
  await shipping;
  assert.equal(await draining, true);
  assert.ok(events.indexOf("exit-permitted") > events.indexOf("cancel"));

  shipper.ship("after permission");
  await shipper.flush();
  assert.equal(posts, 1, "closed lifecycle refuses new provider work after permission");
});

test("createDiscordLogShipper: a >2000-char burst is split across multiple POSTs, in order", async () => {
  const posts: string[] = [];
  const fetchFn = async (_u: string, o: RequestInit) => {
    posts.push(JSON.parse(o.body as string).content);
    return { status: 204 };
  };
  const s = createDiscordLogShipper({ webhookUrl: "https://wh", fetchFn, flushMs: 9999, maxBuffer: 99999 });
  for (let i = 0; i < 60; i++) s.ship("x".repeat(100) + `#${i}`); // ~6KB total
  await s.flush();
  assert.ok(posts.length >= 2, `expected multiple chunks, got ${posts.length}`);
  for (const p of posts) assert.ok(p.length <= 2000, `chunk over Discord limit: ${p.length}`);
  // order preserved: first chunk holds #0, last holds #59
  assert.match(posts[0], /#0\b/);
  assert.match(posts[posts.length - 1], /#59\b/);
});
