import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMessage, encodeEmoji, parseFlags, extractFiles, buildAttachmentPayload, tsToSnowflake, fetchHistory } from "./discord-cli.mjs";

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

// --- fetchHistory: pagination / filtering / bounds (api injected, no network) ---
const _msg = (id, authorId) => ({ id: String(id), author: { id: String(authorId) }, timestamp: "" });
// Serve canned pages (each newest-first) in order, ignoring the cursor.
const fakeApi = (pages) => { let i = 0; return async () => (i < pages.length ? pages[i++] : []); };

test("fetchHistory: --from keeps only that author (filters within a page)", async () => {
  // A <100 page means the channel is exhausted, so this stops after one page --
  // enough to prove the author filter; cross-page paging is covered below + live.
  const pages = [[_msg(500, "A"), _msg(499, "B"), _msg(498, "A"), _msg(497, "B"), _msg(496, "A")]];
  const out = await fetchHistory("c", { from: "A", _api: fakeApi(pages) });
  assert.deepEqual(out.map((m) => m.id), ["500", "498", "496"]);
});

test("fetchHistory: --after/--since stops at the lower bound (excludes id <= bound)", async () => {
  const pages = [[_msg(500, "A"), _msg(460, "A"), _msg(440, "A")], [_msg(400, "A")]];
  const out = await fetchHistory("c", { after: "450", _api: fakeApi(pages) });
  assert.deepEqual(out.map((m) => m.id), ["500", "460"]); // 440 <= 450 -> excluded, scan stops
});

test("fetchHistory: warns on stderr when the page cap fires before reaching --since", async () => {
  const full = (base) => Array.from({ length: 100 }, (_, k) => _msg(base - k, "A"));
  const pages = [full(1_000_000), full(900_000), full(800_000)];
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const out = await fetchHistory("c", { after: "1", maxPages: 2, limit: 1000, _api: fakeApi(pages) });
    assert.equal(out.length, 200); // exactly the 2 scanned pages
  } finally {
    console.error = orig;
  }
  assert.match(errs.join("\n"), /scan cap.*before reaching/);
});

test("fetchHistory: warns when the cap fires on an open-ended --from too (no time window)", async () => {
  const full = (base) => Array.from({ length: 100 }, (_, k) => _msg(base - k, "B")); // none match --from A
  const pages = [full(1_000_000), full(900_000), full(800_000)];
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const out = await fetchHistory("c", { from: "A", maxPages: 2, limit: 100, _api: fakeApi(pages) });
    assert.equal(out.length, 0);
  } finally {
    console.error = orig;
  }
  assert.match(errs.join("\n"), /scan cap.*before satisfying --limit/);
});

test("fetchHistory: rejects a non-positive/garbage --limit (loud, not silent)", async () => {
  await assert.rejects(fetchHistory("c", { limit: "abc" }), /invalid --limit/);
  await assert.rejects(fetchHistory("c", { limit: "0" }), /invalid --limit/);
  await assert.rejects(fetchHistory("c", { limit: "-5" }), /invalid --limit/);
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
