// Timezone conversion via Node's built-in Intl (full IANA tz data) -- no dependency,
// no stale offset table. Shared by schedule-store (naive `--at` wall times) and ical
// (TZID DATE-TIMEs) so the subtle DST two-pass logic lives in ONE place.

// Offset (ms) of `zone` at the instant `utcMs`: (wall-clock in zone) - utc.
export function zoneOffsetMs(zone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asIfUtc - utcMs;
}

// A wall-clock instant in `zone` -> its absolute UTC epoch ms. Iterating the offset
// once makes it correct across DST transitions too -- a single correction is wrong for
// the hours around a transition that lies between `guess` and the true instant; only
// inside the gap/fold itself is either answer defensible.
export function zonedToUtcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return guess - zoneOffsetMs(zone, guess - zoneOffsetMs(zone, guess));
}

// The CIVIL-DATE TOKEN of now's tz-calendar date: Date.UTC(y,m,d) of the household-local
// date. A UTC-midnight token, DST-free, so `token + n*86400000` walks calendar days
// exactly -- and it's the SAME space all-day events live in (ical.ts stores their start
// as Date.UTC(y,m,d)), so a day-N all-day event compares directly against a window's
// day tokens. Moved here from calendar-mirror.ts (system-scheduled-tasks plan, T9) so
// the calendar page's day windows and the digest's today-window share ONE discipline.
export function tzDateToken(now: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"));
}

// The INSTANT of 00:00 in `tz` for a civil-date token -- the actual epoch ms a household
// day starts at. Two-pass via zoneOffsetMs so a midnight landing in a DST gap/overlap
// resolves correctly. Used for BOTH a window's floor (today's token) and its end (a
// later day's token), so the end is tz-aware like the floor -- not a fixed +24h*n that
// drifts an hour across DST and misaligns the day boundary. Moved from
// calendar-mirror.ts (T9); calendar-mirror imports it back, byte-identical behavior.
export function tzMidnightOfToken(tokenMs: number, tz: string): number {
  let ms = tokenMs - zoneOffsetMs(tz, tokenMs);
  ms = tokenMs - zoneOffsetMs(tz, ms); // refine using the offset AT the candidate instant
  return ms;
}
