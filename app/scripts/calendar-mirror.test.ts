// Tests for the calendar mirror (home-calendar plan, Task C2): buildCalendarView's
// own+family merge (ics on own, url on family, 7-day window), calendarViewVersion's
// reorder-insensitive canonicalization + change-detection, watchCalendar's debounced
// dual-file dispatch/error-handling (mirroring recipes-mirror.test.ts's watchRecipes
// suite), isCalendarRefresh's payload guard, and signedCalendarLinkConnect's URL/signing.
// No intent/dispatch tests -- calendar has none inbound (read-only, no down-link intents;
// the one command it accepts is exercised via isCalendarRefresh + home-bot.test.ts's
// onCommand wiring test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import type { watch } from "node:fs";
import {
  buildCalendarView, calendarViewVersion, watchCalendar, signedCalendarLinkConnect,
  isCalendarRefresh, calendarRefreshFeedUrls, isCalendarDelete, calendarDeleteUid, WATCH_DEBOUNCE_MS,
} from "./calendar-mirror.ts";
import type { CalendarViewDeps } from "./calendar-mirror.ts";
import { addEvent } from "./calendar-store.ts";
import { toCalEvent } from "./calendar-cli.ts";
import { buildIcs } from "./ical.ts";
import type { VEvent } from "./ical.ts";
import type { WebSocketLike } from "./home-link.ts";
import type { HomeKeys } from "./home-mirror.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "calendar-mirror-"));
}

// tz pinned to UTC so the window's day-boundary math is deterministic and the boundary tests below
// read in UTC; the tz-aware floor is exercised separately with an explicit non-UTC zone.
function calDeps(dir: string): CalendarViewDeps {
  return { ownEventsPath: join(dir, "calendar", "events.json"), cachePath: join(dir, "calendar", "family-cache.json"), tz: "UTC" };
}

function writeCache(deps: CalendarViewDeps, events: VEvent[]): void {
  mkdirSync(dirname(deps.cachePath), { recursive: true });
  writeFileSync(deps.cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), events }));
}

const familyEvent = (over: Partial<VEvent> = {}): VEvent => ({
  uid: "fam1@family", title: "Soccer practice", location: null,
  startMs: Date.UTC(2026, 7, 5, 16, 0, 0), endMs: Date.UTC(2026, 7, 5, 17, 0, 0),
  allDay: false, rrule: null, url: null, ...over,
});

// ---------- buildCalendarView ----------

test("buildCalendarView merges own+family within the 7-day window: own gets ics, family gets url", async () => {
  const dir = tmpDir();
  const deps = calDeps(dir);
  const now = new Date(Date.UTC(2026, 7, 3, 12, 0, 0)); // 2026-08-03 noon UTC

  const own = await addEvent(deps.ownEventsPath, { title: "Dentist", start: "2026-08-04T15:00:00Z" });
  writeCache(deps, [
    familyEvent({ uid: "fam1@family", startMs: Date.UTC(2026, 7, 5, 16, 0, 0), endMs: Date.UTC(2026, 7, 5, 17, 0, 0), url: "https://calendar.example.com/fam1" }),
  ]);

  const view = buildCalendarView(now, deps);
  assert.equal(view.items.length, 2);

  const ownItem = view.items.find((i) => i.source === "own");
  const famItem = view.items.find((i) => i.source === "family");
  assert.ok(ownItem && famItem, JSON.stringify(view));

  assert.equal(ownItem!.uid, own.uid);
  assert.equal(ownItem!.title, "Dentist");
  assert.equal(ownItem!.ics, buildIcs([toCalEvent(own)]), "own item's ics is built via the shared toCalEvent mapping");
  assert.equal(ownItem!.url, undefined, "own items never carry a url");

  assert.equal(famItem!.uid, "fam1@family");
  assert.equal(famItem!.url, "https://calendar.example.com/fam1");
  assert.equal(famItem!.ics, undefined, "family items never carry an ics");
});

