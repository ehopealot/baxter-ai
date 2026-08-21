// Tests for digest-agenda (system-scheduled-tasks plan, T9): the daily calendar digest's
// PURE selection + projection. selectDigestEvents picks the current household-local day's
// remaining/ongoing/all-day events through calendar-cli's buildAgenda (the SAME merged
// agenda Home renders -- own-vs-linked dedup and recurrence expansion stay shared, no
// drift), over a tz-aware [midnight, next-midnight) window (DST transition days included);
// projectDigestEvents reduces the selection to the bounded DigestEvent shape: localized
// when / single-lined title / single-lined location / allDay / ongoing, never descriptions,
// URLs, UIDs, feed source, recurrence rules, or any contact data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDigestEvents, projectDigestEvents } from "./digest-agenda.ts";
import { isWellFormedString } from "./check-in-context.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";

// Base scenario: America/Los_Angeles (PDT = UTC-7 in August), now = Thu 2026-08-20
// 11:00 AM local (18:00Z). Today's local window: [2026-08-20T07:00Z, 2026-08-21T07:00Z).
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-08-20T18:00:00Z");

const stored = (o: Partial<StoredEvent>): StoredEvent =>
  ({ uid: "u@baxter", title: "T", start: "2026-08-20T15:00:00Z", created: "", updated: "", ...o });
const fam = (o: Partial<VEvent>): VEvent =>
  ({ uid: "f@family", title: "Fam event", location: null, startMs: Date.UTC(2026, 7, 20, 23, 0, 0), endMs: null, allDay: false, rrule: null, url: null, ...o });

const sel = (own: StoredEvent[], family: VEvent[], familyEligible = true) =>
  selectDigestEvents(own, family, { now: NOW, tz: TZ, familyEligible });

// ---------- selectDigestEvents: inclusion ----------

test("selectDigestEvents includes today's all-day events (own + family) and a multi-day all-day event spanning today", () => {
  const own = [
    stored({ uid: "ad1", title: "Grandma's birthday", start: "2026-08-20", allDay: true }),
  ];
  const family = [
    fam({ uid: "f1", title: "Cousin visit", allDay: true, startMs: Date.UTC(2026, 7, 19), endMs: Date.UTC(2026, 7, 22) }), // 8/19..8/21
  ];
  const titles = sel(own, family).map((i) => i.title);
  // all-day first, by start token: the multi-day visit started 8/19, before today's birthday.
  assert.deepEqual(titles, ["Cousin visit", "Grandma's birthday"]);
});

test("selectDigestEvents includes an ongoing timed event whose end is strictly after now (even one that started yesterday)", () => {
  const own = [
    stored({ uid: "o1", title: "Ongoing now", start: "2026-08-20T15:00:00Z", end: "2026-08-20T20:00:00Z" }), // 8am-1pm, now 11am
    stored({ uid: "o2", title: "Started yesterday", start: "2026-08-19T20:00:00Z", end: "2026-08-20T20:00:00Z" }),
  ];
  assert.deepEqual(sel(own, []).map((i) => i.title), ["Started yesterday", "Ongoing now"]); // timed, sorted by start
});

test("selectDigestEvents includes a future-today timed event (with or without an end)", () => {
  const own = [
    stored({ uid: "f1", title: "Afternoon thing", start: "2026-08-20T21:00:00Z", end: "2026-08-20T22:30:00Z" }), // 2pm
    stored({ uid: "f2", title: "Point event", start: "2026-08-20T23:00:00Z" }), // 4pm, no end
  ];
  assert.deepEqual(sel(own, []).map((i) => i.title), ["Afternoon thing", "Point event"]);
});

// ---------- selectDigestEvents: exclusion ----------

test("selectDigestEvents excludes ended events (end <= now, including ending exactly at now)", () => {
  const own = [
    stored({ uid: "e1", title: "Ended earlier", start: "2026-08-20T14:00:00Z", end: "2026-08-20T15:30:00Z" }),
    stored({ uid: "e2", title: "Ends exactly now", start: "2026-08-20T15:00:00Z", end: "2026-08-20T18:00:00Z" }),
  ];
  assert.deepEqual(sel(own, []), []);
});

test("selectDigestEvents excludes a start-only timed event whose start is already past", () => {
  const own = [stored({ uid: "sp", title: "Past point", start: "2026-08-20T15:00:00Z" })]; // started 8am, now 11am
  assert.deepEqual(sel(own, []), []);
});

test("selectDigestEvents excludes tomorrow: timed events at/after the next local midnight and a tomorrow all-day event", () => {
  const own = [
    stored({ uid: "t1", title: "Exactly midnight", start: "2026-08-21T07:00:00Z" }), // == next local midnight
    stored({ uid: "t2", title: "After midnight", start: "2026-08-21T08:00:00Z" }),
    stored({ uid: "t3", title: "Tomorrow all-day", start: "2026-08-21", allDay: true }),
  ];
  assert.deepEqual(sel(own, []), []);
});

