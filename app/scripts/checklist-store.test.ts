// Tests for the checklist store: mutate round-trip + missing-file read. The
// cross-process lock is proven end-to-end in checklist-cli.test.ts (spawned CLI adds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutate, readChecklists, newItemId } from "./checklist-store.ts";
import type { Checklist } from "./checklist-store.ts";

const storePath = (): string => join(mkdtempSync(join(tmpdir(), "cl-")), "checklists.json");
const list = (slug: string): Checklist => ({ slug, name: slug, items: [], created: "", updated: "" });

test("readChecklists on a missing store is [] (not a throw)", () => {
  assert.deepEqual(readChecklists(storePath()), []);
});

test("mutate creates the file, round-trips, and serializes read->write", async () => {
  const p = storePath();
  await mutate(p, (lists) => { lists.push(list("groceries")); return { lists, value: null }; });
  await mutate(p, (lists) => { lists[0].items.push({ id: newItemId(), text: "milk", checked: false, created: "" }); return { lists, value: null }; });
  const all = readChecklists(p);
  assert.equal(all.length, 1);
  assert.equal(all[0].items[0].text, "milk");
});

test("newItemId is unique and hex-shaped", () => {
  assert.notEqual(newItemId(), newItemId());
  assert.match(newItemId(), /^[0-9a-f]{16}$/);
});