test("buildCalendarView omits url on a family item whose feed provided none", async () => {
  const dir = tmpDir();
  const deps = calDeps(dir);
  const now = new Date(Date.UTC(2026, 7, 3, 12, 0, 0));
  writeCache(deps, [familyEvent({ url: null, startMs: Date.UTC(2026, 7, 4, 9, 0, 0), endMs: Date.UTC(2026, 7, 4, 10, 0, 0) })]);

  const view = buildCalendarView(now, deps);
  assert.equal(view.items.length, 1);
  assert.equal("url" in view.items[0], false, "no url key at all when the feed didn't provide one");
});

test("buildCalendarView excludes events outside the 35-day window (before the floor / after the window)", async () => {
  const dir = tmpDir();
  const deps = calDeps(dir);
  const now = new Date(Date.UTC(2026, 7, 3, 12, 0, 0)); // window: [2026-08-03T00:00Z, +35d = 2026-09-07T00:00Z)

  await addEvent(deps.ownEventsPath, { title: "Too soon", start: "2026-07-20T10:00:00Z" });   // before floor
  await addEvent(deps.ownEventsPath, { title: "Too far", start: "2026-10-01T10:00:00Z" });     // past the 35-day window
  const within = await addEvent(deps.ownEventsPath, { title: "Just right", start: "2026-08-30T10:00:00Z" }); // ~4 weeks out, in

  const view = buildCalendarView(now, deps);
  assert.deepEqual(view.items.map((i) => i.uid), [within.uid]);
});

// Fix 2b (review): expandInWindow's overlap check is `startMs <= toMs` -- inclusive of
// the window's upper bound -- so buildAgenda alone would hand back an occurrence
// starting exactly at the window end (the start of the 8th day). That's outside the 7
// rendered day-buckets on the worker side (days 0..6), so buildCalendarView must filter
// it out itself. This is the actual boundary case the old (misnamed) test above did not
// exercise -- "Just right" landed well inside the window, not on its edge.
test("buildCalendarView excludes an event starting exactly at the window end (the day after day 34)", async () => {
  const dir = tmpDir();
  const deps = calDeps(dir);
  const now = new Date(Date.UTC(2026, 7, 3, 12, 0, 0)); // floor: 2026-08-03T00:00Z; window end: +35d = 2026-09-07T00:00Z

  await addEvent(deps.ownEventsPath, { title: "Right on the edge", start: "2026-09-07T00:00:00Z" });

  const view = buildCalendarView(now, deps);
  assert.deepEqual(view.items, [], "an occurrence starting exactly at the window end has no day-bucket to render under");
});

// The flip side: an event that started BEFORE the window floor but is still ongoing
// (overlaps into the window) must be KEPT -- the worker's renderCalendar (Part A) is
// what buckets it under day 0. This mirror must not filter it out just because its own
// start predates fromMs.
test("buildCalendarView keeps an ongoing event that started before the window floor and overlaps into it", async () => {
  const dir = tmpDir();
  const deps = calDeps(dir);
  const now = new Date(Date.UTC(2026, 7, 3, 12, 0, 0)); // floor: 2026-08-03T00:00Z

  // Starts the evening before the window floor, ends the morning after it -- still
  // "happening" when the window opens.
  await addEvent(deps.ownEventsPath, { title: "Overnight", start: "2026-08-02T23:00:00Z", end: "2026-08-03T01:00:00Z" });

  const view = buildCalendarView(now, deps);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].title, "Overnight");
});

test("buildCalendarView reads an absent family cache as empty (no crash) and an absent own-events file as no own events", () => {
  const dir = tmpDir();
  const deps = calDeps(dir); // neither file exists
  const view = buildCalendarView(new Date(), deps);
  assert.deepEqual(view, { lists: [], items: [], tz: "UTC" });
});

