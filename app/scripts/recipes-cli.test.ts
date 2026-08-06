// Tests for recipes-cli: the pure renderRecipe helper, plus an end-to-end CLI round-trip
// (HOME -> a temp STATE_DIR, mirrors checklist-cli.test.ts's spawn helper) and nonzero-exit
// misuse cases (run_cli invariant).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderRecipe } from "./recipes-cli.ts";
import type { Recipe } from "./recipes-store.ts";

const CLI = fileURLToPath(new URL("./recipes-cli.ts", import.meta.url));

const r: Recipe = {
  title: "Toast", servings: 1, timeToPrepare: 3, activeTime: 1, cookTime: 2,
  ingredients: ["1 slice bread", "butter"],
  steps: [
    { title: "Toast it", activeTime: 0, cookTime: 2, ingredients: ["1 slice bread"], instructions: "Toast the bread." },
    { activeTime: 1, cookTime: 0, ingredients: ["butter"], instructions: "Butter it." },
  ],
};

test("renderRecipe is step-by-step: each step lists its own ingredients + times", () => {
  const out = renderRecipe(r);
  assert.match(out, /# Toast/);
  assert.match(out, /serves 1/);
  assert.match(out, /Step 1: Toast it/);
  assert.match(out, /Step 2/);
  // step 1 shows its ingredient; step 2 shows butter
  assert.match(out, /1 slice bread/);
  assert.match(out, /butter/);
  assert.match(out, /active 0 min, cook 2 min/);
});

// ---- CLI (spawned, isolated HOME -> STATE_DIR) ----

function run(home: string, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    input: input ?? "",
  });
  return { status: res.status ?? 0, stdout: res.stdout, stderr: res.stderr };
}

const goodJson = () => JSON.stringify({
  title: "Weeknight Pasta",
  servings: 4,
  timeToPrepare: 30,
  activeTime: 20,
  cookTime: 10,
  ingredients: ["1 lb pasta", "2 cups sauce"],
  steps: [
    { title: "Boil", activeTime: 2, cookTime: 8, ingredients: ["1 lb pasta"], instructions: "Boil the pasta." },
    { activeTime: 5, cookTime: 2, ingredients: [], instructions: "Warm the sauce and combine." },
  ],
});

test("CLI save -> show -> show --json -> list -> rm round-trips", () => {
  const home = mkdtempSync(join(tmpdir(), "recli-"));
  const saveRes = run(home, ["save", "weeknight-pasta"], goodJson());
  assert.equal(saveRes.status, 0);
  assert.match(saveRes.stdout, /saved recipe "weeknight-pasta"/);

  const showRes = run(home, ["show", "weeknight-pasta"]);
  assert.equal(showRes.status, 0);
  assert.match(showRes.stdout, /# Weeknight Pasta/);

  const jsonRes = run(home, ["show", "weeknight-pasta", "--json"]);
  assert.equal(jsonRes.status, 0);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.equal(parsed.title, "Weeknight Pasta");
  // round-trips cleanly back through save
  const resave = run(home, ["save", "weeknight-pasta"], jsonRes.stdout);
  assert.equal(resave.status, 0);

  const listRes = run(home, ["list"]);
  assert.equal(listRes.status, 0);
  assert.match(listRes.stdout, /weeknight-pasta/);
  assert.match(listRes.stdout, /Weeknight Pasta/);

  const rmRes = run(home, ["rm", "weeknight-pasta"]);
  assert.equal(rmRes.status, 0);
  assert.match(rmRes.stdout, /"removed":"weeknight-pasta"/);

  const showAfterRm = run(home, ["show", "weeknight-pasta"]);
  assert.notEqual(showAfterRm.status, 0);
});

test("CLI list with no recipes", () => {
  const home = mkdtempSync(join(tmpdir(), "recli-"));
  const listRes = run(home, ["list"]);
  assert.equal(listRes.status, 0);
  assert.match(listRes.stdout, /no recipes/);
});

test("CLI save with malformed stdin JSON exits nonzero", () => {
  const home = mkdtempSync(join(tmpdir(), "recli-"));
  const res = run(home, ["save", "bad"], "{ not json");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not valid JSON/);
});

test("CLI save with an invalid recipe exits nonzero and writes nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "recli-"));
  const bad = JSON.stringify({ title: "Bad", servings: 0, timeToPrepare: 1, activeTime: 1, cookTime: 0, ingredients: ["x"], steps: [] });
  const res = run(home, ["save", "bad"], bad);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid recipe/);
  const showRes = run(home, ["show", "bad"]);
  assert.notEqual(showRes.status, 0);
});

test("CLI show of an unknown slug exits nonzero", () => {
  const home = mkdtempSync(join(tmpdir(), "recli-"));
  const res = run(home, ["show", "nonexistent"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no such recipe/);
});

test("CLI rm of an unknown slug exits nonzero", () => {
  const home = mkdtempSync(join(tmpdir(), "recli-"));
  const res = run(home, ["rm", "nonexistent"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no such recipe/);
});

test("CLI with no subcommand exits 2", () => {
  const home = mkdtempSync(join(tmpdir(), "recli-"));
  const res = run(home, []);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/);
});

test("CLI with an unknown subcommand exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "recli-"));
  const res = run(home, ["bogus"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage/);
});
