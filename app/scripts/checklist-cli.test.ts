// Tests for checklist-cli: the pure matching helpers (matchScore/findOpen/resolveList/
// resolveItem) and an end-to-end CLI round-trip + cross-process lock (HOME -> a temp
// STATE_DIR). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchScore, findOpen, resolveList, resolveItem } from "./checklist-cli.ts";
import type { Checklist, Item } from "./checklist-store.ts";

const CLI = fileURLToPath(new URL("./checklist-cli.ts", import.meta.url));

const list = (slug: string, items: (string | Partial<Item>)[]): Checklist => ({
  id: slug, slug, name: slug, created: "", updated: "",
  items: items.map((x, i) => (typeof x === "string" ? { id: String(i), text: x, checked: false, created: "" } : { id: String(i), text: "", checked: false, created: "", ...x })),
});

// ---- pure matching ----

test("matchScore ranks a relevant phrase high (stemming-aware) and an unrelated one at 0", () => {
  assert.ok(matchScore("got the milk", "milk") > 0.3);
  assert.ok(matchScore("finished the taxes", "file taxes") > 0.3); // taxes/tax stem align
  assert.equal(matchScore("call the plumber", "buy bread"), 0);
});

test("findOpen ranks open items, excludes checked, and spans lists", () => {
  const lists = [list("groceries", ["milk", "bread", { text: "eggs", checked: true }]), list("todos", ["file taxes"])];
  assert.deepEqual(findOpen(lists, "milk").map((h) => h.item.text), ["milk"]);
  assert.equal(findOpen(lists, "eggs").length, 0); // checked -> excluded
  assert.equal(findOpen(lists, "taxes")[0].listSlug, "todos"); // resolves across lists
});

test("findOpen with includeChecked surfaces checked-off items for reverse-lookup", () => {
  const lists = [list("groceries", ["milk", "bread", { text: "eggs", checked: true }]), list("todos", ["file taxes"])];
  // Default (open-only) still hides checked:
  assert.equal(findOpen(lists, "eggs").length, 0);
  // includeChecked=true returns it, alongside the still-open "milk":
  const hits = findOpen(lists, "eggs", undefined, true);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].item.text, "eggs");
  assert.equal(hits[0].item.checked, true);
  assert.equal(hits[0].listSlug, "groceries");
  // includeChecked is additive, not exclusive: a query that matches both open AND
  // checked items returns both, ranked by score.
  const mixed = findOpen(lists, "milk", undefined, true);
  assert.deepEqual(mixed.map((h) => h.item.text), ["milk"]);
});

test("resolveList: exact slug/name, then fuzzy, else throws listing the lists", () => {
  const lists = [list("groceries", []), list("packing-list", [])];
  assert.equal(resolveList(lists, "groceries").slug, "groceries");
  assert.equal(resolveList(lists, "GROCERIES").slug, "groceries");
  assert.equal(resolveList(lists, "packing").slug, "packing-list"); // fuzzy
  assert.throws(() => resolveList(lists, "nonexistent zzz"), /no list matching/);
});

test("resolveItem: fuzzy within a list; ambiguous ties throw; no match throws", () => {
  const l = list("g", ["2% milk", "whole milk", "bread"]);
  assert.throws(() => resolveItem(l, "milk"), /ambiguous/); // both milk items tie
  assert.equal(resolveItem(l, "bread").text, "bread");
  assert.throws(() => resolveItem(l, "eggs"), /no open item/);
});

// ---- CLI ----

function run(home: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  return { status: r.status ?? 0, stdout: r.stdout, stderr: r.stderr };
}
function runAsync(home: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home } });
    c.on("error", reject);
    c.on("close", (code) => resolve(code ?? 0));
  });
}

test("CLI make -> add -> show -> find -> check (fuzzy) -> clear -> lists round-trips", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  assert.equal(run(home, ["make", "Groceries"]).status, 0);
  assert.equal(run(home, ["add", "groceries", "2% milk"]).status, 0);
  run(home, ["add", "groceries", "bread"]);
  assert.match(run(home, ["show", "groceries"]).stdout, /\[ \] 2% milk/);
  assert.match(run(home, ["find", "milk"]).stdout, /Groceries · 2% milk/); // NL resolve
  assert.equal(run(home, ["check", "groceries", "bread"]).status, 0);      // fuzzy item match
  assert.match(run(home, ["show", "groceries"]).stdout, /\[x\] bread/);
  assert.match(run(home, ["clear", "groceries"]).stdout, /"cleared":1/);   // drops the checked one
  assert.doesNotMatch(run(home, ["show", "groceries"]).stdout, /bread/);
  assert.match(run(home, ["lists"]).stdout, /Groceries \(groceries\)/);
});

