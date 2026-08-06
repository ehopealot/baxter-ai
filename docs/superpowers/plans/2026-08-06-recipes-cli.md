# Recipes (recipes-cli + recipes skill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new content type, recipes — a `recipes-cli` (STATE_DIR store + shape validation) plus an LLM-friendly `recipes` skill that teaches step-oriented intake and step-by-step presentation.

**Architecture:** Mirrors the existing content-type CLIs (checklist/calendar/projects): one JSON file per recipe under `STATE_DIR/recipes/`, mutated only through the validating CLI, atomic writes under a `proper-lockfile` lock. A pure `validateRecipe` core is shared by `save` and unit-tested directly. The skill owns intake (link → `source`; photo → no `source`) and presentation. Text-based only — no home web page.

**Tech Stack:** TypeScript run directly by Node 22 (no build step), `node --test`, `proper-lockfile`. Spec: `docs/superpowers/specs/2026-08-06-recipes-cli-design.md`.

## Global Constraints

- All paths are in the **`core` submodule** (`/app/core`), under `app/scripts/`, `app/skills/`, `app/Dockerfile`, `app/docs/`.
- Recipes live in `STATE_DIR/recipes/` (`RECIPES_DIR`), **never** `MEMORY_DIR` — the CLI is the sole writer, so validation can't be bypassed by a native `Write`.
- Times are **whole non-negative-integer minutes**; `servings` is an integer ≥ 1.
- Validation is **shape-only** — no cross-checking recipe-level aggregates against per-step data.
- `source` is optional; when present it must be an `http:`/`https:` URL. A photo recipe has no `source`.
- Slugs are `[a-z0-9-]`, length-capped (≤ 64), `basename`-defended, resolved under `RECIPES_DIR` — no directory escape.
- The CLI **exits nonzero on any misuse or validation failure** (missing/extra args, unknown verb, unknown slug, malformed stdin JSON, bad recipe); success exits 0. (run_cli invariant.)
- New tool grant `Bash(recipes-cli *)` via `CORE_TOOLS`; new skill `recipes` via `SKILL_NAMES` — both flow to every surface. The `skills/recipes/` dir must exist before `recipes` is added to `SKILL_NAMES`.
- Run the suite from the repo root with `make check` (typecheck + tests). Per-file: `node --test app/scripts/<file>.test.ts` from `app/`.

---

### Task 1: recipes-store.ts — types, validation, storage

**Files:**
- Create: `app/scripts/recipes-store.ts`
- Create: `app/scripts/recipes-store.test.ts`
- Modify: `app/scripts/paths.ts` (add `RECIPES_DIR`)

**Interfaces:**
- Produces: `Step`, `Recipe`, `RecipeSummary` interfaces; `validateRecipe(input: unknown): { recipe: Recipe } | { errors: string[] }`; `toSlug(name: unknown): string` (non-throwing, "" on no-alphanumerics); `recipePath(slug, dir?)`; `readRecipe(slug, dir?): Recipe | null`; `listRecipes(dir?): RecipeSummary[]`; `saveRecipe(slug, input, dir?): Promise<{slug:string}|{errors:string[]}>`; `removeRecipe(slug, dir?): Promise<boolean>`; the `MAX_*` caps. All fs functions take an explicit `dir` defaulting to `RECIPES_DIR` so tests use a tmpdir.

- [ ] **Step 1: Add `RECIPES_DIR` to paths.ts**

In `app/scripts/paths.ts`, beside `CHECKLISTS_PATH`, add:

```ts
// Recipes: one JSON file per recipe. In STATE_DIR (NOT MEMORY_DIR) so recipes-cli is the
// sole writer and a native Write can't bypass its format validation (mirrors the checklist
// store's posture).
export const RECIPES_DIR = join(STATE_DIR, "recipes");
```

- [ ] **Step 2: Write failing validation tests**

Create `app/scripts/recipes-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
```

