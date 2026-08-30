// Tests for calendar-cli: poll (injected fetch over sample ICS), the agenda merge/format,
// and a CLI round-trip (HOME pointed at a temp dir so the STATE_DIR store lives under it).
// No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { feedUrls, performPoll, buildAgenda, formatAgenda, titlesSimilar } from "./calendar-cli.ts";
import lockfile from "proper-lockfile";
import { REFRESH_LOCK_STALE_MS, refreshLockTarget } from "./calendar-refresh.ts";
import { stubFetch } from "./calendar-refresh.testkit.ts";
import type { FetchLike } from "./calendar-cli.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";

const CLI = fileURLToPath(new URL("./calendar-cli.ts", import.meta.url));
const stored = (o: Partial<StoredEvent>): StoredEvent => ({ uid: "u@baxter", title: "T", start: "2026-08-10T15:00:00Z", created: "", updated: "", ...o });

test("feedUrls reads urls from feeds.json; a missing file yields []", () => {
  const d = mkdtempSync(join(tmpdir(), "calfeeds-"));
  const missing = join(d, "feeds.json");
  assert.deepEqual(feedUrls(missing), []);
  const present = join(d, "feeds-present.json");
  writeFileSync(present, JSON.stringify({ urls: ["https://a/x.ics", "https://b/y.ics"], version: 1 }));
  assert.deepEqual(feedUrls(present), ["https://a/x.ics", "https://b/y.ics"]);
});

test("performPoll parses good feeds and captures a bad feed's error without failing the rest", async () => {
  const sample = ["BEGIN:VEVENT", "UID:x", "SUMMARY:Soccer", "DTSTART:20260804T140000Z", "END:VEVENT"].join("\r\n");
  const ok = await performPoll(["https://feed/a.ics"], stubFetch({ body: sample }));
  assert.equal(ok.events.length, 1);
  assert.equal(ok.events[0].title, "Soccer");
  assert.equal(ok.errors.length, 0);
  const bad = await performPoll(["https://feed/b.ics"], stubFetch({ status: 404 }));
  assert.equal(bad.events.length, 0);
  assert.match(bad.errors[0], /404/);
});

test("performPoll keeps detached cancellations local to their source feed when UIDs collide", async () => {
  const calendar = (cancelled: boolean) => [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:shared@google.com", "SUMMARY:Weekly appointment",
    "DTSTART:20260818T160000Z", "RRULE:FREQ=WEEKLY", "END:VEVENT",
    ...(cancelled ? ["BEGIN:VEVENT", "UID:shared@google.com", "RECURRENCE-ID:20260825T160000Z", "STATUS:CANCELLED", "END:VEVENT"] : []),
    "END:VCALENDAR",
  ].join("\r\n");
  const bodies = new Map([
    ["https://feed.test/a.ics", calendar(true)],
    ["https://feed.test/b.ics", calendar(false)],
  ]);
  const polled = await performPoll([...bodies.keys()], async (url) => new Response(bodies.get(String(url))!, { status: 200 }));
  assert.deepEqual(polled.errors, []);
  const aug25 = buildAgenda([], polled.events, Date.UTC(2026, 7, 25), 1).filter((event) => event.startMs === Date.UTC(2026, 7, 25, 16));
  assert.equal(aug25.length, 1, "feed A excludes its copy; feed B's same-UID occurrence remains");
});

test("performPoll rejects an internal-host feed URL before ever calling doFetch (pre-flight SSRF guard)", async () => {
  for (const bad of ["http://169.254.169.254/x.ics", "http://localhost/x.ics", "http://codapi/x.ics"]) {
    let called = false;
    const spy: FetchLike = (async (...args: Parameters<FetchLike>) => { called = true; return stubFetch()(...args); }) as FetchLike;
    const res = await performPoll([bad], spy);
    assert.equal(called, false, `doFetch must not be called for ${bad}`);
    assert.equal(res.events.length, 0);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], new RegExp(`^${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: refusing to fetch an internal/loopback host`));
  }
});