test("selectDigestEvents excludes yesterday's single-day all-day event", () => {
  const own = [stored({ uid: "y1", title: "Yesterday", start: "2026-08-19", allDay: true })];
  assert.deepEqual(sel(own, []), []);
});

// ---------- family eligibility + shared merged-agenda behavior ----------

test("familyEligible=false drops ALL family events while own events still qualify", () => {
  const own = [stored({ uid: "o1", title: "Own today", start: "2026-08-20T21:00:00Z" })];
  const family = [fam({ uid: "f1", title: "Fam today", startMs: Date.UTC(2026, 7, 20, 22, 0, 0) })];
  assert.deepEqual(sel(own, family, false).map((i) => i.title), ["Own today"]);
  assert.deepEqual(sel(own, family, true).map((i) => i.title), ["Own today", "Fam today"]);
});

test("selectDigestEvents shares buildAgenda's merged behavior: a feed copy of an own event collapses to the one own row, and recurrence expands to today", () => {
  const own = [stored({ uid: "shared@b", title: "Dentist", start: "2026-08-20T21:00:00Z" })];
  const family = [
    fam({ uid: "shared@b", title: "Dentist (feed echo)", startMs: Date.UTC(2026, 7, 20, 21, 0, 0) }), // same uid+start -> feed copy dropped, own wins
    fam({ uid: "rec@f", title: "Trash day", rrule: "FREQ=WEEKLY", startMs: Date.UTC(2026, 7, 6, 22, 0, 0), endMs: Date.UTC(2026, 7, 6, 22, 30, 0) }), // Thursdays 3:00 PM; expands onto today (still future at 11 AM)
  ];
  const picked = sel(own, family);
  assert.deepEqual(picked.map((i) => [i.title, i.source]), [["Dentist", "own"], ["Trash day", "family"]]);
});

// ---------- DST boundaries ----------

test("DST spring-forward day (23-hour local day): an 11:30pm-local event still qualifies, a post-midnight one does not", () => {
  // US DST 2026 starts Sun 2026-03-08: local day = 23h (00:00 PST 08:00Z -> 00:00 PDT 07:00Z next day).
  const now = new Date("2026-03-08T18:00:00Z"); // 11:00 AM PDT
  const own = [
    stored({ uid: "late", title: "Late tonight", start: "2026-03-09T06:30:00Z" }), // 23:30 local on 3/8 -- still today
    stored({ uid: "over", title: "Past midnight", start: "2026-03-09T07:30:00Z" }), // 00:30 local on 3/9 -- tomorrow
  ];
  const picked = selectDigestEvents(own, [], { now, tz: TZ, familyEligible: true });
  assert.deepEqual(picked.map((i) => i.title), ["Late tonight"]);
});

test("DST fall-back day (25-hour local day): an 11:30pm-local event still qualifies, a post-midnight one does not", () => {
  // US DST 2026 ends Sun 2026-11-01: local day = 25h (00:00 PDT 07:00Z -> 00:00 PST 08:00Z next day).
  const now = new Date("2026-11-01T18:00:00Z"); // 10:00 AM PST
  const own = [
    stored({ uid: "late", title: "Late tonight", start: "2026-11-02T07:30:00Z" }), // 23:30 local on 11/1 -- still today
    stored({ uid: "over", title: "Past midnight", start: "2026-11-02T08:30:00Z" }), // 00:30 local on 11/2 -- tomorrow
  ];
  const picked = selectDigestEvents(own, [], { now, tz: TZ, familyEligible: true });
  assert.deepEqual(picked.map((i) => i.title), ["Late tonight"]);
});

// ---------- malformed ----------

test("selectDigestEvents excludes malformed entries (unparseable start, non-string title)", () => {
  const own = [stored({ uid: "bad1", title: "Bad start", start: "not-a-date" })];
  const family = [
    fam({ uid: "bad2", title: 42 as unknown as string, startMs: Date.UTC(2026, 7, 20, 22, 0, 0) }), // valid start, non-string title
    fam({ uid: "ok", title: "Fine fam event", startMs: Date.UTC(2026, 7, 20, 23, 0, 0) }),
  ];
  assert.deepEqual(sel(own, family).map((i) => i.title), ["Fine fam event"]);
});

// ---------- sorting ----------

test("selection sorts all-day first, then effective start, with a stable title tie-break", () => {
  const own = [
    stored({ uid: "a", title: "Dentist", start: "2026-08-20T21:00:00Z" }),
    stored({ uid: "b", title: "Zeta day", start: "2026-08-20", allDay: true }),
    stored({ uid: "c", title: "Beach", start: "2026-08-20T20:00:00Z" }),
    stored({ uid: "d", title: "Aardvark", start: "2026-08-20T20:00:00Z" }),
    stored({ uid: "e", title: "Alpha day", start: "2026-08-20", allDay: true }),
  ];
  assert.deepEqual(sel(own, []).map((i) => i.title), ["Alpha day", "Zeta day", "Aardvark", "Beach", "Dentist"]);
});

