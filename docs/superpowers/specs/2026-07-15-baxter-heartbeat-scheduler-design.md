# Baxter Heartbeat Scheduler — Design Spec

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan
**Component:** `app/` (the "Baxter Burgundy" agent)

## Goal

Give Baxter the ability to **act on a schedule, unprompted** — run a task at a future time or on a recurring cadence, deliver the result to Discord or email, and repeat or retire the task afterward. Baxter only ever *edits the schedule* (add/cancel tasks); a dedicated driver does the firing. This is the "acts on its own" capability (heartbeat) that a standing assistant needs for reminders, periodic summaries, and checks.

## Non-goals

- **Baxter does not run the driver or fire tasks.** He mutates the schedule through a scoped CLI; the driver is separate.
- **No sub-minute precision.** The driver ticks about once a minute; a task fires on the first tick at/after its due time.
- **No general workflow engine** — no dependencies between tasks, no fan-out, no conditional branching. One task = one description + when + where to deliver.
- **No new surfaces.** Delivery is Discord or email (the two Baxter already has); a task can also deliver nowhere (internal task, logged only).

## Approach

The heartbeat is structurally identical to the existing `poll.mjs` (a long-running node daemon that fires `claude -p` runs on an interval), so the driver is a **node daemon loop**, not OS cron: `while (true) { await tick(now); await sleep(interval) }`. This reuses the codebase's pattern, needs no cron install/process-manager, is unit-testable (call `tick()` directly), and handles overlap naturally (a slow tick just delays the next scan; the invisibility window still protects a long run). Crash-resilience comes from the container's `--restart unless-stopped`.

Timing supports both **recurring (cron)** and **one-shot (`at` timestamp)** tasks. Next-run computation for cron uses the small, well-tested **`cron-parser`** dependency (hand-rolling cron is error-prone).

## Architecture

### `make heartbeat` — the dedicated driver service
A new detached container (`--restart unless-stopped`), **same image** as the app, with `app/.env` (both tokens), the config volume, and the shared network (so a fired run can reach codapi and the internet). Entry point: `scripts/heartbeat.mjs`. **Single instance** — exactly one driver, so no two drivers ever fire the same task. It fires runs via the existing `runtime.mjs` `runClaude`, exactly as `poll.mjs`/`discord-bot.mjs` do (same stream-json logging, out-of-tokens handling, token-stripping boundary).

### The schedule file
`~/.mail-agent/schedule/schedule.json` — a JSON array of tasks on the config volume, shared with the Discord/email runs. Each task:
```json
{
  "id": "a1b2c3",                       // short random id
  "task": "summarize this week's activity",
  "cron": "0 17 * * 5",                 // recurring; XOR `at`
  "at": null,                           // one-shot ISO timestamp; XOR `cron`
  "tz": "America/New_York",             // IANA zone the cron (and a naive `at`) is read in; null when --tz omitted (HEARTBEAT_TZ fallback applied at compute time)
  "deliver": { "surface": "discord", "target": "<channelId>" },  // or {surface:"gmail",target:"<email>"}, or null
  "next_run_at": "2026-07-17T21:00:00Z",// computed due time (absolute UTC)
  "invisible_until": null,              // visibility-window claim (ISO) or null
  "attempts": 0,                        // failed-fire counter
  "created_at": "2026-07-15T…"
}
```

### `schedule-cli` — Baxter's boundary to the schedule
`scripts/schedule-cli.mjs`, installed on PATH (Dockerfile shim, like `discord-cli`/`code-cli`). Baxter's **only** way to touch the schedule — he never raw-edits the file. Commands:
- `schedule-cli add "<task>" (--cron "<expr>" | --at "<ISO>") [--tz <IANA zone>] [--discord <channelId> | --email <address>]` — validates exactly one of cron/at and at most one delivery target, **enforces the schedule limits** (min recurrence interval, max task count — see Security posture), resolves the schedule into an absolute `next_run_at`, stores `tz` **as given** (null when `--tz` was omitted — the `HEARTBEAT_TZ` fallback is applied at *compute* time, so changing it later affects future reschedules of fallback tasks), and prints the new task's id. (An `--at` carrying an offset/`Z` is absolute; a naive `--at` and every `--cron` are read in the task's `tz` or the fallback.)
- `schedule-cli cancel <id>` — removes a task.
- `schedule-cli list` — prints the current tasks (id, task, schedule, next run, delivery) as JSON.
All mutations go through the shared lock + atomic write (see Concurrency).