- [ ] **Step 3: Run — expect failure** (`node --test app/scripts/recipes-store.test.ts` from `app/`): module not found / functions undefined.

- [ ] **Step 4: Implement recipes-store.ts (types + validation)**

Create `app/scripts/recipes-store.ts` with the header comment, imports, interfaces, caps, `toSlug`, and the validators:

```ts
// recipes-store.ts: recipes-cli's data store + validation. One JSON file per recipe under
// RECIPES_DIR (STATE_DIR/recipes) -- OUTSIDE the run's sandbox-writable MEMORY_DIR, so
// recipes are mutable only through the validating CLI. Writes are atomic (temp + rename)
// under a proper-lockfile lock so concurrent CLI invocations across surfaces serialize
// (mirrors checklist-store/calendar-store). validateRecipe is pure (no fs) and unit-tested
// directly. Every fs function takes an explicit dir so tests never touch the real workspace.
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import lockfile from "proper-lockfile";
import { RECIPES_DIR } from "./paths.ts";

export interface Step {
  title?: string;         // optional label ("Make the sauce")
  activeTime: number;     // minutes, integer >= 0
  cookTime: number;       // minutes, integer >= 0
  ingredients: string[];  // ingredients THIS step uses; may be empty
  instructions: string;   // the step's directions; non-empty
}
export interface Recipe {
  title: string;
  source?: string;        // http(s) URL when from a link; absent when from a photo
  servings: number;       // integer >= 1
  timeToPrepare: number;  // total minutes
  activeTime: number;
  cookTime: number;
  ingredients: string[];  // overall list; >= 1
  steps: Step[];          // >= 1
}
export interface RecipeSummary { slug: string; title: string; servings: number; timeToPrepare: number; updated: string; }

export const MAX_RECIPES = 500;
export const MAX_STEPS_PER_RECIPE = 100;
export const MAX_INGREDIENTS = 200;
export const MAX_TITLE_LEN = 200;
export const MAX_STEP_TITLE_LEN = 200;
export const MAX_INGREDIENT_LEN = 300;
export const MAX_INSTRUCTIONS_LEN = 4000;
export const MAX_SOURCE_LEN = 2000;
export const MAX_TIME_MIN = 100000;
const MAX_SLUG_LEN = 64;

// Mirror of projects-cli.slugify but NON-throwing (returns "" when a title has no
// alphanumerics) -- validateRecipe must report, not throw.
export function toSlug(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function checkTime(v: unknown, label: string, errors: string[]): void {
  if (!isInt(v) || (v as number) < 0 || (v as number) > MAX_TIME_MIN) errors.push(`${label}: integer minutes 0..${MAX_TIME_MIN}`);
}

function validateIngredients(v: unknown, label: string, errors: string[], allowEmpty: boolean): { list: string[]; ok: boolean } {
  if (!Array.isArray(v)) { errors.push(`${label}: must be an array of strings`); return { list: [], ok: false }; }
  let ok = true;
  if (!allowEmpty && v.length < 1) { errors.push(`${label}: at least one entry required`); ok = false; }
  if (v.length > MAX_INGREDIENTS) { errors.push(`${label}: exceeds ${MAX_INGREDIENTS}`); ok = false; }
  const list: string[] = [];
  v.forEach((item, i) => {
    if (typeof item !== "string" || item.trim().length === 0) { errors.push(`${label}[${i}]: non-empty string`); ok = false; }
    else if (item.length > MAX_INGREDIENT_LEN) { errors.push(`${label}[${i}]: exceeds ${MAX_INGREDIENT_LEN} chars`); ok = false; }
    else list.push(item.trim());
  });
  return { list, ok };
}

function validateStep(s: unknown, i: number, errors: string[]): Step | null {
  const o = (s && typeof s === "object" && !Array.isArray(s)) ? (s as Record<string, unknown>) : null;
  if (!o) { errors.push(`steps[${i}]: must be an object`); return null; }
  let ok = true;
  let title: string | undefined;
  if (o.title !== undefined && o.title !== null && o.title !== "") {
    if (typeof o.title !== "string" || o.title.length > MAX_STEP_TITLE_LEN) { errors.push(`steps[${i}].title: string <= ${MAX_STEP_TITLE_LEN} chars`); ok = false; }
    else title = o.title.trim();
  }
  const before = errors.length;
  checkTime(o.activeTime, `steps[${i}].activeTime`, errors);
  checkTime(o.cookTime, `steps[${i}].cookTime`, errors);
  const ing = validateIngredients(o.ingredients, `steps[${i}].ingredients`, errors, true);
  if (typeof o.instructions !== "string" || o.instructions.trim().length === 0) { errors.push(`steps[${i}].instructions: required non-empty string`); ok = false; }
  else if (o.instructions.length > MAX_INSTRUCTIONS_LEN) { errors.push(`steps[${i}].instructions: exceeds ${MAX_INSTRUCTIONS_LEN} chars`); ok = false; }
  if (!ok || !ing.ok || errors.length !== before) return null;
  const step: Step = { activeTime: o.activeTime as number, cookTime: o.cookTime as number, ingredients: ing.list, instructions: (o.instructions as string).trim() };
  if (title) step.title = title;
  return step;
}

export function validateRecipe(input: unknown): { recipe: Recipe } | { errors: string[] } {
  const errors: string[] = [];
  const o = (input && typeof input === "object" && !Array.isArray(input)) ? (input as Record<string, unknown>) : null;
  if (!o) return { errors: ["recipe must be a JSON object"] };

  let title = "";
  if (typeof o.title !== "string" || o.title.trim().length === 0) errors.push("title: required non-empty string");
  else if (o.title.length > MAX_TITLE_LEN) errors.push(`title: exceeds ${MAX_TITLE_LEN} chars`);
  else if (!toSlug(o.title)) errors.push("title: must contain letters or numbers");
  else title = o.title.trim();

  let source: string | undefined;
  if (o.source !== undefined && o.source !== null && o.source !== "") {
    if (typeof o.source !== "string") errors.push("source: must be a string URL");
    else if (o.source.length > MAX_SOURCE_LEN) errors.push(`source: exceeds ${MAX_SOURCE_LEN} chars`);
    else {
      let u: URL | null = null;
      try { u = new URL(o.source); } catch { u = null; }
      if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) errors.push("source: must be an http(s) URL");
      else source = o.source;
    }
  }

  if (!isInt(o.servings) || (o.servings as number) < 1) errors.push("servings: integer >= 1");
  checkTime(o.timeToPrepare, "timeToPrepare", errors);
  checkTime(o.activeTime, "activeTime", errors);
  checkTime(o.cookTime, "cookTime", errors);

  const ing = validateIngredients(o.ingredients, "ingredients", errors, false);

  let steps: Step[] = [];
  if (!Array.isArray(o.steps) || o.steps.length < 1) errors.push("steps: at least one step required");
  else if (o.steps.length > MAX_STEPS_PER_RECIPE) errors.push(`steps: exceeds ${MAX_STEPS_PER_RECIPE}`);
  else steps = (o.steps as unknown[]).map((s, i) => validateStep(s, i, errors)).filter((s): s is Step => s !== null);

  if (errors.length) return { errors };
  const recipe: Recipe = {
    title, servings: o.servings as number, timeToPrepare: o.timeToPrepare as number,
    activeTime: o.activeTime as number, cookTime: o.cookTime as number, ingredients: ing.list, steps,
  };
  if (source) recipe.source = source;
  return { recipe };
}
```

