import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTranscript, hasTranscript, readTranscript } from "./sms-transcript.ts";

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
    await appendTranscript("group:grp_abc", { direction: "in", at: "t0", content: "hey all", from: "+15551234567" });
    await appendTranscript("group:grp_abc", { direction: "out", at: "t1", content: "hi everyone" });
    const g = readTranscript("group:grp_abc");
    assert.equal(g.length, 2);
    assert.equal(g[0].from, "+15551234567", "the speaker survives the round-trip");
    assert.equal(g[1].direction, "out");
    // A group id is NOT confused with a phone: it doesn't collide with a number transcript.
    assert.equal(hasTranscript("group:grp_abc"), true);
    assert.equal(hasTranscript("+15551234567"), false, "the group thread is not stored under any phone");
    assert.deepEqual(readTranscript("+15551234567"), [], "no phone transcript was created by the group append");
  } finally { delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); }
});
