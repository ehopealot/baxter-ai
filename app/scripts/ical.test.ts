// Unit tests for the hand-rolled iCalendar core (ical.ts): RFC 5545 generation
// (folding, escaping, DATE vs DATE-TIME, stable UID), parsing (unfold, TZID via
// Intl, tolerance), and scoped recurrence expansion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIcs, parseIcs, expandInWindow, foldLine, fmtUtc } from "./ical.ts";
import type { CalEvent } from "./ical.ts";

const NOW = new Date("2026-07-30T12:00:00Z");
const ev = (o: Partial<CalEvent>): CalEvent => ({ uid: "u1@baxter", title: "Thing", start: "2026-08-04T15:00:00Z", ...o });

test("buildIcs: a timed event has CRLF lines, UTC DTSTART, the passed UID, and VCALENDAR bookends", () => {
  const ics = buildIcs([ev({})], { now: NOW });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
  assert.match(ics, /\r\nUID:u1@baxter\r\n/);
  assert.match(ics, /\r\nDTSTART:20260804T150000Z\r\n/);
  assert.match(ics, /\r\nSUMMARY:Thing\r\n/);
  assert.match(ics, /\r\nDTSTAMP:20260730T120000Z\r\n/); // deterministic given `now`
  assert.ok(ics.includes("\r\n") && !/\n\n/.test(ics.replace(/\r/g, ""))); // CRLF, no bare LF pairs
});

test("buildIcs: all-day uses VALUE=DATE and an exclusive next-day DTEND", () => {
  const ics = buildIcs([ev({ allDay: true, start: "2026-08-04", end: undefined })], { now: NOW });
  assert.match(ics, /\r\nDTSTART;VALUE=DATE:20260804\r\n/);
  assert.match(ics, /\r\nDTEND;VALUE=DATE:20260805\r\n/); // day after
});

test("buildIcs: an all-day range treats --end as INCLUSIVE (emits the exclusive day-after)", () => {
  const ics = buildIcs([ev({ allDay: true, start: "2026-08-04", end: "2026-08-06" })], { now: NOW }); // 3-day camp Aug 4-6
  assert.match(ics, /DTSTART;VALUE=DATE:20260804/);
  assert.match(ics, /DTEND;VALUE=DATE:20260807/); // day after the inclusive Aug 6 -> covers Aug 4,5,6
});

test("buildIcs: TEXT fields escape backslash, semicolon, comma, and newline", () => {
  const ics = buildIcs([ev({ title: "Lunch; w/ Bob, & \\x\nline2" })], { now: NOW });
  assert.match(ics, /SUMMARY:Lunch\\; w\/ Bob\\, & \\\\x\\nline2/);
});

test("buildIcs: a long SUMMARY folds at 75 octets and round-trips through parseIcs", () => {
  const title = "Soccer practice at the far field ".repeat(4).trim(); // >75 chars
  const ics = buildIcs([ev({ title })], { now: NOW });
  assert.match(ics, /\r\n /); // a fold (CRLF + space) is present
  assert.equal(parseIcs(ics)[0].title, title); // unfolds back to the exact title
});

test("buildIcs -> parseIcs round-trips title, start, and escaped text", () => {
  const ics = buildIcs([ev({ title: "A; B, C\\D\nE", start: "2026-08-04T15:30:00Z" })], { now: NOW });
  const [p] = parseIcs(ics);
  assert.equal(p.title, "A; B, C\\D\nE");
  assert.equal(p.startMs, Date.UTC(2026, 7, 4, 15, 30, 0));
  assert.equal(p.allDay, false);
});

test("foldLine folds >75 octets with a leading-space continuation and never on this ascii boundary splits mid-char", () => {
  const folded = foldLine("X".repeat(200));
  for (const seg of folded.split("\r\n")) assert.ok(Buffer.byteLength(seg, "utf8") <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), "X".repeat(200)); // unfolds exactly
});

