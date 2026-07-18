import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMessage, encodeEmoji, parseFlags, extractFiles, buildAttachmentPayload, tsToSnowflake } from "./discord-cli.mjs";

const DISCORD_EPOCH = 1420070400000n;

test("tsToSnowflake: an ISO timestamp maps to the boundary snowflake (round-trips)", () => {
  const iso = "2026-07-18T14:00:00.000Z";
  const snow = tsToSnowflake(iso);
  // Reverse: (snowflake >> 22) + DISCORD_EPOCH === the original ms.
  const ms = (BigInt(snow) >> 22n) + DISCORD_EPOCH;
  assert.equal(Number(ms), Date.parse(iso));
});

test("tsToSnowflake: epoch milliseconds (all-digits) work too", () => {
  const ms = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(tsToSnowflake(String(ms)), tsToSnowflake("2026-01-01T00:00:00Z"));
});

test("tsToSnowflake: undefined/empty -> undefined (no bound)", () => {
  assert.equal(tsToSnowflake(undefined), undefined);
  assert.equal(tsToSnowflake(""), undefined);
});

test("tsToSnowflake: rejects garbage and pre-Discord times (e.g. epoch SECONDS)", () => {
  assert.throws(() => tsToSnowflake("not a date"), /invalid timestamp/);
  assert.throws(() => tsToSnowflake("1767225600"), /predates Discord/); // epoch seconds, not ms
});

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

test("extractFiles pulls every --file, leaving the rest", () => {
  assert.deepEqual(extractFiles(["123", "--file", "a.png", "--file", "b.wav"]),
    { files: ["a.png", "b.wav"], rest: ["123"] });
  assert.deepEqual(extractFiles(["123", "456"]), { files: [], rest: ["123", "456"] });
  assert.throws(() => extractFiles(["--file"]), /missing value for --file/);
});

test("extractFiles honors the -- end-of-flags sentinel, leaving verbatim positionals untouched", () => {
  // "123" is a positional seen before the sentinel, so it's collected normally;
  // "--" and everything after it (including a literal "--file" token) must
  // survive untouched for parseFlags to see.
  assert.deepEqual(extractFiles(["123", "--", "--file", "x"]), { files: [], rest: ["123", "--", "--file", "x"] });
});

test("buildAttachmentPayload lists attachments with sequential ids + basenames", () => {
  const p = buildAttachmentPayload("hi", { message_reference: { message_id: "9" } }, ["/w/artifacts/chart.png", "/w/t.wav"]);
  assert.equal(p.content, "hi");
  assert.deepEqual(p.message_reference, { message_id: "9" });
  assert.deepEqual(p.attachments, [{ id: 0, filename: "chart.png" }, { id: 1, filename: "t.wav" }]);
});
