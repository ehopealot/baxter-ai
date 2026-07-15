# Baxter Heartbeat Scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Baxter a schedule: a dedicated `make heartbeat` driver fires due tasks (cron-recurring or one-shot `at`) from a locked `schedule.json`, delivers results to Discord or email, and repeats/retires them — Baxter only edits the schedule via `schedule-cli`.

**Architecture:** A node daemon loop (like `poll.mjs`) ticks ~every minute: it claims a due task under a `proper-lockfile` lock (15-min invisibility window), fires a `claude -p` run via `runtime.mjs runClaude`, then removes (one-shot) or reschedules (cron) the task and logs the outcome. Pure queue logic lives in `schedule-store.mjs`; the CLI and driver are thin shells over it. Enforced rate limits (min recurrence, max tasks, daily fire cap) live in code.

**Tech Stack:** Node 22 (ESM), `cron-parser` (next-occurrence + min-gap), `proper-lockfile` (cross-process lock), `node:test`.

## Global Constraints

- **Single driver.** Exactly one `make heartbeat` container fires tasks (`--restart unless-stopped`, same image, `app/.env` tokens, config volume, shared network). Fires go through `runClaude` exactly as `poll.mjs`/`discord-bot.mjs`.
- **Task shape:** `{ id, task, cron|null, at|null, tz|null, deliver:{surface:"discord"|"gmail",target}|null, next_run_at, invisible_until|null, attempts, created_at }`. `cron` XOR `at`. `tz` stored **as given, null when omitted** — the `HEARTBEAT_TZ` fallback is applied at *compute* time, never frozen into the task.
- **Queue semantics:** due = `next_run_at ≤ now && (invisible_until == null || ≤ now)`. Claim sets `invisible_until = now + 15min` and **returns the task or null** (null when the id is absent — a `cancel` won); **fire only on a non-null claim**. Success → one-shot removed / cron rescheduled (`next_run_at` = next cron occurrence, `invisible_until` cleared, `attempts` reset). Failure → leave `invisible_until` (retry after window), `attempts++`; at `attempts ≥ HEARTBEAT_MAX_ATTEMPTS` (3) drop it (`gave-up`). `claim`/`onSuccess`/`onFailure` are **no-ops if the id is absent** (cancellation wins).
- **Enforced limits (code, not prompt):** `schedule-cli add` rejects a `--cron` whose smallest gap between consecutive occurrences over the **next 100 occurrences (an occurrence count with no wall-clock cap — a calendar-sparse expr is scanned further out; `cronMinGapMinutes` in Task 1 does exactly this)** is `< HEARTBEAT_MIN_INTERVAL_MINUTES` (60); rejects at `HEARTBEAT_MAX_TASKS` (100). A one-shot `--at` has NO minimum. The driver stops firing at `HEARTBEAT_MAX_FIRES_PER_DAY` (200), **counted from today's non-`skipped` lines in `task-log.jsonl`** (durable across restart), logging one `skipped` line/day.
- **Concurrency:** every schedule mutation takes a `proper-lockfile` lock + atomic write (temp file + `rename`); the lock is held ONLY for the brief read-modify-write, never across a fire.
- **Fired-run toolset:** Baxter's usual grants **minus `Bash(schedule-cli *)`** — a scheduled task cannot touch the schedule. It DOES get both `Bash(node <GMAIL_CLI_PATH> *)` and `Bash(discord-cli *)` (deliver to either surface).
- **Token file:** `heartbeat.mjs` writes `DISCORD_TOKEN_PATH` (0600) at startup like `discord-bot.mjs`, and passes `runClaude` an env with `DISCORD_BOT_TOKEN` stripped.
- **Timezone default:** `HEARTBEAT_TZ` = `America/Los_Angeles`.
- **Running unit tests:** `node --test` **inside the built `app-app` image** via the throwaway-container `docker cp` pattern (Task 1 Step 4). Since Task 1 adds deps, `make build-app` must run before the docker-cp test so `node_modules` has `cron-parser`/`proper-lockfile`.
- **Commit trailers:** end each commit with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_013R7GwxgVf6Rg1T1Yvr7rZg`.

---

## File Structure

**Created:**
- `app/scripts/schedule-store.mjs` (+ `.test.mjs`) — the task store: pure queue helpers (Task 1) + locked/atomic I/O (Task 2).
- `app/scripts/schedule-cli.mjs` (+ `.test.mjs`) — `add`/`cancel`/`list` over the store (Task 3).
- `app/scripts/heartbeat.mjs` (+ `.test.mjs`) — the driver loop + `tick` (Task 4).
- `app/heartbeat-prompt.md` — the fired-run template (Task 5).
- `app/skills/schedule/SKILL.md` — the `schedule` skill (Task 5).

**Modified:**
- `app/scripts/paths.mjs` — `SCHEDULE_PATH`, `SCHEDULE_LOG_PATH` (Task 1).
- `app/package.json` — `cron-parser`, `proper-lockfile` (Task 1).
- `app/Dockerfile` — `schedule-cli` shim (Task 5).
- `app/scripts/poll.mjs`, `app/scripts/discord-bot.mjs` — grant `Bash(schedule-cli *)`, add `schedule` to `SKILL_SRCS` (Task 5).
- `app/scripts/runtime.mjs` — `"schedule"` in `BAKED_SKILL_NAMES` (Task 5).
- `app/prompt.md`, `app/discord-prompt.md` — the scheduling line (Task 5).
- `Makefile` — `heartbeat` target (Task 6).
- `app/.env.example`, `app/CLAUDE.md` — knobs + docs (Task 6).

---

## Task 1: deps, paths, and the pure queue helpers (TDD)

**Files:**
- Modify: `app/package.json`, `app/scripts/paths.mjs`
- Create: `app/scripts/schedule-store.mjs`, `app/scripts/schedule-store.test.mjs`

**Interfaces (Produced — later tasks consume these exact signatures):**
- `newId()` → 8-char hex string.
- `resolveNextRun({cron, at, tz}, now, fallbackTz)` → ISO string (absolute UTC). `at` with offset/`Z` → as-is; naive `at` → interpreted in `tz||fallbackTz`; `cron` → next occurrence after `now` in `tz||fallbackTz`.
- `cronMinGapMinutes(cron, tz, fallbackTz)` → the smallest gap (minutes) between consecutive occurrences over the next 100 (≤ 35 days).
- `selectDue(tasks, nowMs)` → array of due tasks.
- `applyClaim(tasks, id, nowMs, visibilityMs)` → `{ tasks, claimed }` (`claimed` = the task with `invisible_until` set, or `null` if id absent).
- `applyOnSuccess(tasks, id, nowMs, fallbackTz)` → `tasks` (one-shot removed / cron rescheduled; no-op if absent).
- `applyOnFailure(tasks, id, nowMs, maxAttempts, fallbackTz)` → `{ tasks, gaveUp }` (attempts++, drop at max; no-op if absent).

- [ ] **Step 1: Add deps + paths**
In `app/package.json` `dependencies`, add `"cron-parser": "^4.9.0"` and `"proper-lockfile": "^4.1.2"`; run `npm install` in `app/` to update the lockfile. In `app/scripts/paths.mjs`, after the existing `STATE_DIR` exports, add:
```js
export const SCHEDULE_PATH = join(STATE_DIR, "schedule", "schedule.json");
export const SCHEDULE_LOG_PATH = join(STATE_DIR, "schedule", "task-log.jsonl");
```
(The lock is `proper-lockfile`'s `<SCHEDULE_PATH>.lock`, managed by the lib — no separate path constant.)

- [ ] **Step 2: Write failing tests** `app/scripts/schedule-store.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveNextRun, cronMinGapMinutes, selectDue, applyClaim, applyOnSuccess, applyOnFailure,
} from "./schedule-store.mjs";

