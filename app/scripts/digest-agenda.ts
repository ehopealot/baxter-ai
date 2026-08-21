// Daily calendar digest: PURE today-selection + bounded safe projection (system-scheduled-
// tasks plan, T9). The digest handler (T11) refreshes calendars, reads own events, then
// calls selectDigestEvents to pick the CURRENT household-local day's remaining / ongoing /
// all-day events and projectDigestEvents to reduce them to the bounded DigestEvent shape the
// one tool-less generation prompt carries: localized when / single-lined title / single-lined
// location / allDay / ongoing -- NEVER descriptions, URLs, UIDs, feed source, raw recurrence
// rules, or any delivery/contact data (calendar text is untrusted data, not instructions).
//
// Selection goes through calendar-cli's buildAgenda -- the SAME merged agenda Home renders
// (own-vs-linked dedup and recurrence expansion stay shared, no drift) -- over a tz-aware
// [local-midnight, next-local-midnight) window computed with tz.ts's token helpers, so DST
// transition days (23- and 25-hour local days) keep correct day boundaries.
import { buildAgenda } from "./calendar-cli.ts";
import type { AgendaItem } from "./calendar-cli.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";
import { tzDateToken, tzMidnightOfToken } from "./tz.ts";

// The bounded projection the digest prompt carries. `when` is a human string localized in
// the household tz ("All day" / "Ongoing" / "2:00 PM" / "2:00 PM – 3:30 PM"); title/location
// are single-lined and capped. Optional `location` is omitted when the event has none.
export interface DigestEvent {
  when: string;
  title: string;
  location?: string;
  allDay: boolean;
  ongoing: boolean;
}

export interface DigestSelectionOpts {
  now: Date;
  tz: string;
  // True only when at least one family feed URL is configured (the caller decides). When
  // false ALL family events are excluded even though the cache file is preserved on disk,
  // so removing every feed cannot keep contributing stale events; own events still qualify.
  familyEligible: boolean;
}

const MS_PER_DAY = 86400000;

// Select the current local day's qualifying events from the merged agenda (all-day first,
// then timed by effective start, stable title tie-break):
//   - timed events starting at-or-after now and before the next local midnight (remaining);
//   - timed events that started before now and end strictly after now (ongoing), including
//     ones that started on an earlier day;
//   - all-day events whose span (exclusive end token, default +1 day) contains today.
// Excluded: ended events (end <= now), start-only timed events whose start is already past,
// anything starting at/after the next local midnight (tomorrow), and malformed entries
// (non-finite startMs or a non-string title) -- they never reach the projection.
export function selectDigestEvents(own: StoredEvent[], family: VEvent[], opts: DigestSelectionOpts): AgendaItem[] {
  const nowMs = opts.now.getTime();
  // The window: today's civil-date token -> the INSTANT that local day starts, and the next
  // day's token -> the instant the day ENDS. Token arithmetic + tzMidnightOfToken (not
  // now + 24h) so a DST transition day's 23/25-hour local day stays exact.
  const todayToken = tzDateToken(opts.now, opts.tz);
  const nextMidnightMs = tzMidnightOfToken(todayToken + MS_PER_DAY, opts.tz);
  // One day wider than the window (days=2 -> [fromMs, fromMs+48h), always >= nextMidnightMs
  // even on a 25-hour local day): buildAgenda does the merge, dedup, and recurrence
  // expansion; the inclusion rules below trim to today's actual boundary.
  const agenda = buildAgenda(own, opts.familyEligible ? family : [], tzMidnightOfToken(todayToken, opts.tz), 2);
  const selected: AgendaItem[] = [];
  for (const item of agenda) {
    if (!Number.isFinite(item.startMs) || typeof item.title !== "string") continue; // malformed
    if (item.allDay) {
      // All-day startMs IS a UTC-midnight civil-date token (ical.ts), so the span test runs
      // in token space against today's token: contains today, exclusive end.
      const endToken = item.endMs ?? item.startMs + MS_PER_DAY;
      if (item.startMs <= todayToken && endToken > todayToken) selected.push(item);
    } else if (item.startMs >= nowMs && item.startMs < nextMidnightMs) {
      selected.push(item); // remaining today
    } else if (item.startMs < nowMs && item.endMs != null && item.endMs > nowMs) {
      selected.push(item); // ongoing (end strictly after now)
    }
    // else: ended (endMs <= now), a past start-only event, or tomorrow -- excluded
  }
  selected.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1; // all-day first
    if (a.startMs !== b.startMs) return a.startMs - b.startMs; // effective start
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; // stable title tie-break
  });
  return selected;
}

export interface DigestProjectionOpts { now: Date; tz: string; }

export interface DigestProjection { events: DigestEvent[]; omitted: number; }

// Bounds so the prompt stays small and delivery-safe no matter what the calendars hold.
const MAX_DIGEST_EVENTS = 100;
const TITLE_CAP = 200;
const LOCATION_CAP = 160;

// Collapse every whitespace run to a single space and trim: one line per field, so a
// multi-line title or location can never smuggle structure (or newlines) into the prompt.
function singleLine(s: string | null | undefined): string {
  return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
}

// Localize a start instant as a wall time in the household tz (e.g. "2:00 PM").
function localTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

// Project the selection to bounded DigestEvents: at most 100 (omitted = total - kept, so the
// prompt can require an explicit "and N more events" note), title at 200 chars, location at
// 160, every field single-lined. `when` is localized in the household tz: "All day" for
// all-day, "Ongoing" for ongoing, else the localized start time -- a start-end range when an
// end exists on the same local day as the start. Carries ONLY the DigestEvent fields.
export function projectDigestEvents(selected: AgendaItem[], opts: DigestProjectionOpts): DigestProjection {
  const nowMs = opts.now.getTime();
  const events: DigestEvent[] = [];
  for (const item of selected.slice(0, MAX_DIGEST_EVENTS)) {
    const title = singleLine(item.title).slice(0, TITLE_CAP);
    const location = singleLine(item.location);
    const ongoing = !item.allDay && item.startMs < nowMs && item.endMs != null && item.endMs > nowMs;
    let when: string;
    if (item.allDay) when = "All day";
    else if (ongoing) when = "Ongoing";
    else {
      const start = localTime(item.startMs, opts.tz);
      // Range only when the end lands on the start's local day; an end past local midnight
      // would render a next-day time as if it were still today -- show the start alone.
      when = item.endMs != null && tzDateToken(new Date(item.endMs), opts.tz) === tzDateToken(new Date(item.startMs), opts.tz)
        ? `${start} – ${localTime(item.endMs, opts.tz)}`
        : start;
    }
    const e: DigestEvent = { when, title, allDay: item.allDay, ongoing };
    if (location) e.location = location.slice(0, LOCATION_CAP);
    events.push(e);
  }
  return { events, omitted: selected.length - events.length };
}
