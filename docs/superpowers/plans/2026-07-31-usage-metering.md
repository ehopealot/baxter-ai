# Per-tenant Usage Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record real USD model-spend per tenant into a per-tenant JSONL ledger, expose it via a `usage-cli` / bare `/usage`, and enforce a fail-open (soft) monthly USD budget with a debounced operator alert.

**Architecture:** Each tenant container already writes to an isolated `STATE_DIR` (per-tenant config volume), so a ledger file there is automatically per-tenant. Runners report per-run `usage` (cost/tokens/effective-model/provenance) on their terminal `result` event; the single chokepoint `runAgent` (`runtime.ts`) records it and does the pre-spawn soft-cap check. Reporting is a thin CLI over a pure store. No central DB, no per-run network egress — the operator rolls up across tenants by ssh-running `usage-cli json` (that rollup lives in the separate `baxter-control` repo, out of scope here).

**Tech Stack:** TypeScript run directly by Node 22 (no build step). `proper-lockfile` (already a dep) is *not* needed on the ledger (lock-free O_APPEND, see Global Constraints). Tests: `node --test`. Gate: `make check` from the repo root (`tsc --noEmit` strict + the test suite).

**Spec:** `docs/superpowers/specs/2026-07-31-usage-metering-design.md` — read it; this plan implements it.

## Global Constraints

- **Metering must never throw into, block, or slow a run.** Every ledger write and cap read is best-effort: on failure, one `console.error` and swallow. A run must complete identically whether or not metering succeeds.
- **`recordUsage` always writes an entry**, even with no usage (records `cost:null`, zero tokens, `model:""`), so run counts stay complete across every harness.
- **Cost is real USD** from `usage.cost` (openrouter) / `total_cost_usd` (claude). Harnesses that report no cost record `cost:null` — never a fabricated 0 that would understate the budget silently.
- **Each ledger line is written with one `appendFileSync` of the whole line.** Several surface *containers* of one tenant share the config volume and append the same file concurrently. On a local fs (the docker named volume) the kernel serializes an `O_APPEND` write per-inode so lines don't interleave — in practice a ~150-byte write lands in one `write()` (Node loops `writeSync` until the buffer drains, but it completes in one call for a small write to a local regular file); this would NOT hold on NFS, and PIPE_BUF governs pipes/FIFOs, not regular files, so it isn't the relevant invariant. Clamp the free-form `model`/`logId` fields (200 chars each) and keep one compact JSON line as belt-and-suspenders. No lock is taken on the ledger.
- **Node erasable syntax:** no constructor parameter-property shorthand; type-only imports are fine across files.
- **Period is UTC.** `BAXTER_CREDIT_PERIOD` = `month` (default) | `day`; it drives both the reset boundary and the ledger filename (`ledger-YYYY-MM` / `ledger-YYYY-MM-DD`).
- **Config knobs** (per-tenant `TENANT_ENV`): `BAXTER_CREDIT_BUDGET_USD` (unset/0 = tracking-only), `BAXTER_CREDIT_PERIOD`, `BAXTER_CREDITS_SOFT_NOTE` (`1` ⇒ set child env `BAXTER_CREDITS_LOW=1` when over budget).
- **Test dir redirect:** `USAGE_DIR_OVERRIDE` points the ledger at a temp dir (mirrors `SEND_STATE_DIR_OVERRIDE` / `SCHEDULE_DIR_OVERRIDE`). Only the location changes.

## File Structure

- **Create** `app/scripts/usage-store.ts` — pure ledger core: `recordUsage`, `spentThisPeriod`, `summary`, period math, `creditBudgetUsd`, `evaluateCap` (pure soft-cap decision), `firstTimeThisPeriod` (once-per-period sentinel). One responsibility: the on-disk usage ledger + budget arithmetic.
- **Create** `app/scripts/usage-cli.ts` — thin I/O shell: `show` / `json`.
- **Create** `app/scripts/harnesses/openrouter-usage.ts` — pure per-turn usage accumulator (fed fake events), extracted so the no-double-count / escalation tests run offline.
- **Modify** `app/scripts/paths.ts`, `runner-events.ts`, `runtime.ts` (+ the 6 `runAgent` callers), `harnesses/local-runner.ts`, `custom-runner.ts` (+ `dialects`), `claude.ts`, `openrouter-runner.ts`, `tui-core.ts`, `app/Dockerfile`, `app/.env.example`, and a short architecture doc.

**Task order (each leaves `make check` green):** 1 store → 2 wire types → 3 runtime record + cap + `surface` threading → 4 local/custom capture → 5 claude capture → 6 openrouter capture → 7 CLI/TUI/Dockerfile → 8 docs. After Task 3 the feature works end-to-end recording `cost:null`; Tasks 4-6 fill in real numbers.

---

### Task 1: The pure ledger store (`usage-store.ts` + `paths.ts`)

**Files:**
- Create: `app/scripts/usage-store.ts`
- Create: `app/scripts/usage-store.test.ts`
- Modify: `app/scripts/paths.ts` (add `USAGE_DIR`)

**Interfaces:**
- Produces: `recordUsage(entry: UsageEntry): void`, `spentThisPeriod(now?: number): number`, `summary(now?: number, budget?: number): UsageSummary`, `creditBudgetUsd(): number`, `evaluateCap(opts): {overBudget, alertMsg, creditsLow}`, `firstTimeThisPeriod(kind: string, now?: number): boolean`, and the types `UsageEntry`, `UsageSrc`, `UsageSummary`, `Period`.

- [ ] **Step 1: Add `USAGE_DIR` to `paths.ts`.** After the `ACCESS_LOG_PATH` line (`app/scripts/paths.ts:118`), add:

```ts
// Per-tenant model-usage ledger (one best-effort JSONL append per run) + its
// once-per-period alert sentinels. In STATE_DIR (per-tenant config volume), so
// it's automatically per-tenant and survives restarts. See usage-store.ts.
export const USAGE_DIR = join(STATE_DIR, "usage");
```

