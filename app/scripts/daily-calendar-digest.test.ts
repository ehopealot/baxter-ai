// Tests for the daily-calendar-digest system task handler (system-scheduled-tasks
// plan, T11): refresh -> select -> no-event short circuit -> ONE tool-less bounded
// generation under a pre-reservation -> individual SMS-then-same-contact-email
// delivery -> one-pass completion. Every seam is injected (refreshImpl, runAgentImpl,
// sendSmsImpl, sendNewImpl) against temp calendar/allowlist paths -- no network, no
// model, no provider. Pins the round-5 invariants: the NORMAL path consumes the
// refresh result's selection-ready familySnapshot and NEVER re-reads
// family-cache.json after the refresh returns (the refresh-throw degradation path
// is the handler's ONLY cache read), allowedTools is the LITERAL
// EMPTY STRING (the zero-tool representation T16 pinned), reservation happens AFTER
// refresh/read/selection and strictly BEFORE runAgent, out-of-tokens refunds exactly
// its own token, empty/hard-failed generations keep the reservation consumed, and
// delivered text is always bounded to at most 2,000 characters ending in an ellipsis
// (whitespace-boundary preference with an unbroken-token hard cut that never splits
// a surrogate pair).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dailyCalendarDigestDefinition, buildDigestPrompt, truncateForDelivery } from "./daily-calendar-digest.ts";
import type { DigestDeps } from "./daily-calendar-digest.ts";
import { RefreshLockError } from "./calendar-refresh.ts";
import type { RefreshResult } from "./calendar-refresh.ts";
import { stubFetch } from "./calendar-refresh.testkit.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { VEvent } from "./ical.ts";
import type { Allowlist } from "./allowlist.ts";
import type { Task } from "./schedule-store.ts";
import type { SystemTaskContext, SystemTaskResult } from "./system-tasks.ts";
import type { RunAgentOptions } from "./runtime.ts";

// Scenario: America/Los_Angeles (PDT = UTC-7 in August), now = Thu 2026-08-20
// 11:00 AM local (18:00Z). The digest resolves householdTz(deps.env) -- an empty env
// (no BAXTER_TZ/HEARTBEAT_TZ) yields the America/Los_Angeles fallback, so the subject
// date token is 2026-08-20.
const NOW = new Date("2026-08-20T18:00:00Z");
const FEED_URL = "https://feed.test/cal.ics";

// The claimed system record heartbeat hands the handler (T12 wires dispatch; the
// handler itself only needs the context).
const digestTask: Task = {
  id: "system:daily-calendar-digest", cron: "0 8 * * *", at: null, tz: "America/Los_Angeles",
  next_run_at: "2026-08-20T15:00:00Z", invisible_until: null, attempts: 0,
  system: { key: "daily-calendar-digest", enabled: true },
};

const stored = (o: Partial<StoredEvent>): StoredEvent =>
  ({ uid: "own@baxter", title: "T", start: "2026-08-20T15:00:00Z", created: "", updated: "", ...o });
const fam = (o: Partial<VEvent>): VEvent =>
  ({ uid: "fam@family", title: "Fam", location: null, startMs: Date.UTC(2026, 7, 20, 23, 0), endMs: null, allDay: false, rrule: null, url: null, ...o });

const okRefresh = (familySnapshot: VEvent[], urls: string[] = [FEED_URL]): DigestDeps["refreshImpl"] =>
  async (): Promise<RefreshResult> => ({ urls, ok: urls.length > 0, events: familySnapshot, errors: [], wroteCache: urls.length > 0, familySnapshot });

interface Harness {
  execute(ctxOver?: Partial<SystemTaskContext>): Promise<SystemTaskResult>;
  paths: { ownEventsPath: string; cachePath: string; feedsPath: string; allowlistPath: string; runsDir: string };
  state: {
    order: string[];
    reserved: number;
    released: string[];
    agentCalls: RunAgentOptions[];
    smsCalls: Array<{ phone: string; text: string }>;
    mailCalls: Array<{ to: string; subject: string; text: string }>;
    mailResolveRecipient: ((to: string) => string) | null;
    logs: string[];
  };
}

