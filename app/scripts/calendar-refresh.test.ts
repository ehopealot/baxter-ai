// Tests for calendar-refresh.ts (2026-08-20 system scheduled tasks, T8): the ONE
// shared poll-and-cache for family calendar feeds, serialized across processes by
// a dedicated proper-lockfile refresh lock. Covers the cache-replacement guards
// (only when >=1 configured feed succeeds; zero feeds / all-fail retain the prior
// cache byte-for-byte), the selection-ready familySnapshot contract (captured
// under the lock, immune to a later process replacing the cache), the lock's own
// lifecycle (parent-dir creation, mtime refresh while held, serialization,
// never-falsely-broken slow holders, stale-break recovery, bounded-retry
// exhaustion into the typed RefreshLockError), and the injectable override/log
// seams. Lock-contention fixtures for the two ADOPTERS (home-bot, calendar-cli)
// live in their own test files; this file pins the shared operation itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  refreshCalendars,
  refreshLockTarget,
  RefreshLockError,
  REFRESH_LOCK_STALE_MS,
  REFRESH_LOCK_MTIME_REFRESH_MS,
} from "./calendar-refresh.ts";
import { stubFetch, waitUntil } from "./calendar-refresh.testkit.ts";
import type { VEvent } from "./ical.ts";
import type { FetchLike } from "./calendar-cli.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "calrefresh-"));

// A minimal one-event ICS for a given uid (the same shape calendar-cli.test.ts's
// fixtures use). Dates land well in the future so they parse but nothing here
// depends on the window -- refreshCalendars never filters by time.
const icsFor = (uid: string): string => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//x//EN",
  "BEGIN:VEVENT", `UID:${uid}`, "DTSTART:20260804T140000Z", "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n");

const fetchServing = (body: string): FetchLike => stubFetch({ body });

// A feeds.json with the given URLs at <dir>/feeds.json; returns its path.
function mkFeeds(dir: string, urls: string[]): string {
  const feedsPath = join(dir, "feeds.json");
  writeFileSync(feedsPath, JSON.stringify({ urls, version: 1 }));
  return feedsPath;
}

const cacheEventsOf = (cachePath: string): VEvent[] =>
  (JSON.parse(readFileSync(cachePath, "utf8")) as { events: VEvent[] }).events;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- poll / cache-replacement guards ----------

test("a successful refresh atomically replaces the cache and returns a selection-ready snapshot of the same events", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/family.ics"]);
  const res = await refreshCalendars({ fetchFn: fetchServing(icsFor("fam1@family")), cachePath, feedsPath });
  assert.equal(res.ok, true);
  assert.equal(res.wroteCache, true);
  assert.deepEqual(res.urls, ["https://feed.example.com/family.ics"]);
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].uid, "fam1@family");
  assert.equal(res.errors.length, 0);
  // The cache file carries the { fetchedAt, events } shape the merged view reads.
  const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { fetchedAt: string; events: VEvent[] };
  assert.ok(cached.fetchedAt);
  assert.equal(cached.events.length, 1);
  assert.equal(cached.events[0].uid, "fam1@family");
  // The snapshot is exactly the successful poll's merged events.
  assert.deepEqual(res.familySnapshot, res.events);
});

test("a partial failure still writes the cache (>=1 configured feed succeeded) and returns per-feed structured errors", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const good = "https://feed.example.com/good.ics";
  const bad = "https://feed.example.com/bad.ics";
  const feedsPath = mkFeeds(dir, [good, bad]);
  const fetchFn: FetchLike = async (url) =>
    url === good ? fetchServing(icsFor("kept@family"))(url) : stubFetch({ status: 404 })(url);
  const res = await refreshCalendars({ fetchFn, cachePath, feedsPath });
  assert.equal(res.wroteCache, true, "one good feed is enough to replace the cache");
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].uid, "kept@family");
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /^https:\/\/feed\.example\.com\/bad\.ics: HTTP 404$/);
  assert.deepEqual(res.familySnapshot, res.events);
});

