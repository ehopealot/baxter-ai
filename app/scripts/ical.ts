// iCalendar (RFC 5545) generate + parse, hand-rolled and unit-tested rather than
// pulling a dependency: buildIcs produces Baxter's OWN published feed (full control +
// tests beat a lib, like the transcript sanitizer), and parseIcs/expandInWindow read
// the family's polled feed for an agenda view. Parsing is deliberately scoped (see
// expandInWindow): simple recurrence is expanded; exotic RRULE is surfaced, not
// silently dropped. TZID is resolved via the shared tz.ts (Node's built-in Intl,
// full IANA tz data), so no dependency and no stale offset table.
import { zonedToUtcMs } from "./tz.ts";

// ---------- shared date helpers ----------

const pad = (n: number): string => String(n).padStart(2, "0");

// A Date -> RFC 5545 UTC DATE-TIME (basic format, trailing Z).
export function fmtUtc(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
// A date-only ISO (YYYY-MM-DD...) -> RFC 5545 DATE (YYYYMMDD), no timezone shift.
function fmtDate(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`invalid all-day date (want YYYY-MM-DD): ${iso}`);
  return `${m[1]}${m[2]}${m[3]}`;
}
function isoToUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date-time: ${iso}`);
  return fmtUtc(d);
}
// The exclusive DTEND for a single all-day event: the day after `start`.
function nextDay(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`invalid all-day date: ${iso}`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// ---------- generate ----------

export interface CalEvent {
  uid: string;
  title: string;
  start: string; // ISO: "YYYY-MM-DD" for all-day, full ISO datetime otherwise
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  updated?: string;
}

// RFC 5545 TEXT escaping: backslash, semicolon, comma, and newline. NOT the colon.
function escapeText(s: unknown): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// Fold a content line at 75 OCTETS with a leading-space continuation (RFC 5545 §3.1),
// never splitting a multibyte UTF-8 character (walks by code point, counts bytes).
export function foldLine(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (curBytes + chBytes > limit) {
      parts.push(cur);
      cur = ch;
      curBytes = chBytes;
      limit = 74; // continuation lines reserve 1 octet for the leading space
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

// Build a VCALENDAR from Baxter's own events. Deterministic given `now`. UIDs are
// passed in and never regenerated (so subscribers update in place, not duplicate).
export function buildIcs(events: CalEvent[], opts: { prodId?: string; now?: Date } = {}): string {
  const prodId = opts.prodId ?? "-//baxter//calendar//EN";
  const stamp = fmtUtc(opts.now ?? new Date());
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodId}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDate(ev.start)}`);
      // DTEND is EXCLUSIVE (RFC 5545 §3.6.1). A caller's all-day `end` is the last day
      // INCLUSIVE (an LLM/human means "through the 6th"), so emit the day AFTER it; a
      // single-day event (no end) ends the day after its start.
      lines.push(`DTEND;VALUE=DATE:${fmtDate(nextDay(ev.end ?? ev.start))}`);
    } else {
      lines.push(`DTSTART:${isoToUtc(ev.start)}`);
      if (ev.end) lines.push(`DTEND:${isoToUtc(ev.end)}`);
    }
    lines.push(`SUMMARY:${escapeText(ev.title)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    lines.push(`LAST-MODIFIED:${ev.updated ? fmtUtc(new Date(ev.updated)) : stamp}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---------- parse ----------

export interface VEvent {
  uid: string | null;
  title: string;
  location: string | null;
  startMs: number; // epoch ms (UTC instant; for all-day, UTC midnight of that date)
  endMs: number | null;
  allDay: boolean;
  rrule: string | null; // raw RRULE value, or null
  exdates?: number[]; // recurrence start instants excluded by EXDATE or a cancelled RECURRENCE-ID
  tzid?: string; // valid DTSTART timezone; recurrence keeps this wall clock across DST
  url: string | null; // the event's canonical source URL (RFC 5545 URL property), or null
}

// Parse one DTSTART/DTEND value + its params into an instant. Handles DATE (all-day),
// UTC DATE-TIME (Z), TZID DATE-TIME (Intl), and naive DATE-TIME (treated as UTC).
function parseDt(params: Record<string, string>, value: string): { ms: number; allDay: boolean; tzid?: string } {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) throw new Error(`bad DATE: ${value}`);
    return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) throw new Error(`bad DATE-TIME: ${value}`);
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  if (m[7] === "Z") return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  if (params.TZID) {
    // An unknown/Windows-style TZID (e.g. Outlook's "Eastern Standard Time", or a bad
    // value) makes Intl throw -- fall back to naive UTC so the event still SHOWS UP in
    // the agenda (approximate time) rather than being dropped from the whole feed.
    try { return { ms: zonedToUtcMs(y, mo, d, h, mi, s, params.TZID), allDay: false, tzid: params.TZID }; }
    catch { return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false }; }
  }
  return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false }; // naive -> treat as UTC (documented)
}

