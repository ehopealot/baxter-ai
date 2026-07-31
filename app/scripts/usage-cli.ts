// Per-tenant usage report. `usage show` (also bare /usage) prints spend vs budget
// + breakdowns; `usage json` emits the machine-readable summary the operator's
// `baxctl usage` rolls up across tenants. Thin shell over usage-store.ts.
import { summary, creditBudgetUsd } from "./usage-store.ts";

function fmt(n: number): string {
  return `$${n.toFixed(2)}`;
}

function show(): void {
  const s = summary(Date.now(), creditBudgetUsd());
  console.log(`usage (${s.periodKey}, per ${s.period}):`);
  console.log(`  spent:   ${fmt(s.spent)}${s.budget > 0 ? ` / ${fmt(s.budget)}` : "  (no budget set)"}`);
  if (s.budget > 0) console.log(`  ${s.remaining >= 0 ? "remain:  " : "OVER by: "}${fmt(Math.abs(s.remaining))}`);
  console.log(`  runs:    ${s.runs}    tokens: ${s.tokens.in} in / ${s.tokens.out} out`);
  const byModel = Object.entries(s.byModel).sort((a, b) => b[1].cost - a[1].cost);
  if (byModel.length) {
    console.log("  by model:");
    for (const [m, v] of byModel) console.log(`    ${m}  ${fmt(v.cost)}  (${v.runs})`);
  }
  const bySurface = Object.entries(s.bySurface).sort((a, b) => b[1].cost - a[1].cost);
  if (bySurface.length) {
    console.log("  by surface:");
    for (const [su, v] of bySurface) console.log(`    ${su}  ${fmt(v.cost)}  (${v.runs})`);
  }
}

function main(argv: string[]): void {
  const cmd = argv[0] || "show";
  if (cmd === "json") {
    console.log(JSON.stringify(summary(Date.now(), creditBudgetUsd()), null, 2));
    return;
  }
  if (cmd === "show") {
    show();
    return;
  }
  console.error("usage: usage-cli [show|json]");
  process.exit(1);
}

main(process.argv.slice(2));
