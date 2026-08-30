#!/usr/bin/env node
// calendar-cli: Baxter's calendar. Manages its own events (add/remove/list), reads the
// family's shared read-only feed (poll -> cache), shows a merged upcoming view (agenda),
// and emits a single-event ICS for an email "add to calendar" attachment (ics). The
// separate published-calendar feed was removed. Guarded so importing for tests doesn't
// run the CLI.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refreshCalendars, RefreshLockError } from "./calendar-refresh.ts";
import { feedUrls, performPoll } from "./calendar-poll.ts";
import type { FetchLike } from "./calendar-poll.ts";
import { CALENDAR_EVENTS_PATH, CALENDAR_CACHE_PATH } from "./paths.ts";
import { readEvents, addEvent, removeEvent } from "./calendar-store.ts";
import type { StoredEvent } from "./calendar-store.ts";
import { buildIcs, expandInWindow } from "./ical.ts";
import type { CalEvent, VEvent, Occurrence } from "./ical.ts";
import { parseFlags } from "./cli-flags.ts";
import { issueCalendarPublicLink } from "./calendar-public-links.ts";
import type { CalendarPublicLinkEvent, CalendarPublicLinkIssuerDeps, IssuedCalendarPublicLink } from "./calendar-public-links.ts";

export type { CalendarPublicLinkEvent, CalendarPublicLinkIssuerDeps, IssuedCalendarPublicLink } from "./calendar-public-links.ts";

export { feedUrls, performPoll };
export type { FetchLike };

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

// ---------- public add-to-calendar capability shape ----------
//
// This produces the canonical event fields the public Worker accepts. The capability
// reuse fingerprint deliberately excludes independently generated ICS (including
// DTSTAMP), so these fields are the stable identity contract for a retry.
function civilDateOrThrow(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid all-day date: ${JSON.stringify(value)}`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid all-day date: ${JSON.stringify(value)}`);
  }
  return d;
}

