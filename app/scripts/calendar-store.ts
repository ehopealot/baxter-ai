// Baxter's OWN calendar events (the ones it publishes as an ICS feed). A JSON array
// in STATE_DIR (see paths.ts CALENDAR_EVENTS_PATH) -- deliberately OUTSIDE the run's
// sandbox-writable MEMORY_DIR, so calendar-cli is the only writer and the proper-lockfile
// mutate() actually gates every write (mirrors schedule-store). Functions take an
// explicit path so tests never touch the real workspace.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { CALENDAR_EVENTS_PATH } from "./paths.ts";

export interface StoredEvent {
  uid: string;
  title: string;
  start: string; // ISO: "YYYY-MM-DD" for all-day, full ISO datetime otherwise
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  created: string;
  updated: string;
}

// A soft cap so a runaway or hostile add-loop can't balloon the store; generous for
// a family's own booked events.
export const MAX_EVENTS = 2000;

function ensureFile(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
  // wx = create-or-fail; only EEXIST is expected. Rethrow a real error (EACCES/EROFS)
  // instead of swallowing it and burning the lock's retry loop on a lock we can't take.
  try { writeFileSync(p, "[]", { flag: "wx" }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
}

export function readEvents(p: string = CALENDAR_EVENTS_PATH): StoredEvent[] {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StoredEvent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// Read -> transform -> atomically write, under a proper-lockfile lock, so concurrent
// mutations across surfaces serialize instead of clobbering (mirrors schedule-store.mutate).
export async function mutate<V>(p: string, fn: (events: StoredEvent[]) => { events: StoredEvent[]; value: V }): Promise<V> {
  ensureFile(p);
  const release = await lockfile.lock(p, { realpath: false, stale: 10000, retries: { retries: 30, minTimeout: 30, maxTimeout: 300 } });
  try {
    const events = readEvents(p);
    const { events: next, value } = fn(events);
    // Skip the rewrite when the reducer returned the array UNCHANGED (same identity) -- e.g. a
    // removeEvent that matched no uid. Avoids a needless tmp+rename, which would otherwise fire the
    // home surface's fs watcher and push a same-digest view for nothing. Callers that DO mutate
    // (addEvent, a real removeEvent) always return a fresh array, so the happy path is unaffected.
    if (next !== events) {
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, p);
    }
    return value;
  } finally {
    await release();
  }
}

// A stable, unique UID assigned once at creation and never regenerated.
export function newUid(): string {
  return `${randomBytes(12).toString("hex")}@baxter`;
}

export interface EventInput {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
}

// Append a new event (fresh UID + timestamps). Rejects past the size cap.
export async function addEvent(p: string, input: EventInput): Promise<StoredEvent> {
  const now = new Date().toISOString();
  const ev: StoredEvent = {
    uid: newUid(), created: now, updated: now,
    title: input.title, start: input.start,
    ...(input.end ? { end: input.end } : {}),
    ...(input.allDay ? { allDay: true } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
  return mutate(p, (events) => {
    if (events.length >= MAX_EVENTS) throw new Error(`calendar already has ${events.length} events (cap ${MAX_EVENTS}); remove or prune old ones first`);
    return { events: [...events, ev], value: ev };
  });
}

// Remove by UID; returns true iff an event was removed.
export async function removeEvent(p: string, uid: string): Promise<boolean> {
  return mutate(p, (events) => {
    const next = events.filter((e) => e.uid !== uid);
    const changed = next.length !== events.length;
    return { events: changed ? next : events, value: changed }; // same identity on no-match -> mutate skips the write
  });
}