**Timezone is the requester's** (their `9am` should mean their 9am). Baxter sets `--tz` from what the requester states ("9am Eastern") or knows about them from memory; **if a clock-time schedule needs a timezone and he doesn't know it, he asks the requester** rather than guessing. The operator default `HEARTBEAT_TZ` is only the last-resort fallback. (This guidance lives in the `schedule` skill + prompts.)

### The fired run
The driver renders **`heartbeat-prompt.md`** with the task text and delivery target, then `runClaude` with Baxter's usual toolset (`discord-cli`, `gmail` CLI, `code-cli`, both browsers, `WebSearch`/`WebFetch`, `Skill`, `Read`/`Write`/`Edit`) and cwd `MEMORY_DIR` — **but NOT `Bash(schedule-cli *)`** (a scheduled task cannot touch the schedule; see Security posture). The prompt tells it: this is an autonomous scheduled run, carry out `{{TASK}}`, and **deliver the result to `{{DELIVER_SURFACE}}` → `{{DELIVER_TARGET}}`** (post with `discord-cli` / email with the gmail CLI); if no delivery is set, just do the task. Memory files are provided as in the other prompts.

### Task log
`~/.mail-agent/schedule/task-log.jsonl` — one appended JSON line per fire: `{ ts, id, task, outcome: "completed"|"failed"|"gave-up"|"skipped", deliver, detail }`. `completed`/`failed`/`gave-up` are per-fire; `skipped` records a due fire suppressed by the daily fire cap and is written **at most once per day** (a single cap-exhausted line), never once per due-task per tick. This log is both the operator's record *and* the durable source of today's fire count (see the fire cap).

## Queue semantics

Every tick (`now`):
1. **Select due:** tasks where `next_run_at ≤ now` AND (`invisible_until` is null OR `≤ now`).
2. For each due task, **claim** it under the lock — `claim` sets `invisible_until = now + <visibility>` (default **15 min**) and **returns the claimed task, or `null` if the id is no longer present** (a concurrent `cancel` won). **Fire only if the claim returned a task**; a `null` claim skips it (no fire, no window recorded). Fires are awaited and sequential (≤ one heartbeat run at a time).
3. **On success** (run exits 0): a **one-shot** (`at`) task is **removed**; a **cron** task is **rescheduled** — `next_run_at` = next cron occurrence after `now`, `invisible_until` cleared, `attempts` reset. Append a `completed` log line.
4. **On failure** (non-zero / out-of-tokens): leave `invisible_until` as set — the task becomes due again after the window (**retry**), `attempts++`. Once `attempts ≥ <max-attempts>` (default **3**), **drop** the task (remove one-shot / skip this cron occurrence by rescheduling to the next and resetting attempts). Each failed fire appends **exactly one** log line: `failed` normally, or `gave-up` for the fire that exhausts attempts (`gave-up` *replaces* `failed` — never both — so "one line per fire" holds and the fire count stays exact).

**Cancellation wins.** Fires happen *outside* the lock and take minutes, so `schedule-cli cancel <id>` can legitimately remove a task while its run is in flight. Therefore `claim`, `onSuccess`, and `onFailure` are **no-ops if the task id is absent** from the current locked file state — they re-read under the lock and only mutate a task that still exists. A cancelled task never resurrects (this matters most for a cancelled hostile cron task).

The **15-minute invisibility window** is what lets a fired run take minutes without the next tick re-firing the same task — a crashed/killed driver's claim simply expires and the task retries.

## Concurrency — the schedule file IS locked (unlike memory.md)

The schedule is structured state written by both the driver (claims, reschedules, removals) and `schedule-cli` (Baxter add/cancel), across containers on the shared volume — so every mutation takes a **cross-process advisory lock + atomic write**: `withScheduleLock(fn)` acquires the lock, re-reads the schedule, applies `fn`, writes to a temp file, and `rename`s it into place (atomic replace). Crucially the lock is held only for this **brief read-modify-write** — never across a fire (fires run unlocked; see Cancellation-wins).

