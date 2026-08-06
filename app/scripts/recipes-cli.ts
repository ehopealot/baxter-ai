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
