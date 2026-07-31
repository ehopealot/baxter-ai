# Per-tenant model-usage metering ("credits")

**Goal:** Record how much each tenant spends on model usage (real USD from
OpenRouter), expose it per-tenant and to the operator, and enforce a **soft**
monthly budget — fail-open with a loud operator alert, never dropping a
customer's message.

## Background

Baxter is hosted multi-tenant as **container-per-tenant**: one compose stack
per customer, parameterized by `TENANT_ENV` (the per-tenant secrets/config
file) and `TENANT_STATE` (a per-tenant named volume mounted at `/home/node`).
`STATE_DIR` (`/home/node/.mail-agent`, `paths.ts`) therefore already isolates
all persisted state per tenant automatically — a file written to `STATE_DIR`
is a per-tenant file with no extra work.

Every surface (mail `poll.ts`, `discord-bot.ts`, `heartbeat.ts`, `voice`,
`tui.ts`) spawns a run through the single chokepoint **`runAgent`
(`runtime.ts`)**. The runner runs as a child process speaking a line-delimited
JSONL protocol (`runner-events.ts`); the terminal event is
`{ t:"result", … }`.

**Real cost appears available and is currently discarded — but the SDK
accessor matters.** The default harness (`openrouter-runner.ts`) uses the
`@openrouter/agent` SDK and reads only `getText()`. Two subtleties, both
verified against the vendored SDK, shape the capture design:

- **`getResponse()` returns only the *final* turn**, not an aggregate. It
  returns `this.finalResponse`, reassigned to the latest `currentResponse`
  each round (`model-result.js:352`, `:267`). A Baxter run is a tool loop of
  up to `OPENROUTER_MAX_STEPS` billed requests, each re-billing the whole
  history — so summing one `getResponse().usage` per call captures only the
  last turn and **systematically undercounts**. Per-turn usage lives in
  `allToolExecutionRounds`, exposed publicly as (a) the `steps[].usage` a
  `stopWhen` closure receives, and (b) each turn's completed-response event
  from `getFullResponsesStream()` — which is exactly what the SDK's own
  `maxCost`/`maxTokensUsed` stop conditions sum over (`stop-conditions.js:66`,
  `:74`). Capture must aggregate per turn (see § Capturing usage).
- **`cost` is optional and may need opt-in.** The `Usage` type marks
  `cost?: number | null`, and OpenRouter's chat API only returns `cost` when
  the request opts in (`usage: { include: true }`); the Responses-request type
  shows no such flag, so whether `cost` is populated here is **unverified in
  repo and must be confirmed live** before the ledger is trusted.

The `local`/`custom` runners hit raw OpenAI-style endpoints whose responses
include a `usage` token object the code currently parses away; those endpoints
do **not** return a dollar cost. The **`claude` harness** (`claude.ts`, an
opt-in `BAXTER_HARNESS=claude`) is a *fourth* run path whose `detectOutcome`
already scans the `claude -p` stream-json lines — whose terminal `result` line
carries `total_cost_usd` **and** a `usage` object, i.e. real USD cost for free.

There is **no runtime tenant-id env var**; the closest identifier is
`OPERATOR_EMAIL`. Because state is physically per-tenant, metering needs no
tenant id: each container meters itself.

## Decisions (locked)

1. **Behavior:** track + **soft cap**. Over budget ⇒ the run still proceeds,
   plus a loud operator alert (debounced once per period). Never a hard drop.
2. **Unit:** **USD**, from OpenRouter's `usage.cost`. Model-agnostic real spend.
3. **Aggregation:** **local file per tenant + pull.** Each container keeps its
   own ledger in `STATE_DIR`; the operator rolls up across tenants on demand
   via `baxctl usage` (which ssh-runs `usage-cli json` per container). No
   central DB, no per-run network egress. This spec covers the per-tenant
   side; the `baxctl` rollup lives in the separate `baxter-control` repo and
   consumes the `usage-cli json` contract defined here.
