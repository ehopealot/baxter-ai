// Shared daily send-cap state, read/written by whichever process actually
// sends (mail.ts's `reply`/`send` commands; discord-bot.ts + discord-cli.ts on the Discord side) and read-only by
// poll.ts, which uses it to avoid dispatching a claude run when there's
// obviously no budget left. The cap only has teeth because the increment
// lives at the actual send call, not at dispatch time -- a single run can
// still send more than one message, but each one counts.
//
// Email and Discord each get their own counter (own file, own env var, own
// default) built from the same factory below, since the two channels' daily
// budgets are independent.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { SEND_STATE_PATH, DISCORD_SEND_STATE_PATH } from "./paths.ts";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";

// The one JSON shape the counter file holds: today's (UTC) date + how many
// sends have been recorded so far today.
interface SendState {
  date: string;
  count: number;
  /** Durable logical-send reservations; absent in legacy counter files. */
  reservations?: string[];
}

// Test isolation: redirect the counter files to a temp dir without touching
// paths.ts (mirrors schedule-store's SCHEDULE_DIR_OVERRIDE). Only the file
// LOCATION changes; the counter logic is identical.
function counterPath(defaultPath: string): string {
  const o = process.env.SEND_STATE_DIR_OVERRIDE;
  return o ? join(o, basename(defaultPath)) : defaultPath;
}

