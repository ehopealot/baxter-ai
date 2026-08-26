import { readFileSync } from "node:fs";
import type { Task, TaskDeliver } from "./schedule-store.ts";
import { normalizeFollowUpSubject, parseGregorianDate } from "./followup-normalization.ts";
import { admitEmail, admittedRosterPhone, isSafeVersion, parseNames, type Allowlist } from "./allowlist.ts";
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
  plan_date: string;
  turn_token: string;
  origin: FollowUpOrigin;
  delivery_started_at?: string;
}

export type FollowUpRoute =
  | { surface: "sms" | "sms-group" | "mail-thread"; target: string }
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
  route: FollowUpRoute;
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
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function civilToken(year: number, month: number, day: number): number {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value.getTime();
}

function canonicalIso(value: unknown, label: string): string {
  const text = boundedString(value, label, 40);
  try {
    if (new Date(text).toISOString() !== text) throw new Error();
  } catch { throw new Error(`${label} must be a canonical UTC instant`); }
  return text;
}

function loadProactiveAllowlist(env: NodeJS.ProcessEnv, allowlistPath: string): Allowlist | null {
  let raw: string;
  try { raw = readFileSync(allowlistPath, "utf8"); }
  catch { return null; }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !Array.isArray(parsed.senders) || !parsed.senders.every((entry) => typeof entry === "string")
      || !Array.isArray(parsed.recipients) || !parsed.recipients.every((entry) => typeof entry === "string")
      || !isSafeVersion(parsed.version)) return null;
    return {
      senders: parsed.senders as string[], recipients: parsed.recipients as string[],
      version: parsed.version, names: parseNames(parsed.names),
    };
  } catch { return null; }
}

function emailCurrentlyAdmitted(email: string, list: Allowlist): boolean {
  return [...list.senders, ...list.recipients].some((entry) => admitEmail(entry) === email);
}

export function currentFollowUpAuthority(
  env: NodeJS.ProcessEnv = process.env,
  allowlistPath: string = ALLOWLIST_PATH,
): FollowUpAuthority {
  return {
    directSms(phone) {
      try {
        const list = loadProactiveAllowlist(env, allowlistPath);
        return list !== null && normalizePhone(phone) === phone && admittedRosterPhone(list, phone) && !isSmsOptedOut(phone, env);
      } catch { return false; }
    },
    groupSms(groupId) {
      try { return isStrictGroupId(groupId) && hasTranscript(`group:${groupId}`); }
      catch { return false; }
    },
    mailThread(threadId) {
      try {
        const list = loadProactiveAllowlist(env, allowlistPath);
        if (list === null) return false;
        const binding = mailThreadBinding(threadId);
        return binding !== null && (emailCurrentlyAdmitted(binding.from, list)
          || admitEmail(env.OPERATOR_EMAIL ?? "") === binding.from);
      } catch { return false; }
    },
    homeChat(chatId, email) {
      try {
        const list = loadProactiveAllowlist(env, allowlistPath);
        return list !== null
          && isValidChatId(chatId)
          && listChats().some((chat) => chat.id === chatId)
          && admitEmail(email) === email
          && emailCurrentlyAdmitted(email, list);
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
    const match = /^resend:([^:]+):(.+)$/.exec(id);
    if (!match || admitEmail(match[1]) === null) throw new Error("follow_up mail thread id is invalid");
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
  const planToken = civilToken(parsed.year, parsed.month, parsed.day);
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
  boundedString(task.id, "follow_up task id", 200);
  const raw = task.follow_up as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("follow_up metadata is invalid");
  const metadata = raw as Record<string, unknown>;
  exactKeys(metadata, ["version", "subject", "plan_date", "turn_token", "origin", ...(Object.hasOwn(metadata, "delivery_started_at") ? ["delivery_started_at"] : [])], "follow_up");
  if (metadata.version !== 1) throw new Error("follow_up version is invalid");
  const subject = boundedString(metadata.subject, "follow_up.subject", 640);
  const normalized = normalizeFollowUpSubject(subject);
  if (normalized.subject !== subject) throw new Error("follow_up subject is not normalized");
  const planDate = boundedString(metadata.plan_date, "follow_up.plan_date", 10);
  parseGregorianDate(planDate);
  const turnToken = boundedString(metadata.turn_token, "follow_up.turn_token", 128);
  if (!/^[0-9a-f]{32,128}$/.test(turnToken)) throw new Error("follow_up turn token is invalid");
  const origin = validateOrigin(metadata.origin);
  if (Object.hasOwn(metadata, "subject_key")) throw new Error("follow_up has duplicate subject key");
  const deliveryStartedAt = metadata.delivery_started_at;
  if (deliveryStartedAt !== undefined) canonicalIso(deliveryStartedAt, "follow_up delivery_started_at");
  const followUp: TaskFollowUp = {
    version: 1, subject, plan_date: planDate, turn_token: turnToken, origin,
    ...(deliveryStartedAt === undefined ? {} : { delivery_started_at: deliveryStartedAt as string }),
  };

  if (task.task !== FOLLOW_UP_TASK_MARKER || task.desc !== `Check back about ${subject}`) throw new Error("follow_up task marker/description mismatch");
  if (task.cron !== null || task.system != null || task.system_trigger != null) throw new Error("follow_up task must be an ordinary one-shot");
  if (!Number.isInteger(task.attempts) || (task.attempts as number) < 0) throw new Error("follow_up attempts are invalid");
  if (task.invisible_until != null) canonicalIso(task.invisible_until, "follow_up invisible_until");
  if (OWN.call(task, "enabled") && (task as Task & { enabled?: unknown }).enabled !== true) throw new Error("follow_up task is disabled");
  const at = canonicalIso(task.at, "follow_up at");
  const nextRunAt = canonicalIso(task.next_run_at, "follow_up next_run_at");
  if (at !== nextRunAt) throw new Error("follow_up at/next_run_at mismatch");
  const createdAt = canonicalIso(task.created_at, "follow_up created_at");
  const tz = boundedString(task.tz, "follow_up timezone", 100);
  if (validTz(tz) !== tz) throw new Error("follow_up timezone is invalid");
  if (task.deliver !== null) throw new Error("follow_up must not persist a duplicate delivery route");
  const route: FollowUpRoute = origin.surface === "sms" ? { surface: "sms", target: origin.id }
    : origin.surface === "sms-group" ? { surface: "sms-group", target: origin.id }
    : origin.surface === "mail-thread" ? { surface: "mail-thread", target: origin.id }
    : { surface: "home-chat-email", target: origin.email, chat_id: origin.id };
  validateTiming(task, planDate, nextRunAt, createdAt, tz);
  return { task, followUp, route };
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