// Builds the definition with fake-by-default seams (each test overrides what it
// pins) and temp state paths. The DEFAULT allowlist holds one unnamed email-only
// contact (member@x.com) so successful generations always have a delivery target;
// `gen` shapes the fake runAgent / failing phones; the fake sendNew exercises the
// handler-built admission closure (resolveRecipient) exactly like the real sendNew's
// guard would.
function makeHarness(over: Partial<DigestDeps> = {}, gen: { agentText?: string; agentFail?: boolean; agentOutOfTokens?: boolean; agentRejectMessage?: string; smsFailPhones?: string[] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "digest-"));
  const paths = {
    ownEventsPath: join(dir, "events.json"),
    cachePath: join(dir, "family-cache.json"),
    feedsPath: join(dir, "feeds.json"),
    allowlistPath: join(dir, "allowlist.json"),
    runsDir: join(dir, "runs"),
  };
  writeFileSync(paths.ownEventsPath, "[]");
  writeAllowlistFile(paths.allowlistPath, { recipients: ["member@x.com"] });
  const state: Harness["state"] = {
    order: [], reserved: 0, released: [], agentCalls: [], smsCalls: [], mailCalls: [], mailResolveRecipient: null, logs: [],
  };
  const def = dailyCalendarDigestDefinition({
    ownEventsPath: paths.ownEventsPath,
    cachePath: paths.cachePath,
    feedsPath: paths.feedsPath,
    allowlistPath: paths.allowlistPath,
    runsDir: paths.runsDir,
    env: {},
    // default refresh: one qualifying family event at 4:00 PM local, so the
    // generation/delivery/truncation paths run without per-test overrides (the
    // zero-event tests replace this with an empty snapshot)
    refreshImpl: okRefresh([fam({ uid: "fam-1", title: "Family picnic", location: "Park" })]),
    runAgentImpl: async (opts) => {
      state.order.push("runAgent");
      state.agentCalls.push(opts);
      if (gen.agentRejectMessage != null) throw new Error(gen.agentRejectMessage);
      return { failed: !!gen.agentFail, outOfTokens: !!gen.agentOutOfTokens, resetsAt: null, resultText: gen.agentText ?? "Your day at a glance." };
    },
    sendSmsImpl: async (phone, text) => {
      if (gen.smsFailPhones?.includes(phone)) throw new Error(`sendblue down for ${phone}`);
      state.smsCalls.push({ phone, text });
      return { id: "sm-1" };
    },
    sendNewImpl: async (to, subject, text, d) => {
      const canonical = d.resolveRecipient!(to); // the real sendNew resolves admission first
      state.mailResolveRecipient = d.resolveRecipient ?? null;
      state.mailCalls.push({ to: canonical, subject, text });
    },
    log: (m) => { state.logs.push(m); },
    ...over,
  });
  const ctx = (o: Partial<SystemTaskContext> = {}): SystemTaskContext => ({
    now: NOW,
    reserveAgentRun: async () => { state.order.push("reserve"); state.reserved++; return { token: "tok-1" }; },
    releaseAgentRun: async (token: string) => { state.released.push(token); },
    log: (m: string) => { state.logs.push(m); },
    ...o,
  });
  return { execute: (ctxOver = {}) => def.execute(digestTask, ctx(ctxOver)), paths, state };
}

function writeCache(cachePath: string, events: VEvent[]): void {
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: NOW.toISOString(), events }, null, 2));
}

function writeAllowlistFile(allowlistPath: string, list: Partial<Allowlist>): void {
  writeFileSync(allowlistPath, JSON.stringify({ senders: [], recipients: [], version: 1, names: {}, ...list }, null, 2));
}

// ---------- (5) the no-event short circuit ----------

test("zero qualifying events: no reservation, no runAgent, no sends; completes ok with agentRun:false even while the cap window is full", async () => {
  const h = makeHarness({ refreshImpl: okRefresh([]) });
  const result = await h.execute({ reserveAgentRun: async () => null }); // cap window FULL
  assert.deepEqual(result, { ok: true, agentRun: false, detail: "no qualifying events" });
  assert.equal(h.state.reserved, 0, "a no-event digest never touches the quota");
  assert.equal(h.state.agentCalls.length, 0);
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
});

test("zero-feed normal refresh excludes family snapshot events even when the snapshot is populated", async () => {
  // familyEligible = urls.length > 0 on the normal path -- zero configured feeds must
  // drop family events regardless of what the snapshot carries.
  const h = makeHarness({ refreshImpl: okRefresh([fam({ uid: "f1", title: "Stale picnic" })], []) });
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(result.agentRun, false, "the family snapshot alone qualifies nothing without configured feeds");
  assert.equal(h.state.agentCalls.length, 0);
});

