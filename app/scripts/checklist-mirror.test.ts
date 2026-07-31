// Tests for the checklist Discord mirror: the pure diff/resolution + reconcile/handleReaction
// against a fake DiscordOps and a temp store (no live client).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutate, readChecklists } from "./checklist-store.ts";
import type { Checklist } from "./checklist-store.ts";
import { planReconcile, resolveReaction, reconcile, handleReaction, itemMessageContent, mirrorMessageIdSet } from "./checklist-mirror.ts";
import type { DiscordOps } from "./checklist-mirror.ts";

const storePath = (): string => join(mkdtempSync(join(tmpdir(), "clm-")), "checklists.json");
const seed = (p: string, l: Checklist) => mutate(p, (lists) => { lists.push(l); return { lists, value: null }; });
const cl = (o: Partial<Checklist>): Checklist => ({ slug: "todos", name: "Todos", channelId: "chan1", items: [], created: "", updated: "", ...o, id: o.id ?? o.slug ?? "todos" });
const item = (id: string, text: string, o: Partial<{ checked: boolean; mirrorMessageId: string; mirrorChecked: boolean; due: string }> = {}) => ({ id, text, checked: false, created: "", ...o });

function fakeOps(): { ops: DiscordOps; posted: { channelId: string; content: string; id: string }[]; deleted: string[]; edited: { id: string; content: string }[] } {
  const posted: { channelId: string; content: string; id: string }[] = [];
  const deleted: string[] = [];
  const edited: { id: string; content: string }[] = [];
  let n = 0;
  const ops: DiscordOps = {
    post: async (channelId, content) => { const id = `msg-${++n}`; posted.push({ channelId, content, id }); return id; },
    delete: async (_c, id) => { deleted.push(id); },
    edit: async (_c, id, content) => { edited.push({ id, content }); },
  };
  return { ops, posted, deleted, edited };
}

test("planReconcile: open w/o id -> post; a checked item whose message shows the open form -> edit; pendingUnmirror -> delete", () => {
  const list = cl({ items: [
    item("a", "milk"),                                                                 // open, no id -> post
    item("b", "bread", { checked: true, mirrorMessageId: "m2" }),                       // checked, msg still open form -> edit
    item("c", "eggs", { mirrorMessageId: "m3" }),                                        // open, already mirrored -> nothing
    item("d", "jam", { checked: true, mirrorMessageId: "m4", mirrorChecked: true }),     // checked + already struck -> nothing
  ], pendingUnmirror: ["mX"] });
  const plan = planReconcile(list);
  assert.deepEqual(plan.toPost.map((i) => i.id), ["a"]);
  assert.deepEqual(plan.toEdit.map((e) => e.id), ["m2"]); // only the drifted one, keyed by MESSAGE id
  assert.match(plan.toEdit[0].content, /~~bread~~/);
  assert.equal(plan.toEdit[0].checked, true);
  assert.deepEqual(plan.toDelete, ["mX"]); // only removals delete; checked items are struck, not deleted
});

test("planReconcile: an unchecked item whose message still shows the struck form -> edit back", () => {
  const list = cl({ items: [item("a", "milk", { mirrorMessageId: "m1", mirrorChecked: true })] }); // was checked, now open
  const plan = planReconcile(list);
  assert.deepEqual(plan.toEdit.map((e) => e.id), ["m1"]);
  assert.equal(plan.toEdit[0].content, "- milk"); // rendered back to the open form
  assert.equal(plan.toEdit[0].checked, false);
});

