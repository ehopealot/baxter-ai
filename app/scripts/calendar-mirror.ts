// Calendar mirror for the family-home surface (spec: docs/superpowers/plans/2026-08-06-
// home-calendar.md Task C2; rationale: docs/superpowers/specs/2026-08-06-home-calendar-
// design.md). Pure/injectable helpers wired into the EXISTING home daemon (home-bot.ts)
// as a THIRD HomeLink connection alongside the checklist and recipes links -- no new
// compose profile/process (same "structurally like the checklist link" rationale
// recipes-mirror.ts's own header gives).
//
// Unlike recipes (index+pull), calendar rides the CHECKLIST's whole-view push transport:
// a single small bounded 7-day window, republished wholesale on every change via
// sendChanged/onPull, plus the link's Command down-channel for a `calendar-refresh`
// request. Read-only otherwise -- no down-direction intent traffic (no event create/
// edit/delete from home), so like recipes-mirror.ts this file has no intent type, no
// isIntentLike validator, no handleIntent.
//
// Split into its own file for the same reason recipes-mirror.ts is: keep home-bot.ts's
// daemon-lifecycle file focused, and keep each export pure/injectable and easy to pin in
// isolation.
import { mkdirSync, readFileSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, basename } from "node:path";
import { AwsClient } from "aws4fetch";
import type { WebSocketLike } from "./home-link.ts";
import type { HomeKeys } from "./home-mirror.ts";
import { readEvents } from "./calendar-store.ts";
import type { StoredEvent } from "./calendar-store.ts";
import { buildAgenda, toCalEvent } from "./calendar-cli.ts";
import type { AgendaItem } from "./calendar-cli.ts";
import { buildIcs } from "./ical.ts";
import type { VEvent } from "./ical.ts";
import { CALENDAR_EVENTS_PATH, CALENDAR_CACHE_PATH } from "./paths.ts";
import { logErr } from "./runtime.ts";

// ---------- wire type (the mirrored contract; defined LOCALLY, not imported from the
// worker's own copy -- core and the DO are separate repos/deploys, matching every other
// link's own local-copy discipline -- see home-link.ts's header comment) ----------

export interface CalendarViewItem {
  uid: string;
  title: string;
  start: string; // ISO; date-only (YYYY-MM-DD) for all-day
  end?: string;
  allDay?: boolean;
  location?: string;
  source: "own" | "family";
  url?: string; // family only: the feed's canonical source URL, when the feed provides one
  ics?: string; // own only: a prebuilt single-VEVENT ICS (via calendar-cli's toCalEvent + ical.ts's buildIcs)
  recurring?: boolean;
}

// `lists: []` is a required filler, not part of the real payload -- see buildCalendarView's
// own comment for why it's there. `tz` is the household timezone the WORKER renders day
// boundaries + times in, so producer (this window) and renderer agree on where a day starts.
export interface CalendarView { lists: []; items: CalendarViewItem[]; tz: string; }

// How many days ahead buildCalendarView's window covers. Widened from the spec's original 7 to
// 5 weeks so the worker can paginate week-by-week (renderCalendar's `week` param) over a window
// that already has the events -- the view is pushed wholesale, so the extra days ride the same
// snapshot rather than a per-week re-pull. The worker's max week offset (4) mirrors this.
const AGENDA_DAYS = 35;

// The household timezone the calendar day-window + rendering use. BAXTER_TZ is the repo-wide
// convention (heartbeat.ts/schedule-cli.ts/chat-title.ts), default America/Los_Angeles. Validated
// so a typo'd zone can't throw out of Intl at window-build time.
const DEFAULT_TZ = "America/Los_Angeles";
function validTz(tz: string | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}

// ---------- buildCalendarView: own events + family cache -> the merged, tz-aware window ----------

export interface CalendarViewDeps {
  ownEventsPath: string;
  cachePath: string;
  tz?: string; // household timezone; resolved via validTz (env BAXTER_TZ) when omitted
}

function defaultCalendarViewDeps(): CalendarViewDeps {
  return { ownEventsPath: CALENDAR_EVENTS_PATH, cachePath: CALENDAR_CACHE_PATH, tz: validTz(process.env.BAXTER_TZ) };
}

