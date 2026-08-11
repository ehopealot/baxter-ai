#!/usr/bin/env node
// calendar-cli: Baxter's calendar. Manages its OWN events (add/remove/list), publishes
// them as an ICS feed to S3-compatible object storage (publish), reads the family's
// shared read-only feed (poll -> cache), shows a merged upcoming view (agenda), and
// emits a single-event ICS for an email "add to calendar" attachment (ics). See
// docs/superpowers/specs/2026-07-30-calendar-poll-publish-design.md. Pure helpers +
// injectable fetch/upload seams so tests never hit the network; the CLI resolves real
// paths/env/keys. Guarded so importing for tests doesn't run the CLI.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { AwsClient } from "aws4fetch";
import { readCapped } from "./http-util.ts";
import { guardUrl } from "./web-cli.ts";
import { CALENDAR_EVENTS_PATH, CALENDAR_CACHE_PATH, CALENDAR_KEYS_PATH, CALENDAR_FEEDS_PATH } from "./paths.ts";
import { loadCalendarFeeds } from "./calendar-feeds.ts";
import { readEvents, addEvent, removeEvent } from "./calendar-store.ts";
import type { StoredEvent } from "./calendar-store.ts";
import { buildIcs, parseIcs, expandInWindow } from "./ical.ts";
import type { CalEvent, VEvent, Occurrence } from "./ical.ts";
import { parseFlags } from "./cli-flags.ts";

const UA = "Mozilla/5.0 (compatible; baxter-calendar/1.0)";
const FEED_TIMEOUT_MS = 20000;
const FEED_MAX_BYTES = 2 * 1024 * 1024; // a family calendar feed
const PUBLISH_STALE_DAYS = 30; // events ended > this ago are dropped from the published feed

// ---------- config ----------

export interface CalendarKeys {
  endpoint: string; bucket: string; region?: string;
  accessKeyId: string; secretAccessKey: string; objectKey: string;
  // The public subscribe URL (webcal://<cal-domain>/<objectKey>), written by
  // baxter-control at provisioning. Not needed for upload; read by `mail send-calendar`
  // to share the link with the operator. Core never constructs it (deployment-agnostic).
  subscribeUrl?: string;
}
export function loadKeys(path: string = CALENDAR_KEYS_PATH): CalendarKeys {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no calendar-keys.json at ${path} -- provision the object-storage feed (endpoint/bucket/accessKeyId/secretAccessKey/objectKey) first`);
    throw err;
  }
  const k = JSON.parse(raw) as Partial<CalendarKeys>;
  for (const f of ["endpoint", "bucket", "accessKeyId", "secretAccessKey", "objectKey"] as const) {
    if (!k[f]) throw new Error(`calendar-keys.json is missing "${f}"`);
  }
  return k as CalendarKeys;
}
// The family's subscribe feed URLs now come from calendar/feeds.json (written by home-bot
// from the DO's live push), NOT a retired env var. Missing/empty file -> [] -> poll is a
// no-op, same behavior an empty env var had.
export function feedUrls(path: string = CALENDAR_FEEDS_PATH): string[] {
  return loadCalendarFeeds(path).urls;
}

// ---------- own events <-> VEvent / CalEvent ----------

function startMsOf(e: StoredEvent): number {
  if (e.allDay) { const m = e.start.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  return new Date(e.start).getTime();
}
function endMsOf(e: StoredEvent): number | null {
  if (!e.end) return null; // all-day with no end -> whole-day span handled in expandInWindow
  // A stored all-day `end` is the last day INCLUSIVE, so the exclusive end instant (what
  // agenda overlap compares) is the day AFTER it -- else a multi-day all-day event drops
  // off the agenda on its final day.
  if (e.allDay) { const m = e.end.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) + 86400000 : null; }
  return new Date(e.end).getTime();
}
function storedToVEvent(e: StoredEvent): VEvent {
  // Baxter's own events have no source URL of their own -- they ARE the source.
  return { uid: e.uid, title: e.title, location: e.location ?? null, startMs: startMsOf(e), endMs: endMsOf(e), allDay: !!e.allDay, rrule: null, url: null };
}
// Exported (home-calendar plan, Task C2) so calendar-mirror.ts reuses this EXACT
// StoredEvent -> CalEvent mapping when building an own event's single-event ICS for the
// home view -- one ICS-mapping source of truth, not a re-derived copy.
export const toCalEvent = (e: StoredEvent): CalEvent => ({ uid: e.uid, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, description: e.description, updated: e.updated });

// ---------- publish ----------

export type Uploader = (keys: CalendarKeys, body: string) => Promise<void>;

// Default uploader: an S3-compatible PUT (R2 / B2's S3 endpoint / real S3), SigV4-signed
// by aws4fetch (a zero-dependency signer). Path-style URL. Content-Type text/calendar.
export const s3Upload: Uploader = async (keys, body) => {
  const aws = new AwsClient({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: keys.region || "auto", service: "s3" });
  const url = `${keys.endpoint.replace(/\/+$/, "")}/${keys.bucket}/${keys.objectKey}`;
  const res = await aws.fetch(url, { method: "PUT", body, headers: { "Content-Type": "text/calendar; charset=utf-8" } });
  if (!res.ok) throw new Error(`object storage PUT failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
};

