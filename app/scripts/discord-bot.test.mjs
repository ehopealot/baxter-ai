import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, ChannelDispatcher, renderHistory } from "./discord-bot.mjs";

const base = { selfId: "SELF", guildAllowlist: null, triggerOnBots: false };
const msg = (o) => ({ authorId: "U1", authorIsBot: false, isDM: false, guildId: "G1", mentionsBot: false, repliesToBot: false, ...o });

test("ignores the bot's own messages", () => {
  assert.equal(classifyMessage(msg({ authorId: "SELF" }), base), "ignore");
});
test("always responds to a DM from a human", () => {
  assert.equal(classifyMessage(msg({ isDM: true, guildId: null }), base), "respond");
});
test("always responds to an @mention from a human", () => {
  assert.equal(classifyMessage(msg({ mentionsBot: true }), base), "respond");
});
test("always responds to a human reply to the bot", () => {
  assert.equal(classifyMessage(msg({ repliesToBot: true }), base), "respond");
});
test("plain human channel message goes to the pre-filter", () => {
  assert.equal(classifyMessage(msg({}), base), "prefilter");
});
test("bot @mention wakes the pre-filter, never a reflexive respond", () => {
  // Baxter never posts reflexively at a bot; a mention only wakes the
  // (task-oriented) pre-filter, which handleChannel runs with the strict rule.
  assert.equal(classifyMessage(msg({ authorIsBot: true, mentionsBot: true }), base), "prefilter");
});
test("bot reply to the bot does NOT trigger (no ping-pong)", () => {
  assert.equal(classifyMessage(msg({ authorIsBot: true, repliesToBot: true }), base), "ignore");
});
test("plain bot message is ignored unless triggerOnBots", () => {
  assert.equal(classifyMessage(msg({ authorIsBot: true }), base), "ignore");
  assert.equal(classifyMessage(msg({ authorIsBot: true }), { ...base, triggerOnBots: true }), "prefilter");
});
test("guild not on the allowlist is ignored", () => {
  assert.equal(classifyMessage(msg({ guildId: "GX" }), { ...base, guildAllowlist: ["G1"] }), "ignore");
  assert.equal(classifyMessage(msg({ guildId: "G1" }), { ...base, guildAllowlist: ["G1"] }), "prefilter");
});

test("coalesces rapid messages in one channel into a single run", async () => {
  const calls = [];
  const d = new ChannelDispatcher({ debounceMs: 10, maxConcurrent: 5, runFn: async (ch, m) => { calls.push([ch, m.id]); } });
  d.notify("C1", { id: "m1" });
  d.notify("C1", { id: "m2" });
  d.notify("C1", { id: "m3" });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, [["C1", "m3"]]); // one run, latest message
});

test("runs different channels independently", async () => {
  const calls = [];
  const d = new ChannelDispatcher({ debounceMs: 10, maxConcurrent: 5, runFn: async (ch) => { calls.push(ch); } });
  d.notify("C1", { id: "a" });
  d.notify("C2", { id: "b" });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls.sort(), ["C1", "C2"]);
});

test("serializes a second message that arrives while a channel run is active", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  const d = new ChannelDispatcher({ debounceMs: 5, maxConcurrent: 5, runFn: async (ch, m) => {
    order.push(`start:${m.id}`);
    if (first) { first = false; await gate; }
    order.push(`end:${m.id}`);
  }});
  d.notify("C1", { id: "m1" });
  await new Promise((r) => setTimeout(r, 20)); // m1 running, awaiting gate
  d.notify("C1", { id: "m2" });
  await new Promise((r) => setTimeout(r, 20));
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ["start:m1", "end:m1", "start:m2", "end:m2"]);
});

test("under a saturated global cap, each channel runs once with its latest message", async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let firstDone = false;
  const d = new ChannelDispatcher({ debounceMs: 5, maxConcurrent: 1, runFn: async (ch, m) => {
    calls.push([ch, m.id]);
    if (!firstDone) { firstDone = true; await gate; } // hold the single slot open
  }});
  d.notify("A", { id: "a1" });
  await new Promise((r) => setTimeout(r, 15)); // A running, holding the only slot
  d.notify("B", { id: "b1" });
  d.notify("C", { id: "c1" });
  await new Promise((r) => setTimeout(r, 15));
  d.notify("C", { id: "c2" }); // newer C arrives while C waits on the cap
  await new Promise((r) => setTimeout(r, 15));
  release();
  await new Promise((r) => setTimeout(r, 50));
  const byCh = Object.fromEntries(calls.map(([c, id]) => [c, id]));
  assert.equal(calls.length, 3);   // each channel ran exactly once (no stale duplicate)
  assert.equal(byCh.A, "a1");
  assert.equal(byCh.B, "b1");
  assert.equal(byCh.C, "c2");       // latest C, not the clobbered c1
});

test("renderHistory labels the bot's own messages and includes ids", () => {
  const out = renderHistory([
    { id: "1", author: { id: "SELF", username: "baxter" }, content: "hi", timestamp: 0 },
    { id: "2", author: { id: "U1", username: "erik" }, content: "hey", timestamp: 0 },
  ], "SELF");
  assert.match(out, /\(you\).*msg 1/s);
  assert.match(out, /erik.*msg 2/s);
});
