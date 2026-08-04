import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTranscript, readTranscript } from "./sms-transcript.ts";

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