test("buildCalendarView threads the household tz and floors the window at tz-midnight, not UTC-midnight", async () => {
  const dir = tmpDir();
  // now = 2026-08-03T02:00Z is still 2026-08-02 19:00 in LA, so the tz-floor is LA-midnight Aug 2
  // (2026-08-02T07:00Z) -- an event at 2026-08-02T12:00Z (LA Aug 2 morning) is INSIDE the window,
  // whereas a UTC-midnight floor (Aug 3 00:00Z) would exclude it.
  const deps = { ...calDeps(dir), tz: "America/Los_Angeles" };
  const inLaDay = await addEvent(deps.ownEventsPath, { title: "LA morning", start: "2026-08-02T12:00:00Z" });

  const view = buildCalendarView(new Date(Date.UTC(2026, 7, 3, 2, 0, 0)), deps);
  assert.equal(view.tz, "America/Los_Angeles");
  assert.deepEqual(view.items.map((i) => i.uid), [inLaDay.uid], "the LA-today event is inside the tz-floored window");
});

// The window's END must be tz-aware like its floor (review of 3894e37). All-day events carry a
// UTC-midnight DATE TOKEN, so a fixed fromMs + 35*24h end (Sep 7 07:00Z under LA) sits PAST the
// day-35 token (Sep 7 00:00Z): a west-of-UTC household would leak the first day AFTER the window's
// last rendered day into the view with no bucket. The fix compares all-day items against the tz
// date token, so day 34 is in and day 35 is out on the calendar boundary, not the 07:00 offset.
test("buildCalendarView keeps a day-34 all-day event but excludes the day-35 one under a west-of-UTC tz", async () => {
  const dir = tmpDir();
  const deps = { ...calDeps(dir), tz: "America/Los_Angeles" };
  const now = new Date(Date.UTC(2026, 7, 3, 12, 0, 0)); // LA date Aug 3; window = LA days Aug 3..Sep 6, end token Sep 7
  const lastDay = await addEvent(deps.ownEventsPath, { title: "Day 34 birthday", start: "2026-09-06", allDay: true }); // in
  await addEvent(deps.ownEventsPath, { title: "Day 35 holiday", start: "2026-09-07", allDay: true }); // out: first unrendered day

  const view = buildCalendarView(now, deps);
  assert.deepEqual(view.items.map((i) => i.uid), [lastDay.uid], "day-34 all-day in, day-35 all-day out (tz-token edge, not the 07:00Z offset)");
});

// Timed events across a DST transition: the fixed +35*24h end drifts an hour, so an event on the
// last rendered day (Nov 18 local, after the Nov 1 fall-back) fell OUTSIDE the old window and went
// silently missing. The tz-aware end plus the AGENDA_DAYS+1 buildAgenda widening keep it; an event
// on the next (unrendered) day is still cut. now = Oct 15 (PDT) so the window spans the transition.
test("buildCalendarView keeps a last-day timed event across a DST fall-back and still excludes the day after", async () => {
  const dir = tmpDir();
  const deps = { ...calDeps(dir), tz: "America/Los_Angeles" };
  const now = new Date(Date.UTC(2026, 9, 15, 12, 0, 0)); // LA date Oct 15; window end token Nov 19, tz-midnight = Nov 19 08:00Z (PST)
  const onEdge = await addEvent(deps.ownEventsPath, { title: "Nov 18 dinner", start: "2026-11-19T07:30:00Z" }); // Nov 18 23:30 PST, day 34 -- in
  await addEvent(deps.ownEventsPath, { title: "Nov 19 breakfast", start: "2026-11-19T08:30:00Z" }); // Nov 19 00:30 PST, day 35 -- out

  const view = buildCalendarView(now, deps);
  assert.deepEqual(view.items.map((i) => i.uid), [onEdge.uid], "day-34 timed event survives the DST-shifted end; day-35 timed event is cut");
});

