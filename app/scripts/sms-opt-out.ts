import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizePhone } from "./normalize-phone.ts";
import { SMS_OPT_OUT_PATH } from "./paths.ts";

interface SmsOptOutState {
  version: 1;
  numbers: string[];
}

const EMPTY: SmsOptOutState = { version: 1, numbers: [] };
const STRICT_E164 = /^\+[1-9][0-9]{7,14}$/;

function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SMS_OPT_OUT_PATH_OVERRIDE || SMS_OPT_OUT_PATH;
}

function loadState(env: NodeJS.ProcessEnv = process.env): SmsOptOutState {
  const path = statePath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw new Error("sms opt-out state unreadable", { cause: err });
  }
  try {
    const value = JSON.parse(raw) as Partial<SmsOptOutState>;
    if (value.version !== 1 || !Array.isArray(value.numbers)
      || !value.numbers.every(n => typeof n === "string" && STRICT_E164.test(n))
      || new Set(value.numbers).size !== value.numbers.length) throw new Error("invalid shape");
    return { version: 1, numbers: [...value.numbers].sort() };
  } catch (err) {
    throw new Error("sms opt-out state invalid", { cause: err });
  }
}

function saveState(state: SmsOptOutState, env: NodeJS.ProcessEnv = process.env): void {
  const path = statePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

export function isStopMessage(content: string): boolean {
  return content.trim().toUpperCase() === "STOP";
}

export function isSmsOptedOut(phone: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = normalizePhone(phone);
  if (!norm) throw new Error(`sms opt-out check refused: ${phone} is not a valid phone number`);
  return loadState(env).numbers.includes(norm);
}

export function setSmsOptOut(phone: string, optedOut: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const norm = normalizePhone(phone);
  if (!norm) throw new Error(`sms opt-out update refused: ${phone} is not a valid phone number`);
  const state = loadState(env);
  const numbers = new Set(state.numbers);
  const before = numbers.has(norm);
  if (optedOut) numbers.add(norm); else numbers.delete(norm);
  if (before === optedOut) return;
  saveState({ version: 1, numbers: [...numbers].sort() }, env);
}
