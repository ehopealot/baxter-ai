// Per-tenant model-usage ledger: one best-effort JSONL append per run, summed
// for the soft budget cap and the /usage report. Cost is real USD (openrouter/
// claude); tokens-only harnesses record cost:null. Physically per-tenant because
// STATE_DIR is the per-tenant config volume. Lock-free append (access-log.ts
// pattern): several surface CONTAINERS of one tenant share the config volume and
// append this file concurrently. Each line is written with one appendFileSync()
// on an O_APPEND fd; on a local fs (the docker named volume) the kernel
// serializes the append per-inode so lines don't interleave (Node loops writeSync
// internally, but a ~150-byte write to a local regular file lands in one call).
// The free-form fields are length-clamped as belt-and-suspenders (NOT NFS-safe).
// See docs/superpowers/specs/2026-07-31-usage-metering-design.md.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE_DIR } from "./paths.ts";

export type UsageSrc = "openrouter" | "local" | "custom" | "claude";
export type Period = "month" | "day";

export interface UsageEntry {
  t: number; // epoch ms (run completion)
  surface: string; // mail | discord | heartbeat | voice | tui
  model: string; // effective model actually run ("" if unknown)
  cost: number | null; // USD; null when the harness reports no cost
  inTok: number;
  outTok: number;
  src: UsageSrc;
  logId: string;
}

function usageDir(): string {
  return process.env.USAGE_DIR_OVERRIDE || USAGE_DIR;
}

export function currentPeriod(): Period {
  return process.env.BAXTER_CREDIT_PERIOD === "day" ? "day" : "month";
}

// UTC period key -> "YYYY-MM" (month) or "YYYY-MM-DD" (day). Also names the file.
export function periodKey(now: number, period: Period): string {
  const iso = new Date(now).toISOString();
  return period === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

function ledgerPath(now: number, period: Period): string {
  return join(usageDir(), `ledger-${periodKey(now, period)}.jsonl`);
}

function clamp(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) : s;
}

// Best-effort append -- never throws into a run. Always writes an entry.
export function recordUsage(entry: UsageEntry): void {
  try {
    const dir = usageDir();
    mkdirSync(dir, { recursive: true });
    const line =
      JSON.stringify({
        ...entry,
        model: clamp(entry.model ?? ""),
        logId: clamp(String(entry.logId ?? "")),
      }) + "\n";
    appendFileSync(ledgerPath(entry.t, currentPeriod()), line);
  } catch (err) {
    console.error(`usage: ledger append failed (${(err as Error).message})`);
  }
}

function readEntries(now: number, period: Period): UsageEntry[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(now, period), "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as UsageEntry);
    } catch {
      /* skip a torn/partial line */
    }
  }
  return out;
}

export function spentThisPeriod(now = Date.now()): number {
  let sum = 0;
  for (const e of readEntries(now, currentPeriod())) {
    if (typeof e.cost === "number" && Number.isFinite(e.cost)) sum += e.cost;
  }
  return sum;
}

export interface UsageSummary {
  period: Period;
  periodKey: string;
  spent: number;
  budget: number; // 0 = no budget set
  remaining: number; // budget - spent (may be negative); 0 when no budget
  runs: number;
  tokens: { in: number; out: number };
  byModel: Record<string, { cost: number; runs: number }>;
  bySurface: Record<string, { cost: number; runs: number }>;
}

export function summary(now = Date.now(), budget = 0): UsageSummary {
  const period = currentPeriod();
  const entries = readEntries(now, period);
  const byModel: Record<string, { cost: number; runs: number }> = {};
  const bySurface: Record<string, { cost: number; runs: number }> = {};
  let spent = 0,
    tin = 0,
    tout = 0;
  for (const e of entries) {
    const c = typeof e.cost === "number" && Number.isFinite(e.cost) ? e.cost : 0;
    spent += c;
    tin += e.inTok || 0;
    tout += e.outTok || 0;
    const m = e.model || "(unknown)";
    (byModel[m] ??= { cost: 0, runs: 0 }).cost += c;
    byModel[m].runs += 1;
    const s = e.surface || "(unknown)";
    (bySurface[s] ??= { cost: 0, runs: 0 }).cost += c;
    bySurface[s].runs += 1;
  }
  return {
    period,
    periodKey: periodKey(now, period),
    spent,
    budget,
    remaining: budget > 0 ? budget - spent : 0,
    runs: entries.length,
    tokens: { in: tin, out: tout },
    byModel,
    bySurface,
  };
}

// Monthly (or daily) USD budget. Blank/invalid/<=0 -> 0 (tracking-only).
export function creditBudgetUsd(): number {
  const raw = process.env.BAXTER_CREDIT_BUDGET_USD;
  if (!raw || !raw.trim()) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Pure soft-cap decision (no I/O), so runAgent stays thin and this is unit-tested.
export function evaluateCap(opts: {
  budget: number;
  spent: number;
  softNote: boolean;
}): { overBudget: boolean; alertMsg: string; creditsLow: boolean } {
  const over = opts.budget > 0 && opts.spent >= opts.budget;
  return {
    overBudget: over,
    alertMsg: over
      ? `usage ALERT: tenant over $${opts.budget} budget (spent $${opts.spent.toFixed(2)} this period) -- still serving, fail-open`
      : "",
    creditsLow: over && opts.softNote,
  };
}

// Once-per-period sentinel (O_EXCL create). Returns true the FIRST time only,
// per (kind, period) -- atomic across the tenant's several containers on the
// shared volume, so an alert fires exactly once per period crossing.
export function firstTimeThisPeriod(kind: string, now = Date.now()): boolean {
  try {
    mkdirSync(usageDir(), { recursive: true });
    writeFileSync(join(usageDir(), `${kind}-${periodKey(now, currentPeriod())}.marker`), "", { flag: "wx" });
    return true;
  } catch {
    return false; // EEXIST (already fired) or any other error -> don't spam
  }
}
