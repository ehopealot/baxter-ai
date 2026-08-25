import type { Task, TaskDeliver } from "./schedule-store.ts";
import { normalizeFollowUpSubject, parseGregorianDate } from "./followup-normalization.ts";
import { admitEmail, admittedRosterPhone, loadAllowlist } from "./allowlist.ts";
import { normalizePhone } from "./normalize-phone.ts";
import { hasTranscript, isStrictGroupId } from "./sms-transcript.ts";
import { isSmsOptedOut } from "./sms-opt-out.ts";
import { mailThreadBinding } from "./mail-transcript.ts";
import { isValidChatId, listChats } from "./chat-transcript.ts";
import { validTz } from "./household-tz.ts";
import { ALLOWLIST_PATH } from "./paths.ts";
import { tzDateToken } from "./tz.ts";

export type FollowUpOrigin =
  | { surface: "sms"; id: string }
  | { surface: "sms-group"; id: string }
  | { surface: "mail-thread"; id: string }
  | { surface: "home-chat"; id: string; email: string };

export interface TaskFollowUp {
  version: 1;
  subject: string;
  subject_key: string;
  plan_date: string;
  turn_token: string;
  origin: FollowUpOrigin;
}

export type FollowUpTaskDeliver =
  | { surface: "mail-thread"; target: string }
  | { surface: "home-chat-email"; target: string; chat_id: string };

export const FOLLOW_UP_TASK_MARKER = "proactive-follow-up:v1";

export interface FollowUpAuthority {
  directSms(phone: string): boolean;
  groupSms(groupId: string): boolean;
  mailThread(threadId: string): boolean;
  homeChat(chatId: string, email: string): boolean;
}

export interface ValidatedFollowUpTask {
  task: Task;
  followUp: TaskFollowUp;
  deliver: TaskDeliver;
  nextRunAt: string;
}

const OWN = Object.prototype.hasOwnProperty;
const DAY_MS = 86_400_000;
const KNOWN_DELIVERY = new Set(["discord", "mail", "sms", "sms-group"]);

