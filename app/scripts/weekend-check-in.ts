import { buildAgenda, type AgendaItem } from "./calendar-cli.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";
import { tzDateToken, tzMidnightOfToken } from "./tz.ts";
import { cleanCalendarFieldCodePoints } from "./check-in-context.ts";
import { isValidFamilyCalendarEvent, isValidStoredCalendarEvent } from "./calendar-event-validation.ts";

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

export function selectWeekendEvents(
  own: StoredEvent[],
  family: VEvent[],
  options: { now: Date; tz: string; familyEligible: boolean; onMalformed?: (counts: { own: number; family: number }) => void },
): AgendaItem[] {
  const { saturdayToken, mondayToken, saturdayStart, mondayStart } = weekendWindow(options.now, options.tz);
  const validOwn = (Array.isArray(own) ? own : []).filter(isValidStoredCalendarEvent);
  const eligibleFamily = options.familyEligible && Array.isArray(family) ? family : [];
  const validFamily = eligibleFamily.filter(isValidFamilyCalendarEvent);
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
