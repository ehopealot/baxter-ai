import { test } from "node:test"; import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { dirname, join, resolve } from "node:path";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";
process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = mkdtempSync(join(tmpdir(), "mailtx-"));
const { appendMailTranscript, readMailTranscript, threadEntry } = await import("./mail-transcript.ts");

function fullAncestry(path: string): string[] {
  const ancestry: string[] = [];
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    ancestry.push(cursor);
    if (dirname(cursor) === cursor) return ancestry.reverse();
  }
}
test("transcript bootstrap fsyncs full ancestry before file publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "mailtx-directory-sync-"));
  const target = join(root, "state", "mail", "transcripts");
  const prior = process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE;
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = target;
  const synced: string[] = [];
  const restore = setDurableDirectorySyncForTest(path => { synced.push(resolve(path)); });
  try {
    await appendMailTranscript("directory@example.com", { direction: "out", at: "t0", subject: "s", content: "c" });
    assert.deepEqual(synced, [...fullAncestry(target), resolve(target)], "full bootstrap ancestry precedes the post-file base fsync");
  } finally {
    restore();
    if (prior === undefined) delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE; else process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transcript ancestry fsync failure blocks publication and retries the full barrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "mailtx-directory-fault-"));
  const target = join(root, "state", "mail", "transcripts");
  const prior = process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE;
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = target;
  const synced: string[] = [];
  const faultAt = resolve(root, "state");
  let restore = setDurableDirectorySyncForTest(path => {
    synced.push(resolve(path));
    if (resolve(path) === faultAt) throw new Error("injected parent fsync failure");
  });
  try {
    await assert.rejects(
      appendMailTranscript("fault@example.com", { direction: "out", at: "t0", subject: "s", content: "c" }),
      /injected parent fsync failure/,
    );
    assert.deepEqual(synced, fullAncestry(faultAt));
    assert.equal(existsSync(target), true, "mkdir may complete before its parent fsync");
    assert.deepEqual(readdirSync(target), [], "no transcript pathname is published after the failed durability barrier");

    restore();
    const retried: string[] = [];
    restore = setDurableDirectorySyncForTest(path => { retried.push(resolve(path)); });
    await appendMailTranscript("fault@example.com", { direction: "out", at: "t1", subject: "retry", content: "durable" });
    assert.deepEqual(retried, [...fullAncestry(target), resolve(target)], "retry repeats the full ancestry despite pre-existing directories");
  } finally {
    restore();
    if (prior === undefined) delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE; else process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an append to a precreated transcript file still fsyncs the base directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "mailtx-precreated-"));
  const prior = process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE;
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = root;
  try {
    await appendMailTranscript("precreated@example.com", { direction: "out", at: "t0", subject: "first", content: "first" });
    const synced: string[] = [];
    const restore = setDurableDirectorySyncForTest(path => { synced.push(resolve(path)); });
    try {
      await appendMailTranscript("precreated@example.com", { direction: "out", at: "t1", subject: "second", content: "second" });
      assert.deepEqual(synced, [resolve(root)], "EEXIST append pairs its locked file fsync with a base-directory fsync");
    } finally { restore(); }
  } finally {
    if (prior === undefined) delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE; else process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("round-trips inbound/outbound transcript entries", async () => {
  const who = "friend@example.com";
  await appendMailTranscript(who, { direction: "in", at: "2026-08-06T00:00:00Z", subject: "hi", content: "hello", threadId: "resend:me@bax.bot:abc", messageId: "<m1@x>" });
  await appendMailTranscript(who, { direction: "out", at: "2026-08-06T00:01:00Z", subject: "re: hi", content: "hey" });
  assert.equal((await readMailTranscript(who)).length, 2);
});

test("outbound work-ID replay is idempotent in the durable transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailtx-work-id-"));
  const prior = process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE;
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    const entry = { direction: "out" as const, at: "2026-08-06T00:01:00Z", subject: "re: hi", content: "hey", workId: "c".repeat(64) };
    await appendMailTranscript("receipt@example.com", entry);
    await appendMailTranscript("receipt@example.com", { ...entry, at: "later", content: "rerun text" });
    assert.deepEqual(readMailTranscript("receipt@example.com"), [entry]);
  } finally {
    if (prior === undefined) delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE; else process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = prior;
  }
});

test("threadEntry returns one snapshot with all three fields, or null for an unknown thread", async () => {
  const who = "snapshot@example.com";
  await appendMailTranscript(who, { direction: "in", at: "t0", subject: "Snapshot subject", content: "hello", threadId: "resend:me@bax.bot:snap", messageId: "<snap1@x>" });
  assert.deepEqual(threadEntry("resend:me@bax.bot:snap"), { from: who, subject: "Snapshot subject", messageId: "<snap1@x>" });
  assert.equal(threadEntry("resend:me@bax.bot:unknown-snap"), null);
});

test("a corrupt thread-index.json makes updateIndex throw instead of silently wiping the index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailtx-corrupt-"));
  process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE = dir;
  try {
    const who = "corrupt@example.com";
    await appendMailTranscript(who, { direction: "in", at: "t0", subject: "s", content: "c", threadId: "t1", messageId: "<m1@x>" });
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
    await appendMailTranscript(a, { direction: "in", at: "t0", subject: "s", content: "from a" });
    await appendMailTranscript(b, { direction: "in", at: "t0", subject: "s", content: "from b" });
    assert.deepEqual((await readMailTranscript(a)).map(e => e.content), ["from a"]);
    assert.deepEqual((await readMailTranscript(b)).map(e => e.content), ["from b"]);
  } finally {
    delete process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE;
  }
});