const TZ = "America/Los_Angeles";
const ms = (iso) => Date.parse(iso);

test("resolveNextRun: offset-carrying at is absolute; naive at uses tz; cron computes next", () => {
  assert.equal(resolveNextRun({ at: "2026-07-20T14:00:00Z" }, ms("2026-07-15T00:00:00Z"), TZ), "2026-07-20T14:00:00.000Z");
  // naive 2026-07-20 09:00 in America/New_York (EDT, -4) => 13:00Z
  assert.equal(resolveNextRun({ at: "2026-07-20T09:00:00", tz: "America/New_York" }, ms("2026-07-15T00:00:00Z"), TZ), "2026-07-20T13:00:00.000Z");
  // cron 9am weekdays in NY, from Wed 2026-07-15T20:00Z => Thu 2026-07-16 09:00 EDT = 13:00Z
  assert.equal(resolveNextRun({ cron: "0 9 * * 1-5", tz: "America/New_York" }, ms("2026-07-15T20:00:00Z"), TZ), "2026-07-16T13:00:00.000Z");
});

test("cronMinGapMinutes catches uneven exprs regardless of add-time", () => {
  assert.ok(cronMinGapMinutes("0,30 9 * * *", null, TZ) <= 30);   // twice within 30 min
  assert.equal(cronMinGapMinutes("0 * * * *", null, TZ), 60);     // hourly
  assert.ok(cronMinGapMinutes("0 9 * * 1-5", null, TZ) >= 60);    // daily-ish
  assert.ok(cronMinGapMinutes("* * 25 12 *", null, TZ) <= 1);     // calendar-sparse: still caught (no wall-clock cap)
});

test("selectDue picks past-due visible tasks only", () => {
  const now = ms("2026-07-15T12:00:00Z");
  const tasks = [
    { id: "due", next_run_at: "2026-07-15T11:00:00Z", invisible_until: null },
    { id: "future", next_run_at: "2026-07-15T13:00:00Z", invisible_until: null },
    { id: "claimed", next_run_at: "2026-07-15T11:00:00Z", invisible_until: "2026-07-15T12:10:00Z" },
    { id: "expired", next_run_at: "2026-07-15T11:00:00Z", invisible_until: "2026-07-15T11:59:00Z" },
  ];
  assert.deepEqual(selectDue(tasks, now).map((t) => t.id), ["due", "expired"]);
});

test("applyClaim sets the window and returns the task; null when absent", () => {
  const now = ms("2026-07-15T12:00:00Z");
  const tasks = [{ id: "a", invisible_until: null }];
  const r = applyClaim(tasks, "a", now, 15 * 60000);
  assert.equal(r.claimed.id, "a");
  assert.equal(r.claimed.invisible_until, "2026-07-15T12:15:00.000Z");
  assert.equal(r.tasks[0].invisible_until, "2026-07-15T12:15:00.000Z");
  assert.equal(applyClaim(tasks, "gone", now, 1000).claimed, null);
});

test("applyOnSuccess: one-shot removed, cron rescheduled, absent is no-op", () => {
  const now = ms("2026-07-16T13:05:00Z");
  const one = [{ id: "o", at: "2026-07-16T13:00:00Z", invisible_until: "x" }];
  assert.deepEqual(applyOnSuccess(one, "o", now, TZ), []);
  const cron = [{ id: "c", cron: "0 9 * * 1-5", tz: "America/New_York", invisible_until: "x", attempts: 0, next_run_at: "2026-07-16T13:00:00Z" }];
  const after = applyOnSuccess(cron, "c", now, TZ)[0];
  assert.equal(after.invisible_until, null);
  assert.equal(after.next_run_at, "2026-07-17T13:00:00.000Z"); // next weekday 9am NY
  assert.deepEqual(applyOnSuccess(cron, "gone", now, TZ), cron);
});

