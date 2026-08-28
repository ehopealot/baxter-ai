import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordNoReplyOutcome, requireNoReplyOutcome } from "./runner-resolution-receipts.ts";

test("an explicit no-reply runner outcome is durable and idempotent by surface/work ID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-resolution-"));
  const previous = process.env.RUNNER_RESOLUTION_RECEIPTS_DIR_OVERRIDE;
  process.env.RUNNER_RESOLUTION_RECEIPTS_DIR_OVERRIDE = dir;
  const workId = "c".repeat(64);
  try {
    const first = await recordNoReplyOutcome("mail", workId, "automated notification");
    const replay = await recordNoReplyOutcome("mail", workId, "changed replay reason");
    assert.deepEqual(replay, first, "the first durable no-reply decision wins");
    assert.deepEqual(requireNoReplyOutcome("mail", workId), first);
    assert.throws(() => requireNoReplyOutcome("sms", workId), /not durable/);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_RESOLUTION_RECEIPTS_DIR_OVERRIDE; else process.env.RUNNER_RESOLUTION_RECEIPTS_DIR_OVERRIDE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
