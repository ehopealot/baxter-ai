// Pure queue logic for the heartbeat scheduler. No I/O here (see the lock/atomic
// I/O section below, added in Task 2). cron-parser computes occurrences; every
// time value is stored as an absolute UTC ISO string.
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import parser from "cron-parser";

// A task's recurrence spec: exactly one of cron/at is set (schedule-cli
// enforces this), tz falls back to the caller's fallbackTz when unset. Shared
// shape for resolveNextRun and the pure queue helpers below, which only need
// these three fields (plus id/next_run_at/invisible_until/attempts) regardless
// of what else a real persisted task record carries.
interface RecurrenceSpec {
  cron?: string | null;
  at?: string | null;
  tz?: string | null;
}

export function newId(): string {
  return randomBytes(4).toString("hex");
}

// Reserved namespace for runtime-owned system tasks (2026-08-20 system
// scheduled tasks): reconciliation exclusively creates canonical registry-owned
// records under `system:` ids; validated CLI and heartbeat paths may mutate
// their enabled and queue state. Every id-minting path must refuse the prefix
// (mintTaskId below).
export function isReservedId(id: string): boolean {
  return id.startsWith("system:");
}
export function mintTaskId(): string {
  let id = newId();
  while (isReservedId(id)) id = newId(); // guard: hex ids can't hit it, but no minting path may ever rely on that
  return id;
}

// Reject a non-numeric env var loudly rather than let NaN silently disable a
// limit (NaN comparisons fail open) -- these numeric knobs are code-enforced
// guardrails (rate caps, concurrency caps, poll intervals). A generic env parser
// shared across the fleet's daemons and CLIs, not scheduler-specific.
export function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return dflt; // unset/blank -> default
  const n = Number(raw);
  // Reject non-integers and negatives too: " " (=>0), "-1", "1.5" would all fail
  // the guardrail open (or hot-spin the loop), the same hazard as a NaN.
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  return n;
}

// Absolute UTC ISO for a task's next fire. `at` with an offset/Z is absolute;
// a naive `at` is interpreted as wall-clock in tz||fallbackTz; every `cron` is
// read in tz||fallbackTz via cron-parser.
export function resolveNextRun({ cron, at, tz }: RecurrenceSpec, nowMs: number, fallbackTz: string): string {
  const zone = tz || fallbackTz;
  if (at) {
    if (/[zZ]|[+-]\d\d:?\d\d$/.test(at)) return new Date(at).toISOString(); // absolute
    return naiveInZoneToISO(at, zone);                                      // wall-clock in zone
  }
  const it = parser.parseExpression(cron as string, { currentDate: new Date(nowMs), tz: zone });
  return it.next().toDate().toISOString();
}

// A naive "YYYY-MM-DDTHH:MM[:SS]" wall-clock time in `zone` -> absolute UTC ISO.
// Keeps the year (unlike a cron approximation). The DST-correct two-pass zone
// conversion lives in the shared tz.ts (also used by ical.ts).
function naiveInZoneToISO(naive: string, zone: string): string {
  const m = naive.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/);
  if (!m) throw new Error(`invalid --at timestamp: ${naive}`);
  const [, Y, Mo, D, H, Mi, S] = m;
  return new Date(zonedToUtcMs(+Y, +Mo, +D, +H, +Mi, +(S || 0), zone)).toISOString();
}

export function cronMinGapMinutes(cron: string, tz: string | null | undefined, fallbackTz: string, horizon = 100): number {
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

interface DueLike {
  next_run_at: string;
  invisible_until?: string | null;
}
export function selectDue<T extends DueLike>(tasks: T[], nowMs: number): T[] {
  return tasks.filter(
    (t) => Date.parse(t.next_run_at) <= nowMs &&
      (t.invisible_until == null || Date.parse(t.invisible_until) <= nowMs),
  );
}

interface ClaimLike {
  id: string;
  invisible_until?: string | null;
}
export function applyClaim<T extends ClaimLike>(tasks: T[], id: string, nowMs: number, visibilityMs: number): { tasks: T[]; claimed: T | null } {
  const invisible_until = new Date(nowMs + visibilityMs).toISOString();
  let claimed: T | null = null;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    claimed = { ...t, invisible_until } as T;
    return claimed;
  });
  return { tasks: claimed ? next : tasks, claimed };
}