test("an all-feeds-failed refresh retains the prior cache byte-identically; the snapshot carries the RETAINED events read under the lock", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  mkdirSync(join(dir, "calendar"), { recursive: true });
  const prior = { fetchedAt: "2026-01-01T00:00:00.000Z", events: [{ uid: "stale@family", title: "Stale", location: null, startMs: 1, endMs: null, allDay: false, rrule: null, url: null } as VEvent] };
  const priorBytes = JSON.stringify(prior);
  writeFileSync(cachePath, priorBytes);
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const res = await refreshCalendars({ fetchFn: stubFetch({ status: 503 }), cachePath, feedsPath });
  assert.equal(res.ok, false);
  assert.equal(res.wroteCache, false);
  assert.equal(res.events.length, 0);
  assert.equal(res.errors.length, 1);
  assert.equal(readFileSync(cachePath, "utf8"), priorBytes, "the prior cache survives byte-for-byte");
  assert.deepEqual(res.familySnapshot, prior.events, "the snapshot is the retained prior cache's events");
});

test("an all-feeds-failed refresh with NO prior cache yields an empty snapshot", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const res = await refreshCalendars({ fetchFn: stubFetch({ status: 500 }), cachePath, feedsPath });
  assert.equal(res.wroteCache, false);
  assert.deepEqual(res.familySnapshot, []);
  assert.equal(existsSync(cachePath), false, "a failed refresh never creates the cache");
});

test("zero configured feeds preserves the cache file untouched, skips the write, never fetches, and snapshots the retained events", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  mkdirSync(join(dir, "calendar"), { recursive: true });
  const prior = { fetchedAt: "2026-01-01T00:00:00.000Z", events: [{ uid: "keep@family", title: "Keep", location: null, startMs: 1, endMs: null, allDay: false, rrule: null, url: null } as VEvent] };
  const priorBytes = JSON.stringify(prior);
  writeFileSync(cachePath, priorBytes);
  const feedsPath = join(dir, "feeds.json"); // never written -> zero feeds
  let fetchCalls = 0;
  const fetchFn: FetchLike = async () => { fetchCalls += 1; throw new Error("must not fetch with zero feeds"); };
  const res = await refreshCalendars({ fetchFn, cachePath, feedsPath });
  assert.equal(fetchCalls, 0);
  assert.equal(res.urls.length, 0);
  assert.equal(res.wroteCache, false, "zero feeds skips the write entirely (0 < 0 is false)");
  assert.equal(readFileSync(cachePath, "utf8"), priorBytes, "the cache file is preserved untouched");
  assert.deepEqual(res.familySnapshot, prior.events, "the retained cache's events are still selection-ready");
});

test("zero configured feeds with no cache yields an empty snapshot without creating the file", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = join(dir, "feeds.json");
  const res = await refreshCalendars({ fetchFn: fetchServing(""), cachePath, feedsPath });
  assert.equal(res.wroteCache, false);
  assert.deepEqual(res.familySnapshot, []);
  assert.equal(existsSync(cachePath), false);
});

test("overrideUrls replace the on-disk feeds for THIS attempt; without them the feeds are read under the lock", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://disk.example.com/disk.ics"]);
  const polled: string[] = [];
  const fetchFn: FetchLike = async (url) => { polled.push(url); return fetchServing(icsFor("ovr@family"))(url); };
  const res = await refreshCalendars({ overrideUrls: ["https://payload.example.com/payload.ics"], fetchFn, cachePath, feedsPath });
  assert.deepEqual(polled, ["https://payload.example.com/payload.ics"]);
  assert.deepEqual(res.urls, ["https://payload.example.com/payload.ics"]);
  assert.equal(res.wroteCache, true);
});

test("degradation lines flow through opts.log with aggregate counts but no structured feed error secrets", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const secretUrl = "https://calendar.example/private.ics?token=TOP-SECRET";
  const feedsPath = mkFeeds(dir, [secretUrl]);
  const lines: string[] = [];
  await refreshCalendars({ fetchFn: fetchServing(icsFor("ok@family")), cachePath, feedsPath, log: (m) => lines.push(m) });
  assert.equal(lines.length, 0, "a successful refresh logs nothing");
  const failed = await refreshCalendars({ fetchFn: stubFetch({ status: 500 }), cachePath, feedsPath, log: (m) => lines.push(m) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /all 1 feed\(s\) failed -- kept the previous cache \(1 error\(s\)\)/);
  assert.ok(!lines[0].includes(secretUrl), "the aggregate daemon diagnostic omits the structured URL");
  assert.ok(!lines[0].includes("TOP-SECRET"), "the aggregate daemon diagnostic omits feed tokens");
  assert.match(failed.errors[0], /private\.ics\?token=TOP-SECRET: HTTP 500$/, "explicit callers retain the structured per-feed error");
  const lines2: string[] = [];
  const dir2 = tmp();
  await refreshCalendars({ fetchFn: fetchServing(""), cachePath: join(dir2, "calendar", "family-cache.json"), feedsPath: join(dir2, "feeds.json"), log: (m) => lines2.push(m) });
  assert.equal(lines2.length, 1);
  assert.match(lines2[0], /no feeds configured -- kept the previous cache/);
});

