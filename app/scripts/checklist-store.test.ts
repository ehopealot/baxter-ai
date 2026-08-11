// Tests for the checklist store: mutate round-trip + missing-file read. The
// cross-process lock is proven end-to-end in checklist-cli.test.ts (spawned CLI adds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutate, readChecklists, newItemId, retireList, capCategory, MAX_CATEGORY } from "./checklist-store.ts";
import type { Checklist } from "./checklist-store.ts";

test("capCategory collapses whitespace, trims, and caps at MAX_CATEGORY (the one category sanitizer)", () => {
  assert.equal(capCategory("  Cold\n Dairy  "), "Cold Dairy");
  assert.equal(capCategory("x".repeat(100)).length, MAX_CATEGORY);
  assert.equal(capCategory("   "), ""); // whitespace-only -> empty (the clear signal)
});

const cl = (o: Partial<Checklist>): Checklist => ({ id: o.slug ?? "l", slug: "l", name: "L", items: [], created: "", updated: "", ...o });

test("retireList drops an un-mirrored list outright (by stable id)", () => {
  const lists = [cl({ id: "a", slug: "a", items: [{ id: "i", text: "x", checked: false, created: "" }] }), cl({ id: "b", slug: "b" })];
  const out = retireList(lists, lists[0], "2026-08-11T00:00:00Z");
  assert.deepEqual(out.map((l) => l.id), ["b"]); // "a" removed, no tombstone
});

test("retireList tombstones a mirrored list in place (queues unmirror, empties, keeps it draining)", () => {
  const list = cl({ id: "a", slug: "a", channelId: "c1", items: [{ id: "i", text: "x", checked: true, mirrorMessageId: "m1", created: "" }] });
  const out = retireList([list], list, "2026-08-11T00:00:00Z");
  assert.equal(out.length, 1);
  assert.equal(out[0].deleted, true);
  assert.deepEqual(out[0].items, []);
  assert.deepEqual(out[0].pendingUnmirror, ["m1"]); // queued for the gateway to delete in c1
  assert.equal(out[0].updated, "2026-08-11T00:00:00Z");
});

const storePath = (): string => join(mkdtempSync(join(tmpdir(), "cl-")), "checklists.json");
const list = (slug: string): Checklist => ({ id: slug, slug, name: slug, items: [], created: "", updated: "" });

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
