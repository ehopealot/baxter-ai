// Shared daily send-cap state, read/written by whichever process actually
// sends (gmail.mjs's `reply` command, and the Discord bot) and read-only by
// poll.mjs, which uses it to avoid dispatching a claude run when there's
// obviously no budget left. The cap only has teeth because the increment
// lives at the actual send call, not at dispatch time -- a single run can
// still send more than one message, but each one counts.
//
// Email and Discord each get their own counter (own file, own env var, own
// default) built from the same factory below, since the two channels' daily
// budgets are independent.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { SEND_STATE_PATH, DISCORD_SEND_STATE_PATH } from "./paths.mjs";

// Test isolation: redirect the counter files to a temp dir without touching
// paths.mjs (mirrors schedule-store's SCHEDULE_DIR_OVERRIDE). Only the file
// LOCATION changes; the counter logic is identical.
function counterPath(defaultPath) {
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
export function parseMaxSends(raw, defaultMax, label = "send cap") {
  if (raw === undefined || raw.trim() === "") return defaultMax;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid ${label}="${raw}", falling back to ${defaultMax}.`);
    return defaultMax;
  }
  return parsed;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Create the counter file (dir + a valid empty doc) if missing, so proper-lockfile
// has an existing target to attach its `.lock` to. Atomic "wx" (fail-if-exists),
// like schedule-store's ensureFile, so two processes racing the first-ever write
// can't clobber each other before the lock even exists.
function ensureFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, JSON.stringify({ date: todayUTC(), count: 0 }), { flag: "wx" }); }
  catch (err) { if (err.code !== "EEXIST") throw err; }
}

// Builds a { MAX, load, record } counter over one JSON file + one env var. `path`
// is resolved through counterPath so tests can redirect it.
function createCounter(defaultPath, envVar, defaultMax) {
  const MAX = parseMaxSends(process.env[envVar], defaultMax, envVar);
  function load() {
    try {
      const state = JSON.parse(readFileSync(counterPath(defaultPath), "utf8"));
      return state.date === todayUTC() ? state : { date: todayUTC(), count: 0 };
    } catch {
      return { date: todayUTC(), count: 0 };
    }
  }
  // The cap is one of the project's real safety nets (see the Guardrail
  // philosophy in app/CLAUDE.md), so its counter must survive concurrency. A
  // send can fire from several processes at once (Discord runs up to
  // MAX_CONCURRENT + reaction runs in parallel, each shelling out to
  // discord-cli; a mail run's gmail.mjs can overlap the poller), and an unlocked
  // read-modify-write across processes loses updates -- two readers see count N,
  // both write N+1, one send goes uncounted, and the cap leaks. So take a
  // cross-process lock (proper-lockfile, the same mechanism schedule-store's
  // `mutate` uses) around the read-modify-write and replace via temp+rename.
  // Async because lock acquisition backs off/retries under contention; every
  // caller already awaits at an async send site.
  async function record() {
    ensureFile(counterPath(defaultPath));
    const path = counterPath(defaultPath);
    const release = await lockfile.lock(path, {
      realpath: false, stale: 10000,
      retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
    });
    try {
      const state = load();
      state.count += 1;
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, path); // atomic replace
      return state;
    } finally {
      await release();
    }
  }
  return { MAX, load, record };
}

const email = createCounter(SEND_STATE_PATH, "MAX_SENDS_PER_DAY", 500);
export const MAX_SENDS_PER_DAY = email.MAX;
export const loadSendState = email.load;
export const recordSend = email.record;

const discord = createCounter(DISCORD_SEND_STATE_PATH, "DISCORD_MAX_SENDS_PER_DAY", 1000);
export const DISCORD_MAX_SENDS_PER_DAY = discord.MAX;
export const loadDiscordSendState = discord.load;
export const recordDiscordSend = discord.record;

// Exported for tests to build a counter over a temp path (see send-state.test.mjs).
export { createCounter };