**The lock uses `proper-lockfile`** (added dep) rather than a hand-rolled `mkdir`+stale-TTL scheme. Naive staleness handling (check-mtime → `rmdir` → `mkdir`) has a double-steal race — two processes both seeing a stale lock can both acquire (one's `rmdir` deletes the other's fresh lock) — which would defeat the very "no lost claims" property this section exists for. `proper-lockfile` does atomic acquisition with correct stale-lock detection (mtime-based, with periodic mtime refresh while held); since the lock is only ever held for a sub-second RMW, its short stale threshold is safe. This is the mitigation we deliberately deferred for `memory.md`, applied here because the driver depends on the file's integrity.

## Security posture

A scheduled task turns a one-time instruction into a **persistent, autonomous** action — so a prompt injection that makes Baxter `schedule-cli add` a hostile task would recur, firing full `claude -p` runs (browsers, web, code) on its cadence. Send caps alone don't bound this (they cap *messages sent*, not *runs fired*; a `deliver:null` task never touches them), so the design adds **enforced limits, in `schedule-store`/`schedule-cli`/driver — not prompt text**:
- **Minimum recurrence interval — 1 hour** (`HEARTBEAT_MIN_INTERVAL_MINUTES`, default 60): `schedule-cli add` rejects a `--cron` whose **smallest gap between any two consecutive occurrences over the next 100 occurrences** is < 60 min. The horizon is an **occurrence count with no wall-clock cap** (a calendar-sparse expression like `* * 25 12 *` is simply scanned further out): a single expression's tight gaps always fall within its first active window, so counting occurrences catches them however far out that window is — a wall-clock cap could be *outrun* (an expr whose first window is > the cap would be checked against zero gaps and pass), and the next-*pair*-only check is gameable by add-time (`0,30 9 * * *`). This makes the "≤ ~24 fires/day per recurring task" bound actually hold. **`--cron` only** — a one-shot `--at` has no minimum and can be scheduled for any time, even seconds out (it fires once, so there's no frequency to bound).
- **Max task count** (`HEARTBEAT_MAX_TASKS`, default 100): `add` rejects once the schedule is full.
- **Global daily fire cap** (`HEARTBEAT_MAX_FIRES_PER_DAY`, default 200): the driver stops firing once the day's fires are exhausted (and writes a single `skipped` log line) — a hard ceiling on total autonomous runs regardless of task count. The day's fire count is **derived from durable state — the count of today's non-`skipped` lines in `task-log.jsonl`** (already appended per fire), so it survives a container restart rather than resetting to zero on every `--restart`. A "day" here is the **UTC calendar date of each line's `ts`** (the driver counts and the once-per-day `skipped` line reset on the UTC date boundary).