test("itemMessageContent renders open plainly and checked struck-through", () => {
  assert.equal(itemMessageContent(item("a", "call plumber")), "- call plumber");
  assert.match(itemMessageContent(item("a", "x", { due: "2026-08-04T15:00:00Z" })), /due 2026-08-04 15:00/);
  assert.equal(itemMessageContent(item("a", "call plumber", { checked: true })), "- ~~call plumber~~ ✅");
  assert.equal(itemMessageContent(item("a", "x", { checked: true, due: "2026-08-04T15:00:00Z" })), "- ~~x (due 2026-08-04 15:00)~~ ✅"); // due struck too
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

test("reconcile edits a checked item's message to the struck form (keeps id, records mirrorChecked)", async () => {
  const p = storePath();
  await seed(p, cl({ items: [item("a", "milk", { checked: true, mirrorMessageId: "m5" })] }));
  const { ops, edited, deleted } = fakeOps();
  await reconcile(ops, p);
  assert.deepEqual(edited, [{ id: "m5", content: "- ~~milk~~ ✅" }]);
  assert.equal(deleted.length, 0); // struck, NOT deleted
  const it = readChecklists(p)[0].items[0];
  assert.equal(it.mirrorMessageId, "m5"); // kept
  assert.equal(it.mirrorChecked, true);   // recorded so it isn't re-edited next tick
  const { ops: ops2, edited: edited2 } = fakeOps();
  await reconcile(ops2, p);
  assert.equal(edited2.length, 0); // idempotent -- no drift, no edit
});

test("reconcile edits a struck message back to the open form when the item is unchecked", async () => {
  const p = storePath();
  await seed(p, cl({ items: [item("a", "milk", { mirrorMessageId: "m5", mirrorChecked: true })] })); // checked -> unchecked
  const { ops, edited } = fakeOps();
  await reconcile(ops, p);
  assert.deepEqual(edited, [{ id: "m5", content: "- milk" }]);
  assert.equal(readChecklists(p)[0].items[0].mirrorChecked, false);
});

test("reconcile clears the id of a checked item whose message is gone (404), self-healing", async () => {
  const p = storePath();
  await seed(p, cl({ id: "g", slug: "g", channelId: "c", items: [item("a", "milk", { checked: true, mirrorMessageId: "m5" })] }));
  const gone: DiscordOps = { post: async () => "x", delete: async () => {}, edit: async () => { throw { status: 404 }; } };
  await reconcile(gone, p);
  const it = readChecklists(p)[0].items[0];
  assert.equal(it.mirrorMessageId, undefined); // gone message -> id cleared
  assert.equal(it.mirrorChecked, undefined);
});

test("reconcile drains pendingUnmirror and drops a drained rm-tombstone", async () => {
  const p = storePath();
  await seed(p, cl({ slug: "g", deleted: true, items: [], pendingUnmirror: ["m1", "m2"] }));
  const { ops, deleted } = fakeOps();
  await reconcile(ops, p);
  assert.deepEqual(deleted.slice().sort(), ["m1", "m2"]);
  assert.equal(readChecklists(p).length, 0); // tombstone gone
});

test("reconcile drops a tombstone by IDENTITY, sparing a recreated same-slug list (#1)", async () => {
  const p = storePath();
  await seed(p, cl({ id: "old", slug: "g", name: "g", channelId: "c", deleted: true, items: [], pendingUnmirror: ["m1"] }));
  await seed(p, cl({ id: "new", slug: "g", name: "g", channelId: "c", items: [item("a", "milk")] }));
  const { ops, deleted, posted } = fakeOps();
  await reconcile(ops, p);
  assert.deepEqual(deleted, ["m1"]); // the tombstone's stale message
  const after = readChecklists(p);
  assert.deepEqual(after.map((l) => l.id), ["new"]); // ONLY the tombstone was dropped
  assert.equal(posted.length, 1); // the recreated list's item got mirrored
});

test("reconcile keeps a TRANSIENTLY-failed delete queued, but a 404 drains it (#3)", async () => {
  const p = storePath();
  await seed(p, cl({ id: "g", slug: "g", channelId: "c", deleted: true, items: [], pendingUnmirror: ["mX"] }));
  const boom: DiscordOps = { post: async () => "x", delete: async () => { throw { status: 500 }; }, edit: async () => {} };
  await reconcile(boom, p);
  assert.deepEqual(readChecklists(p)[0].pendingUnmirror, ["mX"]); // 5xx -> still queued, tombstone kept
  const gone: DiscordOps = { post: async () => "x", delete: async () => { throw { status: 404 }; }, edit: async () => {} };
  await reconcile(gone, p);
  assert.equal(readChecklists(p).length, 0); // 404 == gone -> drained + tombstone dropped
});

test("reconcile deletes an orphan when its item vanished between post and lock", async () => {
  const p = storePath();
  await seed(p, cl({ id: "g", slug: "g", channelId: "c", items: [item("a", "milk")] }));
  const deleted: string[] = [];
  let n = 0;
  const racing: DiscordOps = {
    post: async () => { await mutate(p, (ls) => { ls[0].items = []; return { lists: ls, value: null }; }); return `m-${++n}`; }, // concurrent remove during post
    delete: async (_c, id) => { deleted.push(id); },
    edit: async () => {},
  };
  await reconcile(racing, p);
  assert.deepEqual(deleted, ["m-1"]); // the message posted for the now-gone item is deleted as an orphan
});

test("reconcile backfills a legacy id-less record up front, so its items mirror cleanly (no orphan churn)", async () => {
  const p = storePath();
  // A pre-id channel-bound record with an unposted item (no `id`, cast to bypass the type).
  await mutate(p, (lists) => { lists.push({ slug: "g", name: "g", channelId: "c", items: [{ id: "a", text: "milk", checked: false, created: "" }], created: "", updated: "" } as unknown as Checklist); return { lists, value: null }; });
  const { ops, posted, deleted } = fakeOps();
  await reconcile(ops, p);
  assert.equal(posted.length, 1);            // item posted...
  assert.equal(deleted.length, 0);           // ...and NOT immediately orphan-deleted
  const after = readChecklists(p)[0];
  assert.match(after.id, /^[0-9a-f]{16}$/);  // id backfilled + persisted
  assert.equal(after.items[0].mirrorMessageId, posted[0].id); // recorded against the item
});

test("reconcile ignores un-bound (no channelId) lists", async () => {
  const p = storePath();
  await seed(p, cl({ slug: "plain", channelId: undefined, items: [item("a", "milk")] }));
  const { ops, posted } = fakeOps();
  await reconcile(ops, p);
  assert.equal(posted.length, 0);
});

test("mirrorMessageIdSet spans open, checked-not-yet-deleted, and pendingUnmirror ids", async () => {
  const p = storePath();
  await seed(p, cl({ items: [item("a", "milk", { mirrorMessageId: "m1" }), item("b", "bread", { checked: true, mirrorMessageId: "m2" })], pendingUnmirror: ["m3"] }));
  assert.deepEqual([...mirrorMessageIdSet(p)].sort(), ["m1", "m2", "m3"]); // a reaction on ANY still-in-channel message is recognized
});

test("reconcile re-queues an orphan whose delete transiently failed (not a 404)", async () => {
  const p = storePath();
  await seed(p, cl({ id: "g", slug: "g", channelId: "c", items: [item("a", "milk")] }));
  let n = 0;
  const racing: DiscordOps = {
    post: async () => { await mutate(p, (ls) => { ls[0].items = []; return { lists: ls, value: null }; }); return `m-${++n}`; },
    delete: async () => { throw { status: 500 }; }, // transient -> orphan can't be deleted this tick
    edit: async () => {},
  };
  await reconcile(racing, p);
  assert.deepEqual(readChecklists(p)[0].pendingUnmirror, ["m-1"]); // re-queued so a later reconcile retries it
});

test("handleReaction checks the item + strikes its message through; returns false for an unknown message", async () => {
  const p = storePath();
  await seed(p, cl({ items: [item("a", "milk", { mirrorMessageId: "m9" })] }));
  const { ops, edited, deleted } = fakeOps();
  assert.equal(await handleReaction("not-a-mirror", ops, p), false);
  assert.equal(edited.length, 0);
  assert.equal(await handleReaction("m9", ops, p), true);
  const it = readChecklists(p)[0].items[0];
  assert.equal(it.checked, true);
  assert.equal(it.mirrorMessageId, "m9"); // KEPT -- the message stays, struck through
  assert.equal(it.mirrorChecked, true);   // eager edit recorded, so reconcile won't re-edit
  assert.deepEqual(edited, [{ id: "m9", content: "- ~~milk~~ ✅" }]);
  assert.equal(deleted.length, 0);        // never deleted
});

test("handleReaction leaves mirrorChecked unset when the eager edit fails, so reconcile retries", async () => {
  const p = storePath();
  await seed(p, cl({ items: [item("a", "milk", { mirrorMessageId: "m9" })] }));
  const boom: DiscordOps = { post: async () => "x", delete: async () => {}, edit: async () => { throw new Error("rate limited"); } };
  assert.equal(await handleReaction("m9", boom, p), true);
  const it = readChecklists(p)[0].items[0];
  assert.equal(it.checked, true);          // check still persisted
  assert.equal(it.mirrorChecked, undefined); // edit failed -> drift stands -> reconcile re-edits
});