// The all-day FLOOR is token-space too (review of f60a24a). buildAgenda's floor is the fromMs
// instant, which east of UTC sits on the PREVIOUS civil day (Tokyo: fromToken - 9h), so it hands
// in yesterday's all-day event as "ongoing". Comparing the item's exclusive end token against
// fromToken drops a finished single-day event while keeping one still running into today.
test("buildCalendarView drops yesterday's all-day event but keeps today's and a still-running multi-day one, east of UTC", async () => {
  const dir = tmpDir();
  const deps = { ...calDeps(dir), tz: "Asia/Tokyo" }; // UTC+9
  const now = new Date(Date.UTC(2026, 7, 11, 2, 0, 0)); // 11:00 JST Aug 11 -> household date Aug 11
  await addEvent(deps.ownEventsPath, { title: "Yesterday only", start: "2026-08-10", allDay: true }); // out: ended before today
  const today = await addEvent(deps.ownEventsPath, { title: "Today", start: "2026-08-11", allDay: true }); // in
  const spanning = await addEvent(deps.ownEventsPath, { title: "Trip", start: "2026-08-10", end: "2026-08-12", allDay: true }); // in: started before, still running

  const view = buildCalendarView(now, deps);
  assert.deepEqual(view.items.map((i) => i.uid).sort(), [today.uid, spanning.uid].sort(), "finished-yesterday all-day dropped; today's and the ongoing multi-day kept");
});

// The all-day floor guard must NOT swallow an unexpanded EXOTIC RRULE (review of 58d499f).
// expandInWindow surfaces a non-simple rule (here a BY-parts yearly) as its ORIGINAL base
// occurrence, whose end token is far below fromToken -- the floor clause would drop it entirely,
// where before it passed and the worker clamped it onto day 0. recurrenceUnexpanded is exempt from
// the floor so it still surfaces (visible, clamped), matching the timed-unexpanded path. (Plain
// FREQ=YEARLY now expands to its real date instead -- covered in ical.test.ts.)
test("buildCalendarView keeps an all-day unexpanded exotic yearly recurrence whose base is in the past", async () => {
  const dir = tmpDir();
  const deps = calDeps(dir); // UTC
  const now = new Date(Date.UTC(2026, 7, 11, 12, 0, 0));
  writeCache(deps, [familyEvent({
    uid: "bday@fam", title: "Grandma's birthday",
    startMs: Date.UTC(2000, 4, 15), endMs: Date.UTC(2000, 4, 16), // May 15, 2000 -- base occurrence, long past
    allDay: true, rrule: "FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=15", // BY-parts -> not simple -> surfaced unexpanded
  })]);

  const view = buildCalendarView(now, deps);
  assert.deepEqual(view.items.map((i) => i.uid), ["bday@fam"], "the exotic-yearly all-day event still surfaces despite its past base occurrence");
});

test("buildCalendarView falls back to a valid default tz for a missing/garbage BAXTER_TZ", () => {
  const dir = tmpDir();
  const view = buildCalendarView(new Date(), { ...calDeps(dir), tz: "Not/AZone" });
  assert.equal(view.tz, "America/Los_Angeles"); // validTz fallback, never throws out of Intl
});

test("buildCalendarView marks recurring family occurrences and all-day items", async () => {
  const dir = tmpDir();
  const deps = calDeps(dir);
  const now = new Date(Date.UTC(2026, 7, 3, 12, 0, 0));
  writeCache(deps, [{
    uid: "weekly@family", title: "Trash day", location: null,
    startMs: Date.UTC(2026, 7, 4, 8, 0, 0), endMs: Date.UTC(2026, 7, 4, 8, 30, 0),
    allDay: false, rrule: "FREQ=WEEKLY", url: null,
  }]);
  const view = buildCalendarView(now, deps);
  assert.ok(view.items.length >= 1);
  assert.equal(view.items[0].recurring, true);
});

// ---------- calendarViewVersion ----------

