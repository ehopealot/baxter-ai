// Tests for the checklist Discord mirror: the pure diff/resolution + reconcile/handleReaction
// against a fake DiscordOps and a temp store (no live client).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutate, readChecklists } from "./checklist-store.ts";
import type { Checklist } from "./checklist-store.ts";
import { planReconcile, resolveReaction, reconcile, handleReaction, itemMessageContent } from "./checklist-mirror.ts";
import type { DiscordOps } from "./checklist-mirror.ts";

const storePath = (): string => join(mkdtempSync(join(tmpdir(), "clm-")), "checklists.json");
const seed = (p: string, l: Checklist) => mutate(p, (lists) => { lists.push(l); return { lists, value: null }; });
const cl = (o: Partial<Checklist>): Checklist => ({ slug: "todos", name: "Todos", channelId: "chan1", items: [], created: "", updated: "", ...o });
const item = (id: string, text: string, o: Partial<{ checked: boolean; mirrorMessageId: string; due: string }> = {}) => ({ id, text, checked: false, created: "", ...o });

function fakeOps(): { ops: DiscordOps; posted: { channelId: string; content: string; id: string }[]; deleted: string[] } {
  const posted: { channelId: string; content: string; id: string }[] = [];
  const deleted: string[] = [];
  let n = 0;
  const ops: DiscordOps = {
    post: async (channelId, content) => { const id = `msg-${++n}`; posted.push({ channelId, content, id }); return id; },
    delete: async (_c, id) => { deleted.push(id); },
  };
  return { ops, posted, deleted };
}

test("planReconcile: open items w/o id -> post; checked-with-id + pendingUnmirror -> delete", () => {
  const list = cl({ items: [item("a", "milk"), item("b", "bread", { checked: true, mirrorMessageId: "m2" }), item("c", "eggs", { mirrorMessageId: "m3" })], pendingUnmirror: ["mX"] });
  const plan = planReconcile(list);
  assert.deepEqual(plan.toPost.map((i) => i.id), ["a"]); // c already has an id, b is checked
  assert.deepEqual(plan.toDelete.sort(), ["m2", "mX"]);
});

test("itemMessageContent renders the item (with a due)", () => {
  assert.equal(itemMessageContent(item("a", "call plumber")), "- call plumber");
  assert.match(itemMessageContent(item("a", "x", { due: "2026-08-04T15:00:00Z" })), /due 2026-08-04 15:00/);
});

test("resolveReaction matches an open item by mirrorMessageId, skips checked + deleted lists", () => {
  const lists = [cl({ items: [item("a", "milk", { mirrorMessageId: "m1" }), item("b", "bread", { checked: true, mirrorMessageId: "m2" })] }), cl({ slug: "g2", deleted: true, items: [item("c", "x", { mirrorMessageId: "m3" })] })];
  assert.equal(resolveReaction(lists, "m1")?.item.text, "milk");
  assert.equal(resolveReaction(lists, "m2"), null); // checked
  assert.equal(resolveReaction(lists, "m3"), null); // deleted list
  assert.equal(resolveReaction(lists, "nope"), null);
});

test("reconcile posts one message per open item, records the id, and is idempotent", async () => {
  const p = storePath();
  await seed(p, cl({ items: [item("a", "file taxes"), item("b", "call plumber")] }));
  const first = fakeOps();
  await reconcile(first.ops, p);
  assert.equal(first.posted.length, 2);
  assert.ok(readChecklists(p)[0].items.every((i) => i.mirrorMessageId));
  const second = fakeOps();
  await reconcile(second.ops, p); // all posted already
  assert.equal(second.posted.length, 0);
});

test("reconcile deletes a checked item's message and clears its id", async () => {
  const p = storePath();
  await seed(p, cl({ items: [item("a", "milk", { checked: true, mirrorMessageId: "m5" })] }));
  const { ops, deleted } = fakeOps();
  await reconcile(ops, p);
  assert.deepEqual(deleted, ["m5"]);
  assert.equal(readChecklists(p)[0].items[0].mirrorMessageId, undefined);
});

test("reconcile drains pendingUnmirror and drops a drained rm-tombstone", async () => {
  const p = storePath();
  await seed(p, cl({ slug: "g", deleted: true, items: [], pendingUnmirror: ["m1", "m2"] }));
  const { ops, deleted } = fakeOps();
  await reconcile(ops, p);
  assert.deepEqual(deleted.slice().sort(), ["m1", "m2"]);
  assert.equal(readChecklists(p).length, 0); // tombstone gone
});

test("reconcile ignores un-bound (no channelId) lists", async () => {
  const p = storePath();
  await seed(p, cl({ slug: "plain", channelId: undefined, items: [item("a", "milk")] }));
  const { ops, posted } = fakeOps();
  await reconcile(ops, p);
  assert.equal(posted.length, 0);
});

test("handleReaction checks the item + deletes its message; returns false for an unknown message", async () => {
  const p = storePath();
  await seed(p, cl({ items: [item("a", "milk", { mirrorMessageId: "m9" })] }));
  const { ops, deleted } = fakeOps();
  assert.equal(await handleReaction("not-a-mirror", ops, p), false);
  assert.equal(deleted.length, 0);
  assert.equal(await handleReaction("m9", ops, p), true);
  const it = readChecklists(p)[0].items[0];
  assert.equal(it.checked, true);
  assert.equal(it.mirrorMessageId, undefined);
  assert.deepEqual(deleted, ["m9"]);
});
