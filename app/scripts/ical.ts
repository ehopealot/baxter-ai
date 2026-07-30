// iCalendar (RFC 5545) generate + parse, hand-rolled and unit-tested rather than
// pulling a dependency: buildIcs produces Baxter's OWN published feed (full control +
// tests beat a lib, like the transcript sanitizer), and parseIcs/expandInWindow read
// the family's polled feed for an agenda view. Parsing is deliberately scoped (see
// expandInWindow): simple recurrence is expanded; exotic RRULE is surfaced, not
// silently dropped. No timezone lib — TZID is resolved via Node's built-in Intl
// (full IANA tz data), so no dependency and no stale offset table.

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
      lines.push(`DTEND;VALUE=DATE:${fmtDate(ev.end ?? nextDay(ev.start))}`);
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
}

// Wall-clock parts in `tzid` -> the UTC epoch ms of that instant, via Intl (Node's
// IANA tz data). Two-pass to settle DST-boundary offsets.
function zonedToUtcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (ms: number): number => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p: Record<string, number> = {};
    for (const part of dtf.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    return shown - ms; // how far ahead of UTC the zone is at `ms`
  };
  const off1 = offsetAt(guess);
  return guess - offsetAt(guess - off1);
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
  if (params.TZID) return { ms: zonedToUtcMs(y, mo, d, h, mi, s, params.TZID), allDay: false };
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
  let cur: Partial<VEvent> & { _startParams?: Record<string, string>; _startVal?: string } | null = null;
  let startParams: Record<string, string> = {};
  let startVal = "";
  let endParams: Record<string, string> = {};
  let endVal = "";
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") { cur = { uid: null, title: "", location: null, allDay: false, rrule: null }; startVal = ""; endVal = ""; startParams = {}; endParams = {}; continue; }
    if (raw === "END:VEVENT") {
      if (cur && startVal) {
        try {
          const st = parseDt(startParams, startVal);
          const en = endVal ? parseDt(endParams, endVal) : null;
          events.push({ uid: cur.uid ?? null, title: cur.title ?? "", location: cur.location ?? null, startMs: st.ms, endMs: en ? en.ms : null, allDay: st.allDay, rrule: cur.rrule ?? null });
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
    for (const p of paramParts) { const eq = p.indexOf("="); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1); }
    switch (name.toUpperCase()) {
      case "SUMMARY": cur.title = unescapeText(value); break;
      case "LOCATION": cur.location = unescapeText(value); break;
      case "UID": cur.uid = value; break;
      case "RRULE": cur.rrule = value; break;
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
}

function rruleParts(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of rrule.split(";")) { const eq = kv.indexOf("="); if (eq > 0) out[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1); }
  return out;
}

// Expand each parsed event into concrete occurrences overlapping [fromMs, toMs].
// Non-recurring: included if it overlaps the window. Simple FREQ=DAILY|WEEKLY|MONTHLY
// (+ INTERVAL/COUNT/UNTIL): stepped and clipped to the window. Anything else (BYDAY
// lists, BYSETPOS, FREQ=YEARLY, unparseable): the base occurrence is surfaced with
// recurrenceUnexpanded=true rather than silently dropped.
export function expandInWindow(events: VEvent[], fromMs: number, toMs: number): Occurrence[] {
  const out: Occurrence[] = [];
  const durationOf = (e: VEvent): number => (e.endMs != null ? Math.max(0, e.endMs - e.startMs) : 0);
  for (const e of events) {
    const base = { uid: e.uid, title: e.title, location: e.location, allDay: e.allDay };
    if (!e.rrule) {
      const end = e.endMs ?? e.startMs;
      if (end >= fromMs && e.startMs <= toMs) out.push({ ...base, startMs: e.startMs, endMs: e.endMs, recurring: false });
      continue;
    }
    const p = rruleParts(e.rrule);
    const freq = p.FREQ;
    const interval = Math.max(1, Number(p.INTERVAL) || 1);
    const count = p.COUNT ? Number(p.COUNT) : Infinity;
    const until = p.UNTIL ? parseDt({}, p.UNTIL).ms : Infinity;
    const simple = (freq === "DAILY" || freq === "WEEKLY" || freq === "MONTHLY") && !p.BYDAY && !p.BYMONTHDAY && !p.BYSETPOS && !p.BYMONTH;
    if (!simple) {
      out.push({ ...base, startMs: e.startMs, endMs: e.endMs, recurring: true, recurrenceUnexpanded: true });
      continue;
    }
    const dur = durationOf(e);
    const step = (i: number): number => {
      const d = new Date(e.startMs);
      if (freq === "DAILY") d.setUTCDate(d.getUTCDate() + i * interval);
      else if (freq === "WEEKLY") d.setUTCDate(d.getUTCDate() + i * interval * 7);
      else d.setUTCMonth(d.getUTCMonth() + i * interval); // MONTHLY (day overflow rolls forward; acceptable for awareness)
      return d.getTime();
    };
    for (let i = 0, emitted = 0; emitted < count; i++) {
      const s = step(i);
      if (s > toMs || s > until) break;
      if (i > 5000) break; // hard safety bound
      emitted++; // COUNT counts every occurrence from DTSTART, in or out of window
      const end = s + dur;
      if (end >= fromMs && s <= toMs) out.push({ ...base, startMs: s, endMs: e.endMs != null ? end : null, recurring: true });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}