// Pure: resolve a daily cap from an env string, with the same guards the
// project has always used (blank -> default, since Number("") is 0; NaN or
// negative -> default rather than a silent 0-cap lockout; 0 kept as an
// explicit kill switch).
// label names the offending env var in the warning -- with two caps in play
// (MAX_SENDS_PER_DAY and DISCORD_MAX_SENDS_PER_DAY), "raw" alone can't say
// which one an operator typo'd.
export function parseMaxSends(raw: string | undefined, defaultMax: number, label = "send cap"): number {
  if (raw === undefined || raw.trim() === "") return defaultMax;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid ${label}="${raw}", falling back to ${defaultMax}.`);
    return defaultMax;
  }
  return parsed;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function invalidSendState(detail: string): Error {
  return new Error(`invalid send state: ${detail}`);
}

function validUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value; }
  catch { return false; }
}

function parseSendState(raw: string): SendState {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw invalidSendState("malformed JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSendState("expected an object");
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state);
  if (!keys.every(key => key === "date" || key === "count" || key === "reservations")
    || !keys.includes("date") || !keys.includes("count")) throw invalidSendState("unexpected shape");
  if (!validUtcDate(state.date)) throw invalidSendState("invalid date");
  if (!Number.isSafeInteger(state.count) || (state.count as number) < 0) throw invalidSendState("invalid count");
  if (state.reservations !== undefined) {
    if (!Array.isArray(state.reservations)
      || !state.reservations.every(id => typeof id === "string" && id.length > 0 && id.length <= 256)
      || new Set(state.reservations).size !== state.reservations.length
      || state.reservations.length > (state.count as number)) throw invalidSendState("invalid reservations");
  }
  return {
    date: state.date,
    count: state.count as number,
    ...(state.reservations !== undefined ? { reservations: state.reservations as string[] } : {}),
  };
}

function readSendStateForMutation(path: string): SendState {
  const state = parseSendState(readFileSync(path, "utf8"));
  const today = todayUTC();
  if (state.date > today) throw invalidSendState("date is in the future");
  return state.date < today ? { date: today, count: 0 } : state;
}

let fsyncFileImpl = fsyncSync;
let tempSequence = 0;

// Create the lock target only after its ancestry, inode, and directory entry are
// durable. An existing target is repaired before use as well: it may be the
// visible result of a prior process whose final directory fsync failed.
function ensureFile(path: string): void {
  const directory = dirname(path);
  ensureDurableDirectory(directory);
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ date: todayUTC(), count: 0 }));
    fsyncFileImpl(fd);
    closeSync(fd); fd = undefined;
    syncDirectory(directory);
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = openSync(path, "r");
    try { fsyncFileImpl(existing); } finally { closeSync(existing); }
    syncDirectory(directory);
  }
}

function durableReplace(path: string, state: SendState): void {
  const directory = dirname(path);
  const tmp = `${path}.${process.pid}.${++tempSequence}.tmp`;
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(state));
    fsyncFileImpl(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    renamed = true;
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (!renamed) {
      try { unlinkSync(tmp); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

// Builds a { MAX, load, record } counter over one JSON file + one env var. `path`
// is resolved through counterPath so tests can redirect it.
function createCounter(defaultPath: string, envVar: string, defaultMax: number) {
  const MAX = parseMaxSends(process.env[envVar], defaultMax, envVar);
  function load(): SendState {
    try {
      const state = parseSendState(readFileSync(counterPath(defaultPath), "utf8"));
      return state.date === todayUTC() ? state : { date: todayUTC(), count: 0 };
    } catch {
      // Read-only cap displays retain their historical empty fallback. The two
      // mutating paths below use strict parsing and never publish from it.
      return { date: todayUTC(), count: 0 };
    }
  }
  // The cap is one of the project's real safety nets (see the Guardrail
  // philosophy in app/CLAUDE.md), so its counter must survive concurrency. A
  // send can fire from several processes at once (Discord runs up to
  // MAX_CONCURRENT + reaction runs in parallel, each shelling out to
  // discord-cli; a mail run's mail-cli can overlap the mail surface), and an unlocked
  // read-modify-write across processes loses updates -- two readers see count N,
  // both write N+1, one send goes uncounted, and the cap leaks. So take a
  // cross-process lock (proper-lockfile, the same mechanism schedule-store's
  // `mutate` uses) around the read-modify-write and replace via temp+rename.
  // Async because lock acquisition backs off/retries under contention; every
  // caller already awaits at an async send site.
  async function record(): Promise<SendState> {
    ensureFile(counterPath(defaultPath));
    const path = counterPath(defaultPath);
    const release = await lockfile.lock(path, {
      realpath: false, stale: 10000,
      retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
    });
    try {
      const state = readSendStateForMutation(path);
      state.count += 1;
      durableReplace(path, state);
      return state;
    } finally {
      await release();
    }
  }

  /** Atomically reserve one cap slot. A durable identity makes crash replay a
   * no-op even when the counter has since reached its cap. */
  async function reserve(reservationId?: string): Promise<{ state: SendState; reserved: boolean }> {
    if (reservationId !== undefined && (!reservationId || reservationId.length > 256)) throw new Error("invalid send quota reservation id");
    ensureFile(counterPath(defaultPath));
    const path = counterPath(defaultPath);
    const release = await lockfile.lock(path, {
      realpath: false, stale: 10000,
      retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
    });
    try {
      const state = readSendStateForMutation(path);
      if (reservationId && state.reservations?.includes(reservationId)) return { state, reserved: false };
      if (state.count >= MAX) throw new Error(`${envVar} daily send cap (${MAX}) reached`);
      state.count += 1;
      if (reservationId) state.reservations = [...(state.reservations ?? []), reservationId];
      durableReplace(path, state);
      return { state, reserved: true };
    } finally {
      await release();
    }
  }
  return { MAX, load, record, reserve };
}

const email = createCounter(SEND_STATE_PATH, "MAX_SENDS_PER_DAY", 500);
export const MAX_SENDS_PER_DAY = email.MAX;
export const loadSendState = email.load;
export const recordSend = email.record;

const discord = createCounter(DISCORD_SEND_STATE_PATH, "DISCORD_MAX_SENDS_PER_DAY", 2500);
export const DISCORD_MAX_SENDS_PER_DAY = discord.MAX;
export const loadDiscordSendState = discord.load;
export const recordDiscordSend = discord.record;

// Exported for tests to build a counter over a temp path (see send-state.test.ts).
export { createCounter };

/** Narrow ordering/fault seam; production always uses node:fs fsyncSync. */
export function setSendStateFsyncForTest(replacement: typeof fsyncSync): () => void {
  const previous = fsyncFileImpl;
  fsyncFileImpl = replacement;
  return () => { fsyncFileImpl = previous; };
}
