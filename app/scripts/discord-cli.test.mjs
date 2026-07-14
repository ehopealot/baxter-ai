import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMessage, encodeEmoji, parseFlags } from "./discord-cli.mjs";

test("chunkMessage passes short text through as one chunk", () => {
  assert.deepEqual(chunkMessage("hello"), ["hello"]);
});
test("chunkMessage splits on newline boundaries under the cap", () => {
  const line = "x".repeat(1500);
  const out = chunkMessage(`${line}\n${line}`);
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.length <= 2000));
});
test("chunkMessage hard-splits a single over-long line", () => {
  const out = chunkMessage("y".repeat(4500));
  assert.equal(out.length, 3);
  assert.ok(out.every((c) => c.length <= 2000));
  assert.equal(out.join(""), "y".repeat(4500));
});
test("encodeEmoji percent-encodes a unicode emoji", () => {
  assert.equal(encodeEmoji("👍"), encodeURIComponent("👍"));
});
test("encodeEmoji formats a custom emoji as name:id", () => {
  assert.equal(encodeEmoji("<:party:12345>"), "party:12345");
});
test("parseFlags separates positionals and --flags", () => {
  const { positionals, flags } = parseFlags(["chan", "msg", "--limit", "50"]);
  assert.deepEqual(positionals, ["chan", "msg"]);
  assert.deepEqual(flags, { limit: "50" });
});
test("parseFlags: -- ends flag parsing so leading-dash positionals survive", () => {
  const { positionals, flags } = parseFlags(["chan", "--", "--urgent thread"]);
  assert.deepEqual(positionals, ["chan", "--urgent thread"]);
  assert.deepEqual(flags, {});
});
test("parseFlags throws on a dangling flag with no value", () => {
  assert.throws(() => parseFlags(["chan", "--limit"]), /missing value for --limit/);
});
test("chunkMessage never splits a surrogate pair mid-emoji", () => {
  // Odd prefix so a naive cut at 2000 lands mid-pair (an aligned input would
  // cut cleanly and never exercise the backoff). Assert the real invariant:
  // no chunk ends in an unpaired high surrogate.
  const input = "a" + "👍".repeat(1500);
  const out = chunkMessage(input);
  assert.ok(out.every((c) => c.length <= 2000));
  assert.equal(out.join(""), input);
  assert.ok(out.every((c) => {
    const last = c.charCodeAt(c.length - 1);
    return last < 0xd800 || last > 0xdbff;
  }));
});