4. **Reset period:** calendar **month, UTC** (configurable to `day`).
5. **v1 cost source:** OpenRouter only. Local/custom runs record **tokens**
   with `cost: null`. The budget therefore binds meaningfully on the default
   (OpenRouter) harness. A token→USD rate table for the other harnesses is a
   follow-up.
6. **Alert channel v1:** a distinctive operator-facing **log line**
   (`console.error`), the same mechanism `moderation.ts` and `home-mirror.ts`
   already use, surfaced via `ssh baxbox docker logs` / the log-shipper. The
   alert is delivered through an **injectable `alert(msg)` seam** (as in
   `home-mirror.ts`) so a future real channel (Discord DM / email to the
   operator) drops in without touching call sites. **This is the top
   follow-up.**

## Data model — the ledger

One append per run to a **monthly-rotated** JSONL file:

```
STATE_DIR/usage/ledger-<YYYY-MM>.jsonl        # or ledger-<YYYY-MM-DD> when period=day
```

Each line:

```jsonc
{
  "t": 1753900000000,          // epoch ms (run completion)
  "surface": "discord",        // mail | discord | heartbeat | voice | tui
  "model": "claude-opus-4-8",  // the model actually run (override-aware)
  "cost": 0.0142,              // USD; null when the harness reports no cost
  "inTok": 5100,               // input/prompt tokens (0 if unknown)
  "outTok": 380,               // output/completion tokens (0 if unknown)
  "src": "openrouter",         // openrouter | local | custom | claude  (provenance of the numbers)
  "logId": "20260731-…"        // ties back to the raw run log for audit
}
```

- **Append is best-effort and lock-free** — the `access-log.ts` pattern
  (`appendFileSync` relying on O_APPEND atomicity). Metering must never throw
  into, block, or slow a run: any failure is swallowed after a single
  `console.error`.
- **No lossy compaction.** `access-log.ts` folds keep-latest; a billing ledger
  must *sum*, so we never fold-drop. Size is bounded by monthly rotation
  instead: one line ≈150 bytes, so even 10k runs/month ≈1.5 MB, and old months
  remain on disk for audit. Reporting reads only the current period's file.
- **Rotation** is implicit in the filename: the period key (`YYYY-MM`, or
  `YYYY-MM-DD` when `period=day`) is computed from the entry timestamp in UTC.

## Capturing usage (runner → runtime)

The runner child must report usage on the terminal `result` event.

- **`runner-common.ts` / `runner-events.ts`:** the `result` line gains an
  optional field:

  ```ts
  usage?: {
    cost: number | null;   // USD, or null if the harness has no cost
    inTok: number;
    outTok: number;
    src: "openrouter" | "local" | "custom" | "claude";
  }
  ```

- **`openrouter-runner.ts`:** a run is a tool loop of many billed turns, and
  **`getResponse().usage` is only the final turn** (`model-result.js:352`) — so
  it must NOT be the accumulator, or spend is undercounted. Aggregate **per
  turn** via a public SDK surface, in order of preference:
  1. **Usage-recording `stopWhen` closure (primary).** Add a `stopWhen` entry
     (alongside the existing `STOP_WHEN`) that, on each evaluation, sums
     `steps[].usage` (`cost`/`inputTokens`/`outputTokens`) into a run-scoped
     accumulator and **always returns `false`**. This reuses the exact
     `steps[].usage` the SDK's own `maxCost` reads. **Caveat:** stop conditions
     may not be evaluated after the terminal no-tool-call turn, so add that
     final turn separately from `getResponse().usage`.
  2. **`getFullResponsesStream()` (alternative).** Consume it concurrently with
     `getText()` (the SDK permits concurrent consumers) and sum `usage` off each
     turn's completed-response event — this already includes the final turn, no
     separate add.

  Emit the run total on the `result` event with `src:"openrouter"`. Reading
  usage degrades to `cost:null` / zero tokens on any error, never breaking the
  run — **but** an `src:"openrouter"` entry landing with `cost:null` means the
  one harness that *should* report cost didn't; treat it as loud, not silent
  (see § The soft cap, null-cost guard).