test("buildAgenda merges own + family occurrences, sorted, source-tagged; formatAgenda renders both", () => {
  const own: StoredEvent[] = [stored({ uid: "o1", title: "Dentist", start: "2026-08-05T15:00:00Z" })];
  const family: VEvent[] = [{ uid: "f1", title: "Soccer", location: "Park", startMs: Date.UTC(2026, 7, 4, 14), endMs: null, allDay: false, rrule: null, url: null }];
  const items = buildAgenda(own, family, Date.UTC(2026, 7, 1), 10);
  assert.deepEqual(items.map((i) => [i.source, i.title]), [["family", "Soccer"], ["own", "Dentist"]]); // Aug 4 before Aug 5
  const txt = formatAgenda(items);
  assert.match(txt, /\[family\] Soccer @ Park/);
  assert.match(txt, /\[baxter\] Dentist/);
  assert.equal(formatAgenda([]), "(nothing scheduled in that window)");
});

test("buildAgenda sets url on family items (from the feed) and not on own items", () => {
  const own: StoredEvent[] = [stored({ uid: "o1", title: "Dentist", start: "2026-08-05T15:00:00Z" })];
  const family: VEvent[] = [{ uid: "f1", title: "Soccer", location: "Park", startMs: Date.UTC(2026, 7, 4, 14), endMs: null, allDay: false, rrule: null, url: "https://cal.example.com/soccer" }];
  const items = buildAgenda(own, family, Date.UTC(2026, 7, 1), 10);
  const soccer = items.find((i) => i.title === "Soccer");
  const dentist = items.find((i) => i.title === "Dentist");
  assert.equal(soccer?.url, "https://cal.example.com/soccer");
  assert.equal(dentist?.url, null);
});

test("buildAgenda dedups an own event that came back through a feed (same uid+start), keeping the TRUSTED own copy", () => {
  // The family tapped "Add to calendar" on a Baxter event, so the linked feed now carries it with
  // the same uid + start. It must show once, as the OWN row (the feed copy is dropped) -- so a
  // hostile feed forging both can't replace Baxter's authentic record with its own title/url.
  const own: StoredEvent[] = [stored({ uid: "shared-uid@baxter", title: "Dentist", start: "2026-08-05T15:00:00Z" })];
  const family: VEvent[] = [{ uid: "shared-uid@baxter", title: "Not the dentist", location: null, startMs: Date.UTC(2026, 7, 5, 15), endMs: null, allDay: false, rrule: null, url: "https://evil.example/x" }];
  const items = buildAgenda(own, family, Date.UTC(2026, 7, 1), 10);
  assert.deepEqual(items.map((i) => [i.source, i.title]), [["own", "Dentist"]], "shows once, as the own copy -- the feed's forged title/url is dropped");
});

test("buildAgenda keeps an own event whose UID is NOT in any feed (no false dedup)", () => {
  const own: StoredEvent[] = [stored({ uid: "o1@baxter", title: "Dentist", start: "2026-08-05T15:00:00Z" })];
  const family: VEvent[] = [{ uid: "f1", title: "Soccer", location: null, startMs: Date.UTC(2026, 7, 4, 14), endMs: null, allDay: false, rrule: null, url: null }];
  const items = buildAgenda(own, family, Date.UTC(2026, 7, 1), 10);
  assert.deepEqual(items.map((i) => i.title).sort(), ["Dentist", "Soccer"], "both survive -- distinct UIDs");
});

