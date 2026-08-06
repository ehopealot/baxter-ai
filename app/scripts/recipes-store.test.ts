import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateRecipe, toSlug, saveRecipe, readRecipe, listRecipes, removeRecipe, recipePath,
  MAX_STEPS_PER_RECIPE, MAX_INGREDIENTS, MAX_TITLE_LEN,
} from "./recipes-store.ts";

const good = () => ({
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

test("validateRecipe accepts a well-formed recipe and trims", () => {
  const r = validateRecipe(good());
  assert.ok("recipe" in r);
  assert.equal(r.recipe.title, "Weeknight Pasta");
  assert.equal(r.recipe.steps.length, 2);
  assert.equal(r.recipe.source, undefined);
});

test("validateRecipe accepts an http(s) source and rejects other schemes", () => {
  assert.ok("recipe" in validateRecipe({ ...good(), source: "https://example.com/pasta" }));
  const bad = validateRecipe({ ...good(), source: "ftp://example.com/x" });
  assert.ok("errors" in bad && bad.errors.some((e) => e.includes("source")));
});

test("validateRecipe requires title, >=1 ingredient, >=1 step", () => {
  assert.ok("errors" in validateRecipe({ ...good(), title: "   " }));
  assert.ok("errors" in validateRecipe({ ...good(), ingredients: [] }));
  assert.ok("errors" in validateRecipe({ ...good(), steps: [] }));
});

test("validateRecipe rejects non-integer/negative times and servings<1", () => {
  assert.ok("errors" in validateRecipe({ ...good(), cookTime: -1 }));
  assert.ok("errors" in validateRecipe({ ...good(), activeTime: 1.5 }));
  assert.ok("errors" in validateRecipe({ ...good(), servings: 0 }));
});

test("validateRecipe allows an empty per-step ingredient list", () => {
  assert.ok("recipe" in validateRecipe(good())); // step 2 has ingredients: []
});

test("validateRecipe rejects a title with no alphanumerics", () => {
  assert.ok("errors" in validateRecipe({ ...good(), title: "!!!" }));
});

test("validateRecipe rejects a title over MAX_TITLE_LEN", () => {
  assert.ok("errors" in validateRecipe({ ...good(), title: "a".repeat(MAX_TITLE_LEN + 1) }));
});

test("validateRecipe rejects control characters in single-line fields, allows newline only in instructions", () => {
  // title: embedded newline
  assert.ok("errors" in validateRecipe({ ...good(), title: "a\nb" }));
  // step title: embedded tab
  assert.ok("errors" in validateRecipe({
    ...good(),
    steps: [{ title: "x\ty", activeTime: 0, cookTime: 0, ingredients: [], instructions: "ok" }],
  }));
  // instructions: newline is fine (multi-line is legitimate)
  const multiline = validateRecipe({
    ...good(),
    steps: [{ activeTime: 0, cookTime: 0, ingredients: [], instructions: "line1\nline2" }],
  });
  assert.ok("recipe" in multiline);
  // instructions: a non-tab/newline control char still errors
  const badInstructions = validateRecipe({
    ...good(),
    steps: [{ activeTime: 0, cookTime: 0, ingredients: [], instructions: `bad${String.fromCharCode(1)}char` }],
  });
  assert.ok("errors" in badInstructions);
  // overall ingredients list: embedded newline
  assert.ok("errors" in validateRecipe({ ...good(), ingredients: ["2 cups\nflour"] }));
});

test("validateRecipe accumulates multiple errors", () => {
  const r = validateRecipe({ ...good(), title: "", servings: 0, ingredients: [] });
  assert.ok("errors" in r && r.errors.length >= 3);
});

test("validateRecipe enforces step and ingredient caps", () => {
  const steps = Array.from({ length: MAX_STEPS_PER_RECIPE + 1 }, () => ({ activeTime: 0, cookTime: 0, ingredients: [], instructions: "x" }));
  assert.ok("errors" in validateRecipe({ ...good(), steps }));
  const ingredients = Array.from({ length: MAX_INGREDIENTS + 1 }, (_, i) => `i${i}`);
  assert.ok("errors" in validateRecipe({ ...good(), ingredients }));
});

test("validateRecipe ignores unknown keys", () => {
  assert.ok("recipe" in validateRecipe({ ...good(), extra: "whatever" } as unknown));
});

test("toSlug folds titles and returns '' on no-alphanumerics", () => {
  assert.equal(toSlug("Weeknight Pasta!"), "weeknight-pasta");
  assert.equal(toSlug("!!!"), "");
});

test("save/read/list/rm round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recipes-"));
  try {
    const res = await saveRecipe("Weeknight Pasta", good(), dir);
    assert.ok("slug" in res && res.slug === "weeknight-pasta");
    const r = readRecipe("weeknight-pasta", dir);
    assert.equal(r?.title, "Weeknight Pasta");
    const rows = listRecipes(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, "weeknight-pasta");
    assert.equal(await removeRecipe("weeknight-pasta", dir), true);
    assert.equal(readRecipe("weeknight-pasta", dir), null);
    assert.equal(await removeRecipe("weeknight-pasta", dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("save rejects an invalid recipe and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recipes-"));
  try {
    const res = await saveRecipe("Bad", { ...good(), servings: 0 }, dir);
    assert.ok("errors" in res);
    assert.equal(readRecipe("bad", dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recipePath is confined to the dir (basename-defended)", () => {
  const dir = "/tmp/recipes-x";
  assert.equal(recipePath("../escape", dir), join(dir, "escape.json"));
  assert.throws(() => recipePath("!!!", dir));
});

test("listRecipes returns [] for a missing dir", async () => {
  assert.deepEqual(listRecipes(join(tmpdir(), "no-such-recipes-dir")), []);
});

test("listRecipes returns saved recipes newest-first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recipes-"));
  try {
    await saveRecipe("older", { ...good(), title: "Older" }, dir);
    await saveRecipe("newer", { ...good(), title: "Newer" }, dir);
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(recipePath("older", dir), older, older);
    utimesSync(recipePath("newer", dir), newer, newer);
    const rows = listRecipes(dir);
    assert.deepEqual(rows.map((r) => r.slug), ["newer", "older"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