interface QueueTask extends RecurrenceSpec {
  id: string;
  next_run_at?: string;
  invisible_until?: string | null;
  attempts?: number;
}
export function applyOnSuccess<T extends QueueTask>(tasks: T[], id: string, nowMs: number, fallbackTz: string, nextOccurrence?: (task: T) => string): T[] {
  if (!tasks.some((t) => t.id === id)) return tasks; // cancellation won
  return tasks.flatMap((t) => {
    if (t.id !== id) return [t];
    if (t.cron) return [{ ...t, next_run_at: nextOccurrence ? nextOccurrence(t) : resolveNextRun(t, nowMs, fallbackTz), invisible_until: null, attempts: 0 } as T];
    return []; // one-shot: remove
  });
}

export function applyOnFailure<T extends QueueTask>(tasks: T[], id: string, nowMs: number, maxAttempts: number, fallbackTz: string, nextOccurrence?: (task: T) => string): { tasks: T[]; gaveUp: boolean } {
  if (!tasks.some((t) => t.id === id)) return { tasks, gaveUp: false }; // cancellation won
  let gaveUp = false;
  const next = tasks.flatMap((t) => {
    if (t.id !== id) return [t];
    const attempts = (t.attempts || 0) + 1;
    if (attempts < maxAttempts) return [{ ...t, attempts } as T]; // leave invisible_until -> retry after window
    gaveUp = true;
    if (t.cron) return [{ ...t, next_run_at: nextOccurrence ? nextOccurrence(t) : resolveNextRun(t, nowMs, fallbackTz), invisible_until: null, attempts: 0 } as T];
    return []; // one-shot: drop
  });
  return { tasks: next, gaveUp };
}

// --- Locked/atomic I/O ---------------------------------------------------
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from "node:fs";
import lockfile from "proper-lockfile";
import { SCHEDULE_PATH as DEFAULT_PATH, SCHEDULE_LOG_PATH as DEFAULT_LOG } from "./paths.ts";
import { zonedToUtcMs } from "./tz.ts";

// One persisted task record. schedule-cli creates ordinary records, while
// reconciliation exclusively creates canonical registry-owned reserved-ID
// records; validated CLI and heartbeat paths may mutate enabled and queue
// state. This store treats schedule.json as an array of records keyed by id.
// The type extends the pure-helper QueueTask (id/cron/at/tz/invisible_until/
// attempts) rather than re-declaring those fields, and makes `next_run_at`
// REQUIRED: creation paths set it, and heartbeat.ts feeds readTasks() straight
// into selectDue (whose DueLike bound requires it).
export interface TaskDeliver {
  // "sms-group" (spec 2026-08-18-scheduled-sms-group-delivery): target is the EXACT
  // provider group id (never a display name); schedule-cli validates it strict and
  // transcript-admitted at add time, and sms-cli re-checks at fire time. Existing
  // persisted records with the older three surfaces remain compatible.
  surface: "discord" | "mail" | "sms" | "sms-group";
  target: string;
}
export interface Task extends QueueTask {
  next_run_at: string;
  task?: string;
  desc?: string; // user-facing label shown on the home /scheduled page (distinct from the `task` prompt)
  deliver?: TaskDeliver | null;
  created_at?: string;
  // Runtime-owned system task metadata (2026-08-20 system scheduled tasks):
  // absence means an ordinary legacy/user task. Reconciliation exclusively
  // creates canonical registry-owned records under the reserved `system:` id
  // namespace; validated CLI and heartbeat paths may mutate their enabled and
  // queue state. `enabled` is strict (handlers execute only on literal true).
  // System records carry no task prompt and deliver is null.
  system?: SystemTaskState;
  // A separate, one-shot invocation of a registered system task. The marker
  // names only the registry key; reconciliation validates the rest of the
  // record before heartbeat can dispatch it. Unlike `system`, this record uses
  // an ordinary id and is removed after one-shot success/give-up.
  system_trigger?: SystemTaskTriggerState;
}

export interface SystemTaskTriggerState {
  key: string;
}

// The `system` field of a runtime-owned system task record: `key` names the
// compile-time registry entry that owns the record (handler identity never
// comes from disk), `enabled` is a strict boolean.
export interface SystemTaskState {
  key: string;
  enabled: boolean;
}

