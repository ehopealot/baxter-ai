// Durable UTC-date agent-run quota reservations for the heartbeat scheduler
// (2026-08-20 system scheduled tasks, T6). Replaces post-fire log-derived
// counting with a check-and-record reservation state (fire-quota.json beside
// schedule.json, same SCHEDULE_DIR_OVERRIDE resolution), so the daily model-run
// cap is enforced BEFORE a model run rather than discovered after it.
//
// The reservation lock is SEPARATE from schedule-store.mutate's lock (a
// different target entirely): reservation must never run inside a store
// transaction, and its check-and-record is one atomic step under this lock, so
// two simultaneous reserves with exactly one slot left yield exactly one token.
//
// WRITE DISCIPLINE (durability): a reserve that CHANGES state -- first-use
// seeding, corruption recovery, or a UTC-day rollover reset -- persists the
// resulting file EVEN WHEN the reservation is denied; "null and write nothing"
// applies only to an already-valid, same-UTC-day, unchanged full window. The
// approved spec's literal "writes nothing" sentence read together with its
// "later rollovers reset to empty and never re-seed from the log" rule would
// otherwise be unsatisfiable: a state-changing call that returned null without
// persisting would leave no durable state, so every later same-day call would
// re-derive the legacy-log migration from a log that keeps growing
// (post-deployment fires double-counting as seed entries plus their own
// reservations) and could overwrite a hand-repaired file. See the plan's
// "Resolved implementation clarifications" for the disclosed narrowing.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import lockfile from "proper-lockfile";
import { SCHEDULE_PATH } from "./paths.ts";
import { fireCountToday } from "./schedule-store.ts";

// One occupied agent-run slot. `id` is the opaque token handed to the reserving
// fire (release's key); `task` binds the reservation to the id of the task that
// actually fired, so the persisted state audits which task burned each slot.
export interface QuotaReservation {
  id: string;
  task: string;
  ts: string; // ISO instant of the reservation
}

export interface QuotaState {
  version: 1;
  date: string; // UTC date token (YYYY-MM-DD) these reservations belong to
  reservations: QuotaReservation[];
}

// Same test-isolation resolution as schedulePath() in schedule-store.ts: the
// quota file sits BESIDE schedule.json, so one SCHEDULE_DIR_OVERRIDE moves both.
function quotaDir(): string {
  const o = process.env.SCHEDULE_DIR_OVERRIDE;
  return o ? o : dirname(SCHEDULE_PATH);
}
function quotaPath(): string { return join(quotaDir(), "fire-quota.json"); }

// Read + validate. null means first use (absent, corrupt, or version != 1):
// the caller re-derives today's window from the legacy log exactly once;
// afterwards this file is the only source of truth. A parseable v1 file is
// still corruption unless its SHAPE is fully valid -- date must be a REAL UTC
// calendar date (regex shape plus round-trip: 2024-02-30 and 2024-99-99 pass
// the regex but no UTC instant carries them, so they are corruption, not a
// date), every reservation a non-null object with a non-empty string id and
// string task/ts, and reservation ids UNIQUE across the file:
// releaseAgentRunSlot's filter(r => r.id !== token) removes EVERY entry
// sharing a token, so a duplicate-id file would let one release free multiple
// slots from a single token and bypass the durable cap, contradicting
// release's "can never remove another fire's reservation" invariant. Live
// system-written files never trip the uniqueness check (minted tokens are
// randomBytes(16), seed ids are seed-<i> -- unique by construction); only
// hand-edited or corrupted files do. So a garbage or impossible date, a null
// entry, or a repeated id can never pose as a rollover (fail-open reset+grant)
// or crash releaseAgentRunSlot's some(). Only a shape-valid DIFFERENT-day
// date takes the rollover path.
const UTC_DATE_TOKEN = /^\d{4}-\d{2}-\d{2}$/;
// Shape-valid but IMPOSSIBLE dates (Feb 30, month 99) must be corruption, not
// a rollover: they can never equal today, so a regex-only check would route
// them to the reset-and-grant path and fail the cap open. Date.UTC normalizes
// overflow (Feb 30 -> Mar 1), so a Y/M/D round-trip equality proves the date
// exists on the real calendar.
function validUtcDateToken(date: string): boolean {
  if (!UTC_DATE_TOKEN.test(date)) return false;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  return roundTrip.getUTCFullYear() === y && roundTrip.getUTCMonth() === m - 1 && roundTrip.getUTCDate() === d;
}
function readState(p: string): QuotaState | null {
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as Partial<QuotaState>;
    if (
      s.version !== 1 ||
      typeof s.date !== "string" || !validUtcDateToken(s.date) ||
      !Array.isArray(s.reservations) ||
      !s.reservations.every((r) =>
        typeof r === "object" && r !== null &&
        typeof r.id === "string" && r.id.length > 0 &&
        typeof r.task === "string" && typeof r.ts === "string") ||
      new Set(s.reservations.map((r) => r.id)).size !== s.reservations.length
    ) return null;
    return { version: 1, date: s.date, reservations: s.reservations };
  } catch { return null; }
}