- [ ] **Step 2: Write the failing test** `app/scripts/usage-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the ledger to a temp dir BEFORE importing the module under test, so
// USAGE_DIR_OVERRIDE is read at call time (the store reads it per call).
const DIR = mkdtempSync(join(tmpdir(), "usage-"));
process.env.USAGE_DIR_OVERRIDE = DIR;

const {
  recordUsage, spentThisPeriod, summary, creditBudgetUsd, evaluateCap, firstTimeThisPeriod, periodKey,
} = await import("./usage-store.ts");

function entry(over = {}) {
  return { t: Date.UTC(2026, 6, 15, 12), surface: "discord", model: "m", cost: 0.01, inTok: 100, outTok: 20, src: "openrouter", logId: "x", ...over };
}

test("recordUsage + spentThisPeriod sums cost; null contributes 0", () => {
  const now = Date.UTC(2026, 6, 15, 12);
  recordUsage(entry({ cost: 0.02 }));
  recordUsage(entry({ cost: 0.03 }));
  recordUsage(entry({ cost: null, src: "local" }));  // still recorded, adds 0
  assert.ok(Math.abs(spentThisPeriod(now) - 0.05) < 1e-9);
});

test("summary breaks down by model and surface, counts runs+tokens incl. the null-cost run", () => {
  const now = Date.UTC(2026, 6, 15, 12);
  const s = summary(now, 1.0);
  assert.equal(s.runs, 3);
  assert.equal(s.budget, 1.0);
  assert.ok(Math.abs(s.remaining - 0.95) < 1e-9);
  assert.equal(s.tokens.in, 300);
  assert.ok(s.bySurface.discord.runs === 3);
});

test("period rollover: a run in a different month is a different file; spentThisPeriod ignores it", () => {
  const aug = Date.UTC(2026, 7, 3, 9);
  recordUsage(entry({ t: aug, cost: 9.0 }));
  assert.ok(Math.abs(spentThisPeriod(aug) - 9.0) < 1e-9);           // August file only
  assert.ok(spentThisPeriod(Date.UTC(2026, 6, 15, 12)) < 1.0);      // July unaffected
  assert.notEqual(periodKey(aug, "month"), periodKey(Date.UTC(2026, 6, 15), "month"));
});

test("recordUsage never throws on a bad dir", () => {
  const saved = process.env.USAGE_DIR_OVERRIDE;
  process.env.USAGE_DIR_OVERRIDE = "/proc/nonexistent/cannot/mkdir"; // mkdir will fail
  assert.doesNotThrow(() => recordUsage(entry()));
  process.env.USAGE_DIR_OVERRIDE = saved;
});

test("creditBudgetUsd: unset/blank/invalid/negative -> 0; a positive number passes", () => {
  for (const bad of [undefined, "", "abc", "-5", "0"]) {
    if (bad === undefined) delete process.env.BAXTER_CREDIT_BUDGET_USD; else process.env.BAXTER_CREDIT_BUDGET_USD = bad;
    assert.equal(creditBudgetUsd(), 0);
  }
  process.env.BAXTER_CREDIT_BUDGET_USD = "12.5";
  assert.equal(creditBudgetUsd(), 12.5);
  delete process.env.BAXTER_CREDIT_BUDGET_USD;
});

test("evaluateCap: under budget -> nothing; over -> alert + creditsLow gated on softNote", () => {
  assert.deepEqual(evaluateCap({ budget: 0, spent: 100, softNote: true }), { overBudget: false, alertMsg: "", creditsLow: false });
  assert.deepEqual(evaluateCap({ budget: 10, spent: 5, softNote: true }).overBudget, false);
  const over = evaluateCap({ budget: 10, spent: 12, softNote: false });
  assert.equal(over.overBudget, true);
  assert.match(over.alertMsg, /over \$10/);
  assert.equal(over.creditsLow, false);
  assert.equal(evaluateCap({ budget: 10, spent: 12, softNote: true }).creditsLow, true);
});

test("firstTimeThisPeriod returns true once per period then false", () => {
  const now = Date.UTC(2026, 6, 20, 0);
  assert.equal(firstTimeThisPeriod("alerted", now), true);
  assert.equal(firstTimeThisPeriod("alerted", now), false);
  assert.equal(firstTimeThisPeriod("null-cost", now), true); // distinct kind, distinct marker
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
```

- [ ] **Step 3: Run it, confirm it fails** (module missing).
Run: `cd /app && node --test app/scripts/usage-store.test.ts`
Expected: FAIL (cannot find `./usage-store.ts`).

- [ ] **Step 4: Write `app/scripts/usage-store.ts`:**

```ts
// Per-tenant model-usage ledger: one best-effort JSONL append per run, summed
// for the soft budget cap and the /usage report. Cost is real USD (openrouter/
// claude); tokens-only harnesses record cost:null. Physically per-tenant because
// STATE_DIR is the per-tenant config volume. Lock-free append (access-log.ts
// pattern): several surface CONTAINERS of one tenant share the config volume and
// append this file concurrently. Each line is one appendFileSync() call on an
// O_APPEND fd, which Linux local filesystems (the docker named volume) serialize
// per-inode so a whole-line write can't interleave; the free-form fields are
// length-clamped as belt-and-suspenders (this would NOT hold on NFS).
// See docs/superpowers/specs/2026-07-31-usage-metering-design.md.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE_DIR } from "./paths.ts";

export type UsageSrc = "openrouter" | "local" | "custom" | "claude";
export type Period = "month" | "day";

export interface UsageEntry {
  t: number;            // epoch ms (run completion)
  surface: string;      // mail | discord | heartbeat | voice | tui
  model: string;        // effective model actually run ("" if unknown)
  cost: number | null;  // USD; null when the harness reports no cost
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
    const line = JSON.stringify({
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
    try { out.push(JSON.parse(line) as UsageEntry); } catch { /* skip a torn/partial line */ }
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
  budget: number;    // 0 = no budget set
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
  let spent = 0, tin = 0, tout = 0;
  for (const e of entries) {
    const c = typeof e.cost === "number" && Number.isFinite(e.cost) ? e.cost : 0;
    spent += c; tin += e.inTok || 0; tout += e.outTok || 0;
    const m = e.model || "(unknown)";
    (byModel[m] ??= { cost: 0, runs: 0 }).cost += c; byModel[m].runs += 1;
    const s = e.surface || "(unknown)";
    (bySurface[s] ??= { cost: 0, runs: 0 }).cost += c; bySurface[s].runs += 1;
  }
  return {
    period, periodKey: periodKey(now, period), spent, budget,
    remaining: budget > 0 ? budget - spent : 0,
    runs: entries.length, tokens: { in: tin, out: tout }, byModel, bySurface,
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
export function evaluateCap(opts: { budget: number; spent: number; softNote: boolean }):
  { overBudget: boolean; alertMsg: string; creditsLow: boolean } {
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
```