test("parseIcs: DATE is all-day, DATE-TIME with Z is exact UTC", () => {
  const ics = [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a", "SUMMARY:All day", "DTSTART;VALUE=DATE:20260804", "END:VEVENT",
    "BEGIN:VEVENT", "UID:b", "SUMMARY:Timed", "DTSTART:20260804T093000Z", "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const evs = parseIcs(ics);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].allDay, true);
  assert.equal(evs[0].startMs, Date.UTC(2026, 7, 4));
  assert.equal(evs[1].allDay, false);
  assert.equal(evs[1].startMs, Date.UTC(2026, 7, 4, 9, 30, 0));
});

test("parseIcs: a TZID wall-clock time resolves to UTC via Intl (EDT summer = UTC-4)", () => {
  const ics = ["BEGIN:VEVENT", "UID:c", "SUMMARY:Dentist", "DTSTART;TZID=America/New_York:20260804T110000", "END:VEVENT"].join("\r\n");
  const [p] = parseIcs(ics);
  assert.equal(p.startMs, Date.UTC(2026, 7, 4, 15, 0, 0)); // 11:00 EDT -> 15:00 UTC
});

test("parseIcs: a nested VALARM's properties don't clobber the event's own (Google email-reminder shape)", () => {
  const ics = [
    "BEGIN:VEVENT", "UID:e", "SUMMARY:Real Title", "DTSTART:20260804T140000Z",
    "BEGIN:VALARM", "ACTION:EMAIL", "SUMMARY:Alarm notification", "TRIGGER:-PT30M", "END:VALARM",
    "END:VEVENT",
  ].join("\r\n");
  const [p] = parseIcs(ics);
  assert.equal(p.title, "Real Title"); // NOT "Alarm notification"
  assert.equal(p.startMs, Date.UTC(2026, 7, 4, 14, 0, 0));
});

test("parseIcs: a QUOTED TZID (Apple style) resolves instead of dropping the event", () => {
  const ics = ["BEGIN:VEVENT", "UID:q", "SUMMARY:Quoted", 'DTSTART;TZID="America/New_York":20260804T110000', "END:VEVENT"].join("\r\n");
  const [p] = parseIcs(ics);
  assert.equal(p.title, "Quoted");
  assert.equal(p.startMs, Date.UTC(2026, 7, 4, 15, 0, 0)); // 11:00 EDT -> 15:00 UTC
});

test("parseIcs: an unknown/Windows TZID falls back to naive UTC (surfaced, not dropped)", () => {
  const ics = ["BEGIN:VEVENT", "UID:w", "SUMMARY:Outlook", "DTSTART;TZID=Eastern Standard Time:20260804T110000", "END:VEVENT"].join("\r\n");
  const evs = parseIcs(ics);
  assert.equal(evs.length, 1); // NOT dropped by an Intl RangeError
  assert.equal(evs[0].startMs, Date.UTC(2026, 7, 4, 11, 0, 0)); // approximate: naive UTC
});

test("parseIcs: captures a URL: line, and yields null when absent", () => {
  const ics = [
    "BEGIN:VEVENT", "UID:withurl", "SUMMARY:Has URL", "DTSTART:20260804T140000Z", "URL:https://example.com/event/withurl", "END:VEVENT",
    "BEGIN:VEVENT", "UID:nourl", "SUMMARY:No URL", "DTSTART:20260804T150000Z", "END:VEVENT",
  ].join("\r\n");
  const evs = parseIcs(ics);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].url, "https://example.com/event/withurl");
  assert.equal(evs[1].url, null);
});

test("parseIcs: an unparseable event is skipped, the rest survive", () => {
  const ics = [
    "BEGIN:VEVENT", "UID:bad", "SUMMARY:No start", "END:VEVENT",
    "BEGIN:VEVENT", "UID:good", "SUMMARY:Fine", "DTSTART:20260804T120000Z", "END:VEVENT",
  ].join("\r\n");
  const evs = parseIcs(ics);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].uid, "good");
});

