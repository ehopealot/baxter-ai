// Tests for calendar-cli: config loading, publish (injected uploader), poll (injected
// fetch over sample ICS), the agenda merge/format, and a CLI round-trip (HOME pointed at
// a temp dir so the STATE_DIR store lives under it). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadKeys, feedUrls, performPublish, performPoll, buildAgenda, formatAgenda } from "./calendar-cli.ts";
import type { CalendarKeys, Uploader, FetchLike } from "./calendar-cli.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";

const CLI = fileURLToPath(new URL("./calendar-cli.ts", import.meta.url));
const KEYS: CalendarKeys = { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "cal", accessKeyId: "AK", secretAccessKey: "SK", objectKey: "tok3n.ics" };
const stored = (o: Partial<StoredEvent>): StoredEvent => ({ uid: "u@baxter", title: "T", start: "2026-08-10T15:00:00Z", created: "", updated: "", ...o });

// A partial Response double readCapped consumes (no body -> arrayBuffer fallback).
function stubFetch({ status = 200, body = "" }: { status?: number; body?: string } = {}): FetchLike {
  return (async () => ({ status, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(body).buffer })) as unknown as FetchLike;
}

test("feedUrls splits a comma-separated CALENDAR_FEED_URL, trimming + dropping empties", () => {
  assert.deepEqual(feedUrls({ CALENDAR_FEED_URL: " https://a/x.ics , https://b/y.ics ,, " }), ["https://a/x.ics", "https://b/y.ics"]);
  assert.deepEqual(feedUrls({}), []);
});

test("loadKeys reads a valid file and errors clearly on missing file / missing field", () => {
  const d = mkdtempSync(join(tmpdir(), "calk-"));
  const good = join(d, "calendar-keys.json");
  writeFileSync(good, JSON.stringify(KEYS));
  assert.deepEqual(loadKeys(good).objectKey, "tok3n.ics");
  assert.throws(() => loadKeys(join(d, "nope.json")), /no calendar-keys\.json/);
  const bad = join(d, "bad.json");
  writeFileSync(bad, JSON.stringify({ endpoint: "e", bucket: "b" }));
  assert.throws(() => loadKeys(bad), /missing "accessKeyId"/);
});

test("performPublish uploads an ICS of only live events (old ones dropped), returning the count", async () => {
  const captured: string[] = [];
  const upload: Uploader = async (_k, body) => { captured.push(body); };
  const now = new Date("2026-08-01T00:00:00Z");
  const events = [stored({ uid: "future@baxter", title: "Soon", start: "2026-08-10T15:00:00Z" }), stored({ uid: "old@baxter", title: "OldOne", start: "2026-06-01T15:00:00Z" })];
  const res = await performPublish(events, KEYS, upload, now);
  assert.equal(res.count, 1); // June event is >30d before Aug 1 -> dropped
  assert.equal(res.objectKey, "tok3n.ics");
  assert.match(captured[0], /SUMMARY:Soon/);
  assert.doesNotMatch(captured[0], /OldOne/);
  assert.match(captured[0], /BEGIN:VCALENDAR/);
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

test("buildAgenda merges own + family occurrences, sorted, source-tagged; formatAgenda renders both", () => {
  const own: StoredEvent[] = [stored({ uid: "o1", title: "Dentist", start: "2026-08-05T15:00:00Z" })];
  const family: VEvent[] = [{ uid: "f1", title: "Soccer", location: "Park", startMs: Date.UTC(2026, 7, 4, 14), endMs: null, allDay: false, rrule: null }];
  const items = buildAgenda(own, family, Date.UTC(2026, 7, 1), 10);
  assert.deepEqual(items.map((i) => [i.source, i.title]), [["family", "Soccer"], ["own", "Dentist"]]); // Aug 4 before Aug 5
  const txt = formatAgenda(items);
  assert.match(txt, /\[family\] Soccer @ Park/);
  assert.match(txt, /\[baxter\] Dentist/);
  assert.equal(formatAgenda([]), "(nothing scheduled in that window)");
});

test("buildAgenda keeps an own all-day event visible in the afternoon of its own day", () => {
  const own: StoredEvent[] = [stored({ uid: "bday", title: "Birthday", start: "2026-08-04", allDay: true, end: undefined })];
  const items = buildAgenda(own, [], Date.UTC(2026, 7, 4, 15, 0, 0), 7); // 3pm on Aug 4
  assert.deepEqual(items.map((i) => i.title), ["Birthday"]);
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

test("CLI add requires --title and --start; publish without keys errors actionably", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const bad = run(home, ["add", "--title", "NoStart"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /requires --title and --start/);
  const pub = run(home, ["publish"]);
  assert.equal(pub.status, 1);
  assert.match(pub.stderr, /no calendar-keys\.json/);
});

test("CLI add rejects an unparseable --start (an LLM's `tomorrow`) instead of poisoning the store", () => {
  const home = mkdtempSync(join(tmpdir(), "calcli-"));
  const r = run(home, ["add", "--title", "Bad", "--start", "tomorrow"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid --start/);
  assert.match(run(home, ["list"]).stdout, /no events yet/); // nothing stored, list still fine
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
  const r = spawnSync(process.execPath, [CLI, "poll"], { encoding: "utf8", env: { ...process.env, HOME: home, CALENDAR_FEED_URL: "http://127.0.0.1:9/x.ics" } });
  assert.match(r.stdout, /ALL feeds failed/);
  assert.equal(JSON.parse(readFileSync(cache, "utf8")).events[0].title, "Soccer"); // preserved
});