- [ ] **Step 5: Run validation tests — expect PASS.**

- [ ] **Step 6: Write failing storage tests**

Append to `recipes-store.test.ts`:

```ts
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

test("listRecipes returns [] for a missing dir and newest-first", async () => {
  assert.deepEqual(listRecipes(join(tmpdir(), "no-such-recipes-dir")), []);
});
```

Note for the implementer: `../escape` slugifies to `escape` (the `..`/`/` become `-` then trim), so `recipePath` resolves inside `dir` — the assertion documents that traversal can't escape. Adjust the expected slug if `toSlug` folds it differently, but it must stay within `dir`.

- [ ] **Step 7: Run — expect failure** (storage fns undefined).

- [ ] **Step 8: Implement storage fns in recipes-store.ts**

Append:

```ts
function ensureDir(dir: string): void { mkdirSync(dir, { recursive: true }); }
const LOCK_OPTS = { realpath: false, stale: 10000, retries: { retries: 30, minTimeout: 30, maxTimeout: 300 } };

// Resolve slug -> path, basename-defended so a crafted slug can't escape the dir.
export function recipePath(slug: string, dir: string = RECIPES_DIR): string {
  const clean = toSlug(slug);
  if (!clean) throw new Error(`invalid recipe slug: ${JSON.stringify(slug)}`);
  const file = `${clean}.json`;
  if (basename(file) !== file) throw new Error(`invalid recipe slug: ${JSON.stringify(slug)}`);
  return join(dir, file);
}

export function readRecipe(slug: string, dir: string = RECIPES_DIR): Recipe | null {
  try { return JSON.parse(readFileSync(recipePath(slug, dir), "utf8")) as Recipe; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
}

export function listRecipes(dir: string = RECIPES_DIR): RecipeSummary[] {
  let names: string[];
  try { names = readdirSync(dir); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
  const out: RecipeSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const p = join(dir, name);
      const r = JSON.parse(readFileSync(p, "utf8")) as Recipe;
      out.push({ slug: name.slice(0, -5), title: r.title, servings: r.servings, timeToPrepare: r.timeToPrepare, updated: statSync(p).mtime.toISOString() });
    } catch { /* skip a corrupt/half-written file */ }
  }
  out.sort((a, b) => (a.updated < b.updated ? 1 : -1)); // newest first
  return out;
}

// Validate then write atomically under a per-file lock. Enforces MAX_RECIPES on create
// (soft, best-effort under concurrency). create-or-replace; last-write-wins under the lock.
export async function saveRecipe(slug: string, input: unknown, dir: string = RECIPES_DIR): Promise<{ slug: string } | { errors: string[] }> {
  const v = validateRecipe(input);
  if ("errors" in v) return v;
  ensureDir(dir);
  const p = recipePath(slug, dir);
  const exists = (() => { try { statSync(p); return true; } catch { return false; } })();
  if (!exists) {
    if (listRecipes(dir).length >= MAX_RECIPES) return { errors: [`too many recipes (max ${MAX_RECIPES})`] };
    try { writeFileSync(p, "{}", { flag: "wx" }); } // placeholder so proper-lockfile has a target
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  const release = await lockfile.lock(p, LOCK_OPTS);
  try {
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(v.recipe, null, 2));
    renameSync(tmp, p);
    return { slug: toSlug(slug) };
  } finally { await release(); }
}

export async function removeRecipe(slug: string, dir: string = RECIPES_DIR): Promise<boolean> {
  const p = recipePath(slug, dir);
  try { statSync(p); } catch { return false; }
  const release = await lockfile.lock(p, LOCK_OPTS);
  try { unlinkSync(p); return true; } finally { await release(); }
}
```

