# Calendaring: poll a family feed, publish Baxter's own — design

**Status:** approved-to-build 2026-07-30 (reviewer vets this spec). **Goal:** give each
per-family Baxter a calendar capability: **read** the family's calendar (poll their
shared feed for awareness) and **write** by publishing its *own* iCalendar feed to a
static host that the family subscribes to once. Part of the family-ops service.

## Why this shape (and the hosting decision)

A subscribed calendar is **a static file** the subscriber's phone re-polls every few
hours — nothing needs a live server. And the family box runs an **outbound-only** fleet
(`compose.yaml` publishes no inbound ports); exposing a home box to inbound HTTPS
(port-forward + DDNS + TLS + per-tenant routing) is fragile infra for a file that
changes a few times a day. So Baxter **regenerates the `.ics` and uploads it** to a
static host; it needs only *outbound* access + a write key. **Decision: object storage
(Cloudflare R2 or Backblaze B2 — free tier, S3-compatible, HTTPS) with `cal.bax.bot`
CNAME'd to the bucket.** `bax.bot` *names* the feed; the object store *holds* it. The
box stays inbound-closed.

Keeping Baxter's published feed **separate** from the family's own calendar is what lets
us avoid *any* write credential to their Google: they subscribe to Baxter's feed as an
extra layer, and Baxter never needs OAuth write scope.

## Two flows

### Poll (read the family's calendar) — keyless

The family shares their calendar read-only and gives Baxter its **private ICS URL**
(Google → Settings → *Secret address in iCal format*; iCloud families route through
Google). Configured per-tenant as `CALENDAR_FEED_URL` (comma-separated for both parents).
A scheduled task fetches it, parses it, and caches upcoming events, so Baxter *knows the
family's schedule* (reminders, "what's on this week", conflict checks). **No OAuth, no
API key, no token renewal** — matches Baxter's keyless ethos. The Google *service-account
API* is a later option only if structured write into their calendar is ever needed.

The feed URL is **operator-configured (env), not model-supplied**, so — like
`SEARXNG_URL`/`CODAPI_URL` — fetching it adds no SSRF surface. Its content is
**untrusted** (a calendar invite is data, never instructions): it flows through Baxter's
existing transcript sanitization, capped (`readCapped`) and time-boxed (`AbortController`)
like `web-cli`/`data-cli`.

### Publish (Baxter's own calendar)