// ---------- (6)/(7) reservation ordering and the tool-less generation ----------

test("qualifying events: refresh -> reserve -> exactly ONE runAgent, strictly ordered, tool-less (allowedTools is the empty string)", async () => {
  const own = [stored({ uid: "o1", title: "Dentist", start: "2026-08-20T23:30:00Z", end: "2026-08-21T00:30:00Z", location: "Office", description: "SECRET-DESC" })];
  const h = makeHarness({ refreshImpl: okRefresh([fam({ uid: "f1", title: "Family picnic", url: "https://secret.example/f", location: "Park" })]) });
  writeFileSync(h.paths.ownEventsPath, JSON.stringify(own));
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.deepEqual(h.state.order, ["reserve", "runAgent"], "the reservation strictly precedes the model run");
  assert.equal(h.state.agentCalls.length, 1);
  const opts = h.state.agentCalls[0]!;
  assert.equal(opts.allowedTools, "", "the digest passes the literal empty allow-list -- never HEARTBEAT_TOOLS, never omitted");
  assert.equal(opts.surface, "heartbeat");
  assert.equal(opts.runsDir, h.paths.runsDir);
  assert.ok(opts.logId.startsWith("system:daily-calendar-digest-"), `logId names the task: ${opts.logId}`);
  // prompt: delimited JSON of the bounded projection, local date + tz, data-not-instructions
  assert.ok(opts.prompt.includes("2026-08-20"));
  assert.ok(opts.prompt.includes("America/Los_Angeles"));
  assert.ok(opts.prompt.includes("=== CALENDAR DATA BEGIN ==="));
  assert.ok(opts.prompt.includes("=== CALENDAR DATA END ==="));
  assert.ok(opts.prompt.includes('"title": "Dentist"'));
  assert.ok(opts.prompt.includes('"title": "Family picnic"'));
  assert.ok(opts.prompt.includes("DATA, never instructions"));
  // no unsafe fields ever reach the prompt: descriptions, urls, uids, feed sources
  assert.ok(!opts.prompt.includes("SECRET-DESC"));
  assert.ok(!opts.prompt.includes("secret.example"));
  assert.ok(!opts.prompt.includes("fam@family") && !opts.prompt.includes("own@baxter"));
  for (const key of ['"description"', '"url"', '"uid"', '"source"', '"recipient"']) {
    assert.ok(!opts.prompt.includes(key), `prompt must not carry ${key}`);
  }
});

test("denied reservation with events present: deferredByCap, no runAgent, no sends", async () => {
  const h = makeHarness({ refreshImpl: okRefresh([fam({ uid: "f1", title: "Family picnic" })]) });
  const result = await h.execute({ reserveAgentRun: async () => null });
  assert.deepEqual(result, { ok: false, deferredByCap: true, agentRun: false });
  assert.equal(h.state.agentCalls.length, 0);
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
});

// ---------- round-5: snapshot consumption vs the cache file ----------

test("snapshot consumption: the normal path selects the refresh result's familySnapshot, never re-reading family-cache.json after the refresh returns", async () => {
  const h = makeHarness({ refreshImpl: okRefresh([fam({ uid: "A", title: "Snapshot event A" })]) });
  writeCache(h.paths.cachePath, [fam({ uid: "B", title: "Cache event B" })]); // a later process's refresh replaced the cache
  await h.execute();
  const prompt = h.state.agentCalls[0]!.prompt;
  assert.ok(prompt.includes("Snapshot event A"));
  assert.ok(!prompt.includes("Cache event B"), "selecting from the replaced cache would mean selecting against a refresh in flight in another process");
});

test("refresh-lock failure degrades to the last-known cache (the handler's ONLY cache read) with eligibility from the configured feeds", async () => {
  const h = makeHarness({ refreshImpl: async () => { throw new RefreshLockError("calendar refresh lock busy/failed: held"); } });
  writeCache(h.paths.cachePath, [fam({ uid: "B", title: "Last-known event B" })]);
  writeFileSync(h.paths.feedsPath, JSON.stringify({ urls: [FEED_URL], version: 1 }));
  writeFileSync(h.paths.ownEventsPath, JSON.stringify([stored({ uid: "o1", title: "Own event", start: "2026-08-20T23:00:00Z", end: "2026-08-20T24:00:00Z" })]));
  const result = await h.execute();
  assert.equal(result.ok, true, "a refresh failure never fails the occurrence");
  assert.equal(h.state.agentCalls.length, 1);
  const prompt = h.state.agentCalls[0]!.prompt;
  assert.ok(prompt.includes("Last-known event B"), "the degradation path reads the retained cache");
  assert.ok(h.state.logs.some((l) => l.includes("refresh failed") && l.includes("lock")), "the degradation is logged");
});

