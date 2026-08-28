import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createChat, deleteChat, setTitle, appendMessage, readMessages, listChats, setChatTranscriptFsyncForTest } from "./chat-transcript.ts";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";

async function withTmpDir<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    return await fn();
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("createChat is idempotent; appendMessage round-trips and bumps lastAt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    await createChat("wc-1", "2026-08-05T00:00:00Z");
    await createChat("wc-1", "2026-08-05T00:00:00Z"); // no duplicate
    assert.equal(listChats().length, 1);
    await appendMessage("wc-1", { id: "wc-1", at: "2026-08-05T00:01:00Z", authorId: "member:erik@x.com", authorName: "Erik", content: "hi" });
    await appendMessage("wc-1", { id: "b-1", at: "2026-08-05T00:02:00Z", authorId: "baxter", authorName: "Baxter", content: "hello" });
    const msgs = readMessages("wc-1");
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].authorName, "Erik");
    assert.equal(listChats()[0].lastAt, "2026-08-05T00:02:00Z");
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendMessage reconciles one deterministic ID under lock and rejects changed content", async () => {
  await withTmpDir(async () => {
    await createChat("wc-9", "2026-08-05T00:00:00Z");
    const message = { id: "wc-42", at: "2026-08-05T00:01:00Z", authorId: "member:a" as const, authorName: "A", content: "once" };
    await appendMessage("wc-9", message);
    await appendMessage("wc-9", message);
    assert.deepEqual(readMessages("wc-9"), [message], "redelivery cannot append a second row");
    await assert.rejects(() => appendMessage("wc-9", { ...message, content: "changed" }), error => {
      assert.equal((error as { permanent?: unknown }).permanent, true);
      return true;
    });
    assert.deepEqual(readMessages("wc-9"), [message]);
  });
});

function fullAncestry(path: string): string[] {
  const ancestry: string[] = [];
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    ancestry.push(cursor);
    if (dirname(cursor) === cursor) return ancestry.reverse();
  }
}

test("chat transcript commits fsync files and the full directory publication chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "chats-durable-"));
  const target = join(root, "state", "chats");
  process.env.CHATS_DIR_OVERRIDE = target;
  const directories: string[] = [];
  let fileSyncs = 0;
  const restoreDirectory = setDurableDirectorySyncForTest(path => { directories.push(resolve(path)); });
  const restoreFile = setChatTranscriptFsyncForTest(() => { fileSyncs++; });
  try {
    await createChat("wc-1", "2026-08-05T00:00:00Z");
    await appendMessage("wc-1", { id: "wc-2", at: "2026-08-05T00:01:00Z", authorId: "member:a", authorName: "A", content: "durable" });
    assert.ok(fileSyncs >= 5, "index bootstrap/temp and transcript bootstrap/row are file-fsynced");
    assert.deepEqual(directories.slice(0, fullAncestry(target).length), fullAncestry(target), "base directory ancestry is durable before index publication");
    assert.ok(directories.includes(resolve(join(target, "wc-1"))), "the per-chat directory is fsynced");
    assert.ok(directories.filter(path => path === resolve(target)).length >= 2, "index renames fsync their containing directory");
  } finally {
    restoreFile(); restoreDirectory(); delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transcript row fsync failure rejects the commit and redelivery reconciles one row", async () => {
  await withTmpDir(async () => {
    await createChat("wc-10", "2026-08-05T00:00:00Z");
    let calls = 0;
    const restore = setChatTranscriptFsyncForTest(() => { if (++calls === 2) throw new Error("injected row fsync failure"); });
    const message = { id: "wc-11", at: "2026-08-05T00:01:00Z", authorId: "member:a" as const, authorName: "A", content: "retry me" };
    try {
      await assert.rejects(() => appendMessage("wc-10", message), /injected row fsync failure/);
    } finally { restore(); }
    let retrySyncs = 0;
    const restoreRetry = setChatTranscriptFsyncForTest(() => { retrySyncs++; });
    try { await appendMessage("wc-10", message); } finally { restoreRetry(); }
    assert.ok(retrySyncs >= 2, "redelivery fsyncs the visible transcript row and the repaired index commit");
    assert.deepEqual(readMessages("wc-10"), [message], "visible bytes from the rejected fsync are reconciled, not duplicated");
  });
});

test("appendMessage repairs an unterminated partial tail but rejects newline-terminated corruption", async () => {
  await withTmpDir(async () => {
    await createChat("wc-12", "2026-08-05T00:00:00Z");
    const path = join(process.env.CHATS_DIR_OVERRIDE!, "wc-12", "messages.jsonl");
    const first = { id: "wc-13", at: "2026-08-05T00:01:00Z", authorId: "member:a" as const, authorName: "A", content: "first" };
    const second = { id: "wc-14", at: "2026-08-05T00:02:00Z", authorId: "member:a" as const, authorName: "A", content: "second" };
    await appendMessage("wc-12", first);
    writeFileSync(path, readFileSync(path, "utf8").slice(0, -1));
    assert.throws(() => readMessages("wc-12"), /partial trailing transcript row/);
    await appendMessage("wc-12", first);
    assert.ok(readFileSync(path, "utf8").endsWith("\n"), "a complete row missing only its newline is repaired and fsynced");

    writeFileSync(path, readFileSync(path, "utf8") + '{"id":"wc-crash"');
    assert.throws(() => readMessages("wc-12"), /partial trailing transcript row/);
    await appendMessage("wc-12", second);
    assert.deepEqual(readMessages("wc-12"), [first, second]);

    writeFileSync(path, readFileSync(path, "utf8") + "not-json\n");
    await assert.rejects(() => appendMessage("wc-12", { ...second, id: "wc-15" }), /corrupt transcript row/);
  });
});