test("applyOnFailure: retry then give up; absent is no-op", () => {
  const now = ms("2026-07-15T12:00:00Z");
  const t = [{ id: "f", at: "2026-07-15T11:00:00Z", invisible_until: "2026-07-15T12:15:00Z", attempts: 0 }];
  const r1 = applyOnFailure(t, "f", now, 3, TZ);
  assert.equal(r1.gaveUp, false);
  assert.equal(r1.tasks[0].attempts, 1);
  assert.equal(r1.tasks[0].invisible_until, "2026-07-15T12:15:00Z"); // window left for retry
  const t2 = [{ id: "f", at: "x", invisible_until: "x", attempts: 2 }];
  const r2 = applyOnFailure(t2, "f", now, 3, TZ);
  assert.equal(r2.gaveUp, true);
  assert.deepEqual(r2.tasks, []); // one-shot dropped
  assert.equal(applyOnFailure(t2, "gone", now, 3, TZ).gaveUp, false);
});
```

- [ ] **Step 3: Implement** `app/scripts/schedule-store.mjs` (pure part):
```js
// Pure queue logic for the heartbeat scheduler. No I/O here (see the lock/atomic
// I/O section below, added in Task 2). cron-parser computes occurrences; every
// time value is stored as an absolute UTC ISO string.
import { randomBytes } from "node:crypto";
import parser from "cron-parser";

export function newId() {
  return randomBytes(4).toString("hex");
}

// Absolute UTC ISO for a task's next fire. `at` with an offset/Z is absolute;
// a naive `at` is interpreted as wall-clock in tz||fallbackTz; every `cron` is
// read in tz||fallbackTz via cron-parser.
export function resolveNextRun({ cron, at, tz }, nowMs, fallbackTz) {
  const zone = tz || fallbackTz;
  if (at) {
    if (/[zZ]|[+-]\d\d:?\d\d$/.test(at)) return new Date(at).toISOString(); // absolute
    return naiveInZoneToISO(at, zone);                                      // wall-clock in zone
  }
  const it = parser.parseExpression(cron, { currentDate: new Date(nowMs), tz: zone });
  return it.next().toDate().toISOString();
}

// Offset (ms) of `zone` at the instant `utcMs`: (wall-clock in zone) - utc.
function zoneOffsetMs(zone, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asIfUtc - utcMs;
}

// A naive "YYYY-MM-DDTHH:MM[:SS]" wall-clock time in `zone` -> absolute UTC ISO.
// (Keeps the year, unlike a cron approximation; single offset correction is fine
// away from the rare DST-fold second.)
function naiveInZoneToISO(naive, zone) {
  const m = naive.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/);
  if (!m) throw new Error(`invalid --at timestamp: ${naive}`);
  const [, Y, Mo, D, H, Mi, S] = m;
  const guess = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0));
  return new Date(guess - zoneOffsetMs(zone, guess)).toISOString();
}

export function cronMinGapMinutes(cron, tz, fallbackTz, horizon = 100) {
  const it = parser.parseExpression(cron, { currentDate: new Date(), tz: tz || fallbackTz });
  let prev = it.next().toDate().getTime();
  let min = Infinity;
  for (let i = 0; i < horizon; i++) {
    const next = it.next().toDate().getTime();
    min = Math.min(min, (next - prev) / 60000);
    prev = next;
  }
  return min;
}

export function selectDue(tasks, nowMs) {
  return tasks.filter(
    (t) => Date.parse(t.next_run_at) <= nowMs &&
      (t.invisible_until == null || Date.parse(t.invisible_until) <= nowMs),
  );
}

export function applyClaim(tasks, id, nowMs, visibilityMs) {
  const invisible_until = new Date(nowMs + visibilityMs).toISOString();
  let claimed = null;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    claimed = { ...t, invisible_until };
    return claimed;
  });
  return { tasks: claimed ? next : tasks, claimed };
}

export function applyOnSuccess(tasks, id, nowMs, fallbackTz) {
  if (!tasks.some((t) => t.id === id)) return tasks; // cancellation won
  return tasks.flatMap((t) => {
    if (t.id !== id) return [t];
    if (t.cron) return [{ ...t, next_run_at: resolveNextRun(t, nowMs, fallbackTz), invisible_until: null, attempts: 0 }];
    return []; // one-shot: remove
  });
}

