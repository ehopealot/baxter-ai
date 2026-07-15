// Pure queue logic for the heartbeat scheduler. No I/O here (see the lock/atomic
// I/O section below, added in Task 2). cron-parser computes occurrences; every
// time value is stored as an absolute UTC ISO string.
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import parser from "cron-parser";

export function newId() {
  return randomBytes(4).toString("hex");
}

// Reject a non-numeric env var loudly rather than let NaN silently disable a
// limit (NaN comparisons fail open) -- the scheduler's caps are security
// guardrails. Shared by schedule-cli and the heartbeat driver.
export function envInt(name, dflt) {
  const n = Number(process.env[name] || dflt);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got: ${process.env[name]}`);
  return n;
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
// Keeps the year (unlike a cron approximation). Iterating the offset once makes
// it correct across DST transitions too -- a single correction is wrong for the
// hours around a transition that lies between `guess` and the true instant;
// only inside the gap/fold itself is either answer defensible.
function naiveInZoneToISO(naive, zone) {
  const m = naive.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/);
  if (!m) throw new Error(`invalid --at timestamp: ${naive}`);
  const [, Y, Mo, D, H, Mi, S] = m;
  const guess = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0));
  const o1 = zoneOffsetMs(zone, guess);
  const o2 = zoneOffsetMs(zone, guess - o1);
  return new Date(guess - o2).toISOString();
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

// --- Locked/atomic I/O (Task 2) ------------------------------------------
// Everything above this line is pure and unchanged from Task 1.
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from "node:fs";
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
  // Atomic create ("wx" = fail if exists): a check-then-write pair isn't atomic,
  // so two processes racing the first-ever write could clobber a just-created
  // schedule -- the very lost-update this store exists to prevent.
  try { writeFileSync(p, "[]", { flag: "wx" }); }
  catch (err) { if (err.code !== "EEXIST") throw err; }
}

export async function readTasks() {
  const p = schedulePath();
  if (!existsSync(p)) return [];
  // Loud on corruption (writes are atomic, so a bad file is external + rare):
  // surface it rather than silently masking the schedule as empty in `list`.
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (err) { console.error(`schedule-store: ${p} unreadable (${err.message}); treating as empty`); return []; }
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

// One shared scan of today's (UTC) log entries; both counters read off it so a
// future change to log parsing lives in one place.
function todaysLogEntries() {
  const p = logPath();
  if (!existsSync(p)) return [];
  const today = new Date().toISOString().slice(0, 10);
  return readFileSync(p, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { const e = JSON.parse(line); return String(e.ts).slice(0, 10) === today ? [e] : []; }
    catch { return []; }
  });
}
export function fireCountToday() { return todaysLogEntries().filter((e) => e.outcome !== "skipped").length; }
// True if a daily-fire-cap `skipped` line was already written today (UTC), so
// the driver appends it at most once per day, not once per tick.
export function capSkipLoggedToday() { return todaysLogEntries().some((e) => e.outcome === "skipped"); }
