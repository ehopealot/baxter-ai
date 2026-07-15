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
  "deliver": { "surface": "discord", "target": "<channelId>" },  // or {surface:"gmail",target:"<email>"}, or null
  "next_run_at": "2026-07-17T17:00:00Z",// computed due time
  "invisible_until": null,              // visibility-window claim (ISO) or null
  "attempts": 0,                        // failed-fire counter
  "created_at": "2026-07-15T…"
}
```

### `schedule-cli` — Baxter's boundary to the schedule
`scripts/schedule-cli.mjs`, installed on PATH (Dockerfile shim, like `discord-cli`/`code-cli`). Baxter's **only** way to touch the schedule — he never raw-edits the file. Commands:
- `schedule-cli add "<task>" (--cron "<expr>" | --at "<ISO>") [--discord <channelId> | --email <address>]` — validates exactly one of cron/at and at most one delivery target, computes `next_run_at`, appends the task, prints its id.
- `schedule-cli cancel <id>` — removes a task.
- `schedule-cli list` — prints the current tasks (id, task, schedule, next run, delivery) as JSON.
All mutations go through the shared lock + atomic write (see Concurrency).

### The fired run
The driver renders **`heartbeat-prompt.md`** with the task text and delivery target, then `runClaude` with the full toolset (`discord-cli`, `gmail` CLI, `code-cli`, both browsers, `WebSearch`/`WebFetch`, `Skill`, `Read`/`Write`/`Edit`) and cwd `MEMORY_DIR`. The prompt tells it: this is an autonomous scheduled run, carry out `{{TASK}}`, and **deliver the result to `{{DELIVER_SURFACE}}` → `{{DELIVER_TARGET}}`** (post with `discord-cli` / email with the gmail CLI); if no delivery is set, just do the task. Memory files are provided as in the other prompts.

### Task log
`~/.mail-agent/schedule/task-log.jsonl` — one appended JSON line per fire: `{ ts, id, task, outcome: "completed"|"failed"|"gave-up", deliver, detail }`. This is the operator's record of what ran.

## Queue semantics

Every tick (`now`):
1. **Select due:** tasks where `next_run_at ≤ now` AND (`invisible_until` is null OR `≤ now`).
2. For each due task, **claim** it: set `invisible_until = now + <visibility>` (default **15 min**), atomic write, then **fire** the run (awaited; tasks in a tick are processed sequentially, so at most one heartbeat run at a time).
3. **On success** (run exits 0): a **one-shot** (`at`) task is **removed**; a **cron** task is **rescheduled** — `next_run_at` = next cron occurrence after `now`, `invisible_until` cleared, `attempts` reset. Append a `completed` log line.
4. **On failure** (non-zero / out-of-tokens): leave `invisible_until` as set — the task becomes due again after the window (**retry**), `attempts++`, append a `failed` line. Once `attempts ≥ <max-attempts>` (default **3**), **drop** the task (remove one-shot / skip this cron occurrence by rescheduling to the next and resetting attempts) and append a `gave-up` line, so a poison task can't retry forever.

The **15-minute invisibility window** is what lets a fired run take minutes without the next tick re-firing the same task — a crashed/killed driver's claim simply expires and the task retries.

## Concurrency — the schedule file IS locked (unlike memory.md)

The schedule is structured state written by both the driver (claims, reschedules, removals) and `schedule-cli` (Baxter add/cancel), across containers on the shared volume — so every mutation takes a **cross-process advisory lock + atomic write**: `withScheduleLock(fn)` acquires a lock via atomic `mkdir` of a lock dir (POSIX-atomic; steal if older than a short stale-TTL so a crashed holder can't wedge the queue), reads the schedule, applies `fn`, writes to a temp file, and `rename`s it into place (atomic replace). This gives no lost claims and no torn/corrupt queue file — the mitigation we deliberately deferred for `memory.md` is applied here because the driver depends on the file's integrity.

## Security posture

A scheduled task turns a one-time instruction into a **persistent, autonomous** action, so a prompt injection that makes Baxter `schedule-cli add` something hostile would recur. Accepted, with guardrails already in the system: the **daily send caps** (`MAX_SENDS_PER_DAY` / `DISCORD_MAX_SENDS_PER_DAY`) still bound email/Discord output from fired runs; the **task log + `schedule-cli list`** give the operator visibility; and any task can be cancelled. The fired run has the same capabilities Baxter already has (nothing new is granted) — the only new property is persistence, which the caps + visibility bound. The driver container holds the same tokens the Discord/email deploys do (via `app/.env`), and strips them from the spawned run's env exactly as the other daemons do.

## Components / files

**Created:**
- `app/scripts/heartbeat.mjs` — the driver (loop + `tick`; due-selection, claim, fire via `runClaude`, success/failure/reschedule, cron-next, logging).
- `app/scripts/schedule-cli.mjs` (+ `.test.mjs`) — add/cancel/list; the locked boundary.
- `app/scripts/schedule-store.mjs` (+ `.test.mjs`) — the shared task store: `withScheduleLock`, atomic read/write, and pure helpers (`selectDue`, `claim`, `computeNextRun`, `onSuccess`, `onFailure`) so both the driver and CLI use one tested implementation.
- `app/heartbeat-prompt.md` — the fired-run template.

**Modified:**
- `Makefile` — a `heartbeat` target (detached container, tokens + config volume + shared network).
- `app/Dockerfile` — the `schedule-cli` shim on PATH.
- `app/scripts/paths.mjs` — `SCHEDULE_PATH`, `SCHEDULE_LOG_PATH`, `SCHEDULE_LOCK_PATH`.
- `app/package.json` — add `cron-parser`.
- `app/prompt.md`, `app/discord-prompt.md`, and a new `schedule` skill (`app/skills/schedule/SKILL.md`) — teach Baxter to schedule/cancel via `schedule-cli` (and add `schedule` to `SKILL_SRCS` + `BAKED_SKILL_NAMES`, granting `Bash(schedule-cli *)` in both daemons).
- `app/.env.example` — `HEARTBEAT_INTERVAL_SECONDS` (default 60), `HEARTBEAT_VISIBILITY_MINUTES` (15), `HEARTBEAT_MAX_ATTEMPTS` (3), `HEARTBEAT_TZ` (cron timezone, default UTC).
- `app/CLAUDE.md` — a "Heartbeat scheduler" section (the service, the queue/visibility semantics, the locked store, delivery, security).

## Testing

- **Unit (`node:test`, the bulk — the store is pure/injectable):** `selectDue` (due vs future vs invisible), `claim` (sets window), `computeNextRun` (cron next; one-shot passthrough), `onSuccess` (one-shot removed vs cron rescheduled), `onFailure` (attempts++, retry after window, give-up at max), `schedule-cli` arg parsing/validation (cron XOR at; delivery flags), and `withScheduleLock` mutual exclusion + atomic write (two concurrent writers don't lose an update or corrupt the file).
- **Integration:** `make heartbeat` up; `schedule-cli add` a one-shot `--at` a few seconds out with `--discord <channel>`; confirm the driver fires a run, delivers, removes the task, and logs `completed`. A cron task reschedules. A deliberately-failing task retries then gives up.
- **End-to-end:** from Discord, ask Baxter "remind me in 2 minutes to X" and "every weekday at 9am post Y"; confirm the tasks appear via `schedule-cli list`, fire, and deliver.

## Acceptance criteria

1. `make heartbeat` runs one driver that, each ~minute, fires due tasks and only due tasks.
2. Tasks support cron (recurring) and `at` (one-shot); `deliver` routes the result to Discord (channel) or gmail (address), or nowhere.
3. Claiming uses a 15-min invisibility window; success removes (one-shot) or reschedules (cron); failure retries after the window and gives up after max-attempts; every fire is logged to `task-log.jsonl`.
4. Baxter schedules and cancels only through `schedule-cli` (add/cancel/list) from either surface; he never raw-edits the schedule.
5. All schedule mutations are lock-guarded + atomic — concurrent driver/CLI writes never lose a claim or corrupt the file.
6. The fired run has Baxter's existing toolset and no more; daily send caps still bound its output; the email/Discord daemons are unchanged.