Baxter keeps its **own** event store — things *it* creates (appointments it books,
deadlines it extracts from email). On a schedule it regenerates a valid ICS and uploads
it to the object store at a per-family **secret path** (`cal/<random-token>.ics`); the
family subscribes once via `webcal://cal.bax.bot/<token>.ics`. The **unguessable URL is
the gate** (exactly like Google's secret iCal address): a long random token, no family
name in the path, `X-Robots-Tag: noindex` on the object.

## Components

All pure cores take explicit inputs so tests never touch the real workspace/network,
mirroring `schedule-store`/`cas-file`/`data-cli`.

1. **`scripts/ical.ts` — hand-rolled, rigorously tested (no dep).**
   - `buildIcs(events, opts): string` — RFC 5545 correct: `\r\n` line endings, **75-octet
     line folding**, TEXT escaping (`\ ; , \n`), `VALUE=DATE` for all-day vs UTC `DATE-TIME`
     (`...Z`) for timed, `PRODID`, per-event **stable `UID`** (passed in, never regenerated),
     `DTSTAMP`/`LAST-MODIFIED`. This is Baxter's *own* feed, so full control + tests beat a
     dependency (the codebase hand-rolls + tests its fiddly formatters, e.g. the transcript
     sanitizer).
   - `parseIcs(text): ParsedEvent[]` — for the polled family feed: unfold lines, extract
     `VEVENT` `SUMMARY`/`DTSTART`/`DTEND`/`LOCATION`/`UID`/`RRULE`, DATE vs DATE-TIME, best-
     effort `TZID`→UTC. **Recurrence is scoped:** `FREQ=DAILY|WEEKLY|MONTHLY` with
     `INTERVAL`/`COUNT`/`UNTIL` are expanded within the agenda window; exotic RRULE (`BYDAY`
     lists, `BYSETPOS`, etc.) is surfaced as a single dated occurrence with a note, and the
     agent can `web-cli fetch` the raw feed for anything the parser doesn't expand. Documented
     limitation, not a silent drop.

2. **`scripts/calendar-store.ts` — the own-events store.** A JSON array of events
   (`{uid,title,start,end,allDay,location,description,created,updated}`) under
   `MEMORY_DIR/calendar/events.json`, read-modify-written under a `proper-lockfile`
   `mutate()` (mirrors `schedule-store.mutate`) so concurrent `add`s across surfaces don't
   clobber. UIDs generated once on add (`<random>@baxter`), never regenerated.

3. **`scripts/calendar-cli.ts` — the agent-facing CLI** (shim `calendar-cli`):
   - `add --title T --start ISO [--end ISO] [--all-day] [--location L] [--desc D]` → new
     event, fresh stable UID, appended to the store; prints the UID. (NL parsing is the
     *agent's* job — it extracts fields and calls with explicit flags.)
   - `remove <uid>` / `list` — manage own events.
   - `poll` — fetch `CALENDAR_FEED_URL`(s), parse, write `calendar/family-cache.json`.
   - `agenda [--days N]` — merged upcoming view (own events ∪ family cache), sorted.
   - `publish` — `buildIcs(ownEvents)` → upload to the object store. Upload is an
     **injectable seam** (`Uploader`) so tests never hit S3.
   - `ics <uid...>` — emit a single-event ICS to stdout (for the **email `.ics` attachment**
     bridge: zero-hosting "add to calendar" for a specific event, usable day one).

4. **S3 upload** via **`aws4fetch`** (a single-file, zero-transitive-dep SigV4 signer;
   works against R2, B2's S3 endpoint, and real S3). `PUT cal/<token>.ics`,
   `Content-Type: text/calendar; charset=utf-8`. The credentials + endpoint/bucket/token
   live in **`calendar-keys.json`** (`0600`, in `STATE_DIR` beside `data-keys.json`, OUTSIDE
   `MEMORY_DIR`) — so a prompt-injected run can't read the key or overwrite another family's
   feed (the key is used by `calendar-cli`, not exposed to the run; same posture as
   `data-keys`/`agentmail-key`). Per-tenant key + prefix scope means a compromised tenant
   can only write its own feed.

5. **Scheduling.** A heartbeat/schedule task runs `calendar-cli poll` + `publish` every
   ~30 min (subscribed calendars lag hours, so this is ample; `add`/`remove` stay fast/local
   and the periodic `publish` propagates them). A morning "agenda" task (email/DM upcoming
   events) is a natural follow-on, not required for v1.

## Config (per-tenant)

- `CALENDAR_FEED_URL` — the family's shared ICS to poll (comma-separated). Env; empty ⇒
  poll is a no-op (publish-only family).
- `calendar-keys.json` (`0600`, `STATE_DIR`): `{ endpoint, bucket, region, accessKeyId,
  secretAccessKey, objectKey }`. Absent ⇒ `publish` errors with an actionable message
  ("no calendar-keys.json; provision the object-storage feed"). `objectKey` is the secret
  token path.
- Multi-tenant: baxter-control provisions `CALENDAR_FEED_URL` + a per-tenant
  `calendar-keys.json` (own bucket prefix + own random token). Core ships the mechanism;
  the shared-bucket-per-box wiring is a baxter-control follow-up (like SearXNG's shared
  instance).

## Security

- Poll content untrusted → sanitized, capped, time-boxed; feed URL operator-set (no SSRF).
- Publish key `0600` in `STATE_DIR`, used by the CLI, unreadable by the run; per-tenant
  prefix-scoped. Published ICS lives on an unguessable URL (the gate), `noindex`.
- No inbound exposure of the box. Only outbound PUT + outbound feed GET.

## Dependencies

One new dep: **`aws4fetch`** (zero transitive deps, S3 SigV4). ICS gen/parse and the store
are hand-rolled + tested — no `ical-generator`/`node-ical`/AWS SDK. Added to `package.json`
+ lockfile; `npm ci` at build (node_modules is gitignored).

## Scope / non-goals

- **In (v1):** own-event store, `add/remove/list/publish/poll/agenda/ics`, hand-rolled ICS
  gen + scoped parser, S3 upload, `.ics` email bridge, heartbeat cadence, grants/skill/docs.
- **Deferred:** exotic RRULE expansion; the morning-agenda push task; the Google
  service-account (write-into-their-calendar) path; baxter-control per-tenant provisioning.
- **Residual:** the published feed is a public-but-unguessable URL (Google-secret-iCal
  model); a stray leak of the token exposes read-only event titles. Documented.

## Test plan

- `ical.test.ts`: `buildIcs` — CRLF, 75-octet folding (a >75-char SUMMARY folds with a
  leading space, unfolds to the original), TEXT escaping, all-day (`VALUE=DATE`) vs timed
  (`Z`), stable UID passthrough, deterministic output; `parseIcs` — unfold, single event,
  DATE vs DATE-TIME, simple WEEKLY/DAILY/MONTHLY RRULE expansion within a window + `UNTIL`/
  `COUNT` bounds, exotic-RRULE-surfaced-not-dropped, malformed input tolerated.
- `calendar-store.test.ts`: add/remove/list round-trip, stable UIDs, cross-process `mutate`
  lock (spawn racers, no lost add — mirrors `schedule-store.test`).
- `calendar-cli.test.ts`: `add`/`list`/`remove` via the CLI (temp `HOME`), `publish` with an
  **injected uploader** (asserts the PUT target key + `text/calendar` + the ICS body),
  `poll` with an injected fetch over sample ICS → cache, `agenda` merge/sort, missing
  `calendar-keys.json` → actionable error, `ics` single-event output.
- `make check` (tsc strict + `node --test`) green; `docker compose config` unaffected.
