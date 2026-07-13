// Shared daily send-cap state, read/written by whichever process actually
// sends (gmail.mjs's `reply` command) and read-only by poll.mjs, which uses
// it to avoid dispatching a claude run when there's obviously no budget
// left. The cap only has teeth because the increment lives at the actual
// Gmail send call, not at dispatch time -- a single run can still send
// more than one email, but each one counts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SEND_STATE_PATH } from "./paths.mjs";

const DEFAULT_MAX_SENDS_PER_DAY = 50;

// A typo'd env value (e.g. "fifty") would otherwise parse to NaN, and
// `count >= NaN` is always false -- silently disabling the one thing this
// module exists to enforce. Falls back to the default rather than failing
// the whole daemon over a misconfigured cap.
function parseMaxSendsPerDay() {
  const raw = process.env.MAX_SENDS_PER_DAY;
  // Number("") is 0, not NaN, so a blank .env value (the .env.example
  // placeholder is `MAX_SENDS_PER_DAY=` with nothing after it) would
  // otherwise sail past the isFinite guard below and silently cap sends
  // at 0 with no warning -- treat it the same as unset.
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_SENDS_PER_DAY;
  const parsed = Number(raw);
  // Negative would otherwise pass isFinite and then satisfy count >= parsed
  // from count 0 onward -- a silent, permanent lockout rather than a
  // misconfiguration warning. 0 is left alone: it's a legitimate explicit
  // kill switch, not a typo.
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid MAX_SENDS_PER_DAY="${raw}", falling back to ${DEFAULT_MAX_SENDS_PER_DAY}.`);
    return DEFAULT_MAX_SENDS_PER_DAY;
  }
  return parsed;
}

export const MAX_SENDS_PER_DAY = parseMaxSendsPerDay();

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function loadSendState() {
  try {
    const state = JSON.parse(readFileSync(SEND_STATE_PATH, "utf8"));
    return state.date === todayUTC() ? state : { date: todayUTC(), count: 0 };
  } catch {
    return { date: todayUTC(), count: 0 };
  }
}

export function recordSend() {
  const state = loadSendState();
  state.count += 1;
  mkdirSync(dirname(SEND_STATE_PATH), { recursive: true });
  writeFileSync(SEND_STATE_PATH, JSON.stringify(state));
  return state;
}