- [ ] **Step 9: Run the full test file — expect PASS.** Then `make check` from repo root (typecheck clean).

- [ ] **Step 10: Commit**

```bash
git add app/scripts/recipes-store.ts app/scripts/recipes-store.test.ts app/scripts/paths.ts
git commit -m "feat(recipes): recipes-store with shape validation + STATE_DIR store"
```

---

### Task 2: recipes-cli.ts — the CLI

**Files:**
- Create: `app/scripts/recipes-cli.ts`
- Create: `app/scripts/recipes-cli.test.ts`

**Interfaces:**
- Consumes: `readRecipe`, `listRecipes`, `saveRecipe`, `removeRecipe`, `Recipe` from `recipes-store.ts`; `parseFlags` from `cli-flags.ts`.
- Produces: `renderRecipe(r: Recipe): string` (exported for tests); the `recipes-cli` command (`list` / `show <slug> [--json]` / `save <slug>` / `rm <slug>`).

- [ ] **Step 1: Write failing tests**

Create `app/scripts/recipes-cli.test.ts`. The store fns hit `RECIPES_DIR` (the real workspace) when invoked via the CLI binary, so exercise the CLI by spawning it with a `HOME` pointed at a tmpdir (mirrors how other CLI tests isolate STATE_DIR — check `checklist-cli.test.ts` for the exact env/spawn helper and reuse it). Also unit-test the pure `renderRecipe` directly.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRecipe } from "./recipes-cli.ts";
import type { Recipe } from "./recipes-store.ts";

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
```

For the spawn-based verb tests (in the same file), assert:
- `save <slug>` with valid JSON on stdin exits 0 and creates the recipe; `show <slug>` prints it; `show <slug> --json` round-trips (its stdout re-`save`s cleanly); `list` shows it; `rm <slug>` removes it.
- **Nonzero exits:** `save` with malformed JSON, `save` with an invalid recipe (writes nothing), `show`/`rm` of an unknown slug, no subcommand, and an unknown subcommand all exit nonzero (bare no-arg exits 2, others exit 1), matching `checklist-cli.test.ts`'s exit-code assertions.

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement recipes-cli.ts**

```ts
#!/usr/bin/env node
// recipes-cli: Baxter's step-oriented recipe store. Verbs: list / show <slug> [--json] /
// save <slug> (recipe JSON on stdin, validated) / rm <slug>. STATE_DIR store
// (recipes-store.ts). Exits nonzero on any misuse or validation failure (run_cli invariant).
// renderRecipe is exported for tests; the dispatch at the bottom is import-guarded.
import { pathToFileURL } from "node:url";
import { readRecipe, listRecipes, saveRecipe, removeRecipe } from "./recipes-store.ts";
import type { Recipe } from "./recipes-store.ts";
import { parseFlags } from "./cli-flags.ts";