test("buildAgenda does NOT dedup when a feed copy shares the UID but MOVED the start (fail-safe vs a hostile/edited feed)", () => {
  // Same uid, DIFFERENT startMs: a forged or family-moved copy must not suppress Baxter's own event.
  const own: StoredEvent[] = [stored({ uid: "shared@baxter", title: "Dentist", start: "2026-08-05T15:00:00Z" })];
  const family: VEvent[] = [{ uid: "shared@baxter", title: "Dentist", location: null, startMs: Date.UTC(2026, 7, 5, 9), endMs: null, allDay: false, rrule: null, url: null }];
  const items = buildAgenda(own, family, Date.UTC(2026, 7, 1), 10);
  assert.deepEqual(items.map((i) => i.source).sort(), ["family", "own"], "both survive -- the own record stays visible beside the moved copy");
});

test("buildAgenda collapses TWO identical feed copies (no own) to one row", () => {
  // Two family members each imported the same event; both feeds carry identical content.
  const dup = { uid: "ev@fam", title: "Dentist", location: "Main St", startMs: Date.UTC(2026, 7, 5, 15), endMs: Date.UTC(2026, 7, 5, 16), allDay: false, rrule: null } as const;
  const family: VEvent[] = [{ ...dup, url: "https://a.example/a.ics" }, { ...dup, url: "https://b.example/b.ics" }];
  const items = buildAgenda([], family, Date.UTC(2026, 7, 1), 10);
  assert.deepEqual(items.map((i) => i.title), ["Dentist"], "one row -- true duplicates collapse");
});

test("buildAgenda keeps two feed copies that share uid+start but DIFFER in content (conflicting info, not a dup)", () => {
  // Same uid + start, different title/duration: one member edited the imported event on their
  // device. Both must stay visible rather than one silently winning by poll order.
  const base = { uid: "ev@fam", startMs: Date.UTC(2026, 7, 5, 15), allDay: false, rrule: null, url: null } as const;
  const family: VEvent[] = [
    { ...base, title: "Dentist", location: null, endMs: Date.UTC(2026, 7, 5, 16) },
    { ...base, title: "Dentist (moved to 90 min)", location: "New office", endMs: Date.UTC(2026, 7, 5, 16, 30) },
  ];
  const items = buildAgenda([], family, Date.UTC(2026, 7, 1), 10);
  assert.deepEqual(items.map((i) => i.title).sort(), ["Dentist", "Dentist (moved to 90 min)"], "both survive -- divergent content isn't a duplicate");
});

test("buildAgenda drops the OWN copy when a DIFFERENT-uid feed event has the same start + similar title (linked calendar wins)", () => {
  // Baxter added the event to the family's Google calendar; it now returns through the linked feed
  // under Google's OWN uid. Same start, similar title -> show once, as the FEED row (Google manages it).
  const own: StoredEvent[] = [stored({ uid: "o@baxter", title: "St John's Childcare 50th Anniversary", start: "2026-08-29T15:00:00Z", location: "2727 College Ave" })];
  const family: VEvent[] = [{ uid: "google-xyz", title: "St. John's Childcare 50th Anniversary & Fundraising Celebration", location: "2727 College Ave, Berkeley", startMs: Date.UTC(2026, 7, 29, 15), endMs: null, allDay: false, rrule: null, url: "https://cal.google/x.ics" }];
  const items = buildAgenda(own, family, Date.UTC(2026, 7, 1), 40);
  assert.deepEqual(items.map((i) => i.source), ["family"], "one row, the linked-feed copy -- the own copy is hidden");
  assert.match(items[0].title, /Fundraising/, "the feed's title is what shows");
});

test("buildAgenda keeps BOTH an own and a same-title feed event when the START differs (exact-start anchor prevents a false collapse)", () => {
  const own: StoredEvent[] = [stored({ uid: "o@baxter", title: "Dentist", start: "2026-08-05T15:00:00Z" })];
  const family: VEvent[] = [{ uid: "g1", title: "Dentist", location: null, startMs: Date.UTC(2026, 7, 5, 9), endMs: null, allDay: false, rrule: null, url: null }];
  const items = buildAgenda(own, family, Date.UTC(2026, 7, 1), 10);
  assert.deepEqual(items.map((i) => i.source).sort(), ["family", "own"], "different start instants -> two distinct events");
});