function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_m, c) => (c === "n" || c === "N" ? "\n" : c));
}

// Parse a VCALENDAR's VEVENTs. Unfolds first (CRLF/CR/LF + space|tab). Tolerant: a
// VEVENT missing a parseable DTSTART is skipped rather than throwing on the whole feed.
export function parseIcs(text: string): VEvent[] {
  const unfolded = String(text).replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, "");
  const lines = unfolded.split(/\r\n|\n|\r/);
  const events: VEvent[] = [];
  const cancelledInstances: { uid: string; recurrenceIdMs: number }[] = [];
  let cur: Partial<VEvent> | null = null;
  let depth = 0; // nesting inside a VEVENT (VALARM etc.) -- skip those sub-component lines
  let startParams: Record<string, string> = {};
  let startVal = "";
  let endParams: Record<string, string> = {};
  let endVal = "";
  let recurrenceParams: Record<string, string> = {};
  let recurrenceVal = "";
  let status = "";
  let exdates: number[] = [];
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") {
      cur = { uid: null, title: "", location: null, allDay: false, rrule: null, url: null };
      depth = 0; startVal = ""; endVal = ""; recurrenceVal = ""; status = ""; exdates = [];
      startParams = {}; endParams = {}; recurrenceParams = {};
      continue;
    }
    // Skip properties of a nested component (e.g. a VALARM's own SUMMARY/DTSTART would
    // otherwise clobber the event's -- Google emails-reminder alarms do exactly this).
    if (cur && raw.startsWith("BEGIN:")) { depth++; continue; }
    if (cur && depth > 0) { if (raw.startsWith("END:")) depth--; continue; }
    if (raw === "END:VEVENT") {
      if (cur && status === "CANCELLED") {
        // Google may encode a deleted single instance as a detached VEVENT. It can omit
        // DTSTART, so RECURRENCE-ID is the authority for which generated start to remove.
        if (typeof cur.uid === "string" && recurrenceVal) {
          try { cancelledInstances.push({ uid: cur.uid, recurrenceIdMs: parseDt(recurrenceParams, recurrenceVal).ms }); }
          catch { /* malformed exception: skip it without dropping the rest of the feed */ }
        }
      } else if (cur && startVal) {
        try {
          const st = parseDt(startParams, startVal);
          const en = endVal ? parseDt(endParams, endVal) : null;
          events.push({
            uid: cur.uid ?? null, title: cur.title ?? "", location: cur.location ?? null,
            startMs: st.ms, endMs: en ? en.ms : null, allDay: st.allDay,
            rrule: cur.rrule ?? null, ...(exdates.length ? { exdates } : {}),
            ...(st.tzid ? { tzid: st.tzid } : {}), url: cur.url ?? null,
          });
        } catch { /* skip an unparseable event, keep the rest */ }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    const namePart = raw.slice(0, colon);
    const value = raw.slice(colon + 1);
    const [name, ...paramParts] = namePart.split(";");
    const params: Record<string, string> = {};
    // Strip surrounding double-quotes from param values -- TZID="America/New_York" is
    // valid RFC 5545 (Apple emits it); the raw quotes would make Intl reject the zone.
    for (const p of paramParts) { const eq = p.indexOf("="); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ""); }
    switch (name.toUpperCase()) {
      case "SUMMARY": cur.title = unescapeText(value); break;
      case "LOCATION": cur.location = unescapeText(value); break;
      case "UID": cur.uid = value; break;
      case "RRULE": cur.rrule = value; break;
      case "EXDATE":
        // One EXDATE property can carry a comma-separated list; multiple properties are
        // also legal. A bad member is ignored independently so one typo cannot sink the feed.
        for (const date of value.split(",")) {
          try { exdates.push(parseDt(params, date).ms); } catch { /* skip malformed exclusion */ }
        }
        break;
      case "RECURRENCE-ID": recurrenceParams = params; recurrenceVal = value; break;
      case "STATUS": status = value.trim().toUpperCase(); break;
      case "URL": cur.url = value; break; // URI value type (not TEXT) -- no backslash-escaping to undo
      case "DTSTART": startParams = params; startVal = value; break;
      case "DTEND": endParams = params; endVal = value; break;
      default: break;
    }
  }
  // Resolve detached cancellations within this one feed parse, before performPoll combines
  // multiple feeds. This prevents a same-UID cancellation in one linked calendar from
  // suppressing an unrelated event in another linked calendar.
  for (const { uid, recurrenceIdMs } of cancelledInstances) {
    for (const event of events) {
      if (event.uid !== uid || !event.rrule) continue;
      event.exdates = [...new Set([...(event.exdates ?? []), recurrenceIdMs])].sort((a, b) => a - b);
    }
  }
  return events;
}