export function applyOnFailure(tasks, id, nowMs, maxAttempts, fallbackTz) {
  if (!tasks.some((t) => t.id === id)) return { tasks, gaveUp: false }; // cancellation won
  let gaveUp = false;
  const next = tasks.flatMap((t) => {
    if (t.id !== id) return [t];
    const attempts = (t.attempts || 0) + 1;
    if (attempts < maxAttempts) return [{ ...t, attempts }]; // leave invisible_until -> retry after window
    gaveUp = true;
    if (t.cron) return [{ ...t, next_run_at: resolveNextRun(t, nowMs, fallbackTz), invisible_until: null, attempts: 0 }];
    return []; // one-shot: drop
  });
  return { tasks: next, gaveUp };
}
```
Note the naive-`at` regex in `resolveNextRun`: `at` values without a trailing `Z`/offset are treated as local-to-`zone`.

- [ ] **Step 4: Run tests**
```bash
make build-app
cid=$(docker create app-app:latest node --test /app/scripts/schedule-store.test.mjs)
docker cp app/scripts/schedule-store.mjs      "$cid:/app/scripts/schedule-store.mjs"
docker cp app/scripts/schedule-store.test.mjs "$cid:/app/scripts/schedule-store.test.mjs"
docker start -a "$cid"; docker rm "$cid"
```
Expected: all pass. (The image build already ran `npm install`, so `cron-parser` is present.)

- [ ] **Step 5: Commit**
```bash
git add app/package.json app/package-lock.json app/scripts/paths.mjs app/scripts/schedule-store.mjs app/scripts/schedule-store.test.mjs
git commit -m "Add schedule-store pure queue helpers + deps (cron-parser, proper-lockfile)"
```

---

## Task 2: schedule-store locked/atomic I/O + log + fire count (TDD)

**Files:**
- Modify: `app/scripts/schedule-store.mjs`, `app/scripts/schedule-store.test.mjs`

**Interfaces (Produced):**
- `async mutate(fn)` → runs `fn(tasks)` (which returns `{ tasks, value }`) under the lock with an atomic write; returns `value`. Used by the CLI and driver for every write.
- `async readTasks()` → the current task array (unlocked read, for `list`).
- `appendLog(entry)` → append one JSON line to `SCHEDULE_LOG_PATH`.
- `fireCountToday()` → number of today's `task-log.jsonl` lines whose `outcome !== "skipped"`.

- [ ] **Step 1: Failing tests** — append to `schedule-store.test.mjs` (these use a temp `SCHEDULE_PATH` via env override; support it in the impl):
```js
import { mkdtempSync, writeFileSync as wf, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

test("mutate serializes concurrent writers without lost updates", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir; // impl reads this for test isolation
  const { mutate, readTasks } = await import(`./schedule-store.mjs?t=${Date.now()}`);
  // 20 concurrent appends must all land (lock prevents lost updates)
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      mutate((tasks) => ({ tasks: [...tasks, { id: `t${i}` }], value: null })),
    ),
  );
  assert.equal((await readTasks()).length, 20);
});

test("fireCountToday counts today's non-skipped log lines", async () => {
  const dir = mkdtempSync(pjoin(tmpdir(), "sched-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const { appendLog, fireCountToday } = await import(`./schedule-store.mjs?t=${Date.now()}b`);
  const today = new Date().toISOString();
  appendLog({ ts: today, id: "a", outcome: "completed" });
  appendLog({ ts: today, id: "b", outcome: "failed" });
  appendLog({ ts: today, id: "c", outcome: "skipped" });      // not counted
  appendLog({ ts: "2000-01-01T00:00:00Z", id: "d", outcome: "completed" }); // not today
  assert.equal(fireCountToday(), 2);
});
```

- [ ] **Step 2: Implement** — append to `schedule-store.mjs`:
```js
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { SCHEDULE_PATH as DEFAULT_PATH, SCHEDULE_LOG_PATH as DEFAULT_LOG } from "./paths.mjs";

// Test isolation: point the store at a temp dir without touching paths.mjs.
function schedulePath() {
  const o = process.env.SCHEDULE_DIR_OVERRIDE;
  return o ? join(o, "schedule.json") : DEFAULT_PATH;
}
function logPath() {
  const o = process.env.SCHEDULE_DIR_OVERRIDE;
  return o ? join(o, "task-log.jsonl") : DEFAULT_LOG;
}

function ensureFile(p) {
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, "[]");
}

export async function readTasks() {
  const p = schedulePath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}

export async function mutate(fn) {
  const p = schedulePath();
  ensureFile(p);
  const release = await lockfile.lock(p, {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    const tasks = JSON.parse(readFileSync(p, "utf8"));
    const { tasks: nextTasks, value } = fn(tasks);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(nextTasks, null, 2));
    renameSync(tmp, p); // atomic replace
    return value;
  } finally {
    await release();
  }
}

export function appendLog(entry) {
  const p = logPath();
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
}

export function fireCountToday() {
  const p = logPath();
  if (!existsSync(p)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.outcome !== "skipped" && String(e.ts).slice(0, 10) === today) n++;
    } catch { /* ignore malformed line */ }
  }
  return n;
}
```
Add `import { join } from "node:path";` to the top of the file if not already present (Task 1 imported `randomBytes`/`parser` only).

- [ ] **Step 3: Run tests** (docker-cp both `.mjs` + `.test.mjs`, as Task 1 Step 4). Expected: all pass, including the 20-writer concurrency test.

- [ ] **Step 4: Commit**
```bash
git add app/scripts/schedule-store.mjs app/scripts/schedule-store.test.mjs
git commit -m "Add schedule-store locked atomic I/O, log append, and daily fire count"
```

---

## Task 3: `schedule-cli` — add / cancel / list (TDD)

**Files:**
- Create: `app/scripts/schedule-cli.mjs`, `app/scripts/schedule-cli.test.mjs`

**Interfaces:**
- Consumes: `schedule-store` (`mutate`, `readTasks`, `newId`, `resolveNextRun`, `cronMinGapMinutes`).
- Produces: `parseAdd(argv)` → `{ task, cron, at, tz, deliver }` (throws on invalid combos); the CLI `add`/`cancel`/`list`.

- [ ] **Step 1: Failing tests** `app/scripts/schedule-cli.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdd } from "./schedule-cli.mjs";