// Build the ICS from live (recent + future) own events and upload it. Pure over its
// inputs (events, keys, uploader, now) so tests inject a fake uploader.
export async function performPublish(events: StoredEvent[], keys: CalendarKeys, upload: Uploader, now: Date = new Date()): Promise<{ count: number; bytes: number; objectKey: string }> {
  const cutoff = now.getTime() - PUBLISH_STALE_DAYS * 86400000;
  const live = events.filter((e) => (endMsOf(e) ?? startMsOf(e)) >= cutoff);
  const ics = buildIcs(live.map(toCalEvent), { now });
  await upload(keys, ics);
  return { count: live.length, bytes: Buffer.byteLength(ics, "utf8"), objectKey: keys.objectKey };
}

// ---------- poll ----------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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

// ---------- agenda ----------

export interface AgendaItem extends Occurrence { source: "own" | "family"; }

// Merge own + family occurrences overlapping [now, now+days], sorted, source-tagged.
// Dedup on re-entry: a Baxter-created (own) event the family added to their device calendar via the
// home page's "Add to device calendar" comes back through a linked feed. Google and Apple preserve
// the .ics UID *and* DTSTART across import, so the feed occurrence matches the own event on BOTH.
// The key is `uid + startMs`, deliberately NOT uid alone, for two reasons:
//   - feeds are a LOWER trust tier (family-set URLs, untrusted content) and own uids aren't secret
//     (performPublish uploads them to an unauthenticated webcal URL). Keying on uid alone would let
//     a hostile/edited feed SUPPRESS an authentic own event by forging just its uid; requiring the
//     start time to match too means a forged/moved copy leaves the own record visible beside it
//     (conflicting information, not a duplicate) -- fail safe, don't hide Baxter's own truth.
//   - a recurring feed event expands to many occurrences sharing one uid; keying on uid+startMs
//     dedups per-occurrence, not the whole series.
// famOcc is also deduped against ITSELF (same key) so the same event arriving through two linked
// feeds -- two members who each imported it -- collapses to one row, not two.
export function buildAgenda(own: StoredEvent[], family: VEvent[], fromMs: number, days: number): AgendaItem[] {
  const toMs = fromMs + days * 86400000;
  const ownOcc = expandInWindow(own.map(storedToVEvent), fromMs, toMs).map((o): AgendaItem => ({ ...o, source: "own" }));
  const famOccRaw = expandInWindow(family, fromMs, toMs).map((o): AgendaItem => ({ ...o, source: "family" }));
  const key = (o: AgendaItem): string | null => (o.uid ? `${o.uid} ${o.startMs}` : null);
  const seenFam = new Set<string>();
  const famOcc = famOccRaw.filter((o) => { const k = key(o); if (!k) return true; if (seenFam.has(k)) return false; seenFam.add(k); return true; });
  const dedupedOwn = seenFam.size ? ownOcc.filter((o) => { const k = key(o); return !(k && seenFam.has(k)); }) : ownOcc;
  return [...dedupedOwn, ...famOcc].sort((a, b) => a.startMs - b.startMs);
}
function fmtWhen(o: Occurrence): string {
  const d = new Date(o.startMs);
  if (o.allDay) return d.toISOString().slice(0, 10);
  return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}
export function formatAgenda(items: AgendaItem[]): string {
  if (items.length === 0) return "(nothing scheduled in that window)";
  return items.map((o) => {
    const tag = o.source === "own" ? "[baxter]" : "[family]";
    const rec = o.recurrenceUnexpanded ? " (recurring — first shown; check the source feed)" : o.recurring ? " (recurring)" : "";
    return `${fmtWhen(o)}  ${tag} ${o.title}${o.location ? ` @ ${o.location}` : ""}${rec}`;
  }).join("\n");
}

// ---------- CLI ----------

// Valueless flags -- passed to the shared parser so a following token isn't swallowed as a value.
const BOOL_FLAGS = new Set(["all-day"]);