- **`local-runner.ts` / `custom-runner.ts`:** capture the response `usage`
  token counts (currently discarded), emit `cost:null`, `src:"local"|"custom"`.
  No dollar cost is available from these endpoints in v1.

- **`claude.ts` (the `BAXTER_HARNESS=claude` path):** `detectOutcome` already
  scans the `claude -p` stream-json lines; read `total_cost_usd` and the
  `usage` object off the terminal `result` line and surface them as
  `src:"claude"` (real USD cost, no runner change needed beyond reading two
  fields already in scope).

- **`runtime.ts` `runAgent`:** the outcome carries `usage` through
  `detectOutcome`; after the run, `runAgent` calls
  `recordUsage(entry)` with the surface, model, `logId`, timing, and the usage.
  Recording is wrapped best-effort. **`recordUsage` always writes an entry** —
  a run whose harness reported no usage records `cost:null` with zero tokens,
  **not** nothing — so run counts stay complete across every harness (a
  missing-usage harness shows up as runs with `$0`, never as an invisible gap).

## The soft cap (in `runAgent`)

`runAgent` is the one place that sees every run. Around the spawn:

1. **Before spawn** (only when `BAXTER_CREDIT_BUDGET_USD` > 0):
   - `over = spentThisPeriod(now) >= BUDGET`.
   - If `over` and this period has not yet alerted →
     `alert("usage ALERT: tenant over $<budget> budget (spent $<n> of $<budget> this <period>) -- still serving, fail-open")`.
     Debounce via a tiny sentinel: an `alerted-<periodKey>` marker file in
     `STATE_DIR/usage/` (create-once with `wx`), so the alert fires **once per
     period crossing**, not every run.
   - If `over` **and** `BAXTER_CREDITS_SOFT_NOTE=1` → set child env
     `BAXTER_CREDITS_LOW=1`, letting the run optionally prepend a soft
     "low on credits" note (gated; default off = alert-only, no user-visible
     change).
   - **The run always proceeds** regardless of budget.
2. **After the run:** `recordUsage(...)` (best-effort).

`spentThisPeriod` sums `cost` over the current period's ledger file (null costs
contribute 0). Budget is unset/0 ⇒ metering still records, but no cap logic and
no alert run (pure tracking mode).

**Null-cost guard (don't let a broken meter fail silently).** The degrade path
where `cost:null` contributes 0 is safe for harnesses that genuinely lack cost
(`local`/`custom`), but dangerous for `openrouter`, the one harness that is
*supposed* to report cost: if OpenRouter isn't populating `cost` (the
unverified opt-in from § Background), the ledger fills with `null`,
`spentThisPeriod` stays `$0` forever, and the soft cap never fires while
looking fully configured. So: when `recordUsage` writes an entry with
`src:"openrouter"` **and** `cost == null`, emit the distinctive
`console.error` through the same `alert` seam. A verification step —
confirm live that `getResponse()`/stream usage actually carries a non-null
`cost` — is a prerequisite of the implementation plan, not an afterthought.

The `alert` function is an **injected dependency** (defaulting to
`console.error`) so tests capture it and a future channel replaces it centrally.

## Config knobs (per-tenant `TENANT_ENV` file)

| Var | Default | Meaning |
|---|---|---|
| `BAXTER_CREDIT_BUDGET_USD` | unset/`0` | Monthly (or daily) budget in USD. **0/unset ⇒ tracking-only**: record spend, no cap, no alert. Master switch. |
| `BAXTER_CREDIT_PERIOD` | `month` | `month` \| `day`. Sets both the reset boundary and the ledger rotation. |
| `BAXTER_CREDITS_SOFT_NOTE` | `0` | `1` ⇒ when over budget, set `BAXTER_CREDITS_LOW=1` so the run prepends a soft heads-up. |

All read via the existing `envInt`/env conventions. `USAGE_DIR_OVERRIDE` (test
redirect, mirroring `SCHEDULE_DIR_OVERRIDE`/`SEND_STATE_DIR_OVERRIDE`) points
the ledger at a temp dir.

## Reporting surface

