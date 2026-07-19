import { test } from "node:test";
import assert from "node:assert/strict";
import { packLines, createDiscordLogShipper } from "./log-shipper.mjs";

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
  const posts = [];
  const fetchFn = async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { status: 204 }; };
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
  const posts = [];
  const fetchFn = async (_u, o) => { posts.push(JSON.parse(o.body).content); return { status: 204 }; };
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

test("createDiscordLogShipper: a >2000-char burst is split across multiple POSTs, in order", async () => {
  const posts = [];
  const fetchFn = async (_u, o) => { posts.push(JSON.parse(o.body).content); return { status: 204 }; };
  const s = createDiscordLogShipper({ webhookUrl: "https://wh", fetchFn, flushMs: 9999, maxBuffer: 99999 });
  for (let i = 0; i < 60; i++) s.ship("x".repeat(100) + `#${i}`); // ~6KB total
  await s.flush();
  assert.ok(posts.length >= 2, `expected multiple chunks, got ${posts.length}`);
  for (const p of posts) assert.ok(p.length <= 2000, `chunk over Discord limit: ${p.length}`);
  // order preserved: first chunk holds #0, last holds #59
  assert.match(posts[0], /#0\b/);
  assert.match(posts[posts.length - 1], /#59\b/);
});
