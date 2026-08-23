// The ONE shared family-calendar poll-and-cache (2026-08-20 system scheduled
// tasks, T8): fetch every configured feed (calendar/feeds.json or an explicit
// caller override), atomically replace the family cache ONLY when at least one
// configured feed succeeded, and serialize every attempt cross-process through a
// dedicated proper-lockfile refresh lock -- so Home's automatic polls, Home's
// explicit command polls, the morning check-in, and `calendar-cli poll` never
// interleave fetch/parse/write batches against each other.
//
// The lock target is a DEDICATED stable entry beside the cache
// (<cacheDir>/calendar-refresh, whose lockfile is <cacheDir>/calendar-refresh.lock)
// -- never the cache path itself, which is atomically rename-replaced and may not
// exist on a fresh install. The stale window is a FIXED constant (480s = the
// bounded feed maximum MAX_FEEDS 20 x FEED_TIMEOUT_MS 20s sequential worst case,
// plus parse/write overhead), deliberately NOT derived from urls.length: the URL
// list is read only AFTER the lock is acquired, so a length-derived window could
// not size the wait. While held, the lock's mtime is refreshed (proper-lockfile's
// `update` option, typed in types/proper-lockfile.d.ts) so a legal slow poll is
// never falsely broken as stale; a KILLED holder can only wedge refreshes for the
// stale window before the lock is broken automatically. The lock is held across
// fetch/parse/cache-write only -- never across model generation or delivery.
//
// SELECTION-READY SNAPSHOT: every RefreshResult carries familySnapshot, the
// family events THIS caller's own serialized attempt selects from -- the
// successful poll's merged events when the cache was written, otherwise the
// retained prior cache's events read UNDER the lock ([] when no cache exists).
// Captured under the lock, it is immune to a later process replacing the cache
// after this attempt's release (the morning check-in must never select against a refresh
// still in flight in another process). home-bot and calendar-cli ignore the
// field -- their consumers keep reading the cache file; morning check-in is its
// consumer.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CALENDAR_CACHE_PATH, CALENDAR_FEEDS_PATH } from "./paths.ts";
import { performPoll, feedUrls } from "./calendar-poll.ts";
import type { FetchLike } from "./calendar-poll.ts";
import type { VEvent } from "./ical.ts";
import type { LoaderDiagnosticSink } from "./allowlist.ts";

// FIXED stale window (see header). Exported so tests can pin that it stays fixed.
export const REFRESH_LOCK_STALE_MS = 480_000;
// Production mtime-refresh interval while the lock is held: minutes-scale and
// strictly under the 480s stale window (proper-lockfile further clamps it to
// stale/2). Injectable for tests via opts.lockMtimeRefreshMs.
export const REFRESH_LOCK_MTIME_REFRESH_MS = 60_000;

// Lock-acquisition failure (bounded retries exhausted against a held,
// not-yet-stale lock). Callers DEGRADE on it -- home-bot logs and keeps serving
// the last-known cache, calendar-cli prints a kept-previous-cache line and exits
// nonzero -- never wedge their own surface on it.
export class RefreshLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshLockError";
  }
}

export interface RefreshResult {
  // THIS attempt's URL list: the caller's override, or feeds.json read under the lock.
  urls: string[];
  // True iff at least one configured feed succeeded (zero feeds -> false).
  ok: boolean;
  // This attempt's merged parsed events.
  events: VEvent[];
  // Per-feed structured errors ("<url>: <message>"), same shape performPoll returns.
  errors: string[];
  // The cache was atomically replaced. Exactly the `ok` condition, named for its
  // effect: zero configured feeds and all-feeds-failed both retain the prior file.
  wroteCache: boolean;
  // Selection-ready family events captured under the lock (see header).
  familySnapshot: VEvent[];
  // True when familySnapshot comes from a successful refresh or a parseable
  // retained cache. This distinguishes a reliable empty calendar from a
  // configured-feed failure with no usable family snapshot.
  retainedSnapshotAvailable: boolean;
}

// The stable lock target beside the cache: <cacheDir>/calendar-refresh, so the
// entry proper-lockfile creates/removes is <cacheDir>/calendar-refresh.lock.
// Exported so callers' tests hold the SAME target for contention fixtures.
export function refreshLockTarget(cachePath: string): string {
  return join(dirname(cachePath), "calendar-refresh");
}

