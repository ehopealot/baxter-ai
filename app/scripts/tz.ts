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