- [ ] **Step 5: Run tests, confirm PASS.**
Run: `cd /app && node --test app/scripts/usage-store.test.ts`
Expected: PASS.

- [ ] **Step 6: `make check` (whole gate) then commit.**
```bash
cd /app && make check
git add app/scripts/usage-store.ts app/scripts/usage-store.test.ts app/scripts/paths.ts
git commit -m "usage: pure per-tenant ledger store (record/sum/summary/cap)"
```

---

### Task 2: Usage on the runner wire protocol (`runner-events.ts` + `runtime.ts` type)

**Files:**
- Modify: `app/scripts/harnesses/runner-events.ts` (add `UsageReport`, thread through `RunnerLine`/`RunnerOutcome`/`detectRunnerOutcome`)
- Modify: `app/scripts/runtime.ts` (add `usage?` to `HarnessOutcome`; import the type)
- Modify: `app/scripts/harnesses/runner-events.test.ts` if present, else add a test file `app/scripts/harnesses/runner-events.usage.test.ts`

**Interfaces:**
- Produces: `interface UsageReport { cost: number | null; inTok: number; outTok: number; src: "openrouter"|"local"|"custom"|"claude"; model: string }`, exported from `runner-events.ts`. `RunnerOutcome.usage?` and `HarnessOutcome.usage?` carry it.
- Consumes: `UsageEntry`/`UsageSrc` from Task 1 (only the `src` union must match).

- [ ] **Step 1: Write the failing test** `app/scripts/harnesses/runner-events.usage.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRunnerOutcome } from "./runner-events.ts";

test("detectRunnerOutcome carries a usage object off the result line", () => {
  const lines = [
    JSON.stringify({ t: "text", text: "hi" }),
    JSON.stringify({ t: "result", subtype: "success", text: "done", out_of_tokens: false, resets_at: null,
      usage: { cost: 0.014, inTok: 5100, outTok: 380, src: "openrouter", model: "claude-opus-4-8" } }),
  ];
  const o = detectRunnerOutcome(lines);
  assert.equal(o.succeeded, true);
  assert.deepEqual(o.usage, { cost: 0.014, inTok: 5100, outTok: 380, src: "openrouter", model: "claude-opus-4-8" });
});

test("no usage on the result line -> outcome.usage is undefined (a no-usage run)", () => {
  const o = detectRunnerOutcome([JSON.stringify({ t: "result", subtype: "success", text: "x" })]);
  assert.equal(o.usage, undefined);
});
```

- [ ] **Step 2: Run it, confirm FAIL** (`usage` not on the outcome).
Run: `cd /app && node --test app/scripts/harnesses/runner-events.usage.test.ts`

- [ ] **Step 3: Edit `app/scripts/harnesses/runner-events.ts`.**
Add the type (after the imports, before `RunnerLine`):

```ts
// Per-run model usage a runner reports on its terminal `result` event. `cost` is
// real USD (null when the provider gives none); `model` is the EFFECTIVE model
// actually run (post-escalation for openrouter), which runAgent's own `model`
// param does not know. Shared by every runner + both outcome decoders.
export interface UsageReport {
  cost: number | null;
  inTok: number;
  outTok: number;
  src: "openrouter" | "local" | "custom" | "claude";
  model: string;
}
```

Add `usage?: UsageReport;` to `RunnerLine` (after `resets_at`) and to `RunnerOutcome` (after `succeeded`). In `detectRunnerOutcome`, add a local `let usage: UsageReport | undefined;`, and inside the `if (e.t === "result")` block add `if (e.usage) usage = e.usage;`. Return `{ outOfTokens, resetsAt, resultText, succeeded, usage }`.

- [ ] **Step 4: Edit `app/scripts/runtime.ts`.**
Import the type near the top (type-only): add `import type { UsageReport } from "./harnesses/runner-events.ts";` (place beside the other harness imports). Add `usage?: UsageReport;` to the `HarnessOutcome` interface (after `succeeded?`).

- [ ] **Step 5: Run tests + `make check`, confirm PASS/green.**
Run: `cd /app && node --test app/scripts/harnesses/runner-events.usage.test.ts && make check`

- [ ] **Step 6: Commit.**
```bash
git add app/scripts/harnesses/runner-events.ts app/scripts/runtime.ts app/scripts/harnesses/runner-events.usage.test.ts
git commit -m "usage: carry a UsageReport on the runner result event + outcome"
```

---

### Task 3: `runAgent` — record usage, soft cap, and the required `surface` field

**Files:**
- Modify: `app/scripts/runtime.ts` (add `Surface` type + required `surface` to `RunAgentOptions`; pre-spawn cap; child-env flag; post-run record + null-cost guard)
- Modify: `app/scripts/poll.ts`, `app/scripts/discord-bot.ts` (2 sites), `app/scripts/heartbeat.ts`, `app/scripts/voice-bot.ts`, `app/scripts/tui.ts` — pass `surface:`
- Create: `app/scripts/runtime-usage.test.ts` (tests the cap wiring via an injected fake harness)

**Interfaces:**
- Consumes: `recordUsage`, `spentThisPeriod`, `creditBudgetUsd`, `evaluateCap`, `firstTimeThisPeriod` (Task 1); `HarnessOutcome.usage` (Task 2).
- Produces: `export type Surface = "mail" | "discord" | "heartbeat" | "voice" | "tui";` and `RunAgentOptions.surface: Surface` (required).