test("titlesSimilar: identical / truncated / reworded titles match; unrelated ones don't", () => {
  assert.equal(titlesSimilar("Dentist", "Dentist"), true);
  assert.equal(titlesSimilar("St. John's Childcare", "St Johns Childcare"), true, "punctuation-insensitive");
  assert.equal(titlesSimilar("St John's 50th Anniversary", "St John's 50th Anniversary & Fundraising Celebration"), true, "prefix / added words");
  assert.equal(titlesSimilar("Soccer practice", "Dentist appointment"), false, "unrelated");
  assert.equal(titlesSimilar("", "Dentist"), false, "an empty title never matches a real one");
});

test("buildAgenda keeps an own all-day event visible in the afternoon of its own day", () => {
  const own: StoredEvent[] = [stored({ uid: "bday", title: "Birthday", start: "2026-08-04", allDay: true, end: undefined })];
  const items = buildAgenda(own, [], Date.UTC(2026, 7, 4, 15, 0, 0), 7); // 3pm on Aug 4
  assert.deepEqual(items.map((i) => i.title), ["Birthday"]);
});

// ---- public add-to-calendar links ----

test("get-add-to-calendar-link formats the exact public Google/device pair from one issued capability", async () => {
  const api = await import("./calendar-cli.ts") as Record<string, unknown>;
  assert.equal(typeof api.getAddToCalendarLink, "function", "calendar-cli exposes the event-link getter");
  const home = mkdtempSync(join(tmpdir(), "cal-public-link-"));
  const eventsPath = join(home, "events.json");
  writeFileSync(eventsPath, JSON.stringify([stored({
    uid: "event-1@baxter", title: "Dentist", start: "2026-08-10T15:00:00-07:00",
    end: "2026-08-10T16:00:00-07:00", location: "Main St", description: "Bring insurance card",
  })]));
  let sent: any;
  const lines = await (api.getAddToCalendarLink as Function)("event-1@baxter", {
    eventsPath,
    issue: async (issue: unknown) => {
      sent = issue;
      return { token: "a".repeat(36), expiresAt: 1, homeOrigin: "https://home.example.test", tenant: "hopefam" };
    },
  });
  assert.deepEqual(lines, [
    "Add to google calendar - https://home.example.test/calendar/add/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/google?t=hopefam",
    "Add to device calendar - https://home.example.test/calendar/add/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/device?t=hopefam",
  ]);
  assert.deepEqual(sent.event, {
    uid: "event-1@baxter", title: "Dentist", start: "2026-08-10T22:00:00.000Z",
    end: "2026-08-10T23:00:00.000Z", allDay: false, location: "Main St",
  }, "the CLI emits the normalized timed fields the public Worker accepts");
  assert.match(sent.ics, /DESCRIPTION:Bring insurance card/, "the first issuer preserves the device-calendar description snapshot");
});

test("get-add-to-calendar-link uses the signed issuer by default", async () => {
  const api = await import("./calendar-cli.ts") as Record<string, unknown>;
  const home = mkdtempSync(join(tmpdir(), "cal-public-link-default-"));
  const eventsPath = join(home, "events.json");
  writeFileSync(eventsPath, JSON.stringify([stored({ uid: "event-2@baxter", title: "Dentist" })]));
  let request: Request | undefined;
  const lines = await (api.getAddToCalendarLink as Function)("event-2@baxter", {
    eventsPath,
    issuerDeps: {
      keys: {
        endpoint: "https://home.example.test/svc/hopefam", tenant: "hopefam",
        accessKeyId: "AKIDEXAMPLE0000000000000", secretAccessKey: "s3cret-shhh-0000000000000000",
      },
      homeOrigin: "https://home.example.test",
      fetchFn: async (input: Parameters<typeof fetch>[0]) => {
        request = input instanceof Request ? input.clone() : new Request(input);
        return new Response(JSON.stringify({ token: "b".repeat(36), expiresAt: 1 }));
      },
    },
  });
  assert.deepEqual(lines, [
    "Add to google calendar - https://home.example.test/calendar/add/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/google?t=hopefam",
    "Add to device calendar - https://home.example.test/calendar/add/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/device?t=hopefam",
  ]);
  assert.ok(request);
  assert.equal(request!.url, "https://home.example.test/svc/hopefam/calendar-link");
});

