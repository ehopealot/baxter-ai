// The subscribe-side feed URLs the home DO pushes down the link, persisted for calendar-cli
// poll to read. Mirror of allowlist.ts: home-bot is the SOLE writer (writeCalendarFeeds, via
// applyCalendarFeedsCommand); calendar-cli reads FRESH each poll (loadCalendarFeeds) and
// never writes. Atomic temp+rename, created 0600 from the first write (never chmod-after) so
// a crash never leaves a world-readable temp copy. Fail-open value is EMPTY feeds (unlike
// allowlist's env seed): feeds are not a security gate, and there is no env seed post-cutover
// -- an unreadable/corrupt/absent file means "no feeds", i.e. poll is a no-op.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { isSafeVersion } from "./allowlist.ts";
import { CALENDAR_FEEDS_PATH } from "./paths.ts";

export interface CalendarFeeds { urls: string[]; version: number; }

const EMPTY: CalendarFeeds = { urls: [], version: 0 };

export function loadCalendarFeeds(path: string = CALENDAR_FEEDS_PATH): CalendarFeeds {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") console.error(`calendar-feeds: unreadable ${path} (${(err as Error).message}); treating as no feeds`);
    return { ...EMPTY };
  }
  try {
    const p = JSON.parse(raw) as Partial<CalendarFeeds> | null;
    if (!p || typeof p !== "object" || !Array.isArray(p.urls)) {
      console.error(`calendar-feeds: malformed shape in ${path}; treating as no feeds`);
      return { ...EMPTY };
    }
    return {
      urls: p.urls.filter((x): x is string => typeof x === "string"),
      version: isSafeVersion(p.version) ? p.version : 0,
    };
  } catch (err) {
    console.error(`calendar-feeds: corrupt JSON in ${path} (${(err as Error).message}); treating as no feeds`);
    return { ...EMPTY };
  }
}

export function writeCalendarFeeds(feeds: CalendarFeeds, path: string = CALENDAR_FEEDS_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(feeds, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