// ---------- projectDigestEvents ----------

test("projection carries exactly when/title/location/allDay/ongoing; location is omitted when absent or whitespace-only", () => {
  const own = [
    stored({ uid: "a", title: "With location", start: "2026-08-20T21:00:00Z", location: "2727 College Ave" }),
    stored({ uid: "b", title: "No location", start: "2026-08-20T22:00:00Z" }),
    stored({ uid: "c", title: "Blank location", start: "2026-08-20T23:00:00Z", location: "  \n\t " }),
  ];
  const { events, omitted } = projectDigestEvents(sel(own, []), { now: NOW, tz: TZ });
  assert.equal(omitted, 0);
  assert.deepEqual(events[0], { when: "2:00 PM", title: "With location", allDay: false, ongoing: false, location: "2727 College Ave" });
  assert.deepEqual(events[1], { when: "3:00 PM", title: "No location", allDay: false, ongoing: false });
  assert.deepEqual(events[2], { when: "4:00 PM", title: "Blank location", allDay: false, ongoing: false });
  for (const e of events) {
    for (const k of Object.keys(e)) assert.ok(["when", "title", "location", "allDay", "ongoing"].includes(k), `unexpected key ${k}`);
  }
});

test("projection when strings: 'All day' for all-day, 'Ongoing' for ongoing, localized start time, start-end range within the same local day, start only across midnight", () => {
  const own = [
    stored({ uid: "a", title: "All day thing", start: "2026-08-20", allDay: true }),
    stored({ uid: "b", title: "Ongoing thing", start: "2026-08-20T15:00:00Z", end: "2026-08-20T20:00:00Z" }),
    stored({ uid: "c", title: "Ranged thing", start: "2026-08-20T21:00:00Z", end: "2026-08-20T22:30:00Z" }), // 2:00-3:30 PM
    stored({ uid: "d", title: "Point thing", start: "2026-08-20T23:00:00Z" }), // 4:00 PM, no end
    stored({ uid: "e", title: "Late thing", start: "2026-08-21T05:00:00Z", end: "2026-08-21T09:00:00Z" }), // 10 PM-2 AM: end on the NEXT local day -> start only
  ];
  const { events } = projectDigestEvents(sel(own, []), { now: NOW, tz: TZ });
  assert.deepEqual(events.map((e) => e.when), ["All day", "Ongoing", "2:00 PM – 3:30 PM", "4:00 PM", "10:00 PM"]);
  assert.deepEqual(events.map((e) => [e.allDay, e.ongoing]), [
    [true, false], [false, true], [false, false], [false, false], [false, false],
  ]);
});

test("projection caps at 100 events with an omitted count, title at 200 chars, location at 160, all single-line", () => {
  const own: StoredEvent[] = [];
  for (let i = 0; i < 105; i++) own.push(stored({ uid: `c${i}`, title: `Ev ${String(i).padStart(3, "0")}`, start: `2026-08-20T${String(19 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z` }));
  // 105 events 19:00Z..20:44Z (12:00-1:44 PM local), sorted by start+title: keep 000..099, omit 5.
  const { events, omitted } = projectDigestEvents(sel(own, []), { now: NOW, tz: TZ });
  assert.equal(events.length, 100);
  assert.equal(omitted, 5);
  assert.equal(events[0].title, "Ev 000");
  assert.equal(events[99].title, "Ev 099");

  const long = "L".repeat(250);
  const loc = "P".repeat(200);
  const withLong = projectDigestEvents(sel([stored({ uid: "x", title: `A\n${long}\tB`, start: "2026-08-20T21:00:00Z", location: `${loc}\n  ${loc}` })], []), { now: NOW, tz: TZ });
  assert.equal(withLong.events[0].title.length, 200);
  assert.ok(!withLong.events[0].title.includes("\n"));
  assert.equal(withLong.events[0].location!.length, 160);
  assert.ok(!withLong.events[0].location!.includes("\n"));
});

test("daily projection repairs pre-existing lone surrogates and controls before surrogate-safe UTF-16 caps", () => {
  const selected = sel([], [fam({
    title: `Title\ud800\u0085 ${"😀".repeat(110)} END`,
    location: `Place\udc00\u009f ${"😀".repeat(90)} END`,
  })]);
  const projected = projectDigestEvents(selected, { now: NOW, tz: TZ }).events[0]!;
  assert.ok(isWellFormedString(projected.title));
  assert.ok(isWellFormedString(projected.location!));
  assert.ok(projected.title.length <= 200);
  assert.ok(projected.location!.length <= 160);
  assert.doesNotMatch(projected.title + projected.location, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  assert.match(projected.title, /�/);
  assert.match(projected.location!, /�/);
  assert.match(projected.title, /😀/);
  assert.match(projected.location!, /😀/);
});