// ---------- the dedicated refresh lock ----------

test("the lock is a DEDICATED entry beside the cache (never the cache path itself): present while held, gone after release", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const lockFile = `${refreshLockTarget(cachePath)}.lock`;
  assert.equal(refreshLockTarget(cachePath), join(dir, "calendar", "calendar-refresh"), "the stable lock target sits beside the cache");
  let observedHeld = false;
  let releaseFetch!: () => void;
  const gate = new Promise<void>((res) => { releaseFetch = res; });
  const fetchFn: FetchLike = async (url) => {
    observedHeld = existsSync(lockFile) && statSync(lockFile).isDirectory();
    await gate;
    return fetchServing(icsFor("held@family"))(url);
  };
  const pending = refreshCalendars({ fetchFn, cachePath, feedsPath });
  await waitUntil(() => observedHeld, 5_000); // fetchFn runs INSIDE the lock
  releaseFetch();
  await pending;
  assert.equal(existsSync(lockFile), false, "release removes the lock entry");
  assert.equal(existsSync(`${cachePath}.lock`), false, "the cache path itself is never a lock target");
});

test("a cachePath whose parent directory does not exist yet is created and the refresh succeeds (no ENOENT lock failure)", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "nested", "family-cache.json"); // calendar/nested does not exist
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const res = await refreshCalendars({ fetchFn: fetchServing(icsFor("fresh@family")), cachePath, feedsPath });
  assert.equal(res.wroteCache, true, "a fresh install's first refresh works, lock and all");
  assert.ok(existsSync(cachePath));
});

test("the held lock's mtime ADVANCES during a slow legal poll (injectable refresh interval); the production default stays minutes-scale under the fixed 480s window", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const lockFile = `${refreshLockTarget(cachePath)}.lock`;
  // The fixed stale window is a constant, sized for the bounded feed maximum
  // (MAX_FEEDS 20 x 20s sequential + overhead) -- never urls.length-derived.
  assert.equal(REFRESH_LOCK_STALE_MS, 480_000);
  assert.ok(REFRESH_LOCK_MTIME_REFRESH_MS >= 60_000, "production default is minutes-scale");
  assert.ok(REFRESH_LOCK_MTIME_REFRESH_MS < REFRESH_LOCK_STALE_MS, "strictly under the stale window");
  let mtimeAtFetchStart = 0;
  let mtimeAtFetchEnd = 0;
  const fetchFn: FetchLike = async (url) => {
    mtimeAtFetchStart = statSync(lockFile).mtimeMs;
    await delay(2_600); // > 2x the 1100ms refresh interval below
    mtimeAtFetchEnd = statSync(lockFile).mtimeMs;
    return fetchServing(icsFor("slow@family"))(url);
  };
  const res = await refreshCalendars({ fetchFn, cachePath, feedsPath, lockMtimeRefreshMs: 1_100 });
  assert.equal(res.wroteCache, true);
  assert.ok(mtimeAtFetchEnd > mtimeAtFetchStart, `the lock mtime advanced while held (${mtimeAtFetchStart} -> ${mtimeAtFetchEnd})`);
});

test("two simultaneous refreshes SERIALIZE on the lock: no overlapping fetch batches, each receives its own attempt's result", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirst!: () => void;
  const gate = new Promise<void>((res) => { releaseFirst = res; });
  let first = true;
  const fetchFn: FetchLike = async (url) => {
    active += 1; maxActive = Math.max(maxActive, active);
    events.push(`start:${url}`);
    if (first) { first = false; await gate; }
    events.push(`end:${url}`);
    active -= 1;
    return fetchServing(icsFor("ser@family"))(url);
  };
  const p1 = refreshCalendars({ fetchFn, cachePath, feedsPath });
  const p2 = refreshCalendars({ fetchFn, cachePath, feedsPath });
  await delay(300); // p2 contends against p1's gated fetch the whole time
  assert.deepEqual(events, ["start:https://feed.example.com/x.ics"], "the contender has not fetched while the first attempt holds the lock");
  releaseFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(maxActive, 1, "fetch batches never overlap");
  assert.deepEqual(events, [
    "start:https://feed.example.com/x.ics", "end:https://feed.example.com/x.ics",
    "start:https://feed.example.com/x.ics", "end:https://feed.example.com/x.ics",
  ], "the second batch starts only after the first ends");
  assert.equal(r1.wroteCache, true);
  assert.equal(r2.wroteCache, true, "each caller gets its own completed attempt");
});