test("CLI show --open hides checked items, so \"what's left\" differs from the full list", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "g"]);
  run(home, ["add", "g", "milk"]);
  run(home, ["add", "g", "bread"]);
  run(home, ["check", "g", "milk"]);
  const full = run(home, ["show", "g"]).stdout;
  assert.match(full, /\[x\] milk/);   // full list still shows the done item
  assert.match(full, /\[ \] bread/);
  const openOnly = run(home, ["show", "g", "--open"]).stdout;
  assert.doesNotMatch(openOnly, /milk/); // checked item hidden
  assert.match(openOnly, /\[ \] bread/);
  run(home, ["check", "g", "bread"]);
  assert.match(run(home, ["show", "g", "--open"]).stdout, /all done ✅/); // everything checked -> nothing left
  // --open works BEFORE the list name too (the LLM often phrases it that way) -- the parser
  // must not swallow the name as the flag's value.
  const flagFirst = run(home, ["show", "--open", "g"]);
  assert.equal(flagFirst.status, 0);
  assert.match(flagFirst.stdout, /all done ✅/);
});

test("CLI: check -> uncheck round-trips, and remove works on a checked item", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "g"]);
  run(home, ["add", "g", "milk"]);
  assert.equal(run(home, ["check", "g", "milk"]).status, 0);
  assert.match(run(home, ["show", "g"]).stdout, /\[x\] milk/);
  assert.equal(run(home, ["uncheck", "g", "milk"]).status, 0); // was broken: "no open item"
  assert.match(run(home, ["show", "g"]).stdout, /\[ \] milk/);
  run(home, ["check", "g", "milk"]);
  assert.equal(run(home, ["remove", "g", "milk"]).status, 0);  // remove a CHECKED item
  assert.doesNotMatch(run(home, ["show", "g"]).stdout, /milk/);
});

test("CLI: uncheck clears checkedBy attribution (no stale @name survives to the next check)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "g"]);
  run(home, ["add", "g", "milk"]);
  run(home, ["check", "g", "milk"]);
  // The CLI check can't set checkedBy (only the home DO stamps it from the session), so seed it
  // directly into the store to mimic a home-UI check, then uncheck via the CLI.
  const store = join(home, ".mail-agent", "checklists", "checklists.json");
  const data = JSON.parse(readFileSync(store, "utf8")) as Checklist[];
  data[0].items[0].checkedBy = "Erik";
  writeFileSync(store, JSON.stringify(data));
  assert.equal(run(home, ["uncheck", "g", "milk"]).status, 0);
  const after = JSON.parse(readFileSync(store, "utf8")) as Checklist[];
  assert.equal(after[0].items[0].checkedBy, undefined); // stale attribution gone
  assert.equal(after[0].items[0].checkedAt, undefined);
});

test("CLI: check clears a stale checkedBy (CLI can't attribute; sanitizes a pre-0e3b440 corrupted store)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "g"]);
  run(home, ["add", "g", "milk"]);
  // An OPEN item left carrying checkedBy by the pre-fix uncheck bug -- a check must scrub it, not
  // re-publish a wrong (@name).
  const store = join(home, ".mail-agent", "checklists", "checklists.json");
  const data = JSON.parse(readFileSync(store, "utf8")) as Checklist[];
  data[0].items[0].checkedBy = "Erik";
  writeFileSync(store, JSON.stringify(data));
  assert.equal(run(home, ["check", "g", "milk"]).status, 0);
  const after = JSON.parse(readFileSync(store, "utf8")) as Checklist[];
  assert.equal(after[0].items[0].checked, true);
  assert.equal(after[0].items[0].checkedBy, undefined); // stale attribution scrubbed on check
});

test("CLI: uncheck resolves within the CHECKED pool (doesn't falsely match an open item)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "g"]);
  run(home, ["add", "g", "2% milk"]);
  run(home, ["add", "g", "whole milk"]);
  run(home, ["check", "g", "2% milk"]); // only "2% milk" is checked
  const r = run(home, ["uncheck", "g", "milk"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /2% milk/); // unchecks the checked one, not the open "whole milk"
});

