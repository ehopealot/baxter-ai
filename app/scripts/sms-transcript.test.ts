import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendTranscript, entriesForRawGroupId, hasTranscript, isStrictGroupId, quarantineKey, readTranscript, smsGroupSummaries, type TranscriptEntry } from "./sms-transcript.ts";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";

test("append then read returns entries in order, keyed by normalized phone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    await appendTranscript("+1 555 123 4567", { direction: "in", at: "t0", content: "hi" });
    await appendTranscript("(555) 123-4567", { direction: "out", at: "t1", content: "hello" }); // same normalized key
    const all = readTranscript("+15551234567");
    assert.deepEqual(all.map(e => e.content), ["hi", "hello"]);
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("an existing SMS receipt row re-establishes its directory barrier without appending twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-receipt-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    const entry = { direction: "in" as const, at: "t", content: "hello", receiptId: "sms-receipt-1" };
    await appendTranscript("+15551234567", entry);
    const synced: string[] = [];
    const restore = setDurableDirectorySyncForTest(path => synced.push(resolve(path)));
    try { await appendTranscript("+15551234567", entry); }
    finally { restore(); }
    assert.deepEqual(synced, [resolve(dir)]);
    assert.deepEqual(readTranscript("+15551234567"), [entry]);
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("readTranscript(limit) returns the last N", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    for (let i = 0; i < 5; i++) await appendTranscript("+15550000000", { direction: "in", at: `t${i}`, content: String(i) });
    assert.deepEqual(readTranscript("+15550000000", 2).map(e => e.content), ["3", "4"]);
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("hasTranscript is true once a transcript file exists for the (normalized) number, false otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    assert.equal(hasTranscript("+15559876543"), false);
    await appendTranscript("+1 555 987 6543", { direction: "in", at: "t0", content: "hi" });
    assert.equal(hasTranscript("+15559876543"), true);
    assert.equal(hasTranscript("(555) 987-6543"), true); // same normalized key
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("a group key (group:<id>) is its own namespace, distinct from any phone, and round-trips the speaker `from`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-grp-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    await appendTranscript("group:grp_abc", { direction: "in", at: "t0", content: "hey all", from: "+15551234567", group_id: "grp_abc", group_name: "Fam", participants: ["+15551234567", "+15550000000"] });
    await appendTranscript("group:grp_abc", { direction: "out", at: "t1", content: "hi everyone" });
    const g = readTranscript("group:grp_abc");
    assert.equal(g.length, 2);
    assert.equal(g[0].from, "+15551234567", "the speaker survives the round-trip");
    assert.equal(g[0].group_id, "grp_abc", "group metadata survives the round-trip (outbound entries stay metadata-free)");
    assert.equal(g[1].direction, "out");
    assert.equal(g[1].group_id, undefined);
    // A group id is NOT confused with a phone: it doesn't collide with a number transcript.
    assert.equal(hasTranscript("group:grp_abc"), true);
    assert.equal(hasTranscript("+15551234567"), false, "the group thread is not stored under any phone");
    assert.deepEqual(readTranscript("+15551234567"), [], "no phone transcript was created by the group append");
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

// --- Scheduled-sms-group spec (2026-08-18): strict-ID boundary, quarantine, discovery ---

test("isStrictGroupId is the one shared predicate shape (^[-A-Za-z0-9._]{1,64}$)", () => {
  assert.equal(isStrictGroupId("grp_abc"), true);
  assert.equal(isStrictGroupId("grp.ABC-123"), true);
  assert.equal(isStrictGroupId("a"), true);
  assert.equal(isStrictGroupId(""), false, "empty is not a group id");
  assert.equal(isStrictGroupId("grp;evil"), false, "shell metacharacters are rejected");
  assert.equal(isStrictGroupId("g1\nnext"), false, "newlines are rejected");
  assert.equal(isStrictGroupId("x".repeat(65)), false, "over-64 is rejected");
  assert.equal(isStrictGroupId("x".repeat(64)), true);
});

test("quarantineKey is the spec's deterministic digest: sha256 over UTF-8 bytes of JSON.stringify(rawId)", () => {
  // The spec's worked example: grp;evil -> 977da2f0...afbe5.
  assert.equal(quarantineKey("grp;evil"), "977da2f04cb79fc6671c7a317c40a42db07ee763cf42951ac15e8761480afbe5");
  assert.match(quarantineKey("any raw id"), /^[0-9a-f]{64}$/, "always exactly 64 lowercase hex chars");
  // Digest-key separation (spec test 14): a lone surrogate and U+FFFD are DISTINCT
  // keys, because the digest hashes the JSON.stringify form (which escapes lone
  // surrogates as \ud800 sequences) rather than plain UTF-8 bytes (which would
  // collapse both to EF BF BD).
  const lone = "grp\ud800x";
  const repl = "grp\ufffdx";
  assert.notEqual(quarantineKey(lone), quarantineKey(repl), "a lone surrogate and U+FFFD hash to distinct gx- keys");
});

test("a malformed group id is quarantined (gx-<digest>), bounded, and never satisfies hasTranscript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-quar-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    await appendTranscript("group:grp;evil", { direction: "in", at: "t0", content: "m", from: "+1", group_id: "grp;evil" });
    // Spec test 16: a malformed id LONGER than any strict id (1,000 chars) also lands
    // under a fixed 64-hex digest filename -- never an unbounded encoding of the raw id.
    const long = `x;${"y".repeat(998)}`; // 1000 chars, fails strict validation
    await appendTranscript(`group:${long}`, { direction: "in", at: "t1", content: "m2", from: "+2", group_id: long });
    const files = readdirSync(dir).filter((f) => f.startsWith("gx-"));
    assert.equal(files.length, 2);
    for (const f of files) {
      assert.match(f, /^gx-[0-9a-f]{64}\.jsonl$/, "the quarantine filename is bounded: gx- + exactly 64 hex chars");
    }
    // Neither the stripped form nor the raw form is transcript-admitted: a gx-* file
    // never satisfies hasTranscript.
    assert.equal(hasTranscript("group:grpevil"), false);
    assert.equal(hasTranscript("group:grp;evil"), false);
    // But history IS preserved and read back per exact raw id.
    assert.deepEqual(readTranscript("group:grp;evil").map((e) => e.content), ["m"]);
    assert.deepEqual(readTranscript(`group:${long}`).map((e) => e.content), ["m2"]);
    assert.equal(existsSync(join(dir, "g-grpevil.jsonl")), false, "no lossy g-<stripped>.jsonl is created");
    assert.deepEqual(smsGroupSummaries(), [], "quarantined groups are never discoverable");
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("digest-key separation on disk (spec test 14): a lone-surrogate id and a U+FFFD id land in DIFFERENT gx- files, each holding only its own raw-id history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-digest-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    const lone = "grp\ud800x";
    const repl = "grp\ufffdx";
    await appendTranscript(`group:${lone}`, { direction: "in", at: "t0", content: "lone", from: "+1", group_id: lone });
    await appendTranscript(`group:${repl}`, { direction: "in", at: "t1", content: "repl", from: "+2", group_id: repl });
    const gx = readdirSync(dir).filter((f) => f.startsWith("gx-"));
    assert.equal(gx.length, 2, "two distinct digest paths -- plain UTF-8 encoding would have collided these");
    assert.deepEqual(readTranscript(`group:${lone}`).map((e) => e.content), ["lone"]);
    assert.deepEqual(readTranscript(`group:${repl}`).map((e) => e.content), ["repl"]);
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("interleaved quarantine isolation (spec test 15): the production per-raw-ID filter keeps two logical histories unmixed even under a shared physical file/digest", () => {
  // Two raw ids whose entries share ONE physical gx- file (a theoretical digest
  // collision). Reads are DEFINED as exact group_id equality (entriesForRawGroupId,
  // the helper readTranscript applies to gx-* paths), so each raw id gets only its
  // own entries -- the collision cannot mix the histories.
  const a = "grp;one";
  const b = "grp;two";
  const interleaved: TranscriptEntry[] = [
    { direction: "in", at: "t0", content: "a1", from: "+1", group_id: a },
    { direction: "in", at: "t1", content: "b1", from: "+2", group_id: b },
    { direction: "in", at: "t2", content: "a2", from: "+1", group_id: a },
    { direction: "out", at: "t3", content: "b2", group_id: b },
    { direction: "in", at: "t4", content: "a3", from: "+3", group_id: a },
  ];
  assert.deepEqual(entriesForRawGroupId(interleaved, a).map((e) => e.content), ["a1", "a2", "a3"], "raw id a sees only its own entries, in order");
  assert.deepEqual(entriesForRawGroupId(interleaved, b).map((e) => e.content), ["b1", "b2"], "raw id b sees only its own entries, in order");
  // A legacy (group_id-less) entry belongs to NEITHER quarantined history.
  assert.deepEqual(entriesForRawGroupId([{ direction: "in", at: "t5", content: "legacy" }], a), []);
});

test("smsGroupSummaries: enriched and legacy transcripts, metadata fallback, most-recent-wins, deduped speakers, ordering (spec tests 2-3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-sum-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    // Enriched group: metadata on every inbound.
    await appendTranscript("group:grp_new", { direction: "in", at: "2026-08-01T10:00:00Z", content: "hi all", from: "+15551234567", group_id: "grp_new", group_name: "Fam Chat", participants: ["+15551234567", "+15550000000"] });
    await appendTranscript("group:grp_new", { direction: "out", at: "2026-08-01T11:00:00Z", content: "hello" });
    // Legacy group: pre-feature, no metadata (id + speakers + lastActivity only).
    await appendTranscript("group:grp_old", { direction: "in", at: "2026-07-01T10:00:00Z", content: "hey", from: "+15550000000" });
    // Renamed group: most-recent name + participant snapshot win; a MISMATCHED
    // group_id (an attempt to retarget the file) is ignored.
    await appendTranscript("group:grp_ren", { direction: "in", at: "2026-08-02T10:00:00Z", content: "m1", from: "+15551111111", group_id: "grp_ren", group_name: "Old Name", participants: ["+15551111111"] });
    await appendTranscript("group:grp_ren", { direction: "in", at: "2026-08-02T11:00:00Z", content: "m2", from: "+15552222222", group_id: "grp_ren", group_name: "New Name", participants: ["+15551111111", "+15552222222"] });
    await appendTranscript("group:grp_ren", { direction: "in", at: "2026-08-02T12:00:00Z", content: "evil", from: "+15553333333", group_id: "grp_other", group_name: "Retargeted", participants: ["+15553333333"] });
    const sums = smsGroupSummaries();
    // Ordering: valid lastActivity descending.
    assert.deepEqual(sums.map((s) => s.id), ["grp_ren", "grp_new", "grp_old"]);
    const ren = sums[0];
    assert.equal(ren.name, "New Name", "the most recent identity-consistent name wins");
    assert.deepEqual(ren.participants, ["+15551111111", "+15552222222"], "the most recent consistent participant snapshot wins");
    assert.deepEqual(ren.speakers, ["+15551111111", "+15552222222", "+15553333333"], "speakers are the stable deduped inbound from set (speaker attribution is separate from metadata identity)");
    assert.equal(ren.lastActivity, "2026-08-02T12:00:00Z");
    const fresh = sums[1];
    assert.equal(fresh.name, "Fam Chat");
    assert.deepEqual(fresh.participants, ["+15551234567", "+15550000000"]);
    assert.deepEqual(fresh.speakers, ["+15551234567"]);
    assert.equal(fresh.lastActivity, "2026-08-01T11:00:00Z");
    const legacy = sums[2];
    assert.equal(legacy.name, null, "a legacy transcript exposes no name until its next inbound");
    assert.deepEqual(legacy.participants, []);
    assert.deepEqual(legacy.speakers, ["+15550000000"]);
    assert.equal(legacy.lastActivity, "2026-07-01T10:00:00Z");
    // Never message bodies or media urls.
    const json = JSON.stringify(sums);
    assert.ok(!json.includes("hi all") && !json.includes("m1"), "no message bodies");
    assert.ok(!json.includes("media_url"), "no media urls");
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("smsGroupSummaries: corrupt lines ignored, invalid filenames skipped, gx-* never scanned, undated last, deterministic tie-break, empty dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-scan-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    // Corrupt lines are ignored consistently with readTranscript; valid entries survive.
    writeFileSync(join(dir, "g-grp_c.jsonl"), `{not json}\n${JSON.stringify({ direction: "in", at: "2026-08-03T10:00:00Z", content: "ok", from: "+15551234567", group_id: "grp_c", group_name: "Clean" })}\n`);
    // Invalid group transcript filenames are skipped (suffix fails strict validation).
    writeFileSync(join(dir, "g-bad;id.jsonl"), `${JSON.stringify({ direction: "in", at: "2026-08-04T10:00:00Z", content: "x", from: "+1" })}\n`);
    // gx-* quarantine transcripts are NEVER scanned (their suffix would otherwise be strict-shaped: x-<hex>).
    const gx = join(dir, `gx-${quarantineKey("grp;hidden")}.jsonl`);
    writeFileSync(gx, `${JSON.stringify({ direction: "in", at: "2026-08-05T10:00:00Z", content: "x", from: "+1", group_id: "grp;hidden", group_name: "Should Not Appear" })}\n`);
    // Phone transcripts don't start with g- and are skipped.
    writeFileSync(join(dir, "15551234567.jsonl"), `${JSON.stringify({ direction: "in", at: "2026-08-06T10:00:00Z", content: "x" })}\n`);
    // An undated legacy file sorts after every dated one.
    writeFileSync(join(dir, "g-grp_nodate.jsonl"), `${JSON.stringify({ direction: "in", content: "old" })}\n`);
    const sums = smsGroupSummaries();
    assert.deepEqual(sums.map((s) => s.id), ["grp_c", "grp_nodate"], "only valid strict g-<id> files; corrupt lines dropped; undated last");
    assert.equal(sums[0].name, "Clean");
    assert.equal(sums[0].lastActivity, "2026-08-03T10:00:00Z");
    assert.equal(sums[1].lastActivity, null, "an undated entry yields lastActivity null, sorted after dated groups");
    // Deterministic ID tie-break: two undated groups sort by id.
    writeFileSync(join(dir, "g-grp_zz.jsonl"), `${JSON.stringify({ direction: "in", content: "z" })}\n`);
    const tie = smsGroupSummaries().filter((s) => s.lastActivity === null).map((s) => s.id);
    assert.deepEqual(tie, ["grp_nodate", "grp_zz"], "alphabetical ID tie-breaker among undated groups");
    // Empty dir (or none at all) -> [].
    const empty = mkdtempSync(join(tmpdir(), "sms-tx-empty-"));
    process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = empty;
    assert.deepEqual(smsGroupSummaries(), []);
    process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = join(empty, "does-not-exist");
    assert.deepEqual(smsGroupSummaries(), [], "a missing transcript dir is [] not a throw");
    rmSync(empty, { recursive: true, force: true });
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("smsGroupSummaries: lastActivity is the NEWEST entry's timestamp only -- an undated newest entry nulls it even when older entries are dated (spec §Group summaries)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-newest-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    // Hand-written file (the grandfather shape): a dated entry followed by an UNDATED
    // newest one. The old backward walk returned the dated entry's timestamp here,
    // presenting stale activity as the group's last activity.
    writeFileSync(join(dir, "g-grp_stale.jsonl"),
      `${JSON.stringify({ direction: "in", at: "2026-08-01T10:00:00Z", content: "dated", from: "+15550000000" })}\n${JSON.stringify({ direction: "in", content: "undated" })}\n`);
    const sums = smsGroupSummaries();
    assert.equal(sums.length, 1);
    assert.equal(sums[0].id, "grp_stale");
    assert.equal(sums[0].lastActivity, null, "no backward walk past the undated newest entry -- lastActivity is null");
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});

test("grandfather eligibility (spec test 18): a pre-feature strict-looking g-<id>.jsonl transcript is immediately discoverable", () => {
  const dir = mkdtempSync(join(tmpdir(), "sms-tx-grand-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    // Hand-written pre-feature file: bare entries, no metadata, never appended by the
    // post-change code path. It stays eligible for discovery as-is.
    writeFileSync(join(dir, "g-grp_hist.jsonl"), `${JSON.stringify({ direction: "in", at: "2026-01-01T00:00:00Z", content: "legacy", from: "+15550000000" })}\n${JSON.stringify({ direction: "out", at: "2026-01-02T00:00:00Z", content: "re" })}\n`);
    const sums = smsGroupSummaries();
    assert.equal(sums.length, 1);
    assert.equal(sums[0].id, "grp_hist");
    assert.equal(sums[0].name, null);
    assert.deepEqual(sums[0].speakers, ["+15550000000"]);
    assert.equal(sums[0].lastActivity, "2026-01-02T00:00:00Z");
    assert.equal(hasTranscript("group:grp_hist"), true, "still transcript-admitted (schedulable)");
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});
