import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChat, setTitle, appendMessage, readMessages, listChats } from "./chat-transcript.ts";

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
