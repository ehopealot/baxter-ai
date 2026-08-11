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
  url: string | null; // the event's canonical source URL (RFC 5545 URL property), or null
}

// Parse one DTSTART/DTEND value + its params into an instant. Handles DATE (all-day),
// UTC DATE-TIME (Z), TZID DATE-TIME (Intl), and naive DATE-TIME (treated as UTC).
function parseDt(params: Record<string, string>, value: string): { ms: number; allDay: boolean } {
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
    try { return { ms: zonedToUtcMs(y, mo, d, h, mi, s, params.TZID), allDay: false }; }
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
  let cur: Partial<VEvent> | null = null;
  let depth = 0; // nesting inside a VEVENT (VALARM etc.) -- skip those sub-component lines
  let startParams: Record<string, string> = {};
  let startVal = "";
  let endParams: Record<string, string> = {};
  let endVal = "";
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") { cur = { uid: null, title: "", location: null, allDay: false, rrule: null, url: null }; depth = 0; startVal = ""; endVal = ""; startParams = {}; endParams = {}; continue; }
    // Skip properties of a nested component (e.g. a VALARM's own SUMMARY/DTSTART would
    // otherwise clobber the event's -- Google emails-reminder alarms do exactly this).
    if (cur && raw.startsWith("BEGIN:")) { depth++; continue; }
    if (cur && depth > 0) { if (raw.startsWith("END:")) depth--; continue; }
    if (raw === "END:VEVENT") {
      if (cur && startVal) {
        try {
          const st = parseDt(startParams, startVal);
          const en = endVal ? parseDt(endParams, endVal) : null;
          events.push({ uid: cur.uid ?? null, title: cur.title ?? "", location: cur.location ?? null, startMs: st.ms, endMs: en ? en.ms : null, allDay: st.allDay, rrule: cur.rrule ?? null, url: cur.url ?? null });
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
      case "URL": cur.url = value; break; // URI value type (not TEXT) -- no backslash-escaping to undo
      case "DTSTART": startParams = params; startVal = value; break;
      case "DTEND": endParams = params; endVal = value; break;
      default: break;
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

// The RRULE parts the plain-frequency stepper below can honor exactly. A WHITELIST, not a
// blacklist of known-dangerous parts: that shape failed twice (missed BY*, then RSCALE/SKIP), so
// anything NOT listed here -- a BY* refinement, a vendor `X-` part, a future RFC extension -- falls
// to the surfaced-unexpanded path by construction instead of being silently mis-stepped. RSCALE/
// SKIP are listed (so a rule carrying them can still be simple) but then get a narrower check: only
// an ordinary Gregorian one qualifies (see the predicate). WKST is a no-op without BY parts.
const STEPPABLE_RRULE_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST", "RSCALE", "SKIP"]);

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
  const overlaps = (startMs: number, endMs: number | null, allDay: boolean): boolean => {
    const effEnd = endMs != null ? endMs : (allDay ? startMs + DAY : null);
    return (effEnd != null ? effEnd > fromMs : startMs >= fromMs) && startMs <= toMs;
  };
  for (const e of events) {
    const base = { uid: e.uid, title: e.title, location: e.location, allDay: e.allDay, url: e.url };
    if (!e.rrule) {
      if (overlaps(e.startMs, e.endMs, e.allDay)) out.push({ ...base, startMs: e.startMs, endMs: e.endMs, recurring: false });
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
    // overflowStart reads the UTC calendar date, which equals the literal date only for an all-day
    // event (VALUE=DATE -> UTC midnight). A TIMED DTSTART with a TZID can sit on a different UTC day,
    // so the overflow check isn't trustworthy there -- bail on ANY timed RSCALE/SKIP rule too.
    // RSCALE emitters (Google birthdays) are all-day in practice, so this only fail-safes cases that
    // don't really occur.
    const sd = new Date(e.startMs);
    const overflowStart = (freq === "YEARLY" && sd.getUTCMonth() === 1 && sd.getUTCDate() === 29)
      || (freq === "MONTHLY" && sd.getUTCDate() > 28);
    const simple = ruleOk && (freq === "DAILY" || freq === "WEEKLY" || freq === "MONTHLY" || freq === "YEARLY")
      && Object.keys(p).every((k) => STEPPABLE_RRULE_PARTS.has(k))
      && (!p.RSCALE || p.RSCALE.toUpperCase() === "GREGORIAN")
      && !((p.RSCALE || p.SKIP) && (overflowStart || !e.allDay));
    if (!simple) {
      // An exotic rule whose UNTIL has already passed can never occur again -- skip it, don't
      // surface it, or the calendar-mirror floor exemption would clamp it onto today's cell in the
      // home view permanently (b0cfbf7 review). UNTIL bounds the last occurrence's START, so allow
      // the event's own duration past it before ruling it out. (A past COUNT-bounded exotic rule
      // can't be caught this cheaply and isn't worth expanding an exotic rule to find.)
      if (until !== Infinity && until + (e.allDay ? DAY : durationOf(e)) <= fromMs) continue;
      out.push({ ...base, startMs: e.startMs, endMs: e.endMs, recurring: true, recurrenceUnexpanded: true });
      continue;
    }
    const dur = durationOf(e);
    const step = (i: number): number => {
      const d = new Date(e.startMs);
      if (freq === "DAILY") d.setUTCDate(d.getUTCDate() + i * interval);
      else if (freq === "WEEKLY") d.setUTCDate(d.getUTCDate() + i * interval * 7);
      else if (freq === "YEARLY") d.setUTCFullYear(d.getUTCFullYear() + i * interval); // Feb 29 rolls to Mar 1 off-leap; same tolerance as MONTHLY's day overflow
      else d.setUTCMonth(d.getUTCMonth() + i * interval); // MONTHLY (day overflow rolls forward; acceptable for awareness)
      return d.getTime();
    };
    for (let i = 0, emitted = 0; emitted < count; i++) {
      const s = step(i);
      if (s > toMs || s > until) break;
      if (i > 5000) break; // hard safety bound
      emitted++; // COUNT counts every occurrence from DTSTART, in or out of window
      const end = e.endMs != null ? s + dur : null;
      if (overlaps(s, end, e.allDay)) out.push({ ...base, startMs: s, endMs: end, recurring: true });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}
