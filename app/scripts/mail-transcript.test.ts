import { test } from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = mkdtempSync(join(tmpdir(), "mailtx-"));
const { appendMailTranscript, readMailTranscript, hasMailTranscript, latestInboundMessageId, correspondentForThread } = await import("./mail-transcript.ts");
test("round-trips inbound/outbound and recovers last inbound message-id", async () => {
  const who = "friend@example.com";
  assert.equal(hasMailTranscript(who), false);
  await appendMailTranscript(who, { direction: "in", at: "2026-08-06T00:00:00Z", subject: "hi", content: "hello", threadId: "resend:me@bax.bot:abc", messageId: "<m1@x>" });
  await appendMailTranscript(who, { direction: "out", at: "2026-08-06T00:01:00Z", subject: "re: hi", content: "hey" });
  assert.equal(hasMailTranscript(who), true);
  assert.equal((await readMailTranscript(who)).length, 2);
  assert.equal(latestInboundMessageId("resend:me@bax.bot:abc"), "<m1@x>");
  assert.equal(correspondentForThread("resend:me@bax.bot:abc"), "friend@example.com");
  assert.equal(correspondentForThread("resend:me@bax.bot:unknown"), null);
});

test("a corrupt thread-index.json makes updateIndex throw instead of silently wiping the index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailtx-corrupt-"));
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    const who = "corrupt@example.com";
    await appendMailTranscript(who, { direction: "in", at: "t0", subject: "s", content: "c", threadId: "t1", messageId: "<m1@x>" });
    assert.equal(latestInboundMessageId("t1"), "<m1@x>");
    // Simulate a corrupt/garbage index file (e.g. a partial write from a crash).
    writeFileSync(join(dir, "thread-index.json"), "{not valid json", "utf8");
    await assert.rejects(() =>
      appendMailTranscript(who, { direction: "in", at: "t1new", subject: "s2", content: "c2", threadId: "t2", messageId: "<m2@x>" })
    );
    // The corrupt file must be left untouched -- NOT silently replaced with
    // only the new entry, which would have permanently dropped t1's mapping.
    assert.equal(readFileSync(join(dir, "thread-index.json"), "utf8"), "{not valid json");
  } finally {
    delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE;
  }
});

test("addresses that sanitize to the same prefix land in distinct, non-contaminating files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailtx-collide-"));
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    const a = "a.b@x.com";
    const b = "a-b@x.com";
    assert.equal(hasMailTranscript(a), false);
    assert.equal(hasMailTranscript(b), false);
    await appendMailTranscript(a, { direction: "in", at: "t0", subject: "s", content: "from a" });
    assert.equal(hasMailTranscript(a), true);
    assert.equal(hasMailTranscript(b), false); // must not cross-contaminate
    await appendMailTranscript(b, { direction: "in", at: "t0", subject: "s", content: "from b" });
    assert.equal(hasMailTranscript(b), true);
    assert.deepEqual((await readMailTranscript(a)).map(e => e.content), ["from a"]);
    assert.deepEqual((await readMailTranscript(b)).map(e => e.content), ["from b"]);
  } finally {
    delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE;
  }
});