function nextCivilDate(value: string): string {
  const d = civilDateOrThrow(value);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function normalizedInstant(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid event datetime: ${JSON.stringify(value)}`);
  return d.toISOString();
}

export function toCalendarPublicLinkEvent(event: StoredEvent): CalendarPublicLinkEvent {
  if (event.allDay) {
    const start = event.start.slice(0, 10);
    civilDateOrThrow(start);
    // Stored all-day ends are inclusive; Home's view (and Google) use exclusive end.
    return {
      uid: event.uid,
      title: event.title,
      start,
      ...(event.end ? { end: nextCivilDate(event.end.slice(0, 10)) } : {}),
      allDay: true,
      ...(event.location ? { location: event.location } : {}),
    };
  }
  return {
    uid: event.uid,
    title: event.title,
    start: normalizedInstant(event.start),
    ...(event.end ? { end: normalizedInstant(event.end) } : {}),
    allDay: false,
    ...(event.location ? { location: event.location } : {}),
  };
}

export interface GetAddToCalendarLinkDeps {
  eventsPath?: string;
  issue?: (issue: { event: CalendarPublicLinkEvent; ics: string }) => Promise<IssuedCalendarPublicLink>;
  issuerDeps?: CalendarPublicLinkIssuerDeps;
}

export async function getAddToCalendarLink(uid: string, deps: GetAddToCalendarLinkDeps = {}): Promise<string[]> {
  const event = readEvents(deps.eventsPath ?? CALENDAR_EVENTS_PATH).find((candidate) => candidate.uid === uid);
  if (!event) throw new Error(`no stored event matching ${uid}`);
  const issue = { event: toCalendarPublicLinkEvent(event), ics: buildIcs([toCalEvent(event)]) };
  const issued = deps.issue ? await deps.issue(issue) : await issueCalendarPublicLink(issue, deps.issuerDeps);
  return [
    `Add to google calendar - ${issued.homeOrigin}/a/${issued.googleCode}`,
    `Add to device calendar - ${issued.homeOrigin}/a/${issued.deviceCode}`,
  ];
}

// ---------- agenda ----------

export interface AgendaItem extends Occurrence { source: "own" | "family"; }

// Merge own + family occurrences overlapping [now, now+days], sorted, source-tagged.
// Dedup on re-entry: a Baxter-created (own) event the family added to their device calendar via the
// home page comes back through a linked feed (Google/Apple preserve the .ics UID + DTSTART across
// import). Two dedups, and OWN always wins:
//   - Feed-vs-OWN: drop a feed occurrence matching an own event on uid+startMs; keep the OWN row --
//     it is the trusted store copy. A SECURITY call, not a display nicety: feeds are a lower trust
//     tier and a hostile linked feed could forge an own uid and start. Keeping own means such a
//     feed can at worst ADD a row, never REPLACE or hide Baxter's own record. (A re-imported event
//     does still offer "Add to device calendar" -- harmless; re-adding is the family choice.)
//   - Feed self-dedup: collapse two feed copies ONLY when truly identical -- same uid+startMs AND
//     endMs+title+location. Two members importing one event carry identical content and collapse; a
//     copy whose title/duration was edited on a device (or a RECURRENCE-ID override VEVENT, which
//     parses as a same-uid sibling) stays visible beside the original -- conflicting info, not a dup.
export function buildAgenda(own: StoredEvent[], family: VEvent[], fromMs: number, days: number): AgendaItem[] {
  const toMs = fromMs + days * 86400000;
  const ownOcc = expandInWindow(own.map(storedToVEvent), fromMs, toMs).map((o): AgendaItem => ({ ...o, source: "own" }));
  const famOccRaw = expandInWindow(family, fromMs, toMs).map((o): AgendaItem => ({ ...o, source: "family" }));
  const identityKey = (o: AgendaItem): string | null => (o.uid ? `${o.uid}\u0000${o.startMs}` : null);
  const contentKey = (o: AgendaItem): string | null => (o.uid ? `${o.uid}\u0000${o.startMs}\u0000${o.endMs ?? ""}\u0000${o.title}\u0000${o.location ?? ""}` : null);
  // Feed self-dedup on FULL content: only true duplicates collapse; a divergent copy survives.
  const seenFamContent = new Set<string>();
  const famSelfDeduped = famOccRaw.filter((o) => { const k = contentKey(o); if (!k) return true; if (seenFamContent.has(k)) return false; seenFamContent.add(k); return true; });
  // Feed-vs-own on uid+startMs: drop the feed copy of a re-imported own event; the trusted own row stays.
  const ownIds = new Set(ownOcc.map(identityKey).filter((k): k is string => k !== null));
  const famOcc = ownIds.size ? famSelfDeduped.filter((o) => { const k = identityKey(o); return !(k && ownIds.has(k)); }) : famSelfDeduped;
  // Best-effort cross-uid dedup: a LINKED calendar (e.g. the family's Google calendar) that carries
  // the same event under ITS OWN uid should win in display -- the family manages it there -- so drop
  // Baxter's own copy when a feed event has the SAME start and a SIMILAR title. uid-AGNOSTIC on
  // purpose: the Google round-trip re-ids the event, so the identityKey rule above never matches it.
  // The exact-start anchor is what makes fuzzing the title safe -- two genuinely-different events at
  // the identical start instant are vanishingly rare -- so a small title drift (Google truncating or
  // reformatting "St. John's ..." vs "St John's ...", or adding "& Fundraising") still collapses.
  // Runs AFTER the same-uid own-wins rule, so Baxter's OWN event echoed back through a feed with its
  // own uid still shows as the own row (menu intact); only a different-uid external twin hides it.
  // (Feeds are family-trusted; the accepted residual is a feed attributing a same-time, similar-title
  // event to itself and dropping the own row's delete menu.)
  const ownVisible = famOcc.length
    ? ownOcc.filter((o) => !famOcc.some((f) => f.startMs === o.startMs && f.allDay === o.allDay && titlesSimilar(f.title, o.title)))
    : ownOcc;
  return [...ownVisible, ...famOcc].sort((a, b) => a.startMs - b.startMs);
}

// Normalize a title for similarity: lowercase, DROP apostrophes so "John's" -> "johns" (a stray
// apostrophe must not split one word into two tokens and sink the overlap score), then other
// punctuation -> space, collapse whitespace, trim.
function normTitle(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/['’ʼ`]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
// Best-effort "same event, reworded" title test for the cross-source dedup: equal after
// normalization, or one a prefix of the other (truncation), or a high word-overlap (Dice >= 0.6,
// which absorbs an added/dropped word like "& Fundraising"). Anchored by an exact start match at the
// call site, so it only has to tell "the same event, reworded" from "a different event, same instant".
export function titlesSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return na === nb;
  if (na === nb || na.startsWith(nb) || nb.startsWith(na)) return true;
  const ta = new Set(na.split(" ")), tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return (2 * inter) / (ta.size + tb.size) >= 0.6;
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
  "  calendar-cli ics <uid...>         print a single-event ICS to stdout (for an email attachment)",
  "  calendar-cli get-add-to-calendar-link <uid>  print public Google/device links (expire in 24h)",
  "",
  "Your own events appear in Baxter's calendar; `poll`/`agenda` READ the family's calendar.",
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
    // an unparseable date silently vanishes from agenda and crashes `list` for the whole
    // store (Invalid time value), so refuse it here with a clear message.
    const badDate = (v: string): boolean => {
      if (!allDay) return Number.isNaN(new Date(v).getTime());
      try { civilDateOrThrow(v); return false; } catch { return true; }
    };
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
    // Delegates to the ONE shared refresh (calendar-refresh.ts, T8): the same
    // poll + only-overwrite-when-a-feed-succeeded guard as before, but now
    // cross-process serialized by the dedicated refresh lock shared with Home's
    // polls and the digest. Lock-busy is the one new failure mode: print a
    // kept-previous-cache degradation line (plus the error detail) and rethrow so
    // the entry-level catch below exits nonzero -- the cache is never written on
    // that path.
    try {
      const res = await refreshCalendars({ fetchFn: fetch as FetchLike });
      if (res.urls.length === 0) { console.log("no feeds configured in calendar/feeds.json -- nothing to poll"); return; }
      const status = res.wroteCache ? `${res.events.length} events cached` : "ALL feeds failed -- kept the previous cache";
      console.log(`polled ${res.urls.length} feed(s): ${status}${res.errors.length ? `; ${res.errors.length} error(s): ${res.errors.join("; ")}` : ""}`);
    } catch (err) {
      if (err instanceof RefreshLockError) console.log(`refresh lock busy/failed - kept the previous cache (${err.message})`);
      throw err;
    }
  } else if (cmd === "agenda") {
    if (flags.days !== undefined && (typeof flags.days !== "string" || !(Number(flags.days) > 0))) throw new Error("--days must be a positive number");
    const days = typeof flags.days === "string" ? Number(flags.days) : 7;
    const own = readEvents(CALENDAR_EVENTS_PATH);
    let family: VEvent[] = [];
    try { family = (JSON.parse(readFileSync(CALENDAR_CACHE_PATH, "utf8")) as { events: VEvent[] }).events ?? []; } catch { /* no cache yet */ }
    console.log(formatAgenda(buildAgenda(own, family, Date.now(), days)));
  } else if (cmd === "ics") {
    if (positionals.length === 0) throw new Error("usage: calendar-cli ics <uid...>");
    const wanted = new Set(positionals);
    const evs = readEvents(CALENDAR_EVENTS_PATH).filter((e) => wanted.has(e.uid));
    if (evs.length === 0) throw new Error(`no stored event(s) matching ${positionals.join(", ")}`);
    process.stdout.write(buildIcs(evs.map(toCalEvent)));
  } else if (cmd === "get-add-to-calendar-link") {
    if (positionals.length !== 1 || Object.keys(flags).length !== 0) {
      throw new Error("usage: calendar-cli get-add-to-calendar-link <uid>");
    }
    for (const line of await getAddToCalendarLink(positionals[0])) console.log(line);
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