const USAGE = [
  "usage:",
  "  calendar-cli add --title T --start ISO [--end ISO] [--all-day] [--location L] [--desc D]",
  "  calendar-cli remove <uid>",
  "  calendar-cli list",
  "  calendar-cli poll                 fetch the family feed(s) (calendar/feeds.json) into the cache",
  "  calendar-cli agenda [--days N]    merged upcoming view (your events + the family's), default 7",
  "  calendar-cli publish              regenerate the ICS and upload it to the subscribed feed",
  "  calendar-cli ics <uid...>         print a single-event ICS to stdout (for an email attachment)",
  "",
  "Your own events are what you PUBLISH; `poll`/`agenda` READ the family's calendar.",
  "Start/end are ISO 8601 (YYYY-MM-DD for --all-day, else a full datetime like 2026-08-04T15:00:00Z).",
].join("\n");

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positionals } = parseFlags(rest, BOOL_FLAGS);
  if (cmd === "add") {
    const title = typeof flags.title === "string" ? flags.title : "";
    const start = typeof flags.start === "string" ? flags.start : "";
    if (!title || !start) throw new Error("add requires --title and --start (ISO)");
    const allDay = flags["all-day"] === true;
    const end = typeof flags.end === "string" ? flags.end : undefined;
    // Validate dates up front: an LLM caller WILL emit "--start tomorrow" sometimes, and
    // an unparseable date silently vanishes from publish/agenda and crashes `list` for the
    // whole store (Invalid time value), so refuse it here with a clear message.
    const badDate = (v: string): boolean => (allDay ? !/^\d{4}-\d{2}-\d{2}$/.test(v) : Number.isNaN(new Date(v).getTime()));
    const want = allDay ? "YYYY-MM-DD" : "an ISO datetime like 2026-08-04T15:00:00Z";
    if (badDate(start)) throw new Error(`invalid --start (want ${want}): ${JSON.stringify(start)}`);
    if (end && badDate(end)) throw new Error(`invalid --end (want ${want}): ${JSON.stringify(end)}`);
    if (end && new Date(end).getTime() < new Date(start).getTime()) throw new Error(`--end (${end}) is before --start (${start})`);
    const ev = await addEvent(CALENDAR_EVENTS_PATH, {
      title, start, end, allDay,
      location: typeof flags.location === "string" ? flags.location : undefined,
      description: typeof flags.desc === "string" ? flags.desc : undefined,
    });
    console.log(JSON.stringify({ added: true, uid: ev.uid }));
  } else if (cmd === "remove") {
    if (!positionals[0]) throw new Error("usage: calendar-cli remove <uid>");
    const ok = await removeEvent(CALENDAR_EVENTS_PATH, positionals[0]);
    console.log(JSON.stringify({ removed: ok, uid: positionals[0] }));
  } else if (cmd === "list") {
    const evs = readEvents(CALENDAR_EVENTS_PATH);
    if (evs.length === 0) { console.log("(no events yet -- `calendar-cli add ...`)"); return; }
    for (const e of evs) {
      // Defensive: never let one legacy/hand-written bad date crash the whole listing.
      const when = e.allDay || Number.isNaN(new Date(e.start).getTime()) ? e.start : new Date(e.start).toISOString();
      console.log(`${e.uid}  ${when}  ${e.title}`);
    }
  } else if (cmd === "poll") {
    const urls = feedUrls();
    if (urls.length === 0) { console.log("no feeds configured in calendar/feeds.json -- nothing to poll"); return; }
    const { events, errors } = await performPoll(urls, fetch as FetchLike);
    // Only overwrite the cache if at least one feed succeeded -- a transient outage of
    // ALL feeds must NOT replace the last-known calendar with nothing (which would make
    // agenda confidently report "nothing scheduled"). Atomic tmp+rename so a concurrent
    // agenda read never sees a half-written file.
    if (errors.length < urls.length) {
      mkdirSync(dirname(CALENDAR_CACHE_PATH), { recursive: true });
      const tmp = `${CALENDAR_CACHE_PATH}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), events }, null, 2));
      renameSync(tmp, CALENDAR_CACHE_PATH);
    }
    const status = errors.length < urls.length ? `${events.length} events cached` : "ALL feeds failed -- kept the previous cache";
    console.log(`polled ${urls.length} feed(s): ${status}${errors.length ? `; ${errors.length} error(s): ${errors.join("; ")}` : ""}`);
  } else if (cmd === "agenda") {
    if (flags.days !== undefined && (typeof flags.days !== "string" || !(Number(flags.days) > 0))) throw new Error("--days must be a positive number");
    const days = typeof flags.days === "string" ? Number(flags.days) : 7;
    const own = readEvents(CALENDAR_EVENTS_PATH);
    let family: VEvent[] = [];
    try { family = (JSON.parse(readFileSync(CALENDAR_CACHE_PATH, "utf8")) as { events: VEvent[] }).events ?? []; } catch { /* no cache yet */ }
    console.log(formatAgenda(buildAgenda(own, family, Date.now(), days)));
  } else if (cmd === "publish") {
    const keys = loadKeys();
    const res = await performPublish(readEvents(CALENDAR_EVENTS_PATH), keys, s3Upload);
    console.log(JSON.stringify({ published: true, events: res.count, bytes: res.bytes }));
  } else if (cmd === "ics") {
    if (positionals.length === 0) throw new Error("usage: calendar-cli ics <uid...>");
    const wanted = new Set(positionals);
    const evs = readEvents(CALENDAR_EVENTS_PATH).filter((e) => wanted.has(e.uid));
    if (evs.length === 0) throw new Error(`no stored event(s) matching ${positionals.join(", ")}`);
    process.stdout.write(buildIcs(evs.map(toCalEvent)));
  } else {
    console.error(USAGE);
    process.exit(cmd ? 1 : 2); // nonzero even with NO subcommand: exit-0-with-usage made run_cli report ok:true, so a model that misinvoked (cmd in stdin, no args) looped on the success-looking usage instead of self-correcting
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(`calendar-cli: ${(err as Error).message}`);
    process.exit(1);
  });
}
