import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChat, setTitle, appendMessage, readMessages, listChats } from "./chat-transcript.ts";

function withTmpDir<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    return fn();
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("createChat is idempotent; appendMessage round-trips and bumps lastAt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    createChat("wc-1", "2026-08-05T00:00:00Z");
    createChat("wc-1", "2026-08-05T00:00:00Z"); // no duplicate
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

test("setTitle updates the index", () => {
  withTmpDir(() => {
    createChat("wc-2", "2026-08-05T00:00:00Z");
    setTitle("wc-2", "Weekend plans");
    assert.equal(listChats().find(c => c.id === "wc-2")?.title, "Weekend plans");
  });
});

test("readMessages respects limit (last N)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    createChat("wc-3", "2026-08-05T00:00:00Z");
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

test("a bogus id is rejected (no path traversal)", () => {
  withTmpDir(() => {
    assert.throws(() => createChat("../../etc", "2026-08-05T00:00:00Z"));
    assert.throws(() => setTitle("../../etc", "x"));
    assert.throws(() => readMessages("../../etc"));
  });
});

test("listChats returns [] when no chats exist yet", () => {
  withTmpDir(() => {
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
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendMessage's lastAt bump is monotonic (out-of-order timestamps never move it backwards)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  try {
    createChat("wc-4", "2026-08-05T00:00:00Z");
    await appendMessage("wc-4", { id: "m-1", at: "2026-08-05T00:05:00Z", authorId: "baxter", authorName: "Baxter", content: "later" });
    // An out-of-order append (older timestamp than the current lastAt) must not regress lastAt.
    await appendMessage("wc-4", { id: "m-2", at: "2026-08-05T00:01:00Z", authorId: "baxter", authorName: "Baxter", content: "earlier" });
    assert.equal(listChats().find(c => c.id === "wc-4")?.lastAt, "2026-08-05T00:05:00Z");
  } finally {
    delete process.env.CHATS_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});
