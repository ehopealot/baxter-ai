// Exact persisted-calendar schema checks shared by morning and weekend selection.
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dateOnlyMs(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? ms : null;
}

function dateTimeMs(value: string): number | null {
  // Date.parse normalizes impossible civil dates (for example 2026-02-30), so
  // accept only a complete ISO instant whose local components round-trip.
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute, second = "0", fraction = "", zone] = match.slice(1);
  if (dateOnlyMs(`${year}-${month}-${day}`) === null || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const offset = zone === "Z" ? 0 : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * (zone[0] === "+" ? 1 : -1);
  if (Math.abs(offset) > 23 * 60 + 59) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) return null;
  const local = new Date(ms + offset * 60_000);
  return local.getUTCFullYear() === Number(year) && local.getUTCMonth() + 1 === Number(month)
    && local.getUTCDate() === Number(day) && local.getUTCHours() === Number(hour)
    && local.getUTCMinutes() === Number(minute) && local.getUTCSeconds() === Number(second)
    && local.getUTCMilliseconds() === Number((fraction + "000").slice(0, 3)) ? ms : null;
}

function validInstant(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && Number.isFinite(new Date(value).getTime());
}

function isUtcMidnight(value: number): boolean {
  const date = new Date(value);
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

export function isValidStoredCalendarEvent(value: unknown): value is StoredEvent {
  if (!isRecord(value) || typeof value.uid !== "string" || typeof value.title !== "string" || !value.title.trim()
    || typeof value.start !== "string" || typeof value.created !== "string" || typeof value.updated !== "string") return false;
  if (value.allDay !== undefined && typeof value.allDay !== "boolean") return false;
  if (value.end !== undefined && typeof value.end !== "string") return false;
  if (value.location !== undefined && typeof value.location !== "string") return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  const startMs = value.allDay ? dateOnlyMs(value.start) : dateTimeMs(value.start);
  const endMs = value.end === undefined ? null : value.allDay ? dateOnlyMs(value.end) : dateTimeMs(value.end);
  return startMs !== null && (value.end === undefined || (endMs !== null && endMs >= startMs));
}

export function isValidFamilyCalendarEvent(value: unknown): value is VEvent {
  if (!isRecord(value) || (value.uid !== null && typeof value.uid !== "string") || typeof value.title !== "string" || !value.title.trim()
    || typeof value.startMs !== "number" || !validInstant(value.startMs)
    || (value.endMs !== null && (typeof value.endMs !== "number" || !validInstant(value.endMs)))) return false;
  const startMs = value.startMs, endMs = value.endMs;
  return typeof value.allDay === "boolean" && (endMs === null || endMs >= startMs)
    && (!value.allDay || (isUtcMidnight(startMs) && (endMs === null || isUtcMidnight(endMs))))
    && (value.location === null || typeof value.location === "string")
    && (value.rrule === null || typeof value.rrule === "string")
    && (value.url === null || typeof value.url === "string");
}
