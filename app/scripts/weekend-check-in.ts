import { buildAgenda, type AgendaItem } from "./calendar-cli.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";
import { householdTz } from "./household-tz.ts";
import { tzDateToken, tzMidnightOfToken } from "./tz.ts";
import { cleanCalendarFieldCodePoints } from "./check-in-context.ts";

const DAY_MS = 86_400_000;

export interface WeekendEvent {
  when: string;
  title: string;
  location?: string;
  allDay: boolean;
  ongoing: boolean;
}

export interface WeekendProjection { events: WeekendEvent[]; omitted: number; }

export function weekendWindow(now: Date, tz: string): { saturdayToken: number; mondayToken: number; saturdayStart: number; mondayStart: number } {
  const todayToken = tzDateToken(now, tz);
  const weekday = new Date(todayToken).getUTCDay();
  const daysToSaturday = (6 - weekday + 7) % 7;
  const saturdayToken = todayToken + daysToSaturday * DAY_MS;
  const mondayToken = saturdayToken + 2 * DAY_MS;
  return {
    saturdayToken,
    mondayToken,
    saturdayStart: tzMidnightOfToken(saturdayToken, tz),
    mondayStart: tzMidnightOfToken(mondayToken, tz),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidDateOnly(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidStoredEvent(value: unknown): value is StoredEvent {
  if (!isRecord(value) || typeof value.uid !== "string" || typeof value.title !== "string" || !value.title.trim() || typeof value.start !== "string") return false;
  if (value.allDay !== undefined && typeof value.allDay !== "boolean") return false;
  if (value.end !== undefined && typeof value.end !== "string") return false;
  if (value.location !== undefined && typeof value.location !== "string") return false;
  const startMs = value.allDay ? (isValidDateOnly(value.start) ? Date.parse(`${value.start}T00:00:00Z`) : NaN) : Date.parse(value.start);
  const endMs = value.end === undefined ? null : value.allDay
    ? (isValidDateOnly(value.end) ? Date.parse(`${value.end}T00:00:00Z`) : NaN)
    : Date.parse(value.end);
  return Number.isFinite(startMs) && (endMs === null || (Number.isFinite(endMs) && endMs >= startMs));
}

function isValidFamilyEvent(value: unknown): value is VEvent {
  if (!isRecord(value) || (value.uid !== null && typeof value.uid !== "string") || typeof value.title !== "string" || !value.title.trim()) return false;
  if (!Number.isFinite(value.startMs) || (value.endMs !== null && !Number.isFinite(value.endMs))) return false;
  if (value.endMs !== null && (value.endMs as number) < (value.startMs as number)) return false;
  return typeof value.allDay === "boolean"
    && (value.location === null || typeof value.location === "string")
    && (value.rrule === null || typeof value.rrule === "string")
    && (value.url === null || typeof value.url === "string");
}

export function selectWeekendEvents(
  own: StoredEvent[],
  family: VEvent[],
  options: { now: Date; tz: string; familyEligible: boolean; onMalformed?: (counts: { own: number; family: number }) => void },
): AgendaItem[] {
  const { saturdayToken, mondayToken, saturdayStart, mondayStart } = weekendWindow(options.now, options.tz);
  const validOwn = (Array.isArray(own) ? own : []).filter(isValidStoredEvent);
  const eligibleFamily = options.familyEligible && Array.isArray(family) ? family : [];
  const validFamily = eligibleFamily.filter(isValidFamilyEvent);
  const malformed = { own: (Array.isArray(own) ? own.length : 1) - validOwn.length, family: eligibleFamily.length - validFamily.length };
  if (malformed.own > 0 || malformed.family > 0) options.onMalformed?.(malformed);
  // buildAgenda uses fixed 24-hour expansion; three days covers a 49-hour
  // fall-back weekend. Exact civil bounds below decide final inclusion.
  const agenda = buildAgenda(validOwn, validFamily, saturdayStart, 3);
  const selected = agenda.filter((item) => {
    if (!Number.isFinite(item.startMs) || typeof item.title !== "string") return false;
    if (item.allDay) {
      const end = item.endMs ?? item.startMs + DAY_MS;
      return item.startMs < mondayToken && end > saturdayToken;
    }
    if (item.startMs >= saturdayStart && item.startMs < mondayStart) return true;
    return item.startMs < saturdayStart && item.endMs != null && item.endMs > saturdayStart;
  });
  selected.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.startMs - b.startMs || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
  });
  return selected;
}

function dayNameForAllDay(token: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(token));
}

function dayAndTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

export function projectWeekendEvents(selected: readonly AgendaItem[], options: { tz: string; weekendStartMs?: number }): WeekendProjection {
  const events = selected.slice(0, 100).map((item): WeekendEvent => {
    const weekendBoundary = options.weekendStartMs === undefined
      ? undefined
      : item.allDay ? tzDateToken(new Date(options.weekendStartMs), options.tz) : options.weekendStartMs;
    const ongoing = weekendBoundary !== undefined
      && item.endMs != null
      && item.startMs < weekendBoundary
      && item.endMs > weekendBoundary;
    const event: WeekendEvent = {
      when: item.allDay
        ? ongoing ? "Ongoing into the weekend (all day)" : `${dayNameForAllDay(item.startMs)}, all day`
        : ongoing ? "Ongoing into the weekend" : dayAndTime(item.startMs, options.tz),
      title: cleanCalendarFieldCodePoints(item.title, 200),
      allDay: item.allDay,
      ongoing,
    };
    const location = cleanCalendarFieldCodePoints(item.location, 160);
    if (location) event.location = location;
    return event;
  });
  return { events, omitted: selected.length - events.length };
}
