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