// ---------- recurrence expansion (scoped) ----------

export interface Occurrence {
  uid: string | null;
  title: string;
  location: string | null;
  startMs: number;
  endMs: number | null;
  allDay: boolean;
  recurring: boolean;
  recurrenceUnexpanded?: boolean; // true when an exotic RRULE was surfaced, not expanded
  url: string | null; // the source event's URL property, or null
}

function rruleParts(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of rrule.split(";")) { const eq = kv.indexOf("="); if (eq > 0) out[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1); }
  return out;
}

function isExcluded(e: VEvent, startMs: number): boolean {
  return Array.isArray(e.exdates) && e.exdates.includes(startMs);
}

interface CivilStart { y: number; m: number; d: number; h: number; mi: number; s: number }

// DTSTART's calendar fields in its own timezone. Recurrence rules operate in this CIVIL
// space: a weekly 9am stays 9am when the UTC offset changes. Legacy/cache events without
// tzid retain the parser's documented UTC stepping behavior.
function civilStart(e: VEvent): CivilStart {
  if (e.tzid) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: e.tzid, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(new Date(e.startMs)).map((part) => [part.type, part.value]));
      return { y: +parts.year, m: +parts.month - 1, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
    } catch { /* malformed legacy tzid: preserve the old UTC fallback below */ }
  }
  const d = new Date(e.startMs);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

function occurrenceMs(e: VEvent, c: CivilStart, y: number, m: number, d: number): number {
  if (e.tzid) {
    try { return zonedToUtcMs(y, m + 1, d, c.h, c.mi, c.s, e.tzid); }
    catch { /* malformed legacy tzid: preserve the old UTC fallback below */ }
  }
  return Date.UTC(y, m, d, c.h, c.mi, c.s);
}

// The RRULE parts the plain-frequency stepper below can honor exactly. A WHITELIST, not a
// blacklist of known-dangerous parts: that shape failed twice (missed BY*, then RSCALE/SKIP), so
// anything NOT listed here -- a BY* refinement, a vendor `X-` part, a future RFC extension -- falls
// to the surfaced-unexpanded path by construction instead of being silently mis-stepped. RSCALE/
// SKIP are listed (so a rule carrying them can still be simple) but then get a narrower check: only
// an ordinary Gregorian one qualifies (see the predicate). WKST is a no-op without BY parts.
const STEPPABLE_RRULE_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST", "RSCALE", "SKIP"]);