// Offset (ms) of `tz` from UTC at instant `atMs`, derived purely from Intl parts so it never
// depends on the container's own local TZ. Positive east of UTC.
function tzOffsetMs(tz: string, atMs: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(atMs));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  let hour = g("hour"); if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
  return Date.UTC(g("year"), g("month") - 1, g("day"), hour, g("minute"), g("second")) - atMs;
}

// Epoch ms of 00:00 in `tz` on now's tz-calendar-date -- the agenda window's floor, at the start
// of TODAY in the HOUSEHOLD's clock (not UTC), so an event earlier today isn't just outside the
// window and the worker's tz-day buckets line up with the window's edges. Two-pass so a midnight
// that lands in a DST gap/overlap resolves to the right instant.
function startOfDayMs(now: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const civilUtc = Date.UTC(g("year"), g("month") - 1, g("day")); // midnight-UTC token of the tz-calendar date
  let ms = civilUtc - tzOffsetMs(tz, civilUtc);
  ms = civilUtc - tzOffsetMs(tz, ms); // refine using the offset AT the candidate instant
  return ms;
}

// A window-boundary instant -> ISO: date-only (YYYY-MM-DD, UTC) for an all-day occurrence
// (matches CalEvent.start/StoredEvent.start's own all-day convention -- ical.ts's fmtDate
// reads the same YYYY-MM-DD prefix with no timezone shift), else a full ISO datetime.
function msToIso(ms: number, allDay: boolean): string {
  const d = new Date(ms);
  return allDay ? d.toISOString().slice(0, 10) : d.toISOString();
}

function readFamilyCache(path: string): VEvent[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { events?: VEvent[] };
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return []; // no cache yet (ENOENT) or a corrupt file -- an empty family calendar, not a crash
  }
}

// Turn one merged AgendaItem into the mirrored CalendarViewItem shape: own items carry a
// prebuilt single-event ICS (via toCalEvent -- the ONE StoredEvent -> CalEvent mapping,
// shared with calendar-cli's own `ics`/`publish` verbs); family items carry the feed's
// canonical `url`, only when the feed actually provided one.
function toViewItem(item: AgendaItem, ownByUid: Map<string, StoredEvent>): CalendarViewItem {
  const out: CalendarViewItem = {
    uid: item.uid ?? "",
    title: item.title,
    start: msToIso(item.startMs, item.allDay),
    source: item.source,
  };
  if (item.endMs != null) out.end = msToIso(item.endMs, item.allDay);
  if (item.allDay) out.allDay = true;
  if (item.location) out.location = item.location;
  if (item.recurring) out.recurring = true;
  if (item.source === "family") {
    if (item.url) out.url = item.url;
  } else {
    // Own agenda items are single occurrences (no recurrence expansion on Baxter's own
    // events -- see calendar-cli's storedToVEvent, which always sets rrule:null), so a
    // uid lookup back into the store always resolves the one underlying StoredEvent.
    const stored = item.uid ? ownByUid.get(item.uid) : undefined;
    if (stored) out.ics = buildIcs([toCalEvent(stored)]);
  }
  return out;
}