test("setTitle updates the index", async () => {
  await withTmpDir(async () => {
    await createChat("wc-2", "2026-08-05T00:00:00Z");
    await setTitle("wc-2", "Weekend plans");
    assert.equal(listChats().find(c => c.id === "wc-2")?.title, "Weekend plans");
  });
});

test("readMessages respects limit (last N)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    await createChat("wc-3", "2026-08-05T00:00:00Z");
    for (let i = 0; i < 3; i++) {
      await appendMessage("wc-3", { id: `m-${i}`, at: `2026-08-05T00:0${i}:00Z`, authorId: "baxter", authorName: "Baxter", content: String(i) });
    }
    const last2 = readMessages("wc-3", 2);
    assert.deepEqual(last2.map(m => m.content), ["1", "2"]);
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bogus id is rejected (no path traversal)", async () => {
  await withTmpDir(async () => {
    // createChat/setTitle are async, so validateId's throw surfaces as a rejection.
    await assert.rejects(() => createChat("../../etc", "2026-08-05T00:00:00Z"));
    await assert.rejects(() => setTitle("../../etc", "x"));
    assert.throws(() => readMessages("../../etc"));
  });
});

test("listChats returns [] when no chats exist yet", async () => {
  await withTmpDir(() => {
    assert.deepEqual(listChats(), []);
  });
});

test("appendMessage rejects a chat id with no index entry (no orphan log)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    await assert.rejects(() =>
      appendMessage("wc-99", { id: "m-1", at: "2026-08-05T00:00:00Z", authorId: "baxter", authorName: "Baxter", content: "hi" })
    );
    assert.deepEqual(listChats(), []);
    // The rejection must be BEFORE the log write, not just after: the chat's
    // directory must never even be created for a chat with no index entry.
    assert.equal(existsSync(join(dir, "wc-99")), false);
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendMessage's lastAt bump is monotonic (out-of-order timestamps never move it backwards)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    await createChat("wc-4", "2026-08-05T00:00:00Z");
    await appendMessage("wc-4", { id: "m-1", at: "2026-08-05T00:05:00Z", authorId: "baxter", authorName: "Baxter", content: "later" });
    // An out-of-order append (older timestamp than the current lastAt) must not regress lastAt.
    await appendMessage("wc-4", { id: "m-2", at: "2026-08-05T00:01:00Z", authorId: "baxter", authorName: "Baxter", content: "earlier" });
    assert.equal(listChats().find(c => c.id === "wc-4")?.lastAt, "2026-08-05T00:05:00Z");
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendMessage's lastAt bump compares numerically, not lexicographically, across mixed timestamp precision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    await createChat("wc-5", "2026-08-05T00:00:00Z");
    // A chronologically LATER millisecond-precision timestamp that is
    // lexicographically LESS than a whole-second one ('.' < 'Z' in ASCII, so
    // "...00.500Z" < "...00Z" as strings even though 500ms is later) --
    // this is exactly the case a naive string compare gets backwards.
    await appendMessage("wc-5", { id: "m-1", at: "2026-08-05T00:00:00.500Z", authorId: "baxter", authorName: "Baxter", content: "later, ms-precision" });
    assert.equal(listChats().find(c => c.id === "wc-5")?.lastAt, "2026-08-05T00:00:00.500Z");
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteChat tombstones: listChats drops the chat; appendMessage rejects late writes", async () => {
  await withTmpDir(async () => {
    await createChat("wc-6", "2026-08-07T12:00:00.000Z");
    assert.equal(listChats().length, 1, "chat exists before delete");
    await deleteChat("wc-6");
    assert.equal(listChats().length, 0, "listChats filters the tombstoned chat");
    await assert.rejects(
      () => appendMessage("wc-6", { id: "m-late", at: "2026-08-07T12:00:00.000Z", authorId: "baxter", authorName: "Baxter", content: "late" }),
      /was deleted/,
    );
    assert.equal(readMessages("wc-6").length, 0, "tombstoning does not write or purge the log");
  });
});

test("deleteChat is idempotent when repeated", async () => {
  await withTmpDir(async () => {
    await createChat("wc-7", "2026-08-07T12:00:00.000Z");
    await deleteChat("wc-7");
    await deleteChat("wc-7");
    assert.equal(listChats().length, 0);
  });
});

test("deleteChat on a never-created chat is a no-op", async () => {
  await withTmpDir(async () => {
    await deleteChat("wc-99");
    assert.deepEqual(listChats(), []);
  });
});