test("calendarViewVersion is stable for identical content, changes when an item field changes, and is order-sensitive", () => {
  const a = calendarViewVersion({ lists: [], tz: "UTC", items: [{ uid: "u1", title: "T", start: "2026-08-04T15:00:00.000Z", source: "own" }] });
  const b = calendarViewVersion({ lists: [], tz: "UTC", items: [{ uid: "u1", title: "T", start: "2026-08-04T15:00:00.000Z", source: "own" }] });
  const c = calendarViewVersion({ lists: [], tz: "UTC", items: [{ uid: "u1", title: "Changed", start: "2026-08-04T15:00:00.000Z", source: "own" }] });
  assert.equal(a, b);
  assert.notEqual(a, c);

  const reordered = calendarViewVersion({ lists: [], tz: "UTC", items: [{ source: "own", start: "2026-08-04T15:00:00.000Z", title: "T", uid: "u1" }] });
  assert.equal(a, reordered, "object key order does not affect the digest");

  const two = { lists: [] as [], tz: "UTC", items: [{ uid: "u1", title: "T1", start: "s1", source: "own" as const }, { uid: "u2", title: "T2", start: "s2", source: "family" as const }] };
  const swapped = { lists: [] as [], tz: "UTC", items: [two.items[1], two.items[0]] };
  assert.notEqual(calendarViewVersion(two), calendarViewVersion(swapped), "item array order DOES affect the digest");
});

// ---------- isCalendarRefresh ----------

test("isCalendarRefresh accepts {kind:\"calendar-refresh\"} and rejects everything else", () => {
  assert.equal(isCalendarRefresh({ kind: "calendar-refresh" }), true);
  assert.equal(isCalendarRefresh({ kind: "calendar-refresh", extra: 1 }), true, "extra fields are harmless");
  assert.equal(isCalendarRefresh({ kind: "calendar-feeds" }), false, "a different command kind on the SAME wire family");
  assert.equal(isCalendarRefresh({}), false);
  assert.equal(isCalendarRefresh(null), false);
  assert.equal(isCalendarRefresh(undefined), false);
  assert.equal(isCalendarRefresh("calendar-refresh"), false);
  assert.equal(isCalendarRefresh(["calendar-refresh"]), false);
  assert.equal(isCalendarRefresh(42), false);
});

test("calendarRefreshFeedUrls returns the string array when present, else undefined", () => {
  assert.deepEqual(calendarRefreshFeedUrls({ kind: "calendar-refresh", feedUrls: ["https://a.example/a.ics", "https://b.example/b.ics"] }), ["https://a.example/a.ics", "https://b.example/b.ics"]);
  assert.deepEqual(calendarRefreshFeedUrls({ kind: "calendar-refresh", feedUrls: [] }), [], "an empty array is a valid (zero-feed) override");
  assert.equal(calendarRefreshFeedUrls({ kind: "calendar-refresh" }), undefined, "no feedUrls field -> undefined (poll disk)");
  assert.deepEqual(calendarRefreshFeedUrls({ kind: "calendar-refresh", feedUrls: ["https://a.example/a.ics", 42, null, "https://b.example/b.ics"] }), ["https://a.example/a.ics", "https://b.example/b.ics"], "non-string entries are dropped");
  assert.equal(calendarRefreshFeedUrls({ kind: "calendar-refresh", feedUrls: "https://not-an-array.example/x.ics" }), undefined, "a non-array feedUrls is treated as absent -> undefined");
});

// ---------- isCalendarDelete / calendarDeleteUid ----------

test("isCalendarDelete accepts {kind:\"calendar-delete\"} and rejects everything else", () => {
  assert.equal(isCalendarDelete({ kind: "calendar-delete", uid: "e1" }), true);
  assert.equal(isCalendarDelete({ kind: "calendar-delete" }), true, "kind alone matches; uid is read separately");
  assert.equal(isCalendarDelete({ kind: "calendar-refresh" }), false, "the sibling command on the same wire");
  assert.equal(isCalendarDelete({}), false);
  assert.equal(isCalendarDelete(null), false);
  assert.equal(isCalendarDelete("calendar-delete"), false);
  assert.equal(isCalendarDelete(["calendar-delete"]), false);
});

test("calendarDeleteUid returns a non-empty string uid, else null", () => {
  assert.equal(calendarDeleteUid({ kind: "calendar-delete", uid: "evt-1@baxter" }), "evt-1@baxter");
  assert.equal(calendarDeleteUid({ kind: "calendar-delete", uid: "" }), null, "empty uid -> null (nothing to delete)");
  assert.equal(calendarDeleteUid({ kind: "calendar-delete" }), null, "missing uid -> null");
  assert.equal(calendarDeleteUid({ kind: "calendar-delete", uid: 42 }), null, "non-string uid -> null");
  assert.equal(calendarDeleteUid(null), null);
});