// Build the mirrored view: own events (readEvents) merged with the family feed cache
// (CALENDAR_CACHE_PATH's `{events: VEvent[]}`), via calendar-cli's own buildAgenda over a
// 7-day window starting at `now`'s local midnight. Pure/injectable over `deps` so tests
// point both paths at a hermetic tmp dir -- mirrors readEvents/buildAgenda's own
// explicit-path discipline.
//
// `lists: []` FILLER (cross-repo contract fix, home-calendar plan): the worker's
// link-protocol.ts `decode()` runs ONE shared structural gate for every view-carrying
// channel (checklist/chat/recipes/calendar) -- `Array.isArray(view.lists)`. Rather than
// widen that shared gate to also accept `.items` as an alternative proof (a prior
// attempt did this, and a review caught that it also let a malformed `{items:[]}` frame
// slip through on the checklist/chat/recipes channels instead of a loud 1003 close), the
// calendar mirror instead follows the SAME precedent chat-bot.ts/recipes-mirror.ts
// already established: send an inert `lists: []` filler alongside the real `.items`
// payload, so this channel satisfies the identical strict gate every other channel does,
// with no per-channel carve-out on the worker side.
export function buildCalendarView(now: Date = new Date(), deps: CalendarViewDeps = defaultCalendarViewDeps()): CalendarView {
  const own = readEvents(deps.ownEventsPath);
  const family = readFamilyCache(deps.cachePath);
  const tz = validTz(deps.tz);
  const fromMs = startOfDayMs(now, tz);
  const windowEndMs = fromMs + AGENDA_DAYS * 86400000; // exclusive: the start of the day after the window
  // expandInWindow's overlap check (ical.ts) is `startMs <= toMs` -- INCLUSIVE of the
  // window's upper bound, so buildAgenda hands back an occurrence that starts exactly
  // at windowEndMs (the very start of the day after the window). The worker renders
  // AGENDA_DAYS day-buckets (days 0..AGENDA_DAYS-1, paginated a week at a time), so that
  // boundary occurrence has nowhere to render -- it's invisible payload + digest churn. Filter
  // it out here, strictly less than windowEndMs. Items starting BEFORE fromMs (an
  // ongoing event that started earlier and overlaps into the window) are deliberately
  // KEPT -- the worker buckets those under day 0 (Part A's renderCalendar fix).
  const agenda = buildAgenda(own, family, fromMs, AGENDA_DAYS).filter((item) => item.startMs < windowEndMs);
  const ownByUid = new Map(own.map((e) => [e.uid, e] as const));
  return { lists: [], items: agenda.map((item) => toViewItem(item, ownByUid)), tz };
}

// ---------- calendarViewVersion (this link's own "viewVersion") ----------

// A LOCAL copy of recipes-mirror.ts's/chat-bot.ts's own `canonicalize` -- same "define
// locally per domain, don't cross-import" discipline every sibling digest follows.
// Deterministic serialization: sort object keys recursively, preserve array order.
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}
export function calendarViewVersion(view: CalendarView): string {
  return createHash("sha256").update(canonicalize(view)).digest("hex");
}

// ---------- isCalendarRefresh ----------

// Guards a `command` frame's payload before home-bot.ts acts on it -- the only action the
// calendar link's Command down-channel authorizes (spec: "no other down-channel surface").
export function isCalendarRefresh(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && !Array.isArray(payload) && (payload as { kind?: unknown }).kind === "calendar-refresh";
}

// The optional feed-URL override a poll-on-feed-add ships in the refresh payload so the
// poll doesn't race applyCalendarFeedsCommand's write of feeds.json on the separate "link"
// socket. Returns undefined (caller polls the on-disk feeds) unless the payload carries a
// string array; non-string entries are dropped (defense against a malformed frame).
export function calendarRefreshFeedUrls(payload: unknown): string[] | undefined {
  const fu = (payload as { feedUrls?: unknown } | null)?.feedUrls;
  return Array.isArray(fu) ? fu.filter((x): x is string => typeof x === "string") : undefined;
}

// ---------- SigV4-signed calendar-link connect ----------