const MS_PER_DAY = 86400000;

// Does [startMs, effectiveEnd) overlap the inclusive window [fromMs, toMs]? DTEND is EXCLUSIVE
// (RFC 5545 §3.6.1): an event overlaps iff it hasn't already ended at fromMs. An all-day event with
// no explicit end spans its WHOLE day; a timed point event (no end) is a start-instant. Shared by
// expandInWindow and expandByRule so both judge the window edge identically.
function overlapsWindow(startMs: number, endMs: number | null, allDay: boolean, fromMs: number, toMs: number): boolean {
  const effEnd = endMs != null ? endMs : (allDay ? startMs + MS_PER_DAY : null);
  return (effEnd != null ? effEnd > fromMs : startMs >= fromMs) && startMs <= toMs;
}

const WEEKDAY_NUM: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Parse a BYDAY value ("MO,WE,FR", or ordinal forms "2WE" / "-1FR") into {ord, weekday} pairs; null
// on any malformed token, so the caller fails safe to the surfaced-unexpanded path.
function parseByDay(v: string): { ord: number | null; wd: number }[] | null {
  const out: { ord: number | null; wd: number }[] = [];
  for (const raw of v.split(",")) {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(raw.trim().toUpperCase());
    if (!m) return null;
    const ord = m[1] ? Number(m[1]) : null;
    if (ord === 0) return null; // an ordinal of 0 (0MO/+0/-0) is invalid per RFC 5545; surface, don't silently drop
    out.push({ ord, wd: WEEKDAY_NUM[m[2]] });
  }
  return out.length ? out : null;
}

// Parse a comma list of nonzero integers within [min,max]; null on any bad token. BYMONTHDAY allows
// negatives (from month end); BYMONTH is 1..12.
function parseIntList(v: string, min: number, max: number): number[] | null {
  const out: number[] = [];
  for (const raw of v.split(",")) {
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n === 0 || n < min || n > max) return null;
    out.push(n);
  }
  return out.length ? out : null;
}

const utcDaysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// A BYMONTHDAY entry -> concrete day-of-month in (y,m), or null when it doesn't exist there (e.g. 30
// in February): RFC 5545 simply omits it for that month rather than rolling it forward.
function resolveMonthDay(y: number, m: number, n: number): number | null {
  const dim = utcDaysInMonth(y, m);
  const day = n > 0 ? n : dim + n + 1; // -1 -> last day, -2 -> second-to-last, ...
  return day >= 1 && day <= dim ? day : null;
}

// Days-of-month (ascending) in (y,m) whose weekday is wd, narrowed to the ordinal when the BYDAY
// token carried one (2 -> the 2nd such weekday, -1 -> the last). Empty when the ordinal overshoots.
function weekdayDaysOfMonth(y: number, m: number, wd: number, ord: number | null): number[] {
  const dim = utcDaysInMonth(y, m);
  const all: number[] = [];
  for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) all.push(d);
  if (ord == null) return all;
  const idx = ord > 0 ? ord - 1 : all.length + ord;
  return idx >= 0 && idx < all.length ? [all[idx]] : [];
}