test("any refresh throw degrades the same way; zero configured feeds on the degradation path excludes the cache entirely", async () => {
  const h = makeHarness({ refreshImpl: async () => { throw new Error("network unreachable"); } });
  writeCache(h.paths.cachePath, [fam({ uid: "B", title: "Cache event B" })]); // feeds.json ABSENT -> zero feeds
  writeFileSync(h.paths.ownEventsPath, JSON.stringify([stored({ uid: "o1", title: "Own event", start: "2026-08-20T23:00:00Z", end: "2026-08-20T24:00:00Z" })]));
  await h.execute();
  const prompt = h.state.agentCalls[0]!.prompt;
  assert.ok(prompt.includes("Own event"));
  assert.ok(!prompt.includes("Cache event B"), "no configured feeds -> familyEligible false even on the degradation path");
});

test("default refresh wiring keeps token-bearing feed URLs out of every captured digest daemon log", async () => {
  const secretUrl = "https://calendar.example/private.ics?token=TOP-SECRET";
  const h = makeHarness({ refreshImpl: undefined, fetchFn: stubFetch({ status: 401 }) });
  writeFileSync(h.paths.feedsPath, JSON.stringify({ urls: [secretUrl], version: 1 }));
  const result = await h.execute();
  assert.deepEqual(result, { ok: true, agentRun: false, detail: "no qualifying events" });
  assert.ok(h.state.logs.some((l) => l.includes("all 1 feed(s) failed") && l.includes("1 error(s)")), "the all-feed-failure diagnostic remains useful");
  assert.ok(h.state.logs.every((l) => !l.includes(secretUrl)), "no daemon log contains the full subscription URL");
  assert.ok(h.state.logs.every((l) => !l.includes("TOP-SECRET")), "no daemon log contains the feed token");
});

// ---------- (3) read failures ----------

test("unreadable own store fails the occurrence before any reservation: agentRun:false, nothing reserved, no model", async () => {
  const h = makeHarness();
  writeFileSync(h.paths.ownEventsPath, "{ not json"); // readEvents throws (not ENOENT)
  const result = await h.execute();
  assert.deepEqual(result, { ok: false, agentRun: false, detail: "calendar read failed" });
  assert.equal(h.state.reserved, 0);
  assert.equal(h.state.agentCalls.length, 0);
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
});

// ---------- (3)/(4) wrong-shaped own data: selection-time containment ----------

// readEvents' bare cast (calendar-store.ts) admits VALID JSON that is not a
// StoredEvent[] -- the throw then surfaces in selection (buildAgenda's own.map via
// calendar-cli.ts), not in the read. Local containment preserves the dedicated
// pre-reservation failure log/detail and explicit result; tick's generic catch would
// also default agent_run to false for this system task, but would erase that
// diagnostic specificity.

test("a valid-JSON non-array own store fails pre-reservation with agentRun:false (selection contained, never tick's catch)", async () => {
  const h = makeHarness();
  writeFileSync(h.paths.ownEventsPath, "{}"); // passes readEvents' cast; buildAgenda's own.map throws
  const result = await h.execute();
  assert.deepEqual(result, { ok: false, agentRun: false, detail: "calendar selection failed" });
  assert.equal(h.state.reserved, 0);
  assert.equal(h.state.agentCalls.length, 0);
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
  assert.ok(h.state.logs.some((l) => l.includes("calendar selection failed")), "the selection failure is logged, distinguishable from a read failure");
});

test("an own store holding null elements fails the same pre-reservation selection path", async () => {
  const h = makeHarness();
  writeFileSync(h.paths.ownEventsPath, "[null]"); // storedToVEvent/startMsOf dereference null -> throws in selection
  const result = await h.execute();
  assert.deepEqual(result, { ok: false, agentRun: false, detail: "calendar selection failed" });
  assert.equal(h.state.reserved, 0);
  assert.equal(h.state.agentCalls.length, 0);
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
});

// ---------- model seam hermeticity ----------