// Mirrors recipes-mirror.ts's signedRecipesLinkConnect exactly (itself mirroring home-
// bot.ts's signedLinkConnect) but dials /calendar-link -- a DEDICATED fourth-ish socket
// (calendarLinkUpgrade/acceptCalendarLink on the worker side), separate from the
// checklist /link, chat's /chat-link, AND recipes' /recipes-link. Signed fresh on every
// dial -- see signedRecipesLinkConnect's own header comment for why this must be a
// per-call closure, not a construction-time signature. Same credential + service ("home")
// every other link uses.
export function signedCalendarLinkConnect(
  keys: HomeKeys,
  makeSocket: (url: string, headers: Record<string, string>) => WebSocketLike =
    (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike,
): () => Promise<WebSocketLike> {
  const aws = new AwsClient({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: "auto", service: "home" });
  const linkUrl = `${keys.endpoint.replace(/\/+$/, "")}/calendar-link`;
  const wssUrl = linkUrl.replace(/^http/, "ws");
  return async () => {
    const signed = await aws.sign(linkUrl, { method: "GET" });
    return makeSocket(wssUrl, {
      authorization: signed.headers.get("authorization") ?? "",
      "x-amz-date": signed.headers.get("x-amz-date") ?? "",
    });
  };
}

// ---------- fs.watch(own events file) + fs.watch(family cache file) -> changed ----------

// Same value every sibling surface's own WATCH_DEBOUNCE_MS uses -- a courtesy fold of
// repeated fs.watch events (own-events writes via calendar-store.ts's tmp+rename mutate;
// the cache writes the same way, see home-bot.ts's onCommand handler / calendar-cli's own
// `poll` verb) into one onChange() call, not a correctness requirement (calendarViewVersion
// is itself a no-op-detecting digest). A LOCAL copy, like every sibling's own copy of this
// same literal -- see recipes-mirror.ts's own WATCH_DEBOUNCE_MS comment for the "define
// locally, don't cross-import" discipline (and, here, it also sidesteps a circular import:
// home-bot.ts imports FROM this file). Exported so tests can compute boundaries off this
// value rather than a copied literal.
export const WATCH_DEBOUNCE_MS = 200;

function keepAliveFallback(): ReturnType<typeof setInterval> {
  return setInterval(() => {}, 2 ** 31 - 1);
}

// Watch BOTH the own-events file and the family-cache file (each individually, basename-
// filtered against its own directory -- mirrors home-bot.ts's watchChecklistStore, applied
// twice, since a change to EITHER file is a candidate `changed` push) and call onChange,
// leading-edge folded per WATCH_DEBOUNCE_MS SHARED across both watchers (three rapid events
// touching both files still fold into one onChange call). `watchFn`/`logErrFn` are
// injectable seams (default: the real `node:fs` watch / runtime.ts's logErr), mirroring
// watchRecipes/watchChecklistStore.
export function watchCalendar(
  ownPath: string,
  cachePath: string,
  onChange: () => void,
  watchFn: typeof watch = watch,
  logErrFn: (m: string) => void = logErr,
): { close(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Shared across BOTH watchers below, same discipline as watchRecipes/watchChecklistStore.
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  // Gates every handler below against an event arriving after close() -- see
  // watchChecklistStore's own comment (home-bot.ts) for the full rationale.
  let closed = false;

  const schedule = (): void => {
    if (closed) return;
    if (timer !== null) return; // leading-edge: a call is already pending, fold this one in
    timer = setTimeout(() => { timer = null; onChange(); }, WATCH_DEBOUNCE_MS);
    timer.unref?.();
  };

  const closers: Array<() => void> = [];
  const targets: Array<{ path: string; label: string }> = [
    { path: ownPath, label: "own-events" },
    { path: cachePath, label: "family-cache" },
  ];
  for (const { path, label } of targets) {
    const dir = dirname(path);
    const name = basename(path);
    try {
      mkdirSync(dir, { recursive: true });
      const watcher = watchFn(dir, (_event, filename) => {
        if (closed) return;
        // A null filename (platform-dependent) can't be filtered -- treat it as a possible
        // change rather than silently drop it, same tolerance watchChecklistStore gives.
        if (filename !== null && filename !== name) return;
        schedule();
      });
      watcher.on("error", (err: Error) => {
        if (closed) return;
        logErrFn(`calendar: ${label} watch died (${err.message}) -- local changes won't push a 'changed' notice until restart`);
        if (keepAlive === null) keepAlive = keepAliveFallback(); // de-dupe: only the first error needs to re-anchor
      });
      closers.push(() => watcher.close());
    } catch (err) {
      logErrFn(`calendar: could not watch the ${label} file (${(err as Error).message}) -- local changes won't push a 'changed' notice until the next reconnect`);
      if (keepAlive === null) keepAlive = keepAliveFallback();
    }
  }

  return {
    close: () => {
      closed = true;
      for (const c of closers) c();
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (keepAlive !== null) clearInterval(keepAlive);
    },
  };
}