// ---- recurrence ----

const vevent = (o: { start: number; rrule?: string; durMin?: number }) => ({
  uid: "r", title: "R", location: null, startMs: o.start, endMs: o.durMin ? o.start + o.durMin * 60000 : null, allDay: false, rrule: o.rrule ?? null, url: null,
});
const AUG = (d: number, h = 10) => Date.UTC(2026, 7, d, h, 0, 0);

test("expandInWindow: an all-day event with no end stays on the agenda all of its own day", () => {
  const birthday: import("./ical.ts").VEvent = { uid: "a", title: "Birthday", location: null, startMs: Date.UTC(2026, 7, 4), endMs: null, allDay: true, rrule: null, url: null };
  const afternoon = Date.UTC(2026, 7, 4, 15, 0, 0); // 3pm on the event's own date
  const out = expandInWindow([birthday], afternoon, afternoon + 7 * 86400000);
  assert.equal(out.length, 1); // was dropped before the whole-day fix (00:00 < 15:00)
  assert.equal(out[0].title, "Birthday");
});

test("expandInWindow: a non-recurring event is included only if it overlaps the window", () => {
  const evs = [vevent({ start: AUG(10) }), vevent({ start: AUG(20) })];
  const out = expandInWindow(evs, AUG(15), AUG(31));
  assert.deepEqual(out.map((o) => o.startMs), [AUG(20)]);
});

test("expandInWindow: WEEKLY expands, honoring INTERVAL, COUNT, and UNTIL", () => {
  const weekly = (rrule: string) => expandInWindow([vevent({ start: AUG(1), rrule })], AUG(1), AUG(31)).map((o) => o.startMs);
  assert.deepEqual(weekly("FREQ=WEEKLY"), [AUG(1), AUG(8), AUG(15), AUG(22), AUG(29)]);
  assert.deepEqual(weekly("FREQ=WEEKLY;INTERVAL=2"), [AUG(1), AUG(15), AUG(29)]);
  assert.deepEqual(weekly("FREQ=WEEKLY;COUNT=2"), [AUG(1), AUG(8)]);
  assert.deepEqual(weekly("FREQ=WEEKLY;UNTIL=20260815T100000Z"), [AUG(1), AUG(8), AUG(15)]);
});

test("expandInWindow: DAILY and MONTHLY step correctly", () => {
  const daily = expandInWindow([vevent({ start: AUG(1), rrule: "FREQ=DAILY;COUNT=3" })], AUG(1), AUG(31)).map((o) => o.startMs);
  assert.deepEqual(daily, [AUG(1), AUG(2), AUG(3)]);
  const monthly = expandInWindow([vevent({ start: Date.UTC(2026, 0, 15, 9), rrule: "FREQ=MONTHLY;COUNT=3" })], Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)).map((o) => o.startMs);
  assert.deepEqual(monthly, [Date.UTC(2026, 0, 15, 9), Date.UTC(2026, 1, 15, 9), Date.UTC(2026, 2, 15, 9)]);
});

test("expandInWindow: plain YEARLY expands to the year's occurrence, not clamped year-round", () => {
  const bday = (rrule: string) => vevent({ start: Date.UTC(2000, 4, 15, 9), rrule }); // May 15 2000, created long ago
  // Seen from a May-2026 window, the birthday expands to its 2026 occurrence on its real date...
  const inMay = expandInWindow([bday("FREQ=YEARLY")], Date.UTC(2026, 4, 1), Date.UTC(2026, 4, 31));
  assert.equal(inMay.length, 1);
  assert.equal(inMay[0].startMs, Date.UTC(2026, 4, 15, 9), "on May 15 2026");
  assert.notEqual(inMay[0].recurrenceUnexpanded, true, "plain YEARLY is expanded, not surfaced-and-clamped");
  // ...and an August window (no occurrence) shows nothing -- the old unexpanded path clamped it onto
  // day 0 every day of the year, which read as a bug.
  assert.deepEqual(expandInWindow([bday("FREQ=YEARLY")], Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 31)), []);
  // INTERVAL honored: every-other-year from 2000 is on in 2026, off in 2025.
  assert.deepEqual(expandInWindow([bday("FREQ=YEARLY;INTERVAL=2")], Date.UTC(2025, 4, 1), Date.UTC(2025, 4, 31)), [], "2025 is an off-year");
  assert.equal(expandInWindow([bday("FREQ=YEARLY;INTERVAL=2")], Date.UTC(2026, 4, 1), Date.UTC(2026, 4, 31)).length, 1, "2026 is on");
});

