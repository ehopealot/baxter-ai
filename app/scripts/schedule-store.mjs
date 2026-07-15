// Pure queue logic for the heartbeat scheduler. No I/O here (see the lock/atomic
// I/O section below, added in Task 2). cron-parser computes occurrences; every
// time value is stored as an absolute UTC ISO string.
import { randomBytes } from "node:crypto";
import parser from "cron-parser";

export function newId() {
  return randomBytes(4).toString("hex");
}

// Absolute UTC ISO for a task's next fire. `at` with an offset/Z is absolute;
// a naive `at` is interpreted as wall-clock in tz||fallbackTz; every `cron` is
// read in tz||fallbackTz via cron-parser.
export function resolveNextRun({ cron, at, tz }, nowMs, fallbackTz) {
  const zone = tz || fallbackTz;
  if (at) {
    if (/[zZ]|[+-]\d\d:?\d\d$/.test(at)) return new Date(at).toISOString(); // absolute
    return naiveInZoneToISO(at, zone);                                      // wall-clock in zone
  }
  const it = parser.parseExpression(cron, { currentDate: new Date(nowMs), tz: zone });
  return it.next().toDate().toISOString();
}

// Offset (ms) of `zone` at the instant `utcMs`: (wall-clock in zone) - utc.
function zoneOffsetMs(zone, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asIfUtc - utcMs;
}

// A naive "YYYY-MM-DDTHH:MM[:SS]" wall-clock time in `zone` -> absolute UTC ISO.
// (Keeps the year, unlike a cron approximation; single offset correction is fine
// away from the rare DST-fold second.)
function naiveInZoneToISO(naive, zone) {
  const m = naive.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/);
  if (!m) throw new Error(`invalid --at timestamp: ${naive}`);
  const [, Y, Mo, D, H, Mi, S] = m;
  const guess = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0));
  return new Date(guess - zoneOffsetMs(zone, guess)).toISOString();
}

export function cronMinGapMinutes(cron, tz, fallbackTz, horizon = 100) {
  const it = parser.parseExpression(cron, { currentDate: new Date(), tz: tz || fallbackTz });
  let prev = it.next().toDate().getTime();
  let min = Infinity;
  for (let i = 0; i < horizon; i++) {
    const next = it.next().toDate().getTime();
    min = Math.min(min, (next - prev) / 60000);
    prev = next;
  }
  return min;
}

export function selectDue(tasks, nowMs) {
  return tasks.filter(
    (t) => Date.parse(t.next_run_at) <= nowMs &&
      (t.invisible_until == null || Date.parse(t.invisible_until) <= nowMs),
  );
}

export function applyClaim(tasks, id, nowMs, visibilityMs) {
  const invisible_until = new Date(nowMs + visibilityMs).toISOString();
  let claimed = null;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    claimed = { ...t, invisible_until };
    return claimed;
  });
  return { tasks: claimed ? next : tasks, claimed };
}

export function applyOnSuccess(tasks, id, nowMs, fallbackTz) {
  if (!tasks.some((t) => t.id === id)) return tasks; // cancellation won
  return tasks.flatMap((t) => {
    if (t.id !== id) return [t];
    if (t.cron) return [{ ...t, next_run_at: resolveNextRun(t, nowMs, fallbackTz), invisible_until: null, attempts: 0 }];
    return []; // one-shot: remove
  });
}

export function applyOnFailure(tasks, id, nowMs, maxAttempts, fallbackTz) {
  if (!tasks.some((t) => t.id === id)) return { tasks, gaveUp: false }; // cancellation won
  let gaveUp = false;
  const next = tasks.flatMap((t) => {
    if (t.id !== id) return [t];
    const attempts = (t.attempts || 0) + 1;
    if (attempts < maxAttempts) return [{ ...t, attempts }]; // leave invisible_until -> retry after window
    gaveUp = true;
    if (t.cron) return [{ ...t, next_run_at: resolveNextRun(t, nowMs, fallbackTz), invisible_until: null, attempts: 0 }];
    return []; // one-shot: drop
  });
  return { tasks: next, gaveUp };
}