// ---------- watchCalendar ----------

class FakeFSWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
}

// Records every watchFn(dir, listener) call in order -- watchCalendar calls it once per
// watched file (own-events, then family-cache), so index 0/1 below correspond to those two
// targets IN THAT ORDER.
function captureWatchers(): {
  watchFn: typeof watch;
  watchers: FakeFSWatcher[];
  dirs: string[];
  listeners: Array<(event: string, filename: string | null) => void>;
} {
  const watchers: FakeFSWatcher[] = [];
  const dirs: string[] = [];
  const listeners: Array<(event: string, filename: string | null) => void> = [];
  const watchFn = ((dir: string, listener: (event: string, filename: string | null) => void) => {
    dirs.push(dir);
    listeners.push(listener);
    const w = new FakeFSWatcher();
    watchers.push(w);
    return w;
  }) as unknown as typeof watch;
  return { watchFn, watchers, dirs, listeners };
}

test("watchCalendar: a change to the OWN events file fires the debounced onChange", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  const ownPath = join(dir, "own", "events.json");
  const cachePath = join(dir, "cache", "family-cache.json");
  const { watchFn, listeners } = captureWatchers();
  let calls = 0;

  const { close } = watchCalendar(ownPath, cachePath, () => { calls += 1; }, watchFn);
  assert.equal(listeners.length, 2, "watchFn is called once per watched file");

  listeners[0]("change", basename(ownPath));
  assert.equal(calls, 0, "onChange must not fire before the debounce elapses");
  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(calls, 1);

  close();
});

test("watchCalendar: a change to the FAMILY cache file also fires onChange", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  const ownPath = join(dir, "own", "events.json");
  const cachePath = join(dir, "cache", "family-cache.json");
  const { watchFn, listeners } = captureWatchers();
  let calls = 0;

  const { close } = watchCalendar(ownPath, cachePath, () => { calls += 1; }, watchFn);
  listeners[1]("rename", basename(cachePath));
  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(calls, 1);

  close();
});

test("watchCalendar: rapid events on BOTH files within the debounce window fold into one onChange call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  const ownPath = join(dir, "own", "events.json");
  const cachePath = join(dir, "cache", "family-cache.json");
  const { watchFn, listeners } = captureWatchers();
  let calls = 0;

  const { close } = watchCalendar(ownPath, cachePath, () => { calls += 1; }, watchFn);
  listeners[0]("change", basename(ownPath));
  listeners[1]("change", basename(cachePath));
  listeners[0]("rename", basename(ownPath));
  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(calls, 1, "leading-edge fold across both watched files");

  close();
});

test("watchCalendar: an event for an unrelated filename in the same directory is ignored", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  const ownPath = join(dir, "cal", "events.json");
  const cachePath = join(dir, "cal", "family-cache.json"); // SAME directory as ownPath, like production
  const { watchFn, listeners, dirs } = captureWatchers();
  let calls = 0;

  const { close } = watchCalendar(ownPath, cachePath, () => { calls += 1; }, watchFn);
  assert.equal(dirs[0], dirs[1], "own and cache live in the same directory, matching paths.ts's real layout");

  listeners[0]("rename", "events.json.123.tmp"); // mutate()'s own tmp sibling
  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(calls, 0, "a non-matching basename in the watched directory must not trigger onChange");

  close();
});

test("watchCalendar: close() cancels a PENDING debounced onChange", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  const ownPath = join(dir, "own", "events.json");
  const cachePath = join(dir, "cache", "family-cache.json");
  const { watchFn, listeners, watchers } = captureWatchers();
  let calls = 0;

  const { close } = watchCalendar(ownPath, cachePath, () => { calls += 1; }, watchFn);
  listeners[0]("change", basename(ownPath));
  close();

  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(calls, 0, "close() must cancel the pending debounced onChange");
  assert.ok(watchers.every((w) => w.closed));
});

