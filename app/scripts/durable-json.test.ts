import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDurableDirectorySyncForTest } from "./durable-directory.ts";
import { setDurableJsonFsyncForTest, writeDurableJson } from "./durable-json.ts";

test("durable JSON publication fsyncs the temp inode before rename and its directory after", () => {
  const root = mkdtempSync(join(tmpdir(), "durable-json-"));
  const path = join(root, "nested", "cursor.json");
  const events: string[] = [];
  const restoreFile = setDurableJsonFsyncForTest(() => { events.push("file"); });
  const restoreDirectory = setDurableDirectorySyncForTest(directory => { if (directory.endsWith("nested")) events.push("directory"); });
  try {
    writeDurableJson(path, { appliedThrough: 7 });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { appliedThrough: 7 });
    assert.deepEqual(events.slice(-2), ["file", "directory"]);
  } finally { restoreFile(); restoreDirectory(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed cursor inode fsync cannot publish the replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "durable-json-fault-"));
  const path = join(root, "cursor.json");
  const restore = setDurableJsonFsyncForTest(() => { throw new Error("fsync fault"); });
  try {
    assert.throws(() => writeDurableJson(path, { appliedThrough: 9 }), /fsync fault/);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(root), [], "owned failed temp is removed so retry cannot collide");
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});
