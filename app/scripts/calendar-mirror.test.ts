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
  isCalendarRefresh, WATCH_DEBOUNCE_MS,
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

function calDeps(dir: string): CalendarViewDeps {
  return { ownEventsPath: join(dir, "calendar", "events.json"), cachePath: join(dir, "calendar", "family-cache.json") };
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

test("buildCalendarView excludes events outside the 7-day window (and includes one on the boundary)", async () => {
  const dir = tmpDir();
  const deps = calDeps(dir);
  const now = new Date(Date.UTC(2026, 7, 3, 12, 0, 0)); // window: [2026-08-03T00:00Z local-midnight, +7d)

  await addEvent(deps.ownEventsPath, { title: "Too soon", start: "2026-07-20T10:00:00Z" });
  await addEvent(deps.ownEventsPath, { title: "Too far", start: "2026-09-01T10:00:00Z" });
  const within = await addEvent(deps.ownEventsPath, { title: "Just right", start: "2026-08-06T10:00:00Z" });

  const view = buildCalendarView(now, deps);
  assert.deepEqual(view.items.map((i) => i.uid), [within.uid]);
});

test("buildCalendarView reads an absent family cache as empty (no crash) and an absent own-events file as no own events", () => {
  const dir = tmpDir();
  const deps = calDeps(dir); // neither file exists
  const view = buildCalendarView(new Date(), deps);
  assert.deepEqual(view, { lists: [], items: [] });
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
  const a = calendarViewVersion({ lists: [], items: [{ uid: "u1", title: "T", start: "2026-08-04T15:00:00.000Z", source: "own" }] });
  const b = calendarViewVersion({ lists: [], items: [{ uid: "u1", title: "T", start: "2026-08-04T15:00:00.000Z", source: "own" }] });
  const c = calendarViewVersion({ lists: [], items: [{ uid: "u1", title: "Changed", start: "2026-08-04T15:00:00.000Z", source: "own" }] });
  assert.equal(a, b);
  assert.notEqual(a, c);

  const reordered = calendarViewVersion({ lists: [], items: [{ source: "own", start: "2026-08-04T15:00:00.000Z", title: "T", uid: "u1" }] });
  assert.equal(a, reordered, "object key order does not affect the digest");

  const two = { lists: [] as [], items: [{ uid: "u1", title: "T1", start: "s1", source: "own" as const }, { uid: "u2", title: "T2", start: "s2", source: "family" as const }] };
  const swapped = { lists: [] as [], items: [two.items[1], two.items[0]] };
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
