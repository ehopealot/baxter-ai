import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";
import { clearDurableCursorProcessStateForTest, loadDurableCursor, storeDurableCursor } from "./durable-cursor.ts";

test("an uncertain cursor replays live and a restarted process repairs the visible inode before trusting it", () => {
  const root = mkdtempSync(join(tmpdir(), "durable-cursor-"));
  const path = join(root, "state", "cursor.json");
  try {
    storeDurableCursor(path, 1);
    let directorySyncs = 0;
    const restore = setDurableDirectorySyncForTest(directory => {
      if (resolve(directory) === resolve(join(root, "state")) && ++directorySyncs === 2) {
        throw new Error("injected cursor publication barrier failure");
      }
    });
    try { assert.throws(() => storeDurableCursor(path, 2), /publication barrier failure/); }
    finally { restore(); }

    assert.equal(JSON.parse(readFileSync(path, "utf8")).appliedThrough, 2, "rename may already be visible");
    assert.equal(loadDurableCursor(path), 1, "the live process cannot skip replay after an uncertain publication");

    clearDurableCursorProcessStateForTest(path); // emulate a fresh process
    const repaired: string[] = [];
    const restoreRepair = setDurableDirectorySyncForTest(directory => repaired.push(resolve(directory)));
    try { assert.equal(loadDurableCursor(path), 2); }
    finally { restoreRepair(); }
    assert.ok(repaired.includes(resolve(join(root, "state"))), "restart re-fsyncs the containing directory before trusting the cursor");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    clearDurableCursorProcessStateForTest(path);
    rmSync(root, { recursive: true, force: true });
  }
});
