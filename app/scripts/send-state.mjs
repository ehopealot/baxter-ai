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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SEND_STATE_PATH, DISCORD_SEND_STATE_PATH } from "./paths.mjs";

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

// Builds a { MAX, load, record } counter over one JSON file + one env var.
function createCounter(path, envVar, defaultMax) {
  const MAX = parseMaxSends(process.env[envVar], defaultMax, envVar);
  function load() {
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      return state.date === todayUTC() ? state : { date: todayUTC(), count: 0 };
    } catch {
      return { date: todayUTC(), count: 0 };
    }
  }
  function record() {
    const state = load();
    state.count += 1;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
    return state;
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
