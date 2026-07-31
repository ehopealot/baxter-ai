# Per-tenant usage metering ("credits")

(part of Baxter — see [architecture map](../../CLAUDE.md))

Records how much each tenant spends on model usage, exposes it, and enforces a
**soft** (fail-open) monthly USD budget. Design spec:
`docs/superpowers/specs/2026-07-31-usage-metering-design.md` (repo root).

## The ledger

Every run appends one best-effort JSONL line to a **monthly-rotated**, per-tenant
ledger in `STATE_DIR` (`~/.mail-agent/usage/ledger-<YYYY-MM>.jsonl`, or
`-<YYYY-MM-DD>` when `BAXTER_CREDIT_PERIOD=day`). Because `STATE_DIR` is the
per-tenant config volume, the ledger is automatically per-tenant — no tenant id
needed. Fields: `t, surface, model, cost, inTok, outTok, src, logId`.

- **Best-effort:** `recordUsage` (in `scripts/usage-store.ts`) never throws into,
  blocks, or slows a run — a failure is one `console.error` and swallowed.
- **Lock-free append** (the `access-log.ts` pattern): several surface *containers*
  of one tenant share the config volume and append the file concurrently; each
  line is one `appendFileSync` of the whole line, which the local fs serializes
  per-inode, and the free-form `model`/`logId` fields are length-clamped.
- **No lossy compaction** — a billing ledger must sum, so months accumulate on
  disk; reporting reads only the current period's file.

## Where cost comes from (per harness)

Cost is **real USD**; a harness that reports no dollar cost records `cost:null`
(tokens still recorded, so run counts stay complete):

- **openrouter** (default): `openrouter-runner.ts` sums `usage.cost` across every
  billed turn of the run — main loop, resumes, and the nudge's separate call —
  via `getFullResponsesStream` (`openrouter-usage.ts` is the pure accumulator).
  Reports the effective post-escalation model.
- **claude** (`BAXTER_HARNESS=claude`): `claude.ts` `detectOutcome` reads
  `total_cost_usd` (cumulative real USD) + summed cache/input/output tokens off
  the terminal stream-json result line; model off the `system/init` event.
- **openai/custom**: token counts only (`cost:null`) — a raw chat/completions or
  keyed LLM API returns no price. Custom tokens come from each dialect's
  `parseResponse`.

The runner reports usage on its terminal `result` event (`UsageReport` in
`runner-events.ts`); the single chokepoint `runAgent` (`runtime.ts`) reads it and
calls `recordUsage`. Metering is **openrouter/claude for real cost**; a
token→USD rate table for openai/custom is a follow-up.

## The soft cap (fail-open)

Before each spawn, `runAgent` reads the period's spend and, if
`BAXTER_CREDIT_BUDGET_USD > 0` and spend ≥ budget:

- emits a loud operator alert via `logErr` — which rides the daemon's **Discord
  log-mirror** (the operator channel) — **debounced once per period** by a `wx`
  sentinel marker in `STATE_DIR/usage/`;
- optionally (`BAXTER_CREDITS_SOFT_NOTE=1`) sets child env `BAXTER_CREDITS_LOW=1`
  so the run can prepend a soft "low on credits" note.

**The run always proceeds** — never a hard drop. Budget unset/0 ⇒ tracking-only.
A **null-cost guard** additionally fires (once per period, same mechanism) if an
`openrouter` run records `cost:null` — the one harness that *should* have a cost,
so a broken meter is loud rather than silently leaving the cap at $0.

The alert is a log line in v1; the `logErr` seam is the swap point for a
dedicated channel (the top follow-up).

## Reporting

- **`usage-cli show`** (also bare **`/usage`** in the TUI) — this tenant's period
  spend / budget / remaining + by-model and by-surface breakdowns.
- **`usage-cli json`** — the machine-readable `summary()`; the stable contract the
  operator's cross-tenant `baxctl usage` rollup (in `baxter-control`) consumes by
  ssh-running it per container.

## Config knobs

`BAXTER_CREDIT_BUDGET_USD` (unset/0 = tracking-only), `BAXTER_CREDIT_PERIOD`
(`month`|`day`), `BAXTER_CREDITS_SOFT_NOTE` (`0`/`1`) — all in the per-tenant
`TENANT_ENV` file; documented in `.env.example`. `USAGE_DIR_OVERRIDE` redirects
the ledger for tests (and isolates eval runs from the real tenant ledger).