test("the model seam reads only the injected env: no host process.env.BAXTER_MODEL leakage (default 'sonnet')", async () => {
  const saved = process.env.BAXTER_MODEL;
  process.env.BAXTER_MODEL = "leaky-opus"; // the probe a process.env fallback would honor
  try {
    const h = makeHarness(); // injects env: {}
    await h.execute();
    assert.equal(h.state.agentCalls[0]!.model, "sonnet", "an injected env without BAXTER_MODEL must not inherit the host's");
  } finally {
    if (saved === undefined) delete process.env.BAXTER_MODEL;
    else process.env.BAXTER_MODEL = saved;
  }
});

// ---------- (8) generation result handling ----------

test("empty/whitespace generation output is a hard failure BEFORE delivery, with the reservation consumed", async () => {
  for (const empty of ["", "   \n\t "]) {
    const h = makeHarness({}, { agentText: empty });
    const result = await h.execute();
    assert.equal(result.ok, false);
    assert.equal(result.agentRun, true);
    assert.equal(result.detail, "empty generation");
    assert.deepEqual(h.state.released, [], "the reservation stays consumed");
    assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
  }
});

test("hard generation failure: ok:false agentRun:true with the reservation consumed and no sends", async () => {
  const h = makeHarness({}, { agentFail: true });
  const result = await h.execute();
  assert.equal(result.ok, false);
  assert.equal(result.agentRun, true);
  assert.deepEqual(h.state.released, []);
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
});

test("rejected generation invocation is contained as a hard failure after reservation with truthful agentRun state", async () => {
  const h = makeHarness({}, { agentRejectMessage: "provider transport exploded with verbose internals" });
  const result = await h.execute();
  assert.deepEqual(result, { ok: false, agentRun: true, detail: "generation failed" });
  assert.deepEqual(h.state.order, ["reserve", "runAgent"], "reservation and invocation both occurred before containment");
  assert.equal(h.state.reserved, 1);
  assert.deepEqual(h.state.released, [], "a rejected invocation keeps the reservation consumed like any hard generation failure");
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
});

test("out-of-tokens generation releases exactly its own token and keeps free-retry", async () => {
  const h = makeHarness({}, { agentOutOfTokens: true });
  const result = await h.execute();
  assert.deepEqual(result, { ok: false, outOfTokens: true, agentRun: true });
  assert.deepEqual(h.state.released, ["tok-1"], "a provider outage never burns cap");
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
});

// ---------- (8) truncation to the 2,000-character delivery bound ----------

test("a >2000-char generation with whitespace is truncated at the last whitespace at-or-before the limit, ending in a single ellipsis", async () => {
  // word boundary at index 1990; the next word runs past the limit
  const text = "w".repeat(1990) + " " + "x".repeat(500);
  const h = makeHarness({}, { agentText: text });
  await h.execute();
  const delivered = h.state.mailCalls[0]!.text; // the default contact is email-only
  assert.equal(delivered, "w".repeat(1990) + "…");
  assert.ok(delivered.length <= 2000);
  assert.ok(delivered.endsWith("…"));
});

test("an unbroken >2000-char token is hard-cut at 1,999 code units, backing off past a surrogate pair, and still ends in the ellipsis", async () => {
  // indices 1998/1999 hold one surrogate pair: cutting at 1999 would split it
  const text = "x".repeat(1998) + "😀".repeat(60);
  const h = makeHarness({}, { agentText: text });
  await h.execute();
  const delivered = h.state.mailCalls[0]!.text;
  assert.equal(delivered, "x".repeat(1998) + "…");
  assert.ok(delivered.length <= 2000);
});

test("an unbroken ASCII token cuts at exactly 1,999 code units + ellipsis (2,000 total); text within the bound passes through untouched", () => {
  const delivered = truncateForDelivery("a".repeat(1999) + "b".repeat(101));
  assert.equal(delivered.length, 2000);
  assert.ok(delivered.endsWith("…"));
  assert.equal(truncateForDelivery("short text"), "short text");
});

// ---------- (9) delivery ----------

test("delivery: SMS success suppresses the same contact's email", async () => {
  const h = makeHarness();
  writeAllowlistFile(h.paths.allowlistPath, {
    senders: ["+15550001111"],
    recipients: ["dana@x.com"],
    names: { "dana@x.com": "Dana Lee", "+15550001111": "Dana Lee" },
  });
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(h.state.smsCalls.length, 1);
  assert.equal(h.state.smsCalls[0]!.phone, "+15550001111");
  assert.equal(h.state.mailCalls.length, 0, "the successful SMS suppressed the email fallback");
});

