import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage } from "./discord-bot.mjs";

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