// task-log.jsonl records completed, hard-failed, and gave-up outcomes. Cap
// deferral emits at most one skipped entry per UTC day; other deferred
// occurrences and out-of-token attempts remain unlogged.
export interface LogEntry {
  ts: string;
  id: string;
  task?: string;
  outcome: "completed" | "failed" | "gave-up" | "skipped";
  detail?: string;
  deliver?: TaskDeliver | null;
  // Audit-only fields (2026-08-20 system scheduled tasks): whether this fire
  // consumed a model run, and the registry key when a system task fired.
  // Optional so existing readers/writers stay compatible with their absence.
  agent_run?: boolean;
  system_key?: string;
}

// Test isolation: point the store at a temp dir without touching paths.ts.
function schedulePath(): string {
  const o = process.env.SCHEDULE_DIR_OVERRIDE;
  return o ? join(o, "schedule.json") : DEFAULT_PATH;
}
function logPath(): string {
  const o = process.env.SCHEDULE_DIR_OVERRIDE;
  return o ? join(o, "task-log.jsonl") : DEFAULT_LOG;
}

function ensureFile(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
  // Atomic create ("wx" = fail if exists): a check-then-write pair isn't atomic,
  // so two processes racing the first-ever write could clobber a just-created
  // schedule -- the very lost-update this store exists to prevent.
  try { writeFileSync(p, "[]", { flag: "wx" }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
}

export async function readTasks(): Promise<Task[]> {
  const p = schedulePath();
  if (!existsSync(p)) return [];
  // Loud on corruption (writes are atomic, so a bad file is external + rare):
  // surface it rather than silently masking the schedule as empty in `list`.
  try { return JSON.parse(readFileSync(p, "utf8")) as Task[]; }
  catch (err) { console.error(`schedule-store: ${p} unreadable (${(err as Error).message}); treating as empty`); return []; }
}

export async function mutate<V>(fn: (tasks: Task[]) => { tasks: Task[]; value: V }): Promise<V> {
  const p = schedulePath();
  ensureFile(p);
  const release = await lockfile.lock(p, {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    const tasks = JSON.parse(readFileSync(p, "utf8")) as Task[];
    // Snapshot the INPUT serialization BEFORE the callback runs: the skip test
    // below compares against it, so a callback that mutates its Task[] argument
    // in place and returns it IS detected as a change and persists. (Serializing
    // both sides after fn would make an in-place mutation identical on both
    // sides and silently drop the write -- a lost update in the very store that
    // exists to prevent them, and a trap for reconciliation callers that mutate
    // records inside their transaction.)
    const before = JSON.stringify(tasks);
    const { tasks: nextTasks, value } = fn(tasks);
    // No-change transactions skip the atomic rewrite entirely: callers that
    // reconcile/repair without changing anything must not churn schedule.json
    // (the Home schedule-mirror watcher re-reads on every rewrite). Equality is
    // on JSON serialization against the PRE-CALLBACK snapshot above, so callers
    // returning the SAME unmutated objects (or key-order-stable copies) skip;
    // a changed transaction keeps the tmp+rename atomic replace below.
    if (JSON.stringify(nextTasks) !== before) {
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(nextTasks, null, 2));
      renameSync(tmp, p); // atomic replace
    }
    return value;
  } finally {
    await release();
  }
}

export function appendLog(entry: LogEntry): void {
  const p = logPath();
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
}

// One shared scan of today's (UTC) log entries; both counters read off it so a
// future change to log parsing lives in one place. `now` is INJECTABLE (T6):
// quota reset, first-use seeding, and skipped-line logging must all derive
// "today" from one supplied instant rather than the ambient wall clock — the
// default keeps existing no-arg callers (and tests) reading the real date.
function todaysLogEntries(now: Date = new Date()): LogEntry[] {
  const p = logPath();
  if (!existsSync(p)) return [];
  const today = now.toISOString().slice(0, 10);
  return readFileSync(p, "utf8").split("\n").flatMap((line): LogEntry[] => {
    if (!line.trim()) return [];
    try { const e = JSON.parse(line) as LogEntry; return String(e.ts).slice(0, 10) === today ? [e] : []; }
    catch { return []; }
  });
}
export function fireCountToday(now: Date = new Date()): number { return todaysLogEntries(now).filter((e) => e.outcome !== "skipped").length; }
// True if a daily-fire-cap `skipped` line was already written today (UTC), so
// the driver appends it at most once per day, not once per tick.
export function capSkipLoggedToday(now: Date = new Date()): boolean { return todaysLogEntries(now).some((e) => e.outcome === "skipped"); }
