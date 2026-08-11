// Tests for link-cli: end-to-end (spawned process, HOME -> temp STATE_DIR). No network.
// Each store is seeded under <home>/.mail-agent/... and the CLI is run with that HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./link-cli.ts", import.meta.url));

function run(home: string, args: string[], envExtra: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, ...envExtra } });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status };
}

function seedList(home: string, slug: string, name: string): void {
  const dir = join(home, ".mail-agent", "checklists");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "checklists.json");
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as unknown[] : [];
  writeFileSync(path, JSON.stringify([...existing, { id: slug, slug, name, created: "", updated: "", items: [] }]));
}
function seedChat(home: string, id: string, title: string | null): void {
  const dir = join(home, ".mail-agent", "chats");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify([{ id, title, createdAt: "", lastAt: "" }]));
}
function seedRecipe(home: string, slug: string): void {
  const dir = join(home, ".mail-agent", "recipes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify({ title: slug, servings: 1, timeToPrepare: 1, activeTime: 1, cookTime: 0, ingredients: [], steps: [] }));
}

// ---- list (name -> slug) ----
test("list resolves a fuzzy name to /l/<slug> and prints the bare URL", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedList(home, "grocery-list", "Grocery List");
  const r = run(home, ["list", "grocery"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "https://home.bax.bot/l/grocery-list");
});

test("list --json emits {type,url,slug,name}", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedList(home, "grocery-list", "Grocery List");
  const r = run(home, ["list", "grocery", "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { type: "list", url: "https://home.bax.bot/l/grocery-list", slug: "grocery-list", name: "Grocery List" });
});

test("list with no match exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedList(home, "grocery-list", "Grocery List"); // something exists, just not this
  const r = run(home, ["list", "zzz-not-a-list"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no list matching/);
});

// ---- chat (id) ----
test("chat resolves a real id to /chats/<id>", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedChat(home, "wc-3", "Cooking plans");
  const r = run(home, ["chat", "wc-3"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "https://home.bax.bot/chats/wc-3");
});

test("chat --json includes the (possibly null) title", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedChat(home, "wc-3", null);
  const r = run(home, ["chat", "wc-3", "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { type: "chat", url: "https://home.bax.bot/chats/wc-3", id: "wc-3", title: null });
});

test("chat with a malformed id exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedChat(home, "wc-3", null);
  const r = run(home, ["chat", "not-an-id"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid chat id/);
});

test("chat with a well-formed but absent id exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedChat(home, "wc-3", null);
  const r = run(home, ["chat", "wc-99"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such chat/);
});

// ---- recipe (slug) ----
test("recipe resolves a slug to /r/<slug>", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedRecipe(home, "chili");
  const r = run(home, ["recipe", "chili"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "https://home.bax.bot/r/chili");
});

test("recipe with no such slug exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedRecipe(home, "chili");
  const r = run(home, ["recipe", "no-such-recipe"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such recipe/);
});

// ---- base URL + arg errors ----
test("HOME_BASE_URL overrides the default origin", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedRecipe(home, "chili");
  const r = run(home, ["recipe", "chili"], { HOME_BASE_URL: "https://home.example.com/" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "https://home.example.com/r/chili"); // trailing slash stripped
});

test("missing key exits 2", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  const r = run(home, ["list"]);
  assert.equal(r.status, 2);
});

test("unknown type exits 2", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  const r = run(home, ["project", "x"]);
  assert.equal(r.status, 2);
});

test("plural type aliases work (lists/chats/recipes)", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedList(home, "grocery-list", "Grocery List");
  seedChat(home, "wc-3", null);
  seedRecipe(home, "chili");
  assert.equal(run(home, ["lists", "grocery"]).stdout, "https://home.bax.bot/l/grocery-list");
  assert.equal(run(home, ["chats", "wc-3"]).stdout, "https://home.bax.bot/chats/wc-3");
  assert.equal(run(home, ["recipes", "chili"]).stdout, "https://home.bax.bot/r/chili");
});

// ---- review follow-ups: ambiguity, tombstones, recipe --json, base-URL validation ----
test("list with an ambiguous name (two fuzzy matches) exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedList(home, "grocery-a", "Grocery A");
  seedList(home, "grocery-b", "Grocery B");
  const r = run(home, ["list", "grocery"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no list matching/);
});

test("chat pointing at a tombstoned (deletedAt) chat exits 1 -- listChats filters it", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  const dir = join(home, ".mail-agent", "chats");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify([{ id: "wc-4", title: null, createdAt: "", lastAt: "", deletedAt: "2026-01-01T00:00:00.000Z" }]));
  const r = run(home, ["chat", "wc-4"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such chat/);
});

test("recipe --json emits {type,url,slug,title}", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedRecipe(home, "chili");
  const r = run(home, ["recipe", "chili", "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { type: "recipe", url: "https://home.bax.bot/r/chili", slug: "chili", title: "chili" });
});

test("a HOME_BASE_URL with a query/path/userinfo is rejected (exit 1), not silently used", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedRecipe(home, "chili");
  const r = run(home, ["recipe", "chili"], { HOME_BASE_URL: "https://home.example.com?x=1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HOME_BASE_URL/);
});

test("recipe emits the CANONICAL slug even for a title-shaped input (no dead /r/ URL)", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedRecipe(home, "pasta-primavera");
  const r = run(home, ["recipe", "Pasta Primavera"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "https://home.bax.bot/r/pasta-primavera"); // not /r/Pasta%20Primavera
});

test("an Object.prototype name as <type> (toString/constructor/__proto__) exits 2, not the recipe branch", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedRecipe(home, "chili"); // seeded so the pre-fix bug would exit 0, not 1
  for (const bad of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    assert.equal(run(home, [bad, "chili"]).status, 2, `${bad} should be unknown type`);
  }
});

test("an empty HOME_BASE_URL falls back to the default (empty-means-unset, like skills-cli)", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  seedRecipe(home, "chili");
  const r = run(home, ["recipe", "chili"], { HOME_BASE_URL: "" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "https://home.bax.bot/r/chili");
});

test("an all-punctuation recipe key exits 1 with a message naming the raw input", () => {
  const home = mkdtempSync(join(tmpdir(), "lc-"));
  const r = run(home, ["recipe", "!!!"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid recipe slug/);
  assert.ok(r.stderr.includes("!!!"), "error should name the raw input, not the transformed empty slug");
});