test("a LIVE slow refresh holds its lock against a second contender (never falsely broken as stale); the contender waits and both complete", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const events: string[] = [];
  const slowFetch: FetchLike = async (url) => {
    events.push("slow-start");
    await delay(2_500); // far under the 480s stale window, past the short refresh interval
    events.push("slow-end");
    return fetchServing(icsFor("slow@family"))(url);
  };
  const fastFetch: FetchLike = async (url) => {
    events.push("fast-start");
    events.push("fast-end");
    return fetchServing(icsFor("fast@family"))(url);
  };
  const slow = refreshCalendars({ overrideUrls: ["https://a.example/slow.ics"], fetchFn: slowFetch, cachePath, feedsPath, lockMtimeRefreshMs: 1_100 });
  await delay(200); // the slow holder is mid-fetch with its mtime refreshing
  const fast = refreshCalendars({ overrideUrls: ["https://a.example/fast.ics"], fetchFn: fastFetch, cachePath, feedsPath });
  const [slowRes] = await Promise.all([slow, fast]);
  assert.equal(slowRes.wroteCache, true, "the slow holder completed and wrote its cache -- its lock was never broken out from under it (a false stale-break would fail its release)");
  assert.deepEqual(events.slice(0, 2), ["slow-start", "slow-end"], "the contender's fetch began only after the slow attempt finished");
});

test("a stale lockfile (ancient mtime, e.g. a killed holder) is broken and the refresh proceeds", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const lockFile = `${refreshLockTarget(cachePath)}.lock`;
  mkdirSync(lockFile, { recursive: true }); // a lock directory left behind by a killed process
  const ancient = new Date(Date.now() - 600_000); // older than the fixed 480s window
  utimesSync(lockFile, ancient, ancient);
  const res = await refreshCalendars({ fetchFn: fetchServing(icsFor("recovered@family")), cachePath, feedsPath });
  assert.equal(res.wroteCache, true, "the stale lock was broken and the refresh completed");
  assert.equal(existsSync(lockFile), false, "released cleanly after");
});

test("lock-busy: bounded acquisition retries exhaust into the TYPED RefreshLockError; the cache is never written", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  mkdirSync(join(dir, "calendar"), { recursive: true });
  const priorBytes = JSON.stringify({ fetchedAt: "old", events: [] });
  writeFileSync(cachePath, priorBytes);
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  // A REAL held lock with a recent mtime: not stale within the 480s window, so the
  // refresh must exhaust its bounded retry budget (~8s of store-family backoff).
  const release = await lockfile.lock(refreshLockTarget(cachePath), { realpath: false, stale: REFRESH_LOCK_STALE_MS, retries: { retries: 0 } });
  try {
    await assert.rejects(
      refreshCalendars({ fetchFn: fetchServing(icsFor("never@family")), cachePath, feedsPath }),
      (err: unknown) => {
        assert.ok(err instanceof RefreshLockError, `typed RefreshLockError, got ${(err as Error)?.name}`);
        assert.equal((err as Error).name, "RefreshLockError");
        assert.match((err as Error).message, /lock busy\/failed/);
        return true;
      },
    );
    assert.equal(readFileSync(cachePath, "utf8"), priorBytes, "the cache is untouched on the lock-busy path");
  } finally {
    await release();
  }
});

// ---------- the selection-ready snapshot contract ----------

test("snapshot isolation: refresh A's familySnapshot still holds A's events after refresh B replaced the cache", async () => {
  const dir = tmp();
  const cachePath = join(dir, "calendar", "family-cache.json");
  const feedsPath = mkFeeds(dir, ["https://feed.example.com/x.ics"]);
  const resA = await refreshCalendars({ fetchFn: fetchServing(icsFor("a@family")), cachePath, feedsPath });
  await refreshCalendars({ fetchFn: fetchServing(icsFor("b@family")), cachePath, feedsPath });
  // The cache file now holds B's events...
  assert.equal(cacheEventsOf(cachePath)[0].uid, "b@family");
  // ...but A's RESULT still carries A's own attempt's events: a consumer holding
  // A's result selects against its own serialized attempt, never B's cache write.
  assert.equal(resA.familySnapshot[0].uid, "a@family");
});