test("CLI: an ambiguous check errors instead of ticking the wrong item", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "g"]);
  run(home, ["add", "g", "2% milk"]);
  run(home, ["add", "g", "whole milk"]);
  const r = run(home, ["check", "g", "milk"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ambiguous/);
});

test("CLI add rejects an over-long item (can't become a message Discord would reject)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "g"]);
  const r = run(home, ["add", "g", "x".repeat(1001)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /too long/);
});

function seedStore(home: string, records: unknown[]): string {
  const store = join(home, ".mail-agent", "checklists", "checklists.json");
  mkdirSync(join(home, ".mail-agent", "checklists"), { recursive: true });
  writeFileSync(store, JSON.stringify(records));
  return store;
}

test("make pushes a FRESH record beside a still-draining same-slug tombstone (does NOT revive it)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  // A tombstone the gateway is still draining in its OWN channel (messages queued for delete).
  const store = seedStore(home, [{ id: "old", slug: "chores", name: "old", channelId: "c1", deleted: true, pendingUnmirror: ["m1", "m2"], items: [], created: "", updated: "" }]);
  assert.equal(run(home, ["make", "Chores"]).status, 0);
  const after = JSON.parse(readFileSync(store, "utf8"));
  assert.equal(after.length, 2);                                            // tombstone LEFT intact + a new record
  const tomb = after.find((l: { id: string }) => l.id === "old");
  assert.deepEqual(tomb.pendingUnmirror, ["m1", "m2"]);                     // undisturbed -> drains in c1 independently
  assert.equal(tomb.channelId, "c1");
  const live = after.find((l: { id: string }) => l.id !== "old");
  assert.equal(live.deleted, undefined);
  assert.equal(live.channelId, undefined);                                 // fresh + unbound (no --channel)
});

test("rm of a recreated same-slug list filters by id, sparing the draining tombstone", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  const store = seedStore(home, [
    { id: "old", slug: "chores", name: "old", channelId: "c1", deleted: true, pendingUnmirror: ["m1"], items: [], created: "", updated: "" },
    { id: "new", slug: "chores", name: "new", items: [], created: "", updated: "" },
  ]);
  assert.equal(run(home, ["rm", "chores"]).status, 0); // resolves to the live "new" (tombstone is !deleted-filtered)
  const after = JSON.parse(readFileSync(store, "utf8"));
  assert.deepEqual(after.map((l: { id: string }) => l.id), ["old"]); // ONLY "new" removed; tombstone still draining
});

test("recreate: fresh same-slug list with all items unchecked, old (unmirrored) list dropped", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "Groceries"]);
  run(home, ["add", "groceries", "milk", "--due", "2026-09-01T09:00:00Z"]);
  run(home, ["add", "groceries", "bread"]);
  run(home, ["check", "groceries", "milk"]);
  const store = join(home, ".mail-agent", "checklists", "checklists.json");
  // Give milk a category so we can assert recreate carries it onto the fresh copy.
  const seeded = JSON.parse(readFileSync(store, "utf8"));
  seeded[0].items.find((i: Item) => i.text === "milk").category = "Dairy";
  writeFileSync(store, JSON.stringify(seeded));
  const before = JSON.parse(readFileSync(store, "utf8"));
  const out = run(home, ["recreate", "groceries"]);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /"recreated":"groceries","items":2/);
  const after = JSON.parse(readFileSync(store, "utf8"));
  assert.equal(after.length, 1);                              // old dropped outright (no mirror to drain), one fresh list
  const fresh = after[0];
  assert.notEqual(fresh.id, before[0].id);                    // a NEW list identity
  assert.equal(fresh.slug, "groceries");                      // same slug/name
  assert.equal(fresh.name, "Groceries");
  assert.deepEqual(fresh.items.map((i: Item) => i.text).sort(), ["bread", "milk"]);
  assert.equal(fresh.items.every((i: Item) => i.checked === false), true); // completion wiped
  assert.equal(fresh.items.every((i: Item) => i.checkedAt === undefined), true);
  assert.equal(fresh.items.find((i: Item) => i.text === "milk").due, "2026-09-01T09:00:00Z"); // due preserved
  assert.equal(fresh.items.find((i: Item) => i.text === "milk").category, "Dairy"); // category preserved (groups survive a recreate)
});

