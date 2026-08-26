import { neutralizeStructuralMarkers } from "./transcript.ts";
import { tzDateToken, zonedToUtcMs } from "./tz.ts";

export interface NormalizedFollowUpSubject { subject: string; }
export interface CivilDate { year: number; month: number; day: number; token: string; }
export type MinuteSelector = () => number;

const UNICODE_WHITESPACE = /\p{White_Space}+/gu;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
const DAY_MS = 86_400_000;
const SLOT_COUNT = 180;

function collapseSpaces(value: string): string {
  return value.replace(UNICODE_WHITESPACE, " ").trim().replace(/ +/g, " ");
}

export function normalizeFollowUpSubject(raw: string): NormalizedFollowUpSubject {
  if (typeof raw !== "string") throw new Error("follow-up subject must be a string");
  let subject = raw.normalize("NFKC");
  subject = subject.replace(UNICODE_WHITESPACE, " ");
  subject = subject.replace(CONTROL_OR_FORMAT, "");
  subject = collapseSpaces(subject);
  subject = collapseSpaces(neutralizeStructuralMarkers(subject));
  const length = Array.from(subject).length;
  if (length === 0) throw new Error("follow-up subject is empty");
  if (length > 160) throw new Error("follow-up subject exceeds 160 Unicode code points");
  return { subject };
}

function utcCivilMs(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

export function parseGregorianDate(raw: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const invalid = (): never => { throw new Error(`${JSON.stringify(raw)} is not a valid Gregorian YYYY-MM-DD date`); };
  if (!match) return invalid();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return invalid();
  const date = new Date(utcCivilMs(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return invalid();
  const token = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (token !== raw) return invalid();
  return { year, month, day, token };
}

function civilFromToken(tokenMs: number): { year: number; month: number; day: number } {
  const date = new Date(tokenMs);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function selectFollowUpInstant(
  planDate: CivilDate,
  now: Date,
  tz: string,
  selector: MinuteSelector = () => Math.floor(Math.random() * SLOT_COUNT),
): string {
  const planToken = utcCivilMs(planDate.year, planDate.month, planDate.day);
  const todayToken = tzDateToken(now, tz);
  const distance = Math.round((planToken - todayToken) / DAY_MS);
  if (distance < 1) throw new Error("follow-up plan date must be a future civil date");
  const slot = selector();
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new Error("follow-up selector must return an integer in [0, 180)");
  }
  const fireToken = distance === 1 ? planToken : planToken - DAY_MS;
  const fireDate = civilFromToken(fireToken);
  const startHour = distance === 1 ? 9 : 13;
  const totalMinutes = startHour * 60 + slot;
  return new Date(zonedToUtcMs(
    fireDate.year,
    fireDate.month,
    fireDate.day,
    Math.floor(totalMinutes / 60),
    totalMinutes % 60,
    0,
    tz,
  )).toISOString();
}