**The fired run is deliberately NOT granted `schedule-cli`** — a scheduled task cannot create, modify, or cancel scheduled tasks. This is a real guardrail (a hostile task can't spawn more tasks or extend its own life) and the reason self-managing tasks are a non-goal: humans manage the schedule via normal Discord/email runs (which *do* have `schedule-cli`), so there are **three** distinct spawn sites now (email/Discord grant `schedule-cli`; heartbeat does not) whose prompts/permissions must stay in sync.

Standing guardrails still apply: daily **send caps** bound delivered output, the **task log + `schedule-cli list`** give visibility, and any task is cancellable. The driver container holds the same tokens the Discord/email deploys do (via `app/.env`) and strips them from the spawned run's env exactly as the other daemons do.

## Components / files

**Created:**
- `app/scripts/heartbeat.mjs` — the driver (loop + `tick`; due-selection, claim, fire via `runClaude`, success/failure/reschedule, cron-next, logging, daily-fire-cap). **At startup it persists `DISCORD_BOT_TOKEN` to `DISCORD_TOKEN_PATH` (0600), exactly as `discord-bot.mjs` does**, then strips the token from fired runs' env — otherwise a heartbeat-fired run's `discord-cli` (whose env token is stripped) would depend on a file only the Discord daemon writes, and Discord delivery would fail on a host where `make heartbeat` runs without a live Discord daemon.
- `app/scripts/schedule-cli.mjs` (+ `.test.mjs`) — add/cancel/list; the locked boundary.
- `app/scripts/schedule-store.mjs` (+ `.test.mjs`) — the shared task store: `withScheduleLock`, atomic read/write, and pure helpers (`selectDue`, `claim`, `computeNextRun`, `onSuccess`, `onFailure`) so both the driver and CLI use one tested implementation.
- `app/heartbeat-prompt.md` — the fired-run template.

**Modified:**
- `Makefile` — a `heartbeat` target (detached container, tokens + config volume + shared network).
- `app/Dockerfile` — the `schedule-cli` shim on PATH.
- `app/scripts/paths.mjs` — `SCHEDULE_PATH`, `SCHEDULE_LOG_PATH`, `SCHEDULE_LOCK_PATH`.
- `app/package.json` — add `cron-parser` and `proper-lockfile`.
- `app/prompt.md`, `app/discord-prompt.md`, and a new `schedule` skill (`app/skills/schedule/SKILL.md`) — teach Baxter to schedule/cancel via `schedule-cli` (and add `schedule` to `SKILL_SRCS` + `BAKED_SKILL_NAMES`, granting `Bash(schedule-cli *)` in the **email + Discord** daemons only — the heartbeat-fired run is NOT granted it, per Security posture; that's three distinct spawn sites to keep in sync).
- `app/.env.example` — `HEARTBEAT_INTERVAL_SECONDS` (default 60), `HEARTBEAT_VISIBILITY_MINUTES` (15), `HEARTBEAT_MAX_ATTEMPTS` (3), `HEARTBEAT_MIN_INTERVAL_MINUTES` (60), `HEARTBEAT_MAX_TASKS` (100), `HEARTBEAT_MAX_FIRES_PER_DAY` (200), `HEARTBEAT_TZ` (operator **fallback** timezone for a task with no `--tz`, default `America/Los_Angeles`).
- `app/CLAUDE.md` — a "Heartbeat scheduler" section (the service, the queue/visibility semantics, the locked store, delivery, security).

## Testing

- **Unit (`node:test`, the bulk — the store is pure/injectable):** `selectDue` (due vs future vs invisible), `claim` (sets window), `computeNextRun` (cron next in the task's `tz`; naive-`at`-in-`tz` vs offset-carrying-`at`; `HEARTBEAT_TZ` fallback), `onSuccess` (one-shot removed vs cron rescheduled), `onFailure` (attempts++, retry after window, give-up at max), **cancellation-wins** (`claim` returns `null` when the id is absent, so the driver does not fire; `onSuccess`/`onFailure` are no-ops when absent), **the limits** (a `--cron` with a < 60-min gap anywhere over the horizon is rejected — including uneven exprs like `0,30 9 * * *` regardless of add-time; a one-shot `--at` seconds out is accepted; `add` rejected at `HEARTBEAT_MAX_TASKS`; the driver's daily fire count is read from today's `task-log.jsonl` lines and it stops firing + writes one `skipped` line at `HEARTBEAT_MAX_FIRES_PER_DAY`), `schedule-cli` arg parsing/validation (cron XOR at; delivery flags), and `withScheduleLock` mutual exclusion + atomic write (two concurrent writers don't lose an update or corrupt the file; a stale lock from a killed holder is recovered without double-acquisition).
- **Integration:** `make heartbeat` up; `schedule-cli add` a one-shot `--at` a few seconds out with `--discord <channel>`; confirm the driver fires a run, delivers, removes the task, and logs `completed`. A cron task reschedules. A deliberately-failing task retries then gives up.
- **End-to-end:** from Discord, ask Baxter "remind me in 2 minutes to X" and "every weekday at 9am post Y"; confirm the tasks appear via `schedule-cli list`, fire, and deliver.

## Acceptance criteria

1. `make heartbeat` runs one driver that, each ~minute, fires due tasks and only due tasks.
2. Tasks support cron (recurring) and `at` (one-shot); `deliver` routes the result to Discord (channel) or gmail (address), or nowhere.
3. Claiming uses a 15-min invisibility window; success removes (one-shot) or reschedules (cron); failure retries after the window and gives up after max-attempts; every fire is logged to `task-log.jsonl`.
4. Baxter schedules and cancels only through `schedule-cli` (add/cancel/list) from either surface; he never raw-edits the schedule.
5. All schedule mutations are lock-guarded (`proper-lockfile`) + atomic — concurrent driver/CLI writes never lose a claim or corrupt the file, and a `cancel` in flight is never resurrected by a completing run.
6. Enforced limits hold: a `--cron` under 60-min spacing is rejected (one-shot `--at` any time is allowed); `add` is capped at `HEARTBEAT_MAX_TASKS`; the driver stops firing at `HEARTBEAT_MAX_FIRES_PER_DAY`.
7. The fired run has Baxter's existing toolset **minus `schedule-cli`** (a scheduled task can't touch the schedule); daily send caps still bound its output; the email/Discord daemons are unchanged.