// Expand the COMMON BY-refined RRULEs real calendars actually emit -- a weekly class on set weekdays
// (FREQ=WEEKLY;BYDAY=MO,WE,FR), a monthly "2nd Wednesday" or "on the 15th", an annual date -- which
// the plain-frequency stepper below cannot. Google/Apple write a BYDAY on essentially every weekly
// repeat, and surfacing those unexpanded makes calendar-mirror clamp each one onto TODAY (its day-0
// fallback for a past base occurrence), so a weekly class renders as happening every single day.
// Returns null for any rule shape NOT recognized here (caller then surfaces it unexpanded, as
// before); returns [] for a recognized rule with no in-window occurrence (correct -- show nothing).
// Calendar-date arithmetic uses a DST-free UTC token, then converts each candidate through
// DTSTART's TZID so recurring wall-clock times and exception identities remain stable.
function expandByRule(
  e: VEvent, p: Record<string, string>, freq: string, interval: number,
  count: number, until: number, fromMs: number, toMs: number,
): Occurrence[] | null {
  // Only plain-Gregorian rules with the BY parts handled below. RSCALE/SKIP (Google birthdays) keep
  // the stepper's own careful handling; BYSETPOS/BYWEEKNO/BYYEARDAY/BYHOUR/... stay unexpanded.
  if (p.RSCALE || p.SKIP) return null;
  const by = new Set(Object.keys(p).filter((k) => k.startsWith("BY")));
  const onlyBy = (...ok: string[]): boolean => [...by].every((k) => ok.includes(k));

  const c0 = civilStart(e);
  const y0 = c0.y, m0 = c0.m, day0 = c0.d;
  const mk = (y: number, m: number, d: number): number => occurrenceMs(e, c0, y, m, d);
  const mkToken = (token: number): number => {
    const date = new Date(token);
    return mk(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  };

  // period(i): the i-th period's candidate start instants, ascending. periodStart(i): that period's
  // opening instant, used only for the empty-period termination check. Built per FREQ.
  let period: (i: number) => number[];
  let periodStart: (i: number) => number;

  if (freq === "DAILY") {
    if (!by.has("BYDAY") || !onlyBy("BYDAY")) return null;
    const days = parseByDay(p.BYDAY);
    if (!days || days.some((x) => x.ord != null)) return null; // an ordinal is meaningless for DAILY
    const wds = new Set(days.map((x) => x.wd));
    const startTok = Date.UTC(y0, m0, day0);
    period = (i) => { const t = startTok + i * interval * MS_PER_DAY; return wds.has(new Date(t).getUTCDay()) ? [mkToken(t)] : []; };
    periodStart = (i) => mkToken(startTok + i * interval * MS_PER_DAY);
  } else if (freq === "WEEKLY") {
    if (!by.has("BYDAY") || !onlyBy("BYDAY")) return null;
    const days = parseByDay(p.BYDAY);
    if (!days || days.some((x) => x.ord != null)) return null; // an ordinal is invalid for WEEKLY (as for DAILY) -> surface
    const wkst = WEEKDAY_NUM[(p.WKST || "MO").toUpperCase()] ?? 1;
    const offsets = [...new Set(days.map((x) => (((x.wd - wkst) % 7) + 7) % 7))].sort((a, b) => a - b);
    const startTok = Date.UTC(y0, m0, day0);
    const startWeekday = new Date(startTok).getUTCDay();
    const weekStart = startTok - ((((startWeekday - wkst) % 7) + 7) % 7) * MS_PER_DAY;
    period = (i) => { const base = weekStart + i * interval * 7 * MS_PER_DAY; return offsets.map((o) => mkToken(base + o * MS_PER_DAY)); };
    periodStart = (i) => mkToken(weekStart + i * interval * 7 * MS_PER_DAY);
  } else if (freq === "MONTHLY") {
    if (!onlyBy("BYMONTHDAY", "BYDAY")) return null;
    const mdList = by.has("BYMONTHDAY") ? parseIntList(p.BYMONTHDAY, -31, 31) : null;
    const bdList = by.has("BYDAY") ? parseByDay(p.BYDAY) : null;
    if ((by.has("BYMONTHDAY") && !mdList) || (by.has("BYDAY") && !bdList)) return null;
    if (!mdList && !bdList) return null; // MONTHLY with no day selector is just the plain stepper
    period = (i) => {
      const t = Date.UTC(y0, m0 + i * interval, 1); // month arithmetic overflows into years cleanly
      const y = new Date(t).getUTCFullYear(), m = new Date(t).getUTCMonth();
      const set = new Set<number>();
      if (mdList) for (const n of mdList) { const d = resolveMonthDay(y, m, n); if (d) set.add(d); }
      if (bdList) for (const { ord, wd } of bdList) for (const d of weekdayDaysOfMonth(y, m, wd, ord)) set.add(d);
      return [...set].sort((a, b) => a - b).map((d) => mk(y, m, d));
    };
    periodStart = (i) => { const date = new Date(Date.UTC(y0, m0 + i * interval, 1)); return mk(date.getUTCFullYear(), date.getUTCMonth(), 1); };
  } else if (freq === "YEARLY") {
    if (!by.has("BYMONTH") || !onlyBy("BYMONTH", "BYMONTHDAY", "BYDAY")) return null;
    const monthNums = parseIntList(p.BYMONTH, 1, 12);
    if (!monthNums) return null;
    const mons = [...new Set(monthNums.map((n) => n - 1))].sort((a, b) => a - b);
    const mdList = by.has("BYMONTHDAY") ? parseIntList(p.BYMONTHDAY, -31, 31) : null;
    const bdList = by.has("BYDAY") ? parseByDay(p.BYDAY) : null;
    if ((by.has("BYMONTHDAY") && !mdList) || (by.has("BYDAY") && !bdList)) return null;
    period = (i) => {
      const y = y0 + i * interval;
      const starts: number[] = [];
      for (const m of mons) {
        const set = new Set<number>();
        if (mdList) for (const n of mdList) { const d = resolveMonthDay(y, m, n); if (d) set.add(d); }
        if (bdList) for (const { ord, wd } of bdList) for (const d of weekdayDaysOfMonth(y, m, wd, ord)) set.add(d);
        if (!mdList && !bdList && day0 <= utcDaysInMonth(y, m)) set.add(day0); // BYMONTH only -> DTSTART's day
        for (const d of [...set].sort((a, b) => a - b)) starts.push(mk(y, m, d));
      }
      return starts.sort((a, b) => a - b);
    };
    periodStart = (i) => mk(y0 + i * interval, 0, 1);
  } else {
    return null;
  }

  const dur = e.endMs != null ? Math.max(0, e.endMs - e.startMs) : 0;
  const base = { uid: e.uid, title: e.title, location: e.location, allDay: e.allDay, url: e.url };
  // Fast-forward to the window ONLY when the rule is unbounded by COUNT: a COUNT caps the TOTAL
  // occurrences from DTSTART, so those must be counted from i=0 rather than skipped. UNTIL doesn't
  // count occurrences, so skipping ahead past it is fine. The per-freq step below is an UPPER bound
  // on the true period length (31d/366d for month/year) so floor() never overshoots the target
  // period; the extra -1, and backing the anchor off by the event's own duration + a day, keep a
  // long occurrence that starts before the window but overlaps into it from being skipped.
  const ffAnchor = fromMs - dur - MS_PER_DAY;
  const stepUpper = freq === "DAILY" ? interval * MS_PER_DAY
    : freq === "WEEKLY" ? interval * 7 * MS_PER_DAY
    : freq === "MONTHLY" ? interval * 31 * MS_PER_DAY
    : interval * 366 * MS_PER_DAY;
  let i = count === Infinity ? Math.max(0, Math.floor((ffAnchor - periodStart(0)) / stepUpper) - 1) : 0;
  const iCap = i + 6000; // hard safety bound, in the spirit of the stepper's own i>5000 cap
  const out: Occurrence[] = [];
  let emitted = 0;
  for (; i <= iCap; i++) {
    for (const s of period(i)) {
      if (s < e.startMs) continue;           // recurrence instances are >= DTSTART
      if (s > toMs || s > until) return out;  // candidates and periods are monotonic -> nothing later qualifies
      if (++emitted > count) return out;      // COUNT counts every occurrence from DTSTART, in or out of window
      const end = e.endMs != null ? s + dur : null;
      if (!isExcluded(e, s) && overlapsWindow(s, end, e.allDay, fromMs, toMs)) out.push({ ...base, startMs: s, endMs: end, recurring: true });
    }
    if (periodStart(i) > toMs && periodStart(i) > until) break; // an empty period can't trip the inner break
  }
  return out;
}

// Expand each parsed event into concrete occurrences overlapping [fromMs, toMs].
// Non-recurring: included if it overlaps the window. Simple FREQ=DAILY|WEEKLY|MONTHLY|YEARLY
// (+ INTERVAL/COUNT/UNTIL, no BY* parts): stepped and clipped to the window. Anything else (any
// BY* part -- BYDAY/BYMONTHDAY/BYSETPOS/BYMONTH/BYYEARDAY/BYWEEKNO -- or an unparseable rule): the
// base occurrence is surfaced with recurrenceUnexpanded=true rather than silently dropped.
export function expandInWindow(events: VEvent[], fromMs: number, toMs: number): Occurrence[] {
  const out: Occurrence[] = [];
  const DAY = 86400000;
  const durationOf = (e: VEvent): number => (e.endMs != null ? Math.max(0, e.endMs - e.startMs) : 0);
  // DTEND is EXCLUSIVE (RFC 5545 §3.6.1): an event overlaps the window iff it hasn't
  // already ended at fromMs. An all-day event with no explicit end spans the WHOLE day
  // (so it stays on the agenda all of its own date, not just at 00:00). A timed point
  // event (no end) is a start-instant.
  const overlaps = (startMs: number, endMs: number | null, allDay: boolean): boolean =>
    overlapsWindow(startMs, endMs, allDay, fromMs, toMs);
  for (const e of events) {
    const base = { uid: e.uid, title: e.title, location: e.location, allDay: e.allDay, url: e.url };
    if (!e.rrule) {
      if (!isExcluded(e, e.startMs) && overlaps(e.startMs, e.endMs, e.allDay)) out.push({ ...base, startMs: e.startMs, endMs: e.endMs, recurring: false });
      continue;
    }
    const p = rruleParts(e.rrule);
    const freq = p.FREQ;
    const interval = Math.max(1, Number(p.INTERVAL) || 1);
    // A malformed COUNT/UNTIL must not throw out of the whole expansion or silently
    // drop the event -- treat an unparseable RRULE as not-simple (surfaced below),
    // honoring parseIcs's tolerance contract.
    let count = Infinity;
    let until = Infinity;
    let ruleOk = true;
    try {
      if (p.COUNT) { count = Number(p.COUNT); if (!Number.isInteger(count) || count < 1) ruleOk = false; }
      if (p.UNTIL) until = parseDt({}, p.UNTIL).ms;
    } catch { ruleOk = false; }
    // "Simple" = a bare frequency this loop can step exactly. WHITELIST the honored parts
    // (STEPPABLE_RRULE_PARTS) so anything else -- any BY-part, a vendor X- part, a future RFC
    // extension -- surfaces unexpanded by construction, instead of a blacklist that kept missing new
    // parts (BY* once, then RSCALE/SKIP). RSCALE/SKIP are in the whitelist but then get this
    // narrower check below.
    // RFC 7529 RSCALE/SKIP (Google puts these on birthdays): a NON-Gregorian scale never steps as
    // plain Gregorian, and an overflow-capable start (Feb 29 for YEARLY, day>28 for MONTHLY) is
    // where SKIP's resolution diverges from our roll-forward tolerance -- bail on those. But an
    // ordinary RSCALE=GREGORIAN date (the COMMON birthday) steps correctly, so it stays simple; a
    // blanket RSCALE bail would clamp every Google birthday onto today via the unexpanded path.
    // Timed RSCALE/SKIP remains outside this deliberately scoped expander even though civilStart
    // now recovers its local date: RFC 7529 overflow behavior is only covered for the all-day Google
    // birthday shape. Bail rather than silently applying plain-Gregorian semantics.
    const startCivil = civilStart(e);
    const overflowStart = (freq === "YEARLY" && startCivil.m === 1 && startCivil.d === 29)
      || (freq === "MONTHLY" && startCivil.d > 28);
    const simple = ruleOk && (freq === "DAILY" || freq === "WEEKLY" || freq === "MONTHLY" || freq === "YEARLY")
      && Object.keys(p).every((k) => STEPPABLE_RRULE_PARTS.has(k))
      && (!p.RSCALE || p.RSCALE.toUpperCase() === "GREGORIAN")
      && !((p.RSCALE || p.SKIP) && (overflowStart || !e.allDay));
    if (!simple) {
      // Before surfacing-and-clamping, try to actually EXPAND the common BY-refined rules real
      // calendars emit (weekly-on-weekdays, monthly nth-weekday / on-the-Nth, yearly-on-a-date). A
      // recognized rule returns its real windowed occurrences (possibly none); only a genuinely
      // exotic or malformed rule falls through to the surfaced base occurrence below. Gated on
      // ruleOk so a malformed COUNT/UNTIL still surfaces rather than expands.
      if (ruleOk) {
        const expanded = expandByRule(e, p, freq, interval, count, until, fromMs, toMs);
        if (expanded) { for (const o of expanded) out.push(o); continue; }
      }
      // An exotic rule whose UNTIL has already passed can never occur again -- skip it, don't
      // surface it, or the calendar-mirror floor exemption would clamp it onto today's cell in the
      // home view permanently (b0cfbf7 review). UNTIL bounds the last occurrence's START, so mirror
      // `overlaps`'s effective-end exactly for that last start and drop only when even it can't reach
      // the window floor: an explicit end (honored even for all-day) allows the full span past UNTIL,
      // a bare all-day allows one day, and a bare timed point falls back to the start itself. Using
      // the wrong allowance here would drop a still-live multi-day all-day series (1068be6 review).
      // (A past COUNT-bounded exotic rule can't be caught this cheaply and isn't worth expanding one.)
      const untilEffEnd = e.endMs != null ? until + durationOf(e) : (e.allDay ? until + DAY : until);
      const stillReaches = e.endMs != null || e.allDay ? untilEffEnd > fromMs : untilEffEnd >= fromMs;
      if (until !== Infinity && !stillReaches) continue;
      if (!isExcluded(e, e.startMs)) out.push({ ...base, startMs: e.startMs, endMs: e.endMs, recurring: true, recurrenceUnexpanded: true });
      continue;
    }
    const dur = durationOf(e);
    const start = civilStart(e);
    const step = (i: number): number => {
      // UTC is only a DST-free calendar-arithmetic token here. Convert the resulting
      // civil date back through DTSTART's TZID so its wall-clock time stays fixed.
      const d = new Date(Date.UTC(start.y, start.m, start.d, start.h, start.mi, start.s));
      if (freq === "DAILY") d.setUTCDate(d.getUTCDate() + i * interval);
      else if (freq === "WEEKLY") d.setUTCDate(d.getUTCDate() + i * interval * 7);
      else if (freq === "YEARLY") d.setUTCFullYear(d.getUTCFullYear() + i * interval); // Feb 29 rolls to Mar 1 off-leap; same tolerance as MONTHLY's day overflow
      else d.setUTCMonth(d.getUTCMonth() + i * interval); // MONTHLY (day overflow rolls forward; acceptable for awareness)
      return occurrenceMs(e, start, d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    };
    for (let i = 0, emitted = 0; emitted < count; i++) {
      const s = step(i);
      if (s > toMs || s > until) break;
      if (i > 5000) break; // hard safety bound
      emitted++; // COUNT counts every occurrence from DTSTART, in or out of window
      const end = e.endMs != null ? s + dur : null;
      if (!isExcluded(e, s) && overlaps(s, end, e.allDay)) out.push({ ...base, startMs: s, endMs: end, recurring: true });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}
