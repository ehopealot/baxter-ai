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
  if (!value.includes("T")) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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
    || typeof value.startMs !== "number" || !Number.isFinite(value.startMs)
    || (value.endMs !== null && (typeof value.endMs !== "number" || !Number.isFinite(value.endMs)))) return false;
  const startMs = value.startMs, endMs = value.endMs;
  return typeof value.allDay === "boolean" && (endMs === null || endMs >= startMs)
    && (value.location === null || typeof value.location === "string")
    && (value.rrule === null || typeof value.rrule === "string")
    && (value.url === null || typeof value.url === "string");
}