test("delivery: a failed first phone followed by a successful second phone reports SMS fallback and suppresses email", async () => {
  const h = makeHarness({}, { smsFailPhones: ["+15550001111"] });
  writeAllowlistFile(h.paths.allowlistPath, {
    senders: ["+15550001111", "+15550002222"],
    recipients: ["dana@x.com"],
    names: { "dana@x.com": "Dana Lee", "+15550001111": "Dana Lee", "+15550002222": "Dana Lee" },
  });
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.deepEqual(h.state.smsCalls.map((call) => call.phone), ["+15550002222"], "the second phone delivered after the first failed");
  assert.equal(h.state.mailCalls.length, 0, "the successful second SMS suppressed email");
  assert.ok(h.state.logs.some((l) => l.includes("Dana Lee delivered via SMS fallback") && l.includes("+15550001111")), "the fallback log names SMS as the successful channel");
  assert.ok(!h.state.logs.some((l) => l.includes("Dana Lee delivered via email fallback")), "a later-phone success is never misreported as email");
});

test("delivery: SMS failure falls back only to the SAME contact's email, with the EXACT literal subject", async () => {
  const h = makeHarness({}, { smsFailPhones: ["+15550001111"] });
  writeAllowlistFile(h.paths.allowlistPath, {
    senders: ["+15550001111"],
    recipients: ["dana@x.com"],
    names: { "dana@x.com": "Dana Lee", "+15550001111": "Dana Lee" },
  });
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(h.state.smsCalls.length, 0, "the failing SMS sent nothing");
  assert.equal(h.state.mailCalls.length, 1);
  assert.equal(h.state.mailCalls[0]!.to, "dana@x.com");
  // the EXACT literal subject: U+2019 right single quote + em dash + the date localized in the digest tz
  assert.equal(h.state.mailCalls[0]!.subject, "What’s on the calendar today — 2026-08-20");
  assert.ok(h.state.logs.some((l) => l.includes("Dana Lee delivered via email fallback") && l.includes("+15550001111")), "the fallback log names email as the successful channel");
});

test("delivery: one contact's total failure never blocks another contact; the occurrence still completes ok", async () => {
  // Dana: phone fails, email succeeds (fallback). Sam: phone-only, SMS fails -> total failure.
  const h = makeHarness({}, { smsFailPhones: ["+15550002222", "+15550003333"] });
  writeAllowlistFile(h.paths.allowlistPath, {
    senders: ["+15550002222", "+15550003333"],
    recipients: ["dana@x.com"],
    names: { "dana@x.com": "Dana Lee", "+15550002222": "Dana Lee", "+15550003333": "Sam Ray" },
  });
  const result = await h.execute();
  assert.equal(result.ok, true, "a per-contact failure never fails the occurrence");
  assert.equal(h.state.mailCalls.length, 1);
  assert.equal(h.state.mailCalls[0]!.to, "dana@x.com", "Dana's email fallback delivered");
  assert.equal(h.state.smsCalls.length, 0);
  assert.ok(h.state.logs.some((l) => l.includes("delivery failed") && l.includes("Sam Ray")), "Sam's total failure is logged");
});

test("delivery: the email path validates against the INJECTED fresh allowlist (the resolveRecipient closure revalidates)", async () => {
  const h = makeHarness({}, { smsFailPhones: ["+15550001111"] });
  writeAllowlistFile(h.paths.allowlistPath, {
    senders: ["+15550001111"],
    recipients: ["dana@x.com"],
    names: { "dana@x.com": "Dana Lee", "+15550001111": "Dana Lee" },
  });
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(h.state.mailCalls.length, 1, "a contact present in the injected snapshot is emailed");
  const resolve = h.state.mailResolveRecipient;
  assert.ok(resolve, "sendNew received the handler-built resolveRecipient closure");
  assert.equal(resolve!("dana@x.com"), "dana@x.com");
  writeAllowlistFile(h.paths.allowlistPath, {
    recipients: ["sam@x.com"],
    names: { "sam@x.com": "Sam Ray" },
  });
  // The same captured closure sees the fresh snapshot and refuses the removed contact.
  assert.throws(() => resolve!("dana@x.com"), /not on the allow-list/);
});