test("parseAdd requires exactly one of --cron/--at and at most one delivery", () => {
  assert.deepEqual(parseAdd(["do X", "--cron", "0 9 * * 1-5", "--discord", "123"]),
    { task: "do X", cron: "0 9 * * 1-5", at: null, tz: null, deliver: { surface: "discord", target: "123" } });
  assert.deepEqual(parseAdd(["ping", "--at", "2026-07-20T14:00:00Z", "--email", "e@x.com", "--tz", "America/New_York"]),
    { task: "ping", at: "2026-07-20T14:00:00Z", cron: null, tz: "America/New_York", deliver: { surface: "gmail", target: "e@x.com" } });
  assert.throws(() => parseAdd(["x"]), /exactly one of --cron or --at/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--at", "2026-07-20T14:00:00Z"]), /exactly one of --cron or --at/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--discord", "1", "--email", "e@x"]), /one delivery/);
  assert.throws(() => parseAdd(["--cron", "0 9 * * *"]), /task description/); // empty description
});
```

- [ ] **Step 2: Implement** `app/scripts/schedule-cli.mjs`:
```js
#!/usr/bin/env node
// Baxter's only interface to the schedule. Locked/atomic via schedule-store;
// enforces the rate limits (min recurrence, max tasks) at add time. Never lets
// the run raw-edit schedule.json.
import { pathToFileURL } from "node:url";
import {
  mutate, readTasks, newId, resolveNextRun, cronMinGapMinutes,
} from "./schedule-store.mjs";

const MIN_INTERVAL = Number(process.env.HEARTBEAT_MIN_INTERVAL_MINUTES || 60);
const MAX_TASKS = Number(process.env.HEARTBEAT_MAX_TASKS || 100);
const FALLBACK_TZ = process.env.HEARTBEAT_TZ || "America/Los_Angeles";

export function parseAdd(argv) {
  const [task, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--cron" || k === "--at" || k === "--tz" || k === "--discord" || k === "--email") {
      if (i + 1 >= rest.length) throw new Error(`missing value for ${k}`);
      flags[k] = rest[++i];
    } else throw new Error(`unknown argument: ${k}`);
  }
  if (!task || task.startsWith("--")) throw new Error("task description required as the first argument");
  if (!!flags["--cron"] === !!flags["--at"]) throw new Error("exactly one of --cron or --at is required");
  if (flags["--discord"] && flags["--email"]) throw new Error("at most one delivery target (--discord or --email)");
  const deliver = flags["--discord"] ? { surface: "discord", target: flags["--discord"] }
    : flags["--email"] ? { surface: "gmail", target: flags["--email"] } : null;
  return { task, cron: flags["--cron"] || null, at: flags["--at"] || null, tz: flags["--tz"] || null, deliver };
}

async function cmdAdd(argv) {
  const { task, cron, at, tz, deliver } = parseAdd(argv);
  if (cron) {
    const gap = cronMinGapMinutes(cron, tz, FALLBACK_TZ);
    if (gap < MIN_INTERVAL) throw new Error(`--cron fires too often (min gap ${gap}min < ${MIN_INTERVAL}min limit)`);
  }
  const now = Date.now();
  const next_run_at = resolveNextRun({ cron, at, tz }, now, FALLBACK_TZ);
  const id = await mutate((tasks) => {
    if (tasks.length >= MAX_TASKS) throw new Error(`schedule is full (${MAX_TASKS} tasks)`);
    const t = { id: newId(), task, cron, at, tz, deliver, next_run_at, invisible_until: null, attempts: 0, created_at: new Date(now).toISOString() };
    return { tasks: [...tasks, t], value: t.id };
  });
  console.log(id);
}

