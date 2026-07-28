#!/usr/bin/env node
// `make eval` entrypoint. Loads evals/scenarios/*.ts, runs the suite on the pinned
// model, prints a pass table, exits nonzero if any scenario is below its threshold.
//
// Eval RUNS call a real model, so this needs OPENROUTER_API_KEY + a model (see the
// design doc: it's a pre-deploy/nightly gate, not a per-commit unit test).
//   EVAL_MODEL / EVAL_HARNESS / EVAL_SAMPLES  override the pinned model / harness / K
//   node evals/run.ts --scenario <substr>    run only matching scenarios
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NormalizedEvent } from "../scripts/runtime.ts";
import type { Scenario } from "./harness.ts";
import { runSuite } from "./harness.ts";

const SCEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "scenarios");

const harness = process.env.EVAL_HARNESS || process.env.BAXTER_HARNESS || "openrouter";
const model = process.env.EVAL_MODEL || process.env.OPENROUTER_MODEL;
const samples = Number(process.env.EVAL_SAMPLES || 3);

if (harness === "openrouter" && !process.env.OPENROUTER_API_KEY) {
  console.error("evals need OPENROUTER_API_KEY (they call a real model). Set it (e.g. from app/.env), or point at another harness.");
  process.exit(2);
}
if (!model) { console.error("no eval model -- set EVAL_MODEL or OPENROUTER_MODEL."); process.exit(2); }
if (!Number.isInteger(samples) || samples < 1) { console.error(`EVAL_SAMPLES must be a positive integer (got ${process.env.EVAL_SAMPLES}).`); process.exit(2); }

const flagIdx = process.argv.indexOf("--scenario");
const filter = flagIdx >= 0 ? process.argv[flagIdx + 1] : null;

const scenarios: Scenario[] = [];
for (const f of readdirSync(SCEN_DIR).filter((f) => f.endsWith(".ts")).sort()) {
  const mod = (await import(pathToFileURL(join(SCEN_DIR, f)).href)) as { default?: Scenario };
  const sc = mod.default;
  if (sc && (!filter || sc.name.includes(filter))) scenarios.push(sc);
}
if (!scenarios.length) { console.error(filter ? `no scenarios matched "${filter}".` : "no scenarios found."); process.exit(2); }

console.error(`Running ${scenarios.length} scenario(s) x ${samples} sample(s) on ${harness}/${model} ...\n`);

// Live status to stderr: a header per scenario, then one line per sample that streams
// each tool call AS IT HAPPENS (so a slow multi-turn sample shows progress instead of
// a silent gap), then the verdict. The machine-readable result table still goes to
// stdout at the end, so `make eval > out.txt` captures just the table.
const w = (s: string) => process.stderr.write(s);
// A tool_use event -> a compact token: `cli/sub` for a run_cli, else the native name.
const tok = (ev: NormalizedEvent): string => {
  if (ev.name === "run_cli") {
    const input = ev.input as Record<string, unknown> | undefined;
    const cli = (input?.cli as string | undefined) ?? "cli";
    const sub = Array.isArray(input?.args) ? (input?.args as unknown[])[0] : undefined;
    return sub ? `${cli}/${sub}` : cli;
  }
  return ev.name ?? "";
};
const started = Date.now();
const { table, pass } = await runSuite(scenarios, {
  model, harness, samples,
  onScenarioStart: (sc, i, total) => w(`\n[${i + 1}/${total}] ${sc.name}\n`),
  onSampleStart: ({ i, K }) => w(`  ${i + 1}/${K}:`),
  onEvent: (ev) => { if (ev.kind === "tool_use") w(` ${tok(ev)}`); },
  onSample: ({ pass }) => w(pass ? "  ✓\n" : "  ✗\n"),
  onScenarioDone: (row) => w(`  => ${row.pass ? "PASS" : "FAIL"} (${row.passes}/${row.samples})\n`),
});
w(`\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s.\n`);
console.log("\n" + table);
process.exit(pass ? 0 : 1);
