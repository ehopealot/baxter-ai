// Leaf module for family-calendar feed polling. It deliberately has no dependency on
// calendar-cli.ts so calendar-refresh.ts can reuse polling without forming an ESM cycle.
import { readCapped } from "./http-util.ts";
import { guardUrl } from "./web-cli.ts";
import { CALENDAR_FEEDS_PATH } from "./paths.ts";
import { loadCalendarFeeds } from "./calendar-feeds.ts";
import { parseIcs } from "./ical.ts";
import type { VEvent } from "./ical.ts";

const UA = "Mozilla/5.0 (compatible; baxter-calendar/1.0)";
const FEED_TIMEOUT_MS = 20000;
const FEED_MAX_BYTES = 2 * 1024 * 1024; // a family calendar feed

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// The family's subscribe feed URLs come from calendar/feeds.json (written by home-bot
// from the DO's live push). Missing/empty file -> [] -> poll is a no-op.
export function feedUrls(path: string = CALENDAR_FEEDS_PATH): string[] {
  return loadCalendarFeeds(path).urls;
}

async function fetchFeed(url: string, doFetch: FetchLike): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    // Feeds are FAMILY-set (session+CSRF-authenticated, a lower trust tier than the
    // operator) via the settings UI, then pushed down through calendar/feeds.json -- so
    // the initial URL is untrusted input, not an operator-picked value. Guard it BEFORE
    // the fetch so a malicious feed URL never reaches an internal/loopback host in the
    // first place (the worker validates on input too, but this is the load-bearing check:
    // it's what actually issues the GET).
    guardUrl(url);
    const res = await doFetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "text/calendar,text/plain,*/*" } });
    // Re-guard the FINAL url after redirects (mirrors web-cli): a hostile feed host could
    // 3xx-redirect toward an internal/loopback address after passing the pre-flight check
    // on its original URL.
    if (res.url) guardUrl(res.url);
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const { text, truncated } = await readCapped(res, FEED_MAX_BYTES);
    // A silently-truncated feed drops its trailing events; surface it rather than
    // caching a partial calendar that looks complete.
    if (truncated) throw new Error(`feed exceeds ${FEED_MAX_BYTES} bytes (truncated); not caching a partial calendar`);
    return text;
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "AbortError" || controller.signal.aborted ? `timed out after ${FEED_TIMEOUT_MS}ms` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// Fetch + parse each family feed URL. A bad feed is reported, not fatal to the others.
export async function performPoll(urls: string[], doFetch: FetchLike): Promise<{ events: VEvent[]; errors: string[] }> {
  const events: VEvent[] = [];
  const errors: string[] = [];
  for (const url of urls) {
    try { events.push(...parseIcs(await fetchFeed(url, doFetch))); }
    catch (err) { errors.push(`${url}: ${(err as Error).message}`); }
  }
  return { events, errors };
}