async function cmdCancel(id) {
  const removed = await mutate((tasks) => {
    const kept = tasks.filter((t) => t.id !== id);
    return { tasks: kept, value: kept.length !== tasks.length };
  });
  if (!removed) { console.error(`no task with id ${id}`); process.exit(1); }
  console.log(`cancelled ${id}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    try {
      if (cmd === "add") await cmdAdd(rest);
      else if (cmd === "cancel") await cmdCancel(rest[0]);
      else if (cmd === "list") console.log(JSON.stringify(await readTasks(), null, 2));
      else { console.error("usage: schedule-cli <add|cancel|list> …"); process.exit(1); }
    } catch (err) { console.error(`schedule-cli: ${err.message}`); process.exit(1); }
  })();
}
```

- [ ] **Step 3: Run unit tests** (docker-cp `schedule-cli.mjs` + `.test.mjs` + `schedule-store.mjs`). Expected: pass.

- [ ] **Step 4: Integration** (limits + round-trip) against a temp store:
```bash
docker run --rm -e SCHEDULE_DIR_OVERRIDE=/tmp/s app-app:latest sh -c '
  node /app/scripts/schedule-cli.mjs add "hourly ok" --cron "0 * * * *" --discord 123 &&
  (node /app/scripts/schedule-cli.mjs add "too often" --cron "* * * * *" --discord 123 || echo "REJECTED too-often") &&
  node /app/scripts/schedule-cli.mjs list'
```
Expected: first add prints an id; the every-minute cron prints `REJECTED too-often`; `list` shows the one task.

- [ ] **Step 5: Commit**
```bash
git add app/scripts/schedule-cli.mjs app/scripts/schedule-cli.test.mjs
git commit -m "Add schedule-cli (add/cancel/list) with enforced rate limits"
```

---

## Task 4: `heartbeat.mjs` — the driver (TDD)

**Files:**
- Create: `app/scripts/heartbeat.mjs`, `app/scripts/heartbeat.test.mjs`

**Interfaces:**
- Consumes: `schedule-store` (`mutate`, `selectDue`, `applyClaim`, `applyOnSuccess`, `applyOnFailure`, `appendLog`, `fireCountToday`), `runtime.mjs runClaude`, `paths.mjs`.
- Produces: `async tick(now, { runFn, fireCap, visibilityMs, maxAttempts, fallbackTz })` — the injectable core: claims + fires due tasks, honoring the fire cap and cancellation-wins.

- [ ] **Step 1: Failing tests** `app/scripts/heartbeat.test.mjs` (drive `tick` with an injected `runFn`, no real `claude`):
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  return import(`./heartbeat.mjs?t=${Date.now()}${Math.random()}`);
}

test("tick fires a due one-shot, removes it on success, logs completed", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.mjs?t=${Date.now()}a`);
  await store.mutate((t) => ({ tasks: [{ id: "o", task: "x", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  const fired = [];
  await tick(Date.parse("2026-01-02T00:00:00Z"), { runFn: async (task) => { fired.push(task.id); return { ok: true }; }, fireCap: 100, visibilityMs: 900000, maxAttempts: 3, fallbackTz: "UTC" });
  assert.deepEqual(fired, ["o"]);
  assert.equal((await store.readTasks()).length, 0);
});

test("tick does NOT fire when the fire cap is exhausted", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.mjs?t=${Date.now()}b`);
  const today = new Date().toISOString();
  for (let i = 0; i < 3; i++) store.appendLog({ ts: today, id: `x${i}`, outcome: "completed" });
  await store.mutate((t) => ({ tasks: [{ id: "d", task: "x", at: "2026-01-01T00:00:00Z", cron: null, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  let fired = 0;
  await tick(Date.parse("2026-01-02T00:00:00Z"), { runFn: async () => { fired++; return { ok: true }; }, fireCap: 3, visibilityMs: 900000, maxAttempts: 3, fallbackTz: "UTC" });
  assert.equal(fired, 0); // cap already reached
});
```

- [ ] **Step 2: Implement** `app/scripts/heartbeat.mjs`:
```js
#!/usr/bin/env node
// The heartbeat driver: one node loop that fires due scheduled tasks. Structural
// twin of poll.mjs. Fires happen OUTSIDE the lock; claims/completions are locked.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { runClaude, ensureSkills, ensurePlaywrightConfig, fillTemplate } from "./runtime.mjs";
import {
  mutate, selectDue, applyClaim, applyOnSuccess, applyOnFailure, appendLog, fireCountToday, resolveNextRun,
} from "./schedule-store.mjs";
import { MEMORY_DIR, LEARNED_SKILLS_DIR, DISCORD_TOKEN_PATH } from "./paths.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const GMAIL_CLI_PATH = join(APP_DIR, "scripts", "gmail.mjs");
const DISCORD_CLI_PATH = join(APP_DIR, "scripts", "discord-cli.mjs");
const PROMPT_PATH = join(APP_DIR, "heartbeat-prompt.md");
const RUNS_DIR = join(APP_DIR, ".claude", "heartbeat-runs");
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");
const SKILL_SRCS = [
  join(APP_DIR, ".claude", "skills", "playwright-cli"),
  join(APP_DIR, "skills", "invisible-playwright"),
  join(APP_DIR, "skills", "discord"),
  join(APP_DIR, "skills", "code"),
];
const MODEL = process.env.BAXTER_MODEL || "sonnet";
const INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_SECONDS || 60) * 1000;
const VISIBILITY_MS = Number(process.env.HEARTBEAT_VISIBILITY_MINUTES || 15) * 60000;
const MAX_ATTEMPTS = Number(process.env.HEARTBEAT_MAX_ATTEMPTS || 3);
const FIRE_CAP = Number(process.env.HEARTBEAT_MAX_FIRES_PER_DAY || 200);
const FALLBACK_TZ = process.env.HEARTBEAT_TZ || "America/Los_Angeles";
// Fired run: Baxter's usual grants MINUS schedule-cli (a scheduled task can't
// touch the schedule); PLUS gmail so it can deliver by email.
const ALLOWED_TOOLS = `Bash(node ${GMAIL_CLI_PATH} *) Bash(node ${DISCORD_CLI_PATH} *) Bash(discord-cli *) Bash(code-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit`;
const RUN_ENV = { ...process.env };
delete RUN_ENV.DISCORD_BOT_TOKEN;

const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter Burgundy";

async function fireTask(task) {
  const deliver = task.deliver
    ? `${task.deliver.surface} -> ${task.deliver.target}`
    : "(no delivery — just do the task; it is logged)";
  // fillTemplate is the project's single-pass, prototype-safe {{KEY}} substitution.
  const prompt = fillTemplate(readFileSync(PROMPT_PATH, "utf8"), {
    PERSONA_NAME, TASK: task.task, DELIVER: deliver,
    DELIVER_SURFACE: task.deliver?.surface || "none", DELIVER_TARGET: task.deliver?.target || "",
    MEMORY_PATH: join(MEMORY_DIR, "memory.md"), GMAIL_CLI_PATH,
  });
  // runClaude resolves { outOfTokens, resetsAt } (no exit code) -- success is a
  // normal completion that wasn't an out-of-tokens abort.
  const { outOfTokens } = await runClaude({
    prompt, logId: `${task.id}-${Date.now()}`, cwd: MEMORY_DIR, model: MODEL,
    allowedTools: ALLOWED_TOOLS, runsDir: RUNS_DIR, env: RUN_ENV,
    beforeRun: () => { ensurePlaywrightConfig(MEMORY_DIR); ensureSkills(SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR); },
  });
  return { ok: !outOfTokens };
}

export async function tick(nowMs, { runFn, fireCap, visibilityMs, maxAttempts, fallbackTz }) {
  const due = selectDue(await (await import("./schedule-store.mjs")).readTasks(), nowMs);
  let capLoggedThisTick = false;
  for (const dueTask of due) {
    if (fireCountToday() >= fireCap) {
      if (!capLoggedThisTick) { appendLog({ ts: new Date(nowMs).toISOString(), id: dueTask.id, task: dueTask.task, outcome: "skipped", detail: "daily fire cap reached" }); capLoggedThisTick = true; }
      break; // stop firing for this tick
    }
    // Claim under the lock; a concurrent cancel makes claim return null -> skip.
    const claimed = await mutate((tasks) => { const r = applyClaim(tasks, dueTask.id, nowMs, visibilityMs); return { tasks: r.tasks, value: r.claimed }; });
    if (!claimed) continue;
    let result;
    try { result = await runFn(claimed); } catch { result = { ok: false }; }
    if (result.ok) {
      await mutate((tasks) => ({ tasks: applyOnSuccess(tasks, claimed.id, nowMs, fallbackTz), value: null }));
      appendLog({ ts: new Date(nowMs).toISOString(), id: claimed.id, task: claimed.task, outcome: "completed", deliver: claimed.deliver });
    } else {
      const { gaveUp } = await mutate((tasks) => { const r = applyOnFailure(tasks, claimed.id, nowMs, maxAttempts, fallbackTz); return { tasks: r.tasks, value: r }; });
      appendLog({ ts: new Date(nowMs).toISOString(), id: claimed.id, task: claimed.task, outcome: gaveUp ? "gave-up" : "failed", deliver: claimed.deliver });
    }
  }
}

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (token) { mkdirSync(dirname(DISCORD_TOKEN_PATH), { recursive: true }); writeFileSync(DISCORD_TOKEN_PATH, JSON.stringify({ token }), { mode: 0o600 }); }
  console.log(`[heartbeat] up; interval ${INTERVAL_MS}ms, fire cap ${FIRE_CAP}/day, tz ${FALLBACK_TZ}`);
  for (;;) {
    try { await tick(Date.now(), { runFn: fireTask, fireCap: FIRE_CAP, visibilityMs: VISIBILITY_MS, maxAttempts: MAX_ATTEMPTS, fallbackTz: FALLBACK_TZ }); }
    catch (err) { console.error(`[heartbeat] tick error: ${err.message}`); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```
(Verified against the code: `runtime.mjs` exports `runClaude`/`ensureSkills`/`ensurePlaywrightConfig`/`fillTemplate`, and `runClaude` resolves `{ outOfTokens, resetsAt }` — hence `ok: !outOfTokens`. `runFn` is injected in tests, so `tick` never touches `claude`.)

- [ ] **Step 3: Run tests** (docker-cp `heartbeat.mjs` + `.test.mjs` + `schedule-store.mjs`). Expected: both pass.

- [ ] **Step 4: Commit**
```bash
git add app/scripts/heartbeat.mjs app/scripts/heartbeat.test.mjs
git commit -m "Add heartbeat driver: tick (claim/fire/complete), fire cap, token file"
```

---

## Task 5: `heartbeat-prompt.md`, the `schedule` skill, and daemon wiring

**Files:**
- Create: `app/heartbeat-prompt.md`, `app/skills/schedule/SKILL.md`
- Modify: `app/Dockerfile`, `app/scripts/poll.mjs`, `app/scripts/discord-bot.mjs`, `app/scripts/runtime.mjs`, `app/prompt.md`, `app/discord-prompt.md`

- [ ] **Step 1: `heartbeat-prompt.md`** — the autonomous-run template. Include: "You are {{PERSONA_NAME}} (fallback to a hardcoded 'Baxter Burgundy'). A scheduled task has come due — carry it out now, then exit; nobody is watching. Task: `{{TASK}}`. When done, **deliver the result to {{DELIVER}}** (post to a Discord channel with `discord-cli`, or send an email with `node {{GMAIL_CLI_PATH}} send <address>`); if delivery is 'none', just do the task. Read your memory at {{MEMORY_PATH}} first." Use only the placeholders `fill()` provides (`TASK`, `DELIVER`, `DELIVER_SURFACE`, `DELIVER_TARGET`, `GMAIL_CLI_PATH`, `MEMORY_PATH`). Keep it short and follow the tone of `discord-prompt.md`.

- [ ] **Step 2: The `schedule` skill** `app/skills/schedule/SKILL.md` — frontmatter `name: schedule`, `allowed-tools: Bash(schedule-cli:*)`, one-line description. Body documents: `schedule-cli add "<task>" (--cron "<expr>" | --at "<ISO>") [--tz <IANA>] [--discord <channelId> | --email <address>]`, `cancel <id>`, `list`; that **cron min interval is 1 hour** (one-shots any time); **set `--tz` to the requester's timezone — ask them if a clock-time task needs it and you don't know**; and where to deliver. Note a scheduled run canNOT itself schedule (no `schedule-cli` inside a fired task).

- [ ] **Step 3: Dockerfile shim** — in `app/Dockerfile` next to the `code-cli` shim:
```dockerfile
RUN printf '#!/bin/sh\nexec node /app/scripts/schedule-cli.mjs "$@"\n' \
      > /usr/local/bin/schedule-cli \
    && chmod +x /usr/local/bin/schedule-cli
```

- [ ] **Step 4: Grant + skill in the email + Discord daemons only.** In `app/scripts/poll.mjs` add `Bash(schedule-cli *)` to its `allowedTools` string and `join(APP_DIR, "skills", "schedule")` to `SKILL_SRCS`. Same two edits in `app/scripts/discord-bot.mjs`. (Do NOT touch `heartbeat.mjs`'s grants — it deliberately omits `schedule-cli`.)

- [ ] **Step 5: Reserve the skill name.** In `app/scripts/runtime.mjs`:
```js
const BAKED_SKILL_NAMES = new Set(["playwright-cli", "invisible-playwright", "discord", "code", "schedule"]);
```

- [ ] **Step 6: Prompt line (both).** In `app/prompt.md` and `app/discord-prompt.md`, add under "What you can do": "Schedule tasks to run later or on a repeat with `schedule-cli` (see the schedule skill): `schedule-cli add "<what to do>" (--cron "<expr>" | --at "<ISO>") [--tz <zone>] [--discord <channelId> | --email <address>]`, `cancel <id>`, `list`. Recurring tasks fire at most hourly; set `--tz` to the asker's timezone (ask if you need it). The scheduled run will deliver where you say."

- [ ] **Step 7: Build + verify wiring**
```bash
make build-app
docker run --rm app-app:latest sh -c 'command -v schedule-cli && echo shim-ok'
grep -q "Bash(schedule-cli \*)" app/scripts/poll.mjs app/scripts/discord-bot.mjs && echo grants-ok
grep -q '"schedule"' app/scripts/runtime.mjs && echo baked-ok
docker run --rm app-app:latest node --test scripts/runtime.test.mjs 2>&1 | grep -E "# (pass|fail)"
```
Expected: `shim-ok`, `grants-ok`, `baked-ok`, runtime tests pass.

- [ ] **Step 8: Commit**
```bash
git add app/heartbeat-prompt.md app/skills/schedule app/Dockerfile app/scripts/poll.mjs app/scripts/discord-bot.mjs app/scripts/runtime.mjs app/prompt.md app/discord-prompt.md
git commit -m "Wire scheduling: heartbeat-prompt, schedule skill, shim, grants, prompts"
```

---

## Task 6: `make heartbeat`, env, and docs

**Files:**
- Modify: `Makefile`, `app/.env.example`, `app/CLAUDE.md`

- [ ] **Step 1: Makefile `heartbeat` target** — add to `.PHONY` and after `codapi` (mirrors `discord`, detached, on the shared network so a fired run reaches codapi + internet):
```makefile
# The scheduler. One detached driver; fires due tasks from the shared schedule.
heartbeat: build-app
	docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	docker rm -f $(PROJECT)-heartbeat >/dev/null 2>&1 || true
	docker run -d --name $(PROJECT)-heartbeat --restart unless-stopped \
		--memory=8g --shm-size=2g \
		--network $(APP_NET) \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE) node scripts/heartbeat.mjs
	@echo "heartbeat driver running"
```

- [ ] **Step 2: `.env.example`** — append the knobs: `HEARTBEAT_INTERVAL_SECONDS=60`, `HEARTBEAT_VISIBILITY_MINUTES=15`, `HEARTBEAT_MAX_ATTEMPTS=3`, `HEARTBEAT_MIN_INTERVAL_MINUTES=60`, `HEARTBEAT_MAX_TASKS=100`, `HEARTBEAT_MAX_FIRES_PER_DAY=200`, `HEARTBEAT_TZ=America/Los_Angeles` — each with a one-line comment.

- [ ] **Step 3: `app/CLAUDE.md`** — a "Heartbeat scheduler" section: the `make heartbeat` single driver; the locked `schedule.json` store + atomic writes; queue/visibility/retry/give-up semantics; the enforced limits (1h min recurrence, max tasks, daily fire cap from the log); `schedule-cli` as the boundary (email/Discord grant it, the heartbeat run does NOT); delivery to Discord/gmail; and the security note (persistence bounded by the limits + caps + visibility). Cross-reference the spec.

- [ ] **Step 4: Commit**
```bash
git add Makefile app/.env.example app/CLAUDE.md
git commit -m "Add make heartbeat target, env knobs, and CLAUDE.md docs"
```

---

## Task 7: Integration + end-to-end

**Files:** none (verification).

- [ ] **Step 1: Stand up** `make codapi` (if not up) + `make heartbeat`; confirm the driver logs "up".
- [ ] **Step 2: One-shot e2e** — `docker exec <project>-heartbeat schedule-cli add "say the scheduler works" --at "<~90s from now, ISO Z>" --discord <a test channel>`; within ~2 min confirm the driver fires a run, Baxter posts to the channel, the task is gone from `schedule-cli list`, and `task-log.jsonl` has a `completed` line.
- [ ] **Step 3: Cron reschedule** — add a `--cron "0 * * * *"` task; after a fire confirm `next_run_at` advanced (via `schedule-cli list`) rather than the task being removed.
- [ ] **Step 4: Limit** — confirm `schedule-cli add … --cron "* * * * *"` is rejected.
- [ ] **Step 5:** No commit (verification); record results in the progress ledger.

---

## Self-Review

**Spec coverage:** single driver + `make heartbeat` (Task 6) ✓; schedule.json shape + tz-as-given (Tasks 1,3) ✓; cron+at+deliver (Tasks 1,3) ✓; queue claim→null-skip/visibility/success/failure/give-up + cancellation-wins (Tasks 1,4) ✓; enforced limits min-recurrence-horizon/max-tasks/daily-fire-cap-from-log (Tasks 3,4) ✓; lock+atomic (Task 2) ✓; task log incl. `skipped` (Tasks 2,4) ✓; fired run excludes `schedule-cli`, includes gmail+discord (Task 4) ✓; token file at startup (Task 4) ✓; schedule-cli grant in email/Discord only, skill, prompts, BAKED (Task 5) ✓; docs (Task 6) ✓.

**Placeholder scan:** every code step has complete code; the `runClaude` return shape (`{ outOfTokens }`, so `ok: !outOfTokens`) and `runtime.mjs`'s exports were verified against the code before writing, not left as a TODO.

**Type consistency:** `resolveNextRun({cron,at,tz}, nowMs, fallbackTz)`, `applyClaim(...)→{tasks,claimed}`, `applyOnSuccess(...)→tasks`, `applyOnFailure(...)→{tasks,gaveUp}`, `mutate(fn)` where `fn(tasks)→{tasks,value}`, `parseAdd(argv)→{task,cron,at,tz,deliver}`, `tick(now,{runFn,fireCap,visibilityMs,maxAttempts,fallbackTz})` — consistent across Tasks 1–4. `deliver` shape `{surface,target}` matches spec and Task 5's prompt fill.