test("delivery: zero resolvable contacts completes with a config-failure log (the generation is not re-run)", async () => {
  const h = makeHarness();
  writeAllowlistFile(h.paths.allowlistPath, {}); // no admitted members, no operator pair
  const result = await h.execute();
  assert.equal(result.ok, true, "a configuration failure never re-runs the occurrence");
  assert.equal(result.agentRun, true, "the generation already happened");
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 0);
  assert.ok(h.state.logs.some((l) => l.includes("no resolvable contacts")), "the config failure is logged");
  assert.ok(result.detail!.includes("no resolvable contacts"));
});

test("delivery: a merged operator contact receives at most ONE delivery", async () => {
  const h = makeHarness({ env: { OPERATOR_PHONE: "+15550006666", OPERATOR_EMAIL: "op@x.com" } });
  writeAllowlistFile(h.paths.allowlistPath, {
    senders: ["+15550006666"],
    recipients: ["op@x.com"],
    names: { "op@x.com": "Erik Hope" },
  });
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(h.state.smsCalls.length + h.state.mailCalls.length, 1, "exactly one delivery for the merged contact");
  assert.equal(h.state.smsCalls.length, 1, "SMS-first");
  assert.equal(h.state.mailCalls.length, 0, "the SMS success suppressed the email");
});

// T10 rule 3's collision path INTEGRATED through delivery: two DISTINCT recipient
// addresses whose cleaned nickname collides never pair with any phone and never
// collapse into one delivery -- each delivers independently as an email-only contact
// (the acceptance clause "duplicate-nickname contacts deliver independently").
test("delivery: duplicate-nickname contacts deliver independently -- one sendNew per address, SMS never attempted", async () => {
  const h = makeHarness();
  writeAllowlistFile(h.paths.allowlistPath, {
    recipients: ["dana@x.com", "dlee@x.com"], // two DISTINCT addresses...
    names: { "dana@x.com": "Dana Lee", "dlee@x.com": "Dana Lee" }, // ...sharing one cleaned nickname, no same-name phone
  });
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.equal(h.state.smsCalls.length, 0, "rule-3 contacts are email-only -- no phone candidates exist to try");
  assert.equal(h.state.mailCalls.length, 2, "each collision member delivers independently, never collapsed into one send");
  // deterministic order: the two contacts tie on name and tie-break lexicographically by address
  assert.deepEqual(h.state.mailCalls.map((c) => c.to), ["dana@x.com", "dlee@x.com"]);
  assert.ok(!h.state.logs.some((l) => l.includes("unresolved phone")), "no phone candidates -> no unresolved-phone warning");
});

// The handler's resolver-warning contract (step 9): a resolveRecipients result with
// unpairedOperatorPair true OR unresolvedPhones non-empty logs via ctx.log EXACTLY
// ONCE per occurrence, and the occurrence still completes ok. One allowlist + env
// produces BOTH flags at once: the "Dana Lee" nickname collision strands its phone in
// unresolvedPhones (rule 3), while OPERATOR_EMAIL/OPERATOR_PHONE sit in two DIFFERENT
// resolved contacts (a rule-3 email-only contact and Sam Ray's rule-2 contact) so the
// pair stays unmerged (rule 4b).
test("delivery: unresolvedPhones and unpairedOperatorPair each log exactly once per occurrence; the occurrence still completes ok", async () => {
  const h = makeHarness({ env: { OPERATOR_PHONE: "+15550001111", OPERATOR_EMAIL: "dana@x.com" } });
  writeAllowlistFile(h.paths.allowlistPath, {
    senders: ["+15550009999", "+15550001111"],
    recipients: ["dana@x.com", "dlee@x.com", "sam@x.com"],
    names: {
      "dana@x.com": "Dana Lee", "dlee@x.com": "Dana Lee", "+15550009999": "Dana Lee", // rule-3 collision strands +15550009999
      "sam@x.com": "Sam Ray", "+15550001111": "Sam Ray",
    },
  });
  const result = await h.execute();
  assert.equal(result.ok, true, "resolver warnings never fail the occurrence");
  assert.equal(result.agentRun, true);
  // each warning fires EXACTLY once -- not per contact, not per candidate
  assert.equal(h.state.logs.filter((l) => l.includes("operator phone/email pair spans two different contacts")).length, 1);
  assert.equal(h.state.logs.filter((l) => l.includes("unresolved phone(s): +15550009999")).length, 1);
  // and delivery still runs per resolved contact: the collision members email-only, the operator's rule-2 contact by SMS
  assert.equal(h.state.mailCalls.length, 2);
  assert.deepEqual(h.state.mailCalls.map((c) => c.to), ["dana@x.com", "dlee@x.com"]);
  assert.equal(h.state.smsCalls.length, 1);
  assert.equal(h.state.smsCalls[0]!.phone, "+15550001111");
});