function writeState(p: string, s: QuotaState): void {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p); // atomic replace
}

// proper-lockfile creates only the '<target>.lock' entry itself, so the parent
// directory must exist before acquisition (same discipline as
// schedule-store's ensureFile). Store-family conventions (realpath: false,
// bounded retries, small stale window, release in finally). This lock target is
// dedicated to the quota state -- never schedule.json's.
async function withQuotaLock<T>(fn: () => T): Promise<T> {
  const target = join(quotaDir(), "fire-quota.lock");
  mkdirSync(dirname(target), { recursive: true });
  const release = await lockfile.lock(target, {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try { return fn(); } finally { await release(); }
}

const utcDateToken = (now: Date): string => now.toISOString().slice(0, 10);

// Reserve one agent-run slot for `taskId` in the UTC day of `now`. Returns a
// token the caller releases ONLY on the atomic-refund path (an out-of-tokens
// provider outage must not burn cap); success and hard failure keep the slot
// consumed, and a crash after reserving conservatively burns it. Null means
// the window is full (the caller defers to the next UTC reset).
export function reserveAgentRunSlot(now: Date, cap: number, taskId: string): Promise<{ token: string } | null> {
  return withQuotaLock(() => {
    const p = quotaPath();
    const today = utcDateToken(now);
    const stored = readState(p);
    let state: QuotaState;
    let changed = false;
    if (stored === null) {
      // First use (absent/corrupt/version-mismatched): seed today's window from
      // the legacy log's non-skipped fires, counted at the INJECTED instant's
      // UTC day -- never the ambient wall clock. N may reach or exceed cap;
      // over-counting is the fail-closed direction. Derived EXACTLY ONCE: the
      // state persisted below (denied or not) is authoritative afterwards.
      const n = fireCountToday(now);
      state = {
        version: 1, date: today,
        reservations: Array.from({ length: n }, (_, i): QuotaReservation => ({
          id: `seed-${i}`, task: "legacy-seed", ts: now.toISOString(),
        })),
      };
      changed = true;
    } else if (stored.date !== today) {
      // UTC-day rollover: reset to the empty window for the new day. Never
      // re-seeds from the log (the persisted state, not the log, is
      // authoritative once it exists).
      state = { version: 1, date: today, reservations: [] };
      changed = true;
    } else {
      state = stored;
    }
    if (state.reservations.length < cap) {
      // Check-and-record is one step under the lock: the slot is appended and
      // persisted before the lock is released, so a contender re-reads the
      // post-append state and cannot double-take the last slot.
      const token = randomBytes(16).toString("hex");
      state = { ...state, reservations: [...state.reservations, { id: token, task: taskId, ts: now.toISOString() }] };
      writeState(p, state);
      return { token };
    }
    if (changed) writeState(p, state); // durability: a denied but state-changing reserve persists
    return null;
  });
}

// Remove exactly the reservation holding `token`, restoring the slot.
// Idempotent (a missing token is a no-op) and it can never remove another
// fire's reservation: the state tracks tokens, not a bare count.
export function releaseAgentRunSlot(token: string): Promise<void> {
  return withQuotaLock(() => {
    const p = quotaPath();
    const state = readState(p);
    if (state === null || !state.reservations.some((r) => r.id === token)) return;
    // readState guarantees ids are unique, so this filter removes EXACTLY the
    // one reservation holding `token`; a duplicate-id file never reaches here
    // (it reads as corruption above and release is a no-op).
    writeState(p, { ...state, reservations: state.reservations.filter((r) => r.id !== token) });
  });
}