test("watchCalendar: a watcher 'error' on either file logs loudly and de-dupes a shared fallback timer; close() clears it", () => {
  const dir = tmpDir();
  const ownPath = join(dir, "own", "events.json");
  const cachePath = join(dir, "cache", "family-cache.json");
  const { watchFn, watchers } = captureWatchers();
  const errs: string[] = [];
  const intervalHandles: NodeJS.Timeout[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const h = realSetInterval(...args);
    intervalHandles.push(h);
    return h;
  }) as typeof setInterval;

  try {
    const { close } = watchCalendar(ownPath, cachePath, () => {}, watchFn, (m: string) => errs.push(m));

    watchers[0].emit("error", new Error("EMFILE: too many open files"));
    assert.ok(errs.some((m) => m.includes("own-events watch died") && m.includes("EMFILE")), errs.join("\n"));
    assert.equal(intervalHandles.length, 1, "the fallback keep-alive timer fired exactly once");

    watchers[1].emit("error", new Error("EMFILE on the cache too"));
    assert.ok(errs.some((m) => m.includes("family-cache watch died")));
    assert.equal(intervalHandles.length, 1, "a second 'error' (even on the OTHER watcher) does not stack a second keep-alive interval");

    close();
    assert.ok(watchers.every((w) => w.closed));
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    for (const h of intervalHandles) realClearInterval(h);
  }
});

test("watchCalendar: a synchronous watch() failure on both files logs twice and falls back to ONE keep-alive interval", () => {
  const dir = tmpDir();
  const ownPath = join(dir, "own", "events.json");
  const cachePath = join(dir, "cache", "family-cache.json");
  const errs: string[] = [];
  const intervalHandles: NodeJS.Timeout[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const h = realSetInterval(...args);
    intervalHandles.push(h);
    return h;
  }) as typeof setInterval;

  try {
    const throwingWatchFn = (() => { throw new Error("EMFILE at setup"); }) as unknown as typeof watch;
    const { close } = watchCalendar(ownPath, cachePath, () => {}, throwingWatchFn, (m: string) => errs.push(m));
    assert.ok(errs.some((m) => m.includes("could not watch the own-events file") && m.includes("EMFILE")), errs.join("\n"));
    assert.ok(errs.some((m) => m.includes("could not watch the family-cache file")), errs.join("\n"));
    assert.equal(intervalHandles.length, 1, "de-duped across both synchronous failures");
    close();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    for (const h of intervalHandles) realClearInterval(h);
  }
});

// ---------- signedCalendarLinkConnect ----------

const KEYS: HomeKeys = { endpoint: "https://home.example.com/svc/acme", tenant: "acme", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-key" };

test("signedCalendarLinkConnect targets wss://<host>/svc/<tenant>/calendar-link and signs a fresh SigV4 GET on every dial", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const stub: WebSocketLike = { send() {}, close() {}, addEventListener() {} };
  const connect = signedCalendarLinkConnect(KEYS, (url, headers) => { calls.push({ url, headers }); return stub; });

  await connect();
  await connect();

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "wss://home.example.com/svc/acme/calendar-link");
    assert.ok(call.headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/"), JSON.stringify(call.headers));
    assert.match(call.headers.authorization, /SignedHeaders=host;x-amz-date,/);
    assert.match(call.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
  }
});

test("signedCalendarLinkConnect maps an http endpoint to ws (not wss)", async () => {
  const httpKeys: HomeKeys = { ...KEYS, endpoint: "http://localhost:8787/svc/acme/" };
  let seenUrl = "";
  const stub: WebSocketLike = { send() {}, close() {}, addEventListener() {} };
  const connect = signedCalendarLinkConnect(httpKeys, (url) => { seenUrl = url; return stub; });
  await connect();
  assert.equal(seenUrl, "ws://localhost:8787/svc/acme/calendar-link");
});