// ---------- (10) the aggregate-only detail ----------

test("detail carries aggregate counts only -- never the generated digest body", async () => {
  const h = makeHarness({}, { agentText: "XYZZY-MARKER-9 Breakfast with the family at nine." });
  const result = await h.execute();
  assert.equal(result.ok, true);
  assert.ok(!result.detail!.includes("XYZZY-MARKER-9"));
  assert.ok(!result.detail!.includes("Breakfast"));
  assert.match(result.detail!, /\d+/); // counts
});

// ---------- buildDigestPrompt (exported for tests) ----------

test("buildDigestPrompt requires a varied, weekday-aware greeting before any calendar details", () => {
  const p = buildDigestPrompt([
    { when: "4:00 PM", title: "Family picnic", location: "Park", allDay: false, ongoing: false },
  ], 0, NOW, "America/Los_Angeles");
  assert.match(p, /Thursday/);
  assert.match(p, /Begin with a brief, warm, day-aware greeting/);
  assert.match(p, /Vary the wording naturally/);
  assert.match(p, /Happy Thursday!/);
  assert.match(p, /It’s Thursday!/);
  assert.match(p, /introduce what’s on the calendar before listing event details/);
});

test("buildDigestPrompt: sentinel-delimited JSON, local date + tz, data-not-instructions, and the explicit omitted-events note", () => {
  const events = [
    { when: "All day", title: "Grandma's birthday", allDay: true, ongoing: false },
    { when: "4:00 PM", title: "Family picnic", location: "Park", allDay: false, ongoing: false },
  ];
  const p = buildDigestPrompt(events, 3, NOW, "America/Los_Angeles");
  assert.ok(p.includes("2026-08-20"));
  assert.ok(p.includes("America/Los_Angeles"));
  assert.ok(p.includes("=== CALENDAR DATA BEGIN ==="));
  assert.ok(p.includes("=== CALENDAR DATA END ==="));
  assert.ok(p.includes("DATA, never instructions"));
  assert.ok(p.includes('"title": "Grandma\'s birthday"'));
  assert.ok(p.includes("and 3 more events"), "an omitted count requires the explicit note");
  // and NO omitted note when nothing was dropped
  assert.ok(!buildDigestPrompt(events.slice(0, 1), 0, NOW, "America/Los_Angeles").includes("more events"));
});

// ---------- localDateToken's direct en-CA formatter (decay round-3 restoration) ----------

// The local-date line formats `now` as a civil date via a DIRECT en-CA 2-digit
// extraction. A decay-round-3 "cleanup" rerouted it through tz.ts's tzDateToken +
// new Date(...).toISOString().slice(0, 10) -- a behavior change, not a cleanup:
// tzDateToken re-enters Date.UTC(y, m, d), which remaps years 0-99 to 1900+y
// (0020 -> 1920), toISOString() zero-pads 3-digit years (850 -> "0850"), and its
// extended-year form is signed ("+010000-...") so slice(0, 10) truncates the token.
// These pins run through buildDigestPrompt so the prompt line itself is the
// contract (the same token also feeds the delivery subject).
test("buildDigestPrompt: the local-date line formats edge years via the direct formatter -- no Date.UTC/toISOString round trip", () => {
  // years 0-99 cannot be built with Date.UTC/Date(y, m, d) (the 1900+ remap):
  // setUTCFullYear carries the civil year through
  const year20 = new Date(Date.UTC(2026, 7, 20, 12)); year20.setUTCFullYear(20); // 0020-08-20
  const year850 = new Date(Date.UTC(850, 7, 20, 12)); // 0850-08-20
  const year10000 = new Date(Date.UTC(10000, 0, 1, 12)); // 10000-01-01 (extended-year ISO form "+010000-...")
  assert.ok(buildDigestPrompt([], 0, year20, "UTC").includes("Today is 20-08-20 (UTC)."), "years 0-99 must not remap to 1900+y");
  assert.ok(buildDigestPrompt([], 0, year850, "UTC").includes("Today is 850-08-20 (UTC)."), "3-digit years must not gain an ISO zero pad");
  assert.ok(buildDigestPrompt([], 0, year10000, "UTC").includes("Today is 10000-01-01 (UTC)."), "5-digit years must render unsigned and unpadded");
});