test("recreate of a mirrored list tombstones the old (to drain its channel) and keeps the fresh copy", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  const store = seedStore(home, [{
    id: "old", slug: "chores", name: "Chores", channelId: "c1",
    items: [{ id: "i1", text: "trash", checked: true, checkedAt: "2026-01-01T00:00:00Z", mirrorMessageId: "m1", created: "" }],
    created: "", updated: "",
  }]);
  assert.equal(run(home, ["recreate", "chores"]).status, 0);
  const after = JSON.parse(readFileSync(store, "utf8"));
  assert.equal(after.length, 2);
  const tomb = after.find((l: { id: string }) => l.id === "old");
  assert.equal(tomb.deleted, true);
  assert.deepEqual(tomb.pendingUnmirror, ["m1"]);             // queued for the gateway to delete in c1
  assert.deepEqual(tomb.items, []);
  const fresh = after.find((l: { id: string }) => l.id !== "old");
  assert.equal(fresh.slug, "chores");
  assert.equal(fresh.channelId, "c1");                        // re-bound to the same channel, fresh
  assert.deepEqual(fresh.items.map((i: Item) => ({ text: i.text, checked: i.checked })), [{ text: "trash", checked: false }]);
  assert.equal(fresh.items[0].mirrorMessageId, undefined);    // no carried-over mirror binding
});

test("recreate of a missing list errors nonzero (nothing to reset)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  assert.equal(run(home, ["recreate", "nope"]).status, 1);
});

test("set-category sets a category by exact id (whitespace-collapsed, capped), and empty clears it", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  const store = seedStore(home, [{ id: "l", slug: "g", name: "Groceries", items: [{ id: "i1", text: "milk", checked: false, created: "" }], created: "", updated: "" }]);
  assert.match(run(home, ["set-category", "g", "i1", "Cold  ", "Dairy"]).stdout, /"category":"Cold Dairy"/); // collapsed
  assert.equal(JSON.parse(readFileSync(store, "utf8"))[0].items[0].category, "Cold Dairy");
  // A capped label: 100 chars in -> 64 out (MAX_CATEGORY).
  run(home, ["set-category", "g", "i1", "x".repeat(100)]);
  assert.equal(JSON.parse(readFileSync(store, "utf8"))[0].items[0].category.length, 64);
  // Empty category clears it.
  run(home, ["set-category", "g", "i1", ""]);
  assert.equal(JSON.parse(readFileSync(store, "utf8"))[0].items[0].category, undefined);
});

test("set-category on an unknown item id errors nonzero (bulk sort must hit exactly the item it means)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  seedStore(home, [{ id: "l", slug: "g", name: "G", items: [{ id: "i1", text: "milk", checked: false, created: "" }], created: "", updated: "" }]);
  assert.equal(run(home, ["set-category", "g", "nope", "Dairy"]).status, 1);
});

test("set-category with the category ARGUMENT omitted errors nonzero (a dropped arg is misuse, not a silent clear)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  const store = seedStore(home, [{ id: "l", slug: "g", name: "G", items: [{ id: "i1", text: "milk", checked: false, category: "Dairy", created: "" }], created: "", updated: "" }]);
  assert.equal(run(home, ["set-category", "g", "i1"]).status, 1);            // no category arg -> error
  assert.equal(JSON.parse(readFileSync(store, "utf8"))[0].items[0].category, "Dairy"); // untouched
  assert.equal(run(home, ["set-category", "g", "i1", ""]).status, 0);        // explicit "" still clears
  assert.equal(JSON.parse(readFileSync(store, "utf8"))[0].items[0].category, undefined);
});

test("mutate backfills a missing id on a legacy record (no data loss on id-based ops)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  const store = seedStore(home, [{ slug: "chores", name: "chores", items: [], created: "", updated: "" }]); // no id
  run(home, ["add", "chores", "sweep"]); // any mutation triggers the backfill
  const after = JSON.parse(readFileSync(store, "utf8"));
  assert.match(after[0].id, /^[0-9a-f]{16}$/); // id assigned + persisted
});

test("concurrent add across processes never loses an item (the lock holds)", async () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  run(home, ["make", "g"]);
  const N = 8;
  const codes = await Promise.all(Array.from({ length: N }, (_, i) => runAsync(home, ["add", "g", `item-${i}`])));
  assert.deepEqual(codes, Array(N).fill(0));
  const show = run(home, ["show", "g"]).stdout;
  for (let i = 0; i < N; i++) assert.match(show, new RegExp(`item-${i}(\\n|$)`), `lost item-${i}`);
});