function exactKeys(value: object, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function canonicalIso(value: unknown, label: string): string {
  const text = boundedString(value, label, 40);
  try {
    if (new Date(text).toISOString() !== text) throw new Error();
  } catch { throw new Error(`${label} must be a canonical UTC instant`); }
  return text;
}

function emailCurrentlyAdmitted(email: string, env: NodeJS.ProcessEnv, allowlistPath: string): boolean {
  const list = loadAllowlist(env, allowlistPath);
  return [...list.senders, ...list.recipients].some((entry) => typeof entry === "string" && admitEmail(entry) === email);
}

export function currentFollowUpAuthority(
  env: NodeJS.ProcessEnv = process.env,
  allowlistPath: string = ALLOWLIST_PATH,
): FollowUpAuthority {
  return {
    directSms(phone) {
      try {
        const list = loadAllowlist(env, allowlistPath);
        return normalizePhone(phone) === phone && admittedRosterPhone(list, phone) && !isSmsOptedOut(phone, env);
      } catch { return false; }
    },
    groupSms(groupId) {
      try { return isStrictGroupId(groupId) && hasTranscript(`group:${groupId}`); }
      catch { return false; }
    },
    mailThread(threadId) {
      try {
        const binding = mailThreadBinding(threadId);
        return binding !== null && emailCurrentlyAdmitted(binding.from, env, allowlistPath);
      } catch { return false; }
    },
    homeChat(chatId, email) {
      try {
        return isValidChatId(chatId)
          && listChats().some((chat) => chat.id === chatId)
          && admitEmail(email) === email
          && emailCurrentlyAdmitted(email, env, allowlistPath);
      } catch { return false; }
    },
  };
}

export function isFeatureShapedTask(task: Task): boolean {
  if (OWN.call(task, "follow_up")) return true;
  const deliver = task.deliver as unknown;
  if (deliver == null) return false;
  if (typeof deliver !== "object" || Array.isArray(deliver)) return true;
  const surface = (deliver as { surface?: unknown }).surface;
  return typeof surface !== "string" || !KNOWN_DELIVERY.has(surface);
}

function validateOrigin(raw: unknown): FollowUpOrigin {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("follow_up.origin is invalid");
  const origin = raw as Record<string, unknown>;
  const surface = origin.surface;
  if (surface === "sms") {
    exactKeys(origin, ["surface", "id"], "follow_up.origin");
    const id = boundedString(origin.id, "follow_up.origin.id", 32);
    if (normalizePhone(id) !== id) throw new Error("follow_up direct SMS id is invalid");
    return { surface, id };
  }
  if (surface === "sms-group") {
    exactKeys(origin, ["surface", "id"], "follow_up.origin");
    const id = boundedString(origin.id, "follow_up.origin.id", 64);
    if (!isStrictGroupId(id)) throw new Error("follow_up SMS group id is invalid");
    return { surface, id };
  }
  if (surface === "mail-thread") {
    exactKeys(origin, ["surface", "id"], "follow_up.origin");
    const id = boundedString(origin.id, "follow_up.origin.id", 500);
    if (!/^resend:[^:]+:.+$/.test(id)) throw new Error("follow_up mail thread id is invalid");
    return { surface, id };
  }
  if (surface === "home-chat") {
    exactKeys(origin, ["surface", "id", "email"], "follow_up.origin");
    const id = boundedString(origin.id, "follow_up.origin.id", 100);
    const email = boundedString(origin.email, "follow_up.origin.email", 254);
    if (!isValidChatId(id) || admitEmail(email) !== email) throw new Error("follow_up Home Chat origin is invalid");
    return { surface, id, email };
  }
  throw new Error("follow_up origin surface is invalid");
}

function validateTiming(task: Task, planDate: string, nextRunAt: string, createdAt: string, tz: string): void {
  const parsed = parseGregorianDate(planDate);
  const planToken = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const createdToken = tzDateToken(new Date(createdAt), tz);
  const distance = Math.round((planToken - createdToken) / DAY_MS);
  if (distance < 1) throw new Error("follow_up plan date was not future at creation");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(nextRunAt)).map((part) => [part.type, part.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const expectedToken = distance === 1 ? planToken : planToken - DAY_MS;
  const expectedDate = new Date(expectedToken).toISOString().slice(0, 10);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const start = distance === 1 ? 9 * 60 : 13 * 60;
  if (localDate !== expectedDate || minute < start || minute >= start + 180 || parts.second !== "00" || new Date(nextRunAt).getUTCMilliseconds() !== 0) {
    throw new Error("follow_up next run is outside the approved plan-relative window");
  }
}

export function validateStoredFollowUp(task: Task): Omit<ValidatedFollowUpTask, "nextRunAt"> {
  if (!task || typeof task !== "object" || !OWN.call(task, "follow_up")) throw new Error("task has no proactive follow-up metadata");
  const raw = task.follow_up as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("follow_up metadata is invalid");
  const metadata = raw as Record<string, unknown>;
  exactKeys(metadata, ["version", "subject", "subject_key", "plan_date", "turn_token", "origin"], "follow_up");
  if (metadata.version !== 1) throw new Error("follow_up version is invalid");
  const subject = boundedString(metadata.subject, "follow_up.subject", 640);
  const normalized = normalizeFollowUpSubject(subject);
  if (normalized.subject !== subject || metadata.subject_key !== normalized.subjectKey) throw new Error("follow_up subject/key mismatch");
  const planDate = boundedString(metadata.plan_date, "follow_up.plan_date", 10);
  parseGregorianDate(planDate);
  const turnToken = boundedString(metadata.turn_token, "follow_up.turn_token", 128);
  if (!/^[0-9a-f]{32,128}$/.test(turnToken)) throw new Error("follow_up turn token is invalid");
  const origin = validateOrigin(metadata.origin);
  const followUp: TaskFollowUp = { version: 1, subject, subject_key: normalized.subjectKey, plan_date: planDate, turn_token: turnToken, origin };

  if (task.task !== FOLLOW_UP_TASK_MARKER || task.desc !== `Check back about ${subject}`) throw new Error("follow_up task marker/description mismatch");
  if (task.cron !== null || task.system != null || task.system_trigger != null) throw new Error("follow_up task must be an ordinary one-shot");
  const at = canonicalIso(task.at, "follow_up at");
  const nextRunAt = canonicalIso(task.next_run_at, "follow_up next_run_at");
  if (at !== nextRunAt) throw new Error("follow_up at/next_run_at mismatch");
  const createdAt = canonicalIso(task.created_at, "follow_up created_at");
  const tz = boundedString(task.tz, "follow_up timezone", 100);
  if (validTz(tz) !== tz) throw new Error("follow_up timezone is invalid");
  if (!task.deliver || typeof task.deliver !== "object") throw new Error("follow_up delivery is missing");
  const deliver = task.deliver;

  if (origin.surface === "sms") {
    if (deliver.surface !== "sms" || deliver.target !== origin.id) throw new Error("follow_up SMS route mismatch");
  } else if (origin.surface === "sms-group") {
    if (deliver.surface !== "sms-group" || deliver.target !== origin.id) throw new Error("follow_up SMS group route mismatch");
  } else if (origin.surface === "mail-thread") {
    if (deliver.surface !== "mail-thread" || deliver.target !== origin.id) throw new Error("follow_up mail route mismatch");
  } else {
    if (deliver.surface !== "home-chat-email" || deliver.target !== origin.email || deliver.chat_id !== origin.id) throw new Error("follow_up Home Chat route mismatch");
  }
  validateTiming(task, planDate, nextRunAt, createdAt, tz);
  return { task, followUp, deliver };
}

export function validateFollowUpTask(task: Task, currentAuthority: FollowUpAuthority): ValidatedFollowUpTask {
  const stored = validateStoredFollowUp(task);
  const origin = stored.followUp.origin;
  const authorized = origin.surface === "sms" ? currentAuthority.directSms(origin.id)
    : origin.surface === "sms-group" ? currentAuthority.groupSms(origin.id)
    : origin.surface === "mail-thread" ? currentAuthority.mailThread(origin.id)
    : currentAuthority.homeChat(origin.id, origin.email);
  if (!authorized) throw new Error("follow-up destination is not currently authorized");
  return { ...stored, nextRunAt: task.next_run_at };
}