test("CLI get-add-to-calendar-link prints the exact two public lines", async () => {
  const home = mkdtempSync(join(tmpdir(), "cal-public-link-cli-"));
  const state = join(home, ".mail-agent");
  mkdirSync(join(state, "calendar"), { recursive: true });
  writeFileSync(join(state, "calendar", "events.json"), JSON.stringify([stored({ uid: "event-3@baxter", title: "Dentist" })]));

  let requestPath = "";
  const server = createServer((req, res) => {
    requestPath = req.url ?? "";
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: "c".repeat(36), expiresAt: 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(state, "home-keys.json"), JSON.stringify({
    endpoint: `${origin}/svc/hopefam`, tenant: "hopefam",
    accessKeyId: "AKIDEXAMPLE0000000000000", secretAccessKey: "s3cret-shhh-0000000000000000",
  }));

  try {
    const child = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const proc = spawn(process.execPath, [CLI, "get-add-to-calendar-link", "event-3@baxter"], {
        env: { ...process.env, HOME: home, HOME_BASE_URL: origin },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(child.code, 0, child.stderr);
    assert.equal(child.stdout, [
      `Add to google calendar - ${origin}/calendar/add/${"c".repeat(36)}/google?t=hopefam`,
      `Add to device calendar - ${origin}/calendar/add/${"c".repeat(36)}/device?t=hopefam`,
      "",
    ].join("\n"));
    assert.equal(requestPath, "/svc/hopefam/calendar-link");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("toCalendarPublicLinkEvent converts an all-day stored inclusive end to the public exclusive end", async () => {
  const api = await import("./calendar-cli.ts") as Record<string, unknown>;
  assert.equal(typeof api.toCalendarPublicLinkEvent, "function", "calendar-cli exposes the shared canonicalizer");
  const normalized = (api.toCalendarPublicLinkEvent as Function)(stored({
    uid: "camp@baxter", title: "Camp", start: "2026-08-10", end: "2026-08-12", allDay: true,
  }));
  assert.deepEqual(normalized, {
    uid: "camp@baxter", title: "Camp", start: "2026-08-10", end: "2026-08-13", allDay: true,
  });
});

test("toCalendarPublicLinkEvent refuses an impossible all-day date instead of normalizing it", async () => {
  const api = await import("./calendar-cli.ts") as Record<string, unknown>;
  assert.throws(
    () => (api.toCalendarPublicLinkEvent as Function)(stored({ start: "2026-02-30", end: "2026-03-01", allDay: true })),
    /invalid all-day date/,
  );
});

// ---- CLI round-trip ----

function run(home: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  return { status: r.status ?? 0, stdout: r.stdout, stderr: r.stderr };
}

test("CLI add -> list -> ics -> remove round-trips against a temp STATE_DIR", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const add = run(home, ["add", "--title", "Dentist", "--start", "2026-08-04T15:00:00Z", "--location", "Main St"]);
  assert.equal(add.status, 0);
  const uid = JSON.parse(add.stdout).uid as string;
  assert.match(uid, /@baxter$/);
  const list = run(home, ["list"]);
  assert.match(list.stdout, /Dentist/);
  const ics = run(home, ["ics", uid]);
  assert.match(ics.stdout, /BEGIN:VCALENDAR[\s\S]*SUMMARY:Dentist[\s\S]*LOCATION:Main St/);
  assert.equal(run(home, ["remove", uid]).status, 0);
  assert.match(run(home, ["list"]).stdout, /no events yet/);
});

test("CLI add requires --title and --start; publish is not a command", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const bad = run(home, ["add", "--title", "NoStart"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /requires --title and --start/);
  const publish = run(home, ["publish"]);
  assert.equal(publish.status, 1);
  assert.match(publish.stderr, /usage:/);
  assert.doesNotMatch(publish.stderr, /publish|calendar-keys/);
});

test("CLI add rejects an unparseable --start (an LLM's `tomorrow`) instead of poisoning the store", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const r = run(home, ["add", "--title", "Bad", "--start", "tomorrow"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid --start/);
  assert.match(run(home, ["list"]).stdout, /no events yet/); // nothing stored, list still fine
});

test("CLI add rejects an impossible --all-day date instead of poisoning the stored event", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-bad-all-day-"));
  const r = run(home, ["add", "--title", "Impossible", "--all-day", "--start", "2026-02-30"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid --start/);
});

test("CLI add rejects --end before --start", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const r = run(home, ["add", "--title", "Backwards", "--start", "2026-08-06T15:00:00Z", "--end", "2026-08-04T15:00:00Z"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /before --start/);
});

test("CLI --key=value keeps a dash-leading value (add --desc=--x)", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const add = run(home, ["add", "--title", "T", "--start", "2026-08-04T15:00:00Z", "--desc=--dashes"]);
  const uid = JSON.parse(add.stdout).uid as string;
  assert.match(run(home, ["ics", uid]).stdout, /DESCRIPTION:--dashes/);
});

test("CLI poll keeps the previous cache when every feed fails (a transient outage doesn't wipe it)", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const cacheDir = join(home, ".mail-agent", "calendar");
  mkdirSync(cacheDir, { recursive: true });
  const cache = join(cacheDir, "family-cache.json");
  writeFileSync(cache, JSON.stringify({ fetchedAt: "old", events: [{ uid: "keep", title: "Soccer", location: null, startMs: 1, endMs: null, allDay: false, rrule: null }] }));
  const feeds = join(cacheDir, "feeds.json");
  writeFileSync(feeds, JSON.stringify({ urls: ["http://127.0.0.1:9/x.ics"], version: 1 }));
  const r = spawnSync(process.execPath, [CLI, "poll"], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.match(r.stdout, /ALL feeds failed/);
  assert.equal(JSON.parse(readFileSync(cache, "utf8")).events[0].title, "Soccer"); // preserved
});

// ---------- poll adoption: the shared refresh lock (system-scheduled-tasks T8) ----------

test("CLI poll degrades on a held refresh lock: kept-previous-cache line, nonzero exit, cache untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const cacheDir = join(home, ".mail-agent", "calendar");
  mkdirSync(cacheDir, { recursive: true });
  const cache = join(cacheDir, "family-cache.json");
  const prior = JSON.stringify({ fetchedAt: "old", events: [{ uid: "keep", title: "Soccer", location: null, startMs: 1, endMs: null, allDay: false, rrule: null }] });
  writeFileSync(cache, prior);
  const feeds = join(cacheDir, "feeds.json");
  writeFileSync(feeds, JSON.stringify({ urls: ["https://feed.example.com/family.ics"], version: 1 }));
  // A REAL held refresh lock on the same target (recent mtime, not stale within the
  // fixed 480s window): the CLI child exhausts its bounded acquisition retries
  // (~8s), prints the degradation line, and the entry-level catch exits nonzero.
  const target = refreshLockTarget(cache);
  const release = await lockfile.lock(target, { realpath: false, stale: REFRESH_LOCK_STALE_MS, retries: { retries: 0 } });
  let r: { status: number; stdout: string; stderr: string };
  try {
    r = run(home, ["poll"]);
  } finally {
    await release();
  }
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /refresh lock busy\/failed - kept the previous cache/);
  assert.match(r.stderr, /calendar-cli: /, "the entry-level catch carries the underlying error");
  assert.equal(readFileSync(cache, "utf8"), prior, "the cache file is byte-identical");
});
