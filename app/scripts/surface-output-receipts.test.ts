import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";
import { completeOutput, outputReceiptsForWork, prepareOutput } from "./surface-output-receipts.ts";

test("pre-existing surface output receipts and lock targets repair their directory barriers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-receipt-existing-"));
  const previous = process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE;
  process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE = dir;
  const workId = "a".repeat(64);
  const operation = { kind: "chat" as const, chatId: "wc-1", content: "hello", authorName: "Baxter" };
  try {
    await prepareOutput("chat", workId, operation);
    const synced: string[] = [];
    const restore = setDurableDirectorySyncForTest(path => synced.push(resolve(path)));
    try {
      await completeOutput("chat", workId, operation);
      assert.equal(outputReceiptsForWork("chat", workId)[0]?.state, "completed");
    } finally { restore(); }
    assert.ok(synced.length >= 3, "existing lock target and receipt reads each repeat a directory barrier");
    assert.ok(synced.every(path => path === resolve(dir)));
  } finally {
    if (previous === undefined) delete process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE; else process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