**`usage-store.ts`** (pure, tested) — the core:
- `recordUsage(entry, now?)` — best-effort append to the period file.
- `spentThisPeriod(now?)` → `number` (USD).
- `summary(now?)` → `{ period, spent, budget, remaining, byModel, bySurface, runs, tokens }`.
- period-key math in UTC (reuse existing `tz`/UTC helpers where present).

**`usage-cli.ts`** (thin I/O shell over the store):
- `usage show` (also the **bare `/usage`** default) — human table: period,
  spent / budget / remaining, breakdown by model and by surface.
- `usage json` — machine-readable `summary()` for the operator rollup. **This
  is the stable contract `baxctl usage` consumes.**

**TUI wiring:** `SLASH_TOOLS.usage = ["usage-cli"]` in `tui-core.ts`, with
`usage` in the bare-lists map so a bare `/usage` runs `show`. `baxter shell` →
`/usage` then works with no extra plumbing.

## Files

**Create:**
- `app/scripts/usage-store.ts` — pure core (record/sum/summary/period math).
- `app/scripts/usage-cli.ts` — thin CLI.
- `app/scripts/usage-store.test.ts`, `app/scripts/usage-cli.test.ts`.

**Modify:**
- `app/scripts/paths.ts` — `USAGE_DIR` + `USAGE_DIR_OVERRIDE`.
- `app/scripts/harnesses/runner-events.ts` — optional `usage` on the result line.
- `app/scripts/harnesses/openrouter-runner.ts` — accumulate per-turn usage
  (usage-recording `stopWhen` closure or `getFullResponsesStream`), emit total.
- `app/scripts/harnesses/local-runner.ts`, `custom-runner.ts` — capture tokens, `cost:null`.
- `app/scripts/harnesses/claude.ts` — read `total_cost_usd`/`usage` off the
  terminal stream-json result line in `detectOutcome`; surface as `src:"claude"`.
- `app/scripts/runtime.ts` — over-budget eval (injected `alert`, debounce) +
  `recordUsage` (always writes an entry) + the openrouter null-cost guard.
- `app/scripts/tui-core.ts` — `/usage` slash verb + bare-list.
- `app/.env.example` — the three knobs.
- `app/docs/architecture/*.md` — a short "usage metering" section.
- Runner usage-capture assertions in `local-runner.test.ts` and
  `claude.test.ts`; over-budget/alert-debounce + null-cost-guard test for the
  runtime seam.

## Testing

- **usage-store:** append then sum; multiple entries sum correctly; `null` cost
  contributes 0; `recordUsage` writes an entry even with no usage (run count
  intact); period rollover puts entries in the right file and `spentThisPeriod`
  ignores prior periods; `summary` breakdowns by model and surface; best-effort
  append swallows a write error without throwing.
- **cap logic (pure seam):** over-budget fires `alert` exactly once per period
  (debounce), never blocks the run, sets `BAXTER_CREDITS_LOW` only when
  `SOFT_NOTE=1`; budget 0/unset ⇒ no alert, still records; an `src:"openrouter"`
  entry with `cost:null` fires the null-cost guard `alert`, while `local`/
  `custom`/`claude` nulls do not.
- **runner capture:** openrouter result carries usage summed **across multiple
  turns** (a two-turn fixture must total both, proving it's not just the final
  turn); local/custom carry tokens with `cost:null`; claude carries
  `total_cost_usd`/`usage` from the result line as `src:"claude"`.
- **cli:** `show` renders period/spent/budget/remaining + breakdowns; `json`
  emits the documented shape; bare `/usage` ⇒ `show`.

## Non-goals / follow-ups

- **Route the alert to a real channel** (operator Discord DM / email) — the
  `alert` seam exists precisely for this; **top follow-up.**
- Hard cap (blocking a run) — chose soft.
- Control-plane push / live central dashboard — chose pull.
- Token→USD rate table for `local`/`custom` harnesses (v1 real cost = the
  OpenRouter and `claude` harnesses; `local`/`custom` are tokens-only).
- `baxctl usage` cross-tenant rollup — lives in `baxter-control`, consumes
  `usage-cli json`.
- Per-user-within-a-tenant attribution — tenant-level only.