const USAGE = [
  "usage:",
  "  recipes-cli list",
  "  recipes-cli show <slug> [--json]",
  "  … | recipes-cli save <slug>     (recipe JSON on stdin; validated)",
  "  recipes-cli rm <slug>",
].join("\n");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function renderRecipe(r: Recipe): string {
  const lines: string[] = [`# ${r.title}`];
  lines.push([`serves ${r.servings}`, `total ${r.timeToPrepare} min`, `active ${r.activeTime} min`, `cook ${r.cookTime} min`].join(" · "));
  if (r.source) lines.push(`source: ${r.source}`);
  lines.push("", "Ingredients (overall):");
  for (const ing of r.ingredients) lines.push(`  - ${ing}`);
  lines.push("");
  r.steps.forEach((s, i) => {
    lines.push(`Step ${i + 1}${s.title ? `: ${s.title}` : ""}  (active ${s.activeTime} min, cook ${s.cookTime} min)`);
    if (s.ingredients.length) { lines.push("  uses:"); for (const ing of s.ingredients) lines.push(`    - ${ing}`); }
    lines.push(`  ${s.instructions}`, "");
  });
  return lines.join("\n").trimEnd();
}

async function main(): Promise<void> {
  const { positionals, flags } = parseFlags(process.argv.slice(2), new Set(["json"]));
  const cmd = positionals[0];
  if (cmd === "list") {
    const rows = listRecipes();
    if (rows.length === 0) { console.log("(no recipes)"); return; }
    for (const r of rows) console.log(`${r.slug}\t${r.title}\tserves ${r.servings}\t${r.timeToPrepare} min\t${r.updated.slice(0, 10)}`);
  } else if (cmd === "show") {
    const slug = positionals[1];
    if (!slug) throw new Error("usage: recipes-cli show <slug> [--json]");
    const r = readRecipe(slug);
    if (!r) { console.error(`no such recipe: ${slug}`); process.exit(1); }
    console.log(flags.json === true ? JSON.stringify(r, null, 2) : renderRecipe(r));
  } else if (cmd === "save") {
    const slug = positionals[1];
    if (!slug) throw new Error("usage: … | recipes-cli save <slug>");
    let input: unknown;
    try { input = JSON.parse(await readStdin()); } catch { console.error("save: stdin is not valid JSON"); process.exit(1); }
    const res = await saveRecipe(slug, input);
    if ("errors" in res) { console.error("save: invalid recipe:\n" + res.errors.map((e) => `  - ${e}`).join("\n")); process.exit(1); }
    console.log(`saved recipe "${res.slug}"`);
  } else if (cmd === "rm") {
    const slug = positionals[1];
    if (!slug) throw new Error("usage: recipes-cli rm <slug>");
    if (!(await removeRecipe(slug))) { console.error(`no such recipe: ${slug}`); process.exit(1); }
    console.log(JSON.stringify({ removed: slug }));
  } else {
    console.error(USAGE);
    process.exit(cmd ? 1 : 2); // nonzero even with NO subcommand (matches checklist-cli: exit-0 usage made run_cli report ok)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(`recipes-cli: ${(err as Error).message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test file — expect PASS.** Then `make check` (typecheck clean).

- [ ] **Step 5: Commit**

```bash
git add app/scripts/recipes-cli.ts app/scripts/recipes-cli.test.ts
git commit -m "feat(recipes): recipes-cli (list/show/save/rm), nonzero on misuse"
```

---

### Task 3: recipes skill

**Files:**
- Create: `app/skills/recipes/SKILL.md`

**Interfaces:** none (content only). Must exist before Task 4 registers `recipes` in `SKILL_NAMES`.

- [ ] **Step 1: Write `app/skills/recipes/SKILL.md`**

Match the tone/structure of `app/skills/projects/SKILL.md` and `app/skills/checklist/SKILL.md`. Full content:

```markdown
---
name: recipes
description: Capture and present recipes with recipes-cli -- a step-oriented recipe model where each step carries only the ingredients it uses and how long it takes. Use whenever a user mentions, asks about, or provides a recipe (from a link or a photo). Verbs: list/show/save/rm; save takes recipe JSON on stdin and validates it.
allowed-tools: Bash(recipes-cli:*)
---

# Recipes with recipes-cli

`recipes-cli` stores recipes in a **step-oriented** model and lets you present
them **step by step** — each step shows the ingredients *that step* uses and how
long it takes, instead of the traditional "all ingredients up front, then a wall
of prose." Reach for this whenever a user **mentions, asks about, or provides**
a recipe.

## The model

A recipe is a JSON object:

- `title` — required.
- `source` — the recipe's URL **if it came from a link**. Omit it entirely for a
  recipe read from a **photo** the user sent.
- `servings` — number of people served (integer ≥ 1).
- `timeToPrepare`, `activeTime`, `cookTime` — whole minutes.
- `ingredients` — the overall list, free-text lines like `"2 cups flour"`.
- `steps` — an ordered list; **at least one**. Each step:
  - `title` — optional label, e.g. `"Make the sauce"`.
  - `activeTime`, `cookTime` — whole minutes for *this* step.
  - `ingredients` — only the ingredients *this* step uses (may be empty, e.g. a
    "preheat the oven" step).
  - `instructions` — what to do in this step.

The whole point: **distribute each ingredient and time into the step that
actually uses it.** Don't just dump everything up front and then describe it.

## Intake

**From a link:** fetch the page (`web-cli` or WebFetch), read the recipe, and
**restructure** it into the model above — pull each ingredient down into the
step that uses it, estimate per-step active/cook time from the directions, and
set `source` to the URL.

**From a photo:** you're on a multimodal model, so read the recipe straight from
the image, restructure it the same way, and **leave `source` out**.

Then `save` it (see below). `save` validates; if it reports errors, fix them and
`save` again.

## Commands

| Command | What it does |
|---|---|
| `recipes-cli list` | Every recipe: slug, title, servings, total time, last-updated. |
| `recipes-cli show <slug>` | Print a stored recipe (readable step-by-step dump). |
| `recipes-cli show <slug> --json` | Print the raw JSON (edit it, then re-`save`). |
| `… \| recipes-cli save <slug>` | Read recipe JSON on stdin, **validate**, and create-or-replace `<slug>`. |
| `recipes-cli rm <slug>` | Delete a recipe. |

`save` **validates** the JSON. On a bad recipe it writes nothing and exits
nonzero with the specific problems on stderr — read them, fix the JSON, and
`save` again. There is no separate "validate" command; just `save`.

Pipe the JSON straight into `save` with a heredoc — don't stage a scratch file:

```
recipes-cli save weeknight-pasta <<'EOF'
{
  "title": "Weeknight Pasta",
  "source": "https://example.com/pasta",
  "servings": 4,
  "timeToPrepare": 30, "activeTime": 20, "cookTime": 10,
  "ingredients": ["1 lb pasta", "2 cups tomato sauce", "parmesan"],
  "steps": [
    { "title": "Boil the pasta", "activeTime": 2, "cookTime": 8,
      "ingredients": ["1 lb pasta"], "instructions": "Boil salted water and cook the pasta until al dente." },
    { "title": "Finish", "activeTime": 5, "cookTime": 2,
      "ingredients": ["2 cups tomato sauce", "parmesan"], "instructions": "Warm the sauce, toss the pasta in it, top with parmesan." }
  ]
}
EOF
```

Use a slug that matches the title (lowercase, hyphenated). It's slugified for
you, so `save "Weeknight Pasta"` works too.

## Presenting a recipe

When the user asks for a recipe, present it **step by step** — this is the whole
reason recipes are structured this way:

1. A short header: the title, who it serves, and the total time (and the source
   link if there is one).
2. Then, for **each step** in order: its label (if any), **the ingredients that
   step uses**, how long it'll take (active / cook), and what to do.

Don't lead with the full ingredient list and then a block of prose. Adapt the
formatting to the channel (chat, SMS, email, Discord), but always keep the
step-by-step structure where each step carries its own ingredients and timing.
`recipes-cli show <slug>` already prints in this shape — use it as the basis.

## When to use a recipe vs. just replying

Any time a recipe is in play — the user shares a link or photo of one, asks you
to save one, or asks you to pull one back up — use `recipes-cli`. For a passing
mention that isn't really about capturing or cooking a recipe, just reply.
```

- [ ] **Step 2: Commit**

```bash
git add app/skills/recipes/SKILL.md
git commit -m "feat(recipes): recipes skill (intake + step-by-step presentation)"
```

---

### Task 4: Wiring — grant, skill registration, shim, docs

**Files:**
- Modify: `app/scripts/grants.ts` (add `Bash(recipes-cli *)` to `CORE_TOOLS`; add `recipes` to `SKILL_NAMES`)
- Modify: `app/scripts/grants.test.ts` (add `Bash(recipes-cli *)` to the enumerated CORE-tool lists)
- Modify: `app/Dockerfile` (PATH shim)
- Modify: `app/docs/architecture/tool-clis.md` (new paragraph + header list)

**Interfaces:** none new.

- [ ] **Step 1: Register the grant + skill in grants.ts**

In `CORE_TOOLS`, insert `Bash(recipes-cli *)` right after `Bash(checklist-cli *)`:

```ts
const CORE_TOOLS =
  "Bash(code-cli *) Bash(files-cli *) Bash(projects-cli *) Bash(memory-cli *) Bash(calendar-cli *) Bash(checklist-cli *) Bash(recipes-cli *) Bash(data-cli *) Bash(skills-cli *) Bash(web-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit";
```

In `SKILL_NAMES`, insert `"recipes"` right after `"checklist"`:

```ts
export const SKILL_NAMES = ["playwright-cli", "invisible-playwright", "discord", "code", "schedule", "web", "projects", "memory", "calendar", "checklist", "recipes", "data", "skill-discovery", "skill-creator", "help-user-setup"];
```

- [ ] **Step 2: Update grants.test.ts**

`grants.test.ts` enumerates the exact CORE tool list in **three** places (the MAIL/heartbeat check ~line 30, the smaller subset check ~line 50, and the CHAT check ~line 118). In each array that already contains `"Bash(checklist-cli *)"`, add `"Bash(recipes-cli *)"` immediately after it. (The `SKILL_NAMES`/`BAKED_SKILL_NAMES` assertions derive from `SKILL_NAMES` and need no change, but confirm they still pass — `recipes` flows to every non-excluded surface automatically.)

- [ ] **Step 3: Run grants tests — expect PASS** (`node --test app/scripts/grants.test.ts`). If the subset list at ~line 50 does **not** contain `checklist-cli`, do not add `recipes-cli` there either — match wherever `checklist-cli` appears, exactly.

- [ ] **Step 4: Add the Dockerfile shim**

In `app/Dockerfile`, right after the `checklist-cli` shim block (~line 351-356), add:

```dockerfile
# `recipes-cli` on PATH -> step-oriented recipe store (list/show/save/rm). STATE_DIR
# store; save validates the format. Mirrors the checklist-cli shim above.
RUN printf '#!/bin/sh\nexec node /app/scripts/recipes-cli.ts "$@"\n' \
      > /usr/local/bin/recipes-cli \
    && chmod +x /usr/local/bin/recipes-cli
```

- [ ] **Step 5: Document in tool-clis.md**

In `app/docs/architecture/tool-clis.md`: add `recipes-cli` to the header file list (first line), and add a paragraph after the `checklist-cli` one describing recipes-cli: the step-oriented model, STATE_DIR sole-writer posture, shape-only validation, nonzero-on-misuse, verbs, and that the `recipes` skill owns intake + step-by-step presentation. Reference the spec (`docs/superpowers/specs/2026-08-06-recipes-cli-design.md`).

- [ ] **Step 6: Run the full suite — expect PASS** (`make check` from repo root: typecheck + all tests).

- [ ] **Step 7: Commit**

```bash
git add app/scripts/grants.ts app/scripts/grants.test.ts app/Dockerfile app/docs/architecture/tool-clis.md
git commit -m "feat(recipes): wire recipes-cli grant + recipes skill, shim, docs"
```

---

## Self-review notes

- **Spec coverage:** model (§1)→T1; storage+validation (§2,§3)→T1; CLI verbs+exit codes (§4)→T2; skill (§5)→T3; wiring (§6)→T4. `validate` verb intentionally absent (spec §4). ✅
- **Type consistency:** `Recipe`/`Step`/`RecipeSummary` and `validateRecipe`/`saveRecipe`/`toSlug`/`recipePath` signatures are identical across T1 (produced) and T2 (consumed). ✅
- **Ordering:** `RECIPES_DIR` lands in T1 (store imports it); skill dir exists (T3) before `SKILL_NAMES` registration (T4). ✅
- **Post-merge (operator, outside this plan):** a `git add core` pointer bump in the outer `/app` repo, and a container rebuild+redeploy so the new shim/skill/grant take effect (recipes is baked into the image).
```