- [ ] **Step 1: Write the failing test** `app/scripts/runtime-usage.test.ts`. It injects a fake `Harness` whose `detectOutcome` returns a chosen `usage`, points the ledger at a temp dir, and asserts a ledger line is written with the right `surface`; and it drives `evaluateCap` for the cap message. (The soft-cap *decision* is already unit-tested in Task 1; here we prove `runAgent` records and threads `surface`.)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "runusage-"));
process.env.USAGE_DIR_OVERRIDE = DIR;
const RUNS = mkdtempSync(join(tmpdir(), "runs-"));

const { runAgent } = await import("./runtime.ts");
import type { Harness } from "./runtime.ts";

// A fake harness: `true` exits 0 immediately; detectOutcome returns our usage.
function fakeHarness(usage: any): Harness {
  return {
    name: "fake",
    describe: () => "fake",
    buildInvocation: () => ({ command: "true", args: [] }),
    parseEvents: () => [],
    detectOutcome: () => ({ outOfTokens: false, resetsAt: null, succeeded: true, resultText: "", usage }),
  };
}

test("runAgent records a ledger entry with the caller's surface + the runner-reported usage", async () => {
  await runAgent({
    prompt: "hi", logId: "t1", cwd: DIR, runsDir: RUNS, surface: "heartbeat",
    harness: fakeHarness({ cost: 0.02, inTok: 10, outTok: 5, src: "openrouter", model: "big-model" }),
  });
  const file = readdirSync(DIR).find((f) => f.startsWith("ledger-"))!;
  const rows = readFileSync(join(DIR, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const row = rows.find((r) => r.logId === "t1");
  assert.equal(row.surface, "heartbeat");
  assert.equal(row.model, "big-model");
  assert.equal(row.cost, 0.02);
  assert.equal(row.src, "openrouter");
});

test("a no-usage outcome still records an entry (cost null, model '')", async () => {
  await runAgent({
    prompt: "hi", logId: "t2", cwd: DIR, runsDir: RUNS, surface: "tui",
    harness: fakeHarness(undefined),
  });
  const file = readdirSync(DIR).find((f) => f.startsWith("ledger-"))!;
  const row = readFileSync(join(DIR, file), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.logId === "t2");
  assert.equal(row.cost, null);
  assert.equal(row.model, "");
});

test.after(() => { rmSync(DIR, { recursive: true, force: true }); rmSync(RUNS, { recursive: true, force: true }); });
```

- [ ] **Step 2: Run it, confirm FAIL** (`surface` not accepted / not recorded).
Run: `cd /app && node --test app/scripts/runtime-usage.test.ts`

- [ ] **Step 3: Edit `app/scripts/runtime.ts`.**

(a) Add the imports near the top:
```ts
import { recordUsage, spentThisPeriod, creditBudgetUsd, evaluateCap, firstTimeThisPeriod } from "./usage-store.ts";
import type { UsageSrc } from "./usage-store.ts";
```

(b) Export the surface union (place near `RunAgentOptions`):
```ts
export type Surface = "mail" | "discord" | "heartbeat" | "voice" | "tui";
```

(c) Add the **required** field to `RunAgentOptions` (put it right after `cwd`, so a missing arg is an obvious `tsc` error at every call site):
```ts
  surface: Surface;
```

(d) In the `runAgent` destructure, add `surface`:
```ts
export async function runAgent({ prompt, logId, cwd, surface, model, allowedTools, runsDir, receivedAt, beforeRun, env, harness, onEvent, logEvents = true, quiet = false }: RunAgentOptions): Promise<RunAgentResult> {
```

(e) After `const adapter = harness ?? ENV_ADAPTER;`, compute the soft cap and the child env, best-effort:
```ts
  // --- soft budget cap (fail-open): decide BEFORE the spawn; never blocks. ---
  let runEnv = env ?? process.env;
  try {
    const cap = evaluateCap({
      budget: creditBudgetUsd(),
      spent: spentThisPeriod(),
      softNote: process.env.BAXTER_CREDITS_SOFT_NOTE === "1",
    });
    if (cap.overBudget && firstTimeThisPeriod("alerted")) logErr(cap.alertMsg); // logErr rides the daemon's Discord log-mirror -> the operator channel; the "real channel" follow-up is now just formatting
    if (cap.creditsLow) runEnv = { ...runEnv, BAXTER_CREDITS_LOW: "1" };
  } catch (err) {
    logErr(`usage: cap check failed (${(err as Error).message})`);
  }
```

(f) Change the spawn env to use `runEnv`: replace `env: stripRunSecrets(env ?? process.env),` with `env: stripRunSecrets(runEnv),`.

(g) Replace the final `return { ...adapter.detectOutcome(rawLines), failed };` with:
```ts
  const outcome = adapter.detectOutcome(rawLines);
  // --- usage metering (best-effort; must never change the run's result). ---
  try {
    const u = outcome.usage;
    recordUsage({
      t: Date.now(), surface, logId,
      model: u?.model ?? "",
      cost: u?.cost ?? null,
      inTok: u?.inTok ?? 0,
      outTok: u?.outTok ?? 0,
      src: (u?.src ?? adapterSrc(adapter.name)) as UsageSrc,
    });
    // Null-cost guard: openrouter is the one harness that SHOULD have a cost; if
    // it doesn't, the meter is broken (usage.cost not populated) and the cap would
    // silently sit at $0. Make it loud -- once per period, so it can't flood.
    if (u && u.src === "openrouter" && u.cost == null && firstTimeThisPeriod("null-cost")) {
      logErr("usage ALERT: an openrouter run reported no cost -- is OpenRouter usage.cost populated? spend is under-tracked and the cap may never fire");
    }
  } catch (err) {
    logErr(`usage: record failed (${(err as Error).message})`);
  }
  return { ...outcome, failed };
```

(h) Add the small `adapterSrc` helper (near the other module-level helpers in `runtime.ts`) so a no-usage entry still gets a sensible `src`:
```ts
// Best-effort src for a run whose harness reported NO usage (e.g. a hard spawn
// failure with no result line). Maps the adapter's registry name to a UsageSrc.
// NB: the local adapter's registry name is "openai" (local.ts:15), not "local".
function adapterSrc(name: string): UsageSrc {
  if (name === "openai") return "local";
  return name === "openrouter" || name === "claude" ? (name as UsageSrc) : "custom";
}
```

- [ ] **Step 4: Thread `surface` into all six callers.** Add the field to each `runAgent({...})`:
  - `app/scripts/poll.ts` (~line 236): `surface: "mail",`
  - `app/scripts/discord-bot.ts` (~726 and ~780): `surface: "discord",` at both
  - `app/scripts/heartbeat.ts` (~68): `surface: "heartbeat",`
  - `app/scripts/voice-bot.ts` (~805): `surface: "voice",`
  - `app/scripts/tui.ts` (~118): `surface: "tui",`

- [ ] **Step 5: Run the test + `make check`.** `tsc` proves no caller was missed (the field is required).
Run: `cd /app && node --test app/scripts/runtime-usage.test.ts && make check`
Expected: PASS + green (any missed caller is a compile error to fix).

- [ ] **Step 6: Commit.**
```bash
git add app/scripts/runtime.ts app/scripts/poll.ts app/scripts/discord-bot.ts app/scripts/heartbeat.ts app/scripts/voice-bot.ts app/scripts/tui.ts app/scripts/runtime-usage.test.ts
git commit -m "usage: runAgent records usage + soft cap; surface now a required RunAgentOptions field"
```

---

### Task 4: Token capture on the `local` and `custom` runners

**Files:**
- Modify: `app/scripts/harnesses/local-runner.ts` (parse + emit `usage`)
- Modify: `app/scripts/harnesses/custom-runner.ts` and `app/scripts/harnesses/dialects/*` (extend `DialectResponse` with optional usage; populate per dialect)
- Modify: `app/scripts/harnesses/runner-common.ts` (`DialectResponse` type)
- Modify: `app/scripts/harnesses/local-runner.test.ts` and `custom-runner.test.ts`

**Interfaces:**
- Produces: a `usage` field on the `local`/`custom` runners' terminal `result` emit — `{ cost: null, inTok, outTok, src, model }`.

- [ ] **Step 1: local-runner failing test.** In `local-runner.test.ts`, add a case: given a stubbed `chat/completions` response that includes `usage:{prompt_tokens,completion_tokens}` and `model`, the runner's terminal `result` line carries `usage:{cost:null,inTok,outTok,src:"local",model}`. Follow the file's existing runner-spawn+parse-stdout harness (it already spawns the runner and reads JSONL); if the suite stubs `fetch`, reuse that stub, else assert on the pure response-mapping helper you extract in Step 3.

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Edit `local-runner.ts`.** Extend the parsed `ChatResponse` (`local-runner.ts:51-53`) to `{ choices?: {...}[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string }`. When emitting the terminal `result`, include:
```ts
usage: { cost: null, inTok: res.usage?.prompt_tokens ?? 0, outTok: res.usage?.completion_tokens ?? 0, src: "local", model: res.model ?? MODEL_ENV ?? "" },
```
(where `MODEL_ENV` is the runner's configured model env — use whatever the file already reads for the model). Import the `UsageReport` type only if you annotate; otherwise the inline object is fine.

- [ ] **Step 4: Edit the `custom` path.** Add `usage?: { inTok: number; outTok: number; model?: string }` to `DialectResponse` (`runner-common.ts:110-114`). In each dialect's `parseResponse` (`app/scripts/harnesses/dialects/*`), populate it from that provider's usage block (anthropic: `usage.input_tokens`/`usage.output_tokens`; openai-style: `prompt_tokens`/`completion_tokens`). In `custom-runner.ts`, on the terminal `result` emit include `usage: { cost: null, inTok: r.usage?.inTok ?? 0, outTok: r.usage?.outTok ?? 0, src: "custom", model: r.usage?.model ?? "" }`.

- [ ] **Step 5: Run both runner tests + `make check`, confirm green.**

- [ ] **Step 6: Commit.**
```bash
git add app/scripts/harnesses/local-runner.ts app/scripts/harnesses/custom-runner.ts app/scripts/harnesses/runner-common.ts app/scripts/harnesses/dialects app/scripts/harnesses/local-runner.test.ts app/scripts/harnesses/custom-runner.test.ts
git commit -m "usage: local/custom runners report token counts (cost:null)"
```

---

### Task 5: Real cost on the `claude` harness

**Files:**
- Modify: `app/scripts/harnesses/claude.ts` (`ClaudeStreamEvent` + `detectOutcome` read `total_cost_usd`/`usage`/`model`)
- Modify: `app/scripts/harnesses/claude.test.ts`

**Interfaces:**
- Produces: `ClaudeOutcome.usage = { cost: total_cost_usd ?? null, inTok, outTok, src: "claude", model }` when the terminal `result` line carries them.

- [ ] **Step 1: Failing test** in `claude.test.ts`. Feed `detectOutcome` **two** lines — the model rides the init event, NOT the result line (this is what catches the bug):
```ts
const lines = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8" }),
  JSON.stringify({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.037, usage: { input_tokens: 900, output_tokens: 120 } }),
];
assert.deepEqual(detectOutcome(lines).usage, { cost: 0.037, inTok: 900, outTok: 120, src: "claude", model: "claude-opus-4-8" });
```
Add a second case: an init line + a `result` line with no `total_cost_usd` → `usage.cost` is `null` (still an entry, model still captured).

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Edit `claude.ts`.** Extend `ClaudeStreamEvent` (`claude.ts:28-36`) with `total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number }; model?: string; subtype?: string;` (`subtype` is already present for the init discriminant — reuse it). Claude Code puts the **model on the `system`/`init` event, not the `result` line** (the repo's own fixture proves it: `claude.test.ts:69` has `{ type:"system", subtype:"init", model:"claude-sonnet-5" }` and no `model` on the result). So capture the model as the loop scans, then build usage on the result. Declare at the top of `detectOutcome`: `let usage: UsageReport | undefined; let model = "";` (import `UsageReport` from `./runner-events.ts`). In the loop, before/alongside the existing branches:
```ts
if (e.type === "system" && e.subtype === "init" && e.model) model = e.model;
```
In the `else if (e.type === "result")` success branch, set:
```ts
usage = {
  cost: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
  inTok: e.usage?.input_tokens ?? 0,   // NOTE: last-message tokens, not cumulative -- cosmetic; cost is cumulative
  outTok: e.usage?.output_tokens ?? 0,
  src: "claude",
  model,                               // captured from the init event above
};
```
Add `usage` to the returned object. **Also update the two existing full-object `deepEqual` fixtures** — `detectOutcome` currently returns exactly `{ outOfTokens, resetsAt, resultText, succeeded }` and `claude.test.ts` asserts the whole object: `:73` (success) gains `usage: { cost: null, inTok: 0, outTok: 0, src: "claude", model: "claude-sonnet-5" }` (that file's init fixture uses `claude-sonnet-5`), and `:89` (failure, no result usage) gains `usage: undefined` (strict `deepEqual` distinguishes an own `usage: undefined` key from an absent one). Otherwise Step 4 goes red on pre-existing tests, not just the new one. Confirm live that `total_cost_usd` is on the terminal `result` line and `model` on the init event (the comment records the token-is-last-message assumption).

- [ ] **Step 4: Run test + `make check`.**

- [ ] **Step 5: Commit.**
```bash
git add app/scripts/harnesses/claude.ts app/scripts/harnesses/claude.test.ts
git commit -m "usage: claude harness reports real USD cost (total_cost_usd)"
```

---

### Task 6: Per-turn usage aggregation on the openrouter runner (the careful one)

**Files:**
- Create: `app/scripts/harnesses/openrouter-usage.ts` (pure accumulator)
- Create: `app/scripts/harnesses/openrouter-usage.test.ts`
- Modify: `app/scripts/harnesses/openrouter-runner.ts` (wrap the two `getText()` sites; emit the run total + effective model)

**Interfaces:**
- Produces: `emptyAccum()`, `addTurnUsage(acc, turnUsage)`, `finalizeUsage(acc, model): UsageReport`.

- [ ] **Step 1: Pure accumulator failing test** `openrouter-usage.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyAccum, addTurnUsage, finalizeUsage } from "./openrouter-usage.ts";

test("sums three turns exactly once each (no double-count), keeps cost null until any turn has one", () => {
  const acc = emptyAccum();
  assert.equal(finalizeUsage(acc, "m").cost, null);          // nothing seen yet
  addTurnUsage(acc, { cost: 0.01, inputTokens: 100, outputTokens: 10 });
  addTurnUsage(acc, { cost: 0.02, inputTokens: 200, outputTokens: 20 });
  addTurnUsage(acc, { cost: 0.03, inputTokens: 50, outputTokens: 5 });
  const r = finalizeUsage(acc, "big-model");
  assert.ok(Math.abs(r.cost! - 0.06) < 1e-9);                // each round counted once
  assert.equal(r.inTok, 350);
  assert.equal(r.outTok, 35);
  assert.equal(r.src, "openrouter");
  assert.equal(r.model, "big-model");
});

test("a turn with no usage is ignored; token-only turns keep cost null", () => {
  const acc = emptyAccum();
  addTurnUsage(acc, undefined);
  addTurnUsage(acc, { inputTokens: 10, outputTokens: 2 }); // no cost
  const r = finalizeUsage(acc, "m");
  assert.equal(r.cost, null);
  assert.equal(r.inTok, 10);
});
```

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Write `openrouter-usage.ts`:**

```ts
// Pure per-turn usage accumulator for the openrouter runner. A run is many billed
// turns across possibly several callModel invocations (main loop + escalation
// resume + nudge); the runner feeds each turn's usage here and reports the sum.
// Pure over plain objects so the no-double-count + escalation behavior is tested
// offline (the runner can't be unit-tested against the live SDK).
import type { UsageReport } from "./runner-events.ts";

export interface TurnUsage { cost?: number | null; inputTokens?: number; outputTokens?: number }
export interface UsageAccum { cost: number; inTok: number; outTok: number; haveCost: boolean }

export function emptyAccum(): UsageAccum { return { cost: 0, inTok: 0, outTok: 0, haveCost: false }; }

export function addTurnUsage(acc: UsageAccum, u: TurnUsage | undefined | null): void {
  if (!u) return;
  if (typeof u.cost === "number" && Number.isFinite(u.cost)) { acc.cost += u.cost; acc.haveCost = true; }
  acc.inTok += u.inputTokens ?? 0;
  acc.outTok += u.outputTokens ?? 0;
}

// haveCost distinguishes "no turn ever reported a cost" (-> null, triggers the
// runtime null-cost guard) from a genuine $0.00 run.
export function finalizeUsage(acc: UsageAccum, model: string): UsageReport {
  return { cost: acc.haveCost ? acc.cost : null, inTok: acc.inTok, outTok: acc.outTok, src: "openrouter", model };
}
```

- [ ] **Step 4: Run the pure test, confirm PASS.**

- [ ] **Step 5: Wire it into `openrouter-runner.ts`.**

(a) Import at the top: `import { emptyAccum, addTurnUsage, finalizeUsage } from "./openrouter-usage.ts";`

(b) Create ONE run-scoped accumulator before the retry loop (near where `text`/`resumeInput` are set up, ~line 195): `const usageAcc = emptyAccum();`. **Critical:** a run issues *several* `callModel` results — the main `callOnce`, every context-trim/invalid/escalation resume (all through `callOnce` in the loop), **and the nudge's separate direct `client.callModel(...)` at ~`:305`** which bypasses `callOnce`. Each resume/nudge re-bills the whole history and is the priciest part of a run, so **every one of those results must feed this same `usageAcc`** — that's why Step 5d wraps *both* `getText()` sites (the loop's `:226` and the nudge's `:314`), not just the primary call. Summing across resumes is correct accounting (each is a real additional billed call), not double-counting.

(c) Add the isolated capture wrapper (module-level function, or a local `const`):
```ts
// Drive a ModelResult to text WHILE summing per-turn usage off its full-response
// stream. The SDK broadcaster does NOT replay, so start iterating the stream
// BEFORE awaiting getText() (a consumer created after getText resolves sees
// nothing). Fully isolated: any stream error is swallowed, and getText's
// result/exception propagate EXACTLY as before -- metering can't touch the run's
// control flow or its duplicate-send guards. A 2s drain cap guarantees the run
// never hangs on metering.
async function getTextWithUsage(
  result: { getText(): Promise<string>; getFullResponsesStream(): AsyncIterable<unknown> },
  acc: ReturnType<typeof emptyAccum>,
): Promise<string> {
  const summing = (async () => {
    try {
      for await (const ev of result.getFullResponsesStream()) {
        // Gate on the per-turn completed-response event. CONFIRM the exact
        // discriminant against @openrouter/agent (e.g. ev.type === "response.completed"
        // or the SDK's isResponseCompletedEvent); the pure sum is already tested.
        const resp = (ev as { type?: string; response?: { usage?: unknown } });
        if (resp?.type === "response.completed" && resp.response?.usage) {
          addTurnUsage(acc, resp.response.usage as { cost?: number | null; inputTokens?: number; outputTokens?: number });
        }
      }
    } catch { /* usage is best-effort; never disturb the run */ }
  })();
  try {
    return await result.getText();
  } finally {
    // Drain remaining buffered turns, but never let metering hang the run: cap the
    // wait at 2s with an unref'd timer (won't keep the process alive).
    await Promise.race([summing, new Promise((r) => { const h = setTimeout(r, 2000); (h as { unref?: () => void }).unref?.(); })]);
  }
}
```

(d) Replace the two `.getText()` call sites with the wrapper:
- `openrouter-runner.ts:226` `text = await callOnce(resumeInput).getText();` → `text = await getTextWithUsage(callOnce(resumeInput), usageAcc);`
- `openrouter-runner.ts:314` `const nudgedText = await nudged.getText();` → `const nudgedText = await getTextWithUsage(nudged, usageAcc);`

(e) Add `usage` to the terminal emits. At the success emit (`openrouter-runner.ts:347`):
```ts
emit({ t: "result", subtype: "success", text: text ?? "", out_of_tokens: false, resets_at: null, usage: finalizeUsage(usageAcc, String(model)) });
```
At the out-of-tokens emit (~`:359`), include the same `usage: finalizeUsage(usageAcc, String(model))` (partial spend still counts). `model` here is the outer, post-escalation binding — that's the effective model.

- [ ] **Step 6: Run the whole harness suite + `make check`.**
Run: `cd /app && node --test app/scripts/harnesses/ && make check`
Expected: green. (The runner integration is covered by the existing openrouter runner tests plus the pure accumulator test; do not add a live-SDK test.)

- [ ] **Step 7: Live-verification note (do, don't skip).** Before trusting the ledger, confirm on a real run that an openrouter run records a **non-null** `cost` (tail `STATE_DIR/usage/ledger-*.jsonl`, or run `usage-cli show` after Task 7). If cost is null, the null-cost guard from Task 3 will have logged the loud line — resolve the `usage.cost` opt-in (`usage:{include:true}` or the Responses-API equivalent) before relying on the cap.

- [ ] **Step 8: Commit.**
```bash
git add app/scripts/harnesses/openrouter-usage.ts app/scripts/harnesses/openrouter-usage.test.ts app/scripts/harnesses/openrouter-runner.ts
git commit -m "usage: openrouter runner sums per-turn cost via getFullResponsesStream; reports effective model"
```

---

### Task 7: Reporting — `usage-cli`, `/usage` TUI verb, Dockerfile shim

**Files:**
- Create: `app/scripts/usage-cli.ts`
- Create: `app/scripts/usage-cli.test.ts`
- Modify: `app/scripts/tui-core.ts` (`SLASH_TOOLS.usage`, `SLASH_TOOL_DEFAULT.usage`)
- Modify: `app/Dockerfile` (PATH shim)

**Interfaces:**
- Consumes: `summary`, `creditBudgetUsd` (Task 1).

- [ ] **Step 1: Failing test** `usage-cli.test.ts`: point `USAGE_DIR_OVERRIDE` at a temp dir, `recordUsage` a couple of entries via the store, spawn `node app/scripts/usage-cli.ts json` (inherit env), and assert the parsed stdout has `spent`, `byModel`, `bySurface`. Then run `usage-cli show` and assert the stdout matches `/spent:/`.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolve the CLI relative to THIS test file (repo isn't always at /app -- CI
// checks out elsewhere) and run it with the same node. No cwd. Mirrors
// calendar-cli.test.ts / memory-cli.test.ts.
const CLI = fileURLToPath(new URL("./usage-cli.ts", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "usagecli-"));
const env = { ...process.env, USAGE_DIR_OVERRIDE: DIR, BAXTER_CREDIT_BUDGET_USD: "5" };
process.env.USAGE_DIR_OVERRIDE = DIR;
const { recordUsage } = await import("./usage-store.ts");
recordUsage({ t: Date.now(), surface: "discord", model: "m", cost: 0.5, inTok: 10, outTok: 2, src: "openrouter", logId: "a" });

test("usage-cli json emits the summary shape", () => {
  const out = execFileSync(process.execPath, [CLI, "json"], { env, encoding: "utf8" });
  const s = JSON.parse(out);
  assert.equal(s.budget, 5);
  assert.ok(Math.abs(s.spent - 0.5) < 1e-9);
  assert.ok(s.byModel.m && s.bySurface.discord);
});

test("usage-cli show renders a spent line; bare (no arg) defaults to show", () => {
  const out = execFileSync(process.execPath, [CLI], { env, encoding: "utf8" });
  assert.match(out, /spent:/);
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
```

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Write `usage-cli.ts`** (thin, per the spec's Reporting section):

```ts
// Per-tenant usage report. `usage show` (also bare /usage) prints spend vs budget
// + breakdowns; `usage json` emits the machine-readable summary the operator's
// `baxctl usage` rolls up across tenants. Thin shell over usage-store.ts.
import { summary, creditBudgetUsd } from "./usage-store.ts";

function fmt(n: number): string { return `$${n.toFixed(2)}`; }

function show(): void {
  const s = summary(Date.now(), creditBudgetUsd());
  console.log(`usage (${s.periodKey}, per ${s.period}):`);
  console.log(`  spent:   ${fmt(s.spent)}${s.budget > 0 ? ` / ${fmt(s.budget)}` : "  (no budget set)"}`);
  if (s.budget > 0) console.log(`  ${s.remaining >= 0 ? "remain:  " : "OVER by: "}${fmt(Math.abs(s.remaining))}`);
  console.log(`  runs:    ${s.runs}    tokens: ${s.tokens.in} in / ${s.tokens.out} out`);
  const byModel = Object.entries(s.byModel).sort((a, b) => b[1].cost - a[1].cost);
  if (byModel.length) { console.log("  by model:"); for (const [m, v] of byModel) console.log(`    ${m}  ${fmt(v.cost)}  (${v.runs})`); }
  const bySurface = Object.entries(s.bySurface).sort((a, b) => b[1].cost - a[1].cost);
  if (bySurface.length) { console.log("  by surface:"); for (const [su, v] of bySurface) console.log(`    ${su}  ${fmt(v.cost)}  (${v.runs})`); }
}

function main(argv: string[]): void {
  const cmd = argv[0] || "show";
  if (cmd === "json") { console.log(JSON.stringify(summary(Date.now(), creditBudgetUsd()), null, 2)); return; }
  if (cmd === "show") { show(); return; }
  console.error("usage: usage-cli [show|json]");
  process.exit(1);
}

main(process.argv.slice(2));
```

- [ ] **Step 4: Wire the TUI verb.** In `app/scripts/tui-core.ts`, add to `SLASH_TOOLS` (after `invisible`): `usage: ["usage-cli"],`. Add to `SLASH_TOOL_DEFAULT`: `usage: ["show"],`.

- [ ] **Step 5: Add the Dockerfile shim.** In `app/Dockerfile`, next to the `schedule-cli` shim (~line 273), add:
```dockerfile
# `usage-cli` on PATH -> the run's per-tenant model-spend report (`/usage`).
RUN printf '#!/bin/sh\nexec node /app/scripts/usage-cli.ts "$@"\n' \
      > /usr/local/bin/usage-cli \
    && chmod +x /usr/local/bin/usage-cli
```

- [ ] **Step 6: Run the CLI test + `make check`.**
Run: `cd /app && node --test app/scripts/usage-cli.test.ts && make check`

- [ ] **Step 7: Commit.**
```bash
git add app/scripts/usage-cli.ts app/scripts/usage-cli.test.ts app/scripts/tui-core.ts app/Dockerfile
git commit -m "usage: usage-cli + /usage TUI verb + Dockerfile PATH shim"
```

---

### Task 8: Docs + `.env.example`

**Files:**
- Modify: `app/.env.example`
- Create: `app/docs/architecture/usage-metering.md` (short) and link it from the architecture index if one exists
- Modify: `app/scripts/harnesses/CLAUDE.md` (one line: runners now report `usage` on the result event)

- [ ] **Step 1: `.env.example`.** Add a commented block:
```
# --- Per-tenant model-usage metering (credits) ---
# Monthly USD budget. Unset/0 = tracking-only (record spend, no cap, no alert).
# Over budget: the run STILL proceeds (fail-open) + a loud operator log line.
# BAXTER_CREDIT_BUDGET_USD=15
# Reset/rotation period: month (default) or day. Effectively set-once per deploy.
# BAXTER_CREDIT_PERIOD=month
# 1 = when over budget, set BAXTER_CREDITS_LOW=1 in the run so Baxter can add a
# soft "low on credits" note. Default (unset) = alert-only, no user-visible change.
# BAXTER_CREDITS_SOFT_NOTE=0
```

- [ ] **Step 2: `usage-metering.md`.** A short doc: what the ledger is (`STATE_DIR/usage/ledger-<period>.jsonl`, per-tenant, lock-free append), how cost is sourced per harness (openrouter/claude real USD; local/custom tokens-only), the soft-cap fail-open behavior + the alert-as-log-line seam (top follow-up: a real channel), the three env knobs, `usage-cli show|json` and bare `/usage`, and that `baxctl usage` (in `baxter-control`) rolls up `usage json` across tenants. Note the null-cost guard and the live cost-verification step.

- [ ] **Step 3: `harnesses/CLAUDE.md`.** One line under the wire-protocol/result-event description: the terminal `result` event now optionally carries a `usage` object (cost/tokens/effective-model/src) consumed by `runAgent`'s metering.

- [ ] **Step 4: `make check` (docs don't break it, but confirm) + commit.**
```bash
git add app/.env.example app/docs/architecture/usage-metering.md app/scripts/harnesses/CLAUDE.md
git commit -m "usage: document metering (env knobs, ledger, /usage, alert seam)"
```

---

## Self-Review (completed while writing)

- **Spec coverage:** ledger (T1), soft cap + fail-open + debounce + null-cost guard (T1 pure + T3 wiring), USD from openrouter (T6) / claude (T6→T5) / tokens-only local/custom (T4), surface + effective-model threading (T3/T6), `/usage` + json contract + Dockerfile shim (T7), config knobs + docs (T8). The `getFullResponsesStream`-primary capture with the ordering caveat is T6; the `stopWhen` fallback is documented in the spec and intentionally not implemented unless T6's stream approach fails live (noted in T6 Step 5c).
- **Type consistency:** the `src` union `"openrouter"|"local"|"custom"|"claude"` is identical in `UsageReport` (runner-events), `UsageSrc` (usage-store), and every emit. `UsageReport` is defined once (runner-events) and imported everywhere. `Surface` defined once (runtime), imported by callers via the required field.
- **No placeholders:** every code step carries real code; the two "confirm against the SDK/live" items (T6 completed-event discriminant, T5/T6 cost-populated) are genuine verification steps with a tested pure fallback, not deferred work.
- **Sequencing:** each task leaves `make check` green; the required-`surface` change and its six callers land together in T3 so `tsc` never breaks mid-task.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-31-usage-metering.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, task review (spec + quality) between tasks, broad review at the end.

**2. Inline Execution** — execute the tasks in this session with checkpoints.

**Which approach?**