test("expandInWindow: a YEARLY rule with yearly-only BY-parts stays unexpanded (not misread as a plain anniversary)", () => {
  // BYYEARDAY/BYWEEKNO are valid only with FREQ=YEARLY; adding YEARLY to the simple set must not
  // swallow them, or their extra occurrences vanish silently. Surface the base occurrence instead.
  for (const rrule of ["FREQ=YEARLY;BYYEARDAY=1,100,200", "FREQ=YEARLY;BYWEEKNO=1,20", "FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=15"]) {
    const out = expandInWindow([vevent({ start: Date.UTC(2000, 0, 1, 9), rrule })], Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
    assert.equal(out.length, 1, rrule);
    assert.equal(out[0].recurrenceUnexpanded, true, `${rrule} must be surfaced unexpanded`);
  }
});

test("expandInWindow: an exotic RRULE is surfaced (base occurrence + flag), not dropped", () => {
  const out = expandInWindow([vevent({ start: AUG(1), rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" })], AUG(1), AUG(31));
  assert.equal(out.length, 1);
  assert.equal(out[0].recurrenceUnexpanded, true);
  assert.equal(out[0].startMs, AUG(1));
});

test("expandInWindow: a malformed RRULE is surfaced, never throwing out or dropping the event", () => {
  // bad UNTIL (would throw in parseDt) and bad COUNT (would be NaN -> zero occurrences)
  for (const rrule of ["FREQ=WEEKLY;UNTIL=2026-08-15", "FREQ=WEEKLY;COUNT=abc"]) {
    const out = expandInWindow([vevent({ start: AUG(1), rrule })], AUG(1), AUG(31));
    assert.equal(out.length, 1, `rrule ${rrule} should surface one occurrence`);
    assert.equal(out[0].recurrenceUnexpanded, true);
  }
});

test("expandInWindow: DTEND is exclusive — an event ending exactly at the window start is NOT included", () => {
  // 13:00-14:00 event; window starts at 14:00 -> excluded (ended at the boundary)
  const ended = expandInWindow([vevent({ start: AUG(4, 13), durMin: 60 })], AUG(4, 14), AUG(5));
  assert.equal(ended.length, 0);
  // same event with the window starting one minute earlier -> included
  const live = expandInWindow([vevent({ start: AUG(4, 13), durMin: 60 })], AUG(4, 13) + 59 * 60000, AUG(5));
  assert.equal(live.length, 1);
});

test("expandInWindow: propagates url onto each occurrence, including expanded recurrences", () => {
  const withUrl = { ...vevent({ start: AUG(1), rrule: "FREQ=DAILY;COUNT=2" }), url: "https://example.com/e" };
  const out = expandInWindow([withUrl], AUG(1), AUG(31));
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => o.url === "https://example.com/e"));
  const noUrl = expandInWindow([vevent({ start: AUG(10) })], AUG(1), AUG(31));
  assert.equal(noUrl[0].url, null);
});

test("fmtUtc formats a Date as RFC5545 basic UTC", () => {
  assert.equal(fmtUtc(new Date("2026-08-04T15:00:00Z")), "20260804T150000Z");
});
