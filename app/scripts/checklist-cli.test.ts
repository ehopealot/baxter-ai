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

test("make REVIVES a same-slug rm-tombstone in place (keeps id + pendingUnmirror, drops deleted)", () => {
  const home = mkdtempSync(join(tmpdir(), "clcli-"));
  const store = join(home, ".mail-agent", "checklists", "checklists.json");
  mkdirSync(join(home, ".mail-agent", "checklists"), { recursive: true });
  // A tombstone the gateway is still draining (mirror messages queued for delete).
  writeFileSync(store, JSON.stringify([{ id: "keep-me", slug: "chores", name: "old", channelId: "c1", deleted: true, pendingUnmirror: ["m1", "m2"], items: [{ id: "z", text: "stale", checked: true, created: "" }], created: "", updated: "" }]));
  assert.equal(run(home, ["make", "Chores"]).status, 0);
  const after = JSON.parse(readFileSync(store, "utf8"));
  assert.equal(after.length, 1);                          // revived in place, NOT a second same-slug record
  assert.equal(after[0].id, "keep-me");                   // same identity, so the gateway's in-flight deletes still match
  assert.equal(after[0].deleted, undefined);              // active again
  assert.equal(after[0].name, "Chores");                  // re-named
  assert.deepEqual(after[0].pendingUnmirror, ["m1", "m2"]); // kept -> old messages still get cleaned up
  assert.deepEqual(after[0].items, []);                   // fresh + empty
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
