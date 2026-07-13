// Shared daily send-cap state, read/written by whichever process actually
// sends (gmail.mjs's `reply` command) and read-only by poll.mjs, which uses
// it to avoid dispatching a claude run when there's obviously no budget
// left. The cap only has teeth because the increment lives at the actual
// Gmail send call, not at dispatch time -- a single run can still send
// more than one email, but each one counts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SEND_STATE_PATH = join(homedir(), ".mail-agent", "send-state.json");

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