// The retained family cache's events ([] when absent/corrupt/non-array).
// Shared by three consumers: the lock-held prior-cache read below (which makes
// the captured snapshot race-free), the morning check-in's degradation read of
// the last-known cache (morning-check-in.ts -- the handler's ONLY cache read),
// and the calendar mirror's family-cache agenda render (calendar-mirror.ts).
export interface FamilyCacheSnapshot {
  events: VEvent[];
  available: boolean;
}

// Availability is explicit: an empty parseable cache is reliable, while []
// from a missing/corrupt cache is not safe to use as a calendar answer.
export function readFamilyCacheSnapshot(cachePath: string): FamilyCacheSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as { events?: unknown };
    return Array.isArray(parsed.events)
      ? { events: parsed.events as VEvent[], available: true }
      : { events: [], available: false };
  } catch {
    return { events: [], available: false };
  }
}

export function readFamilyCacheEvents(cachePath: string): VEvent[] {
  return readFamilyCacheSnapshot(cachePath).events;
}

export async function refreshCalendars(opts: {
  overrideUrls?: string[];
  fetchFn: FetchLike;
  cachePath?: string; // default CALENDAR_CACHE_PATH
  feedsPath?: string; // default CALENDAR_FEEDS_PATH
  lockMtimeRefreshMs?: number; // test-only shortening; default REFRESH_LOCK_MTIME_REFRESH_MS
  log?: (m: string) => void;
  diagnostic?: LoaderDiagnosticSink;
}): Promise<RefreshResult> {
  const cachePath = opts.cachePath ?? CALENDAR_CACHE_PATH;
  const feedsPath = opts.feedsPath ?? CALENDAR_FEEDS_PATH;
  const lockTarget = refreshLockTarget(cachePath);
  // proper-lockfile creates only the '<target>.lock' entry itself, so the parent
  // directory must exist BEFORE acquisition -- a missing parent (fresh install,
  // injected cachePath under a not-yet-created dir) must yield a WORKING refresh,
  // not an ENOENT lock failure (same discipline as schedule-store's ensureFile).
  mkdirSync(dirname(lockTarget), { recursive: true });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: REFRESH_LOCK_STALE_MS,
      update: opts.lockMtimeRefreshMs ?? REFRESH_LOCK_MTIME_REFRESH_MS,
      retries: { retries: 30, minTimeout: 30, maxTimeout: 300 }, // store-family acquisition budget
    });
  } catch (err) {
    // Bounded acquisition retries exhausted against a held, not-yet-stale lock.
    opts.diagnostic?.({ category: "refresh-lock-failure" });
    throw new RefreshLockError(`calendar refresh lock busy/failed: ${(err as Error).message}`);
  }
  try {
    // The URL snapshot is taken INSIDE serialization: a normal poll's feeds.json
    // read cannot race another process's poll. An explicit Home command override
    // carries its FULL URL list into its own serialized attempt.
    const urls = opts.overrideUrls ?? feedUrls(feedsPath, opts.diagnostic);
    const { events, errors } = await performPoll(urls, opts.fetchFn);
    if (errors.length > 0) opts.diagnostic?.({ category: "feed-failure", count: errors.length });
    const ok = errors.length < urls.length; // zero feeds: 0 < 0 is false -- no write
    let familySnapshot: VEvent[];
    let retainedSnapshotAvailable: boolean;
    if (ok) {
      // Atomic replace (tmp+rename) so a concurrent agenda read never sees a
      // half-written file; a poll failure never erases Baxter-owned events (the
      // own store is never touched here). The parent dir exists: the mkdirSync
      // above created dirname(lockTarget) === dirname(cachePath).
      const tmp = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), events }, null, 2));
      renameSync(tmp, cachePath);
      familySnapshot = events; // exactly what the cache now holds
      retainedSnapshotAvailable = true;
    } else {
      // Zero configured feeds (skip the write entirely) or an all-feeds failure:
      // the prior cache is retained, and the snapshot is its events read under
      // the lock ([] when no cache exists).
      if (urls.length === 0) opts.log?.("calendar refresh: no feeds configured -- kept the previous cache");
      else opts.log?.(`calendar refresh: all ${urls.length} feed(s) failed -- kept the previous cache (${errors.length} error(s))`);
      const retained = readFamilyCacheSnapshot(cachePath);
      familySnapshot = retained.events;
      retainedSnapshotAvailable = retained.available;
    }
    // The result describes THIS caller's own completed attempt only; callers
    // never join or borrow another caller's result.
    return { urls, ok, events, errors, wroteCache: ok, familySnapshot, retainedSnapshotAvailable };
  } finally {
    // Release immediately after the attempt (fetch/parse/cache-write only).
    await release();
  }
}
