import { test } from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
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
