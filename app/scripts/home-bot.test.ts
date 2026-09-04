// Tests for the family-home surface driver's lifecycle (B4): idle-if-unprovisioned is
// preserved, a provisioned tenant starts exactly one HomeLink dialing a correctly SigV4-
// signed wss://.../svc/<tenant>/link, and a local checklist-store change reaches the link
// as a 'changed' push. Light -- most logic (HomeLink's transport, wireLink's apply/ack) is
// already pinned in home-link.test.ts/home-mirror.test.ts; this file is the wiring only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { watch } from "node:fs";
import { main, signedLinkConnect, watchCollections, watchChecklistStore, WATCH_DEBOUNCE_MS, applyMembersCommand, applyCalendarFeedsCommand, removeCollectionItemCommand, deleteCollectionCommand } from "./home-bot.ts";
import type { HomeBotDeps } from "./home-bot.ts";
import type { WebSocketLike } from "./home-link.ts";
import { MAX_HOME_COLLECTION_DIRECTORY_ENTRIES, buildCollectionsView } from "./home-mirror.ts";
import type { HomeKeys } from "./home-mirror.ts";
import { deleteCollection, readCollection } from "./collections-cli.ts";
import { FakeSocketPair } from "./home-link.testkit.ts";
import lockfile from "proper-lockfile";
import { REFRESH_LOCK_STALE_MS, refreshLockTarget } from "./calendar-refresh.ts";
import { waitUntil } from "./calendar-refresh.testkit.ts";
import { saveRecipe, readRecipe, listRecipes } from "./recipes-store.ts";
import { recipesIndexVersion } from "./recipes-mirror.ts";
import { buildCalendarView, calendarViewVersion } from "./calendar-mirror.ts";
import type { FetchLike } from "./calendar-cli.ts";
import { addEvent, readEvents } from "./calendar-store.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "hb-"));

test("collection command handlers delete by displayed index and delete a whole collection through CAS", async () => {
  const dir = tmp();
  const path = join(dir, "kitchen.md");
  writeFileSync(path, JSON.stringify([{ title: "Soup", content: "S", notes: "private S" }, { title: "Salad", content: "A", notes: "private A" }]));
  const logs: string[] = [];
  await removeCollectionItemCommand({ kind: "remove-collection-item", slug: "kitchen", index: 0 }, dir, (m) => logs.push(m));
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(after, [{ title: "Salad", content: "A", notes: "private A" }]);
  await deleteCollectionCommand({ kind: "delete-collection", slug: "kitchen" }, dir, (m) => logs.push(m));
  assert.equal(existsSync(path), false);
  assert.deepEqual(logs, []);
  rmSync(dir, { recursive: true, force: true });
});

test("collection command handlers reject malformed payloads without touching sources", async () => {
  const dir = tmp();
  const path = join(dir, "kitchen.md");
  writeFileSync(path, "[]");
  const logs: string[] = [];
  await removeCollectionItemCommand({ kind: "remove-collection-item", slug: "kitchen", index: -1 }, dir, (m) => logs.push(m));
  await deleteCollectionCommand({ kind: "delete-collection", slug: 1 }, dir, (m) => logs.push(m));
  assert.equal(existsSync(path), true);
  assert.equal(logs.length, 2);
  rmSync(dir, { recursive: true, force: true });
});
// endpoint is TENANT-SCOPED, exactly as baxctl writes it (https://home.<domain>/svc/<id>) and
// as it appears in a real home-keys.json -- NOT a bare host. The link URL must be endpoint+"/link",
// never endpoint+"/svc/<tenant>/link" (that doubles the segment: .../svc/acme/svc/acme/link -> 404).
const KEYS: HomeKeys = { endpoint: "https://home.example.com/svc/acme", tenant: "acme", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-key" };

function noopWatch(): { close(): void } { return { close() {} }; }
// A recipes-link socket stub that never fires "open" -- every existing test in this file
// exercises the CHECKLIST link only and doesn't care about the recipes link at all, so
// this default just parks it "connecting" forever (harmless: HomeLink's own dial-timeout
// timer is unref'd, so it never keeps the test process alive). DELIBERATELY not `fake.client`
// from a test's own FakeSocketPair -- see HomeBotDeps.makeRecipesSocket's own comment for
// why reusing one fake wire for both links would cross-deliver their messages.
function noopRecipesSocket(): WebSocketLike { return { send() {}, close() {}, addEventListener() {} }; }
// Same rationale as noopRecipesSocket, for the calendar link's own default socket stub.
function noopCalendarSocket(): WebSocketLike { return { send() {}, close() {}, addEventListener() {} }; }
// Same rationale as noopRecipesSocket, for the schedule link's own default socket stub -- a
// socket that never fires "open", so buildScheduleView is never invoked and no test touches
// the real ~/.mail-agent/schedule/schedule.json (buildScheduleView reads that path directly).
function noopScheduleSocket(): WebSocketLike { return { send() {}, close() {}, addEventListener() {} }; }
// A fetch stub that never resolves usefully -- every existing test in this file (and every
// test that doesn't specifically exercise the calendar-refresh command) never triggers a
// poll, so this default is never actually invoked; it exists only to satisfy HomeBotDeps'
// required `fetch` field hermetically (no real network reachable even if it somehow were).
const noopFetch: FetchLike = async () => { throw new Error("fetch must not be called in this test"); };
function baseDeps(dir: string, over: Partial<HomeBotDeps> = {}): HomeBotDeps {
  return {
    loadHomeKeys: () => KEYS,
    checklistsPath: join(dir, "checklists.json"),
    statePath: join(dir, "home-state.json"),
    env: {},
    collectionsDir: join(dir, "collections"),
    watchCollections: noopWatch,
    watchChecklists: noopWatch,
    idle: () => { throw new Error("must not idle -- keys were present"); },
    log: () => {},
    logErr: () => {},
    // HERMETIC: a no-file path in the test's own temp dir, never the operator's real
    // ~/.mail-agent/home/allowlist.json (matches the noFile() pattern the other suites use).
    allowlistPath: join(dir, "allowlist.json"),
    // HERMETIC, like allowlistPath above -- a no-file path in the test's own temp dir.
    calendarFeedsPath: join(dir, "calendar-feeds.json"),
    // Recipes mirror (home-recipes plan, Task C1): HERMETIC dir + no-op watcher/socket by
    // default, like every other field above. The "recipes link: onPull ..." tests below
    // are what actually override recipesDir/makeRecipesSocket to exercise that link's
    // scope:"recipe"/scope:"index" onPull handler with a real fake-socket pair -- every
    // OTHER test in this file leaves these at their harmless defaults (a socket stub that
    // never opens, over a directory nothing ever reads from) because it's exercising the
    // checklist link instead.
    recipesDir: join(dir, "recipes"),
    watchRecipes: noopWatch,
    makeRecipesSocket: noopRecipesSocket,
    // Calendar mirror (home-calendar plan, Task C2): HERMETIC paths + no-op
    // watcher/socket/fetch by default, like every other field above. The "calendar link"
    // tests further down override these to exercise onPull/onCommand/watchCalendar wiring
    // with a real fake-socket pair.
    calendarEventsPath: join(dir, "calendar", "events.json"),
    calendarCachePath: join(dir, "calendar", "family-cache.json"),
    watchCalendar: noopWatch,
    makeCalendarSocket: noopCalendarSocket,
    calendarPollIntervalMs: 0,
    scheduleCalendarPoll: (_fn, _ms) => () => {},
    // Schedule mirror (scheduled-tasks plan, Task 6): HERMETIC path + no-op watcher/socket by
    // default, like the calendar fields above. The socket never opens, so onOpen never fires
    // and buildScheduleView is never called in the default hermetic path.
    schedulePath: join(dir, "schedule", "schedule.json"),
    watchSchedule: noopWatch,
    makeScheduleSocket: noopScheduleSocket,
    fetch: noopFetch,
    // HERMETIC default: a categorizer that throws if a test triggers it without opting in. The
    // "sort-list command" test below overrides this with a capturing fake (there is no model here).
    categorize: async () => { throw new Error("categorize must not be called in this test"); },
    // HERMETIC default: a welcome sender that throws if a test triggers it without opting in. The
    // "member-welcome command" test overrides this with a capturing fake (no Resend key here).
    welcomeSender: async () => { throw new Error("welcomeSender must not be called in this test"); },
    ...over,
  };
}

// ---------- signedLinkConnect: the SigV4-signed link URL/headers, signed fresh per dial ----------

test("signedLinkConnect targets wss://<host>/svc/<tenant>/link and signs a fresh SigV4 GET on every dial", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const stub: WebSocketLike = { send() {}, close() {}, addEventListener() {} };
  const connect = signedLinkConnect(KEYS, (url, headers) => { calls.push({ url, headers }); return stub; });

  await connect();
  await connect(); // a second dial -- proves signing happens fresh each call, not once at construction

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "wss://home.example.com/svc/acme/link");
    assert.ok(call.headers.authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/"), call.headers.authorization);
    assert.match(call.headers.authorization, /SignedHeaders=host;x-amz-date,/, "no body hash header -- SignedHeaders stays host;x-amz-date");
    assert.match(call.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
  }
});

test("signedLinkConnect maps an http endpoint to ws (not wss)", async () => {
  const httpKeys: HomeKeys = { ...KEYS, endpoint: "http://localhost:8787/svc/acme/" }; // tenant-scoped + trailing slash, like a real endpoint value
  let seenUrl = "";
  const stub: WebSocketLike = { send() {}, close() {}, addEventListener() {} };
  const connect = signedLinkConnect(httpKeys, (url) => { seenUrl = url; return stub; });
  await connect();
  assert.equal(seenUrl, "ws://localhost:8787/svc/acme/link");
});

// ---------- main(): idle-if-unprovisioned (preserved from the old poll-loop driver) ----------

test("absent home-keys.json (ENOENT) -> idles, logs once, never builds a connect/socket", async () => {
  const dir = tmp();
  const logs: string[] = [];
  let idled = false;
  await main(baseDeps(dir, {
    loadHomeKeys: () => { const e = new Error("nope") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; },
    idle: () => { idled = true; },
    log: (m) => logs.push(m),
    watchChecklists: () => { throw new Error("must not watch -- unprovisioned"); },
  }));
  assert.equal(idled, true);
  assert.ok(logs.some((l) => l.includes("no home-keys.json")), logs.join("\n"));
});

test("malformed home-keys.json (non-ENOENT error) -> idles, logs loudly via logErr", async () => {
  const dir = tmp();
  const errs: string[] = [];
  let idled = false;
  await main(baseDeps(dir, {
    loadHomeKeys: () => { throw new Error('home-keys.json is missing "tenant"'); },
    idle: () => { idled = true; },
    logErr: (m) => errs.push(m),
    watchChecklists: () => { throw new Error("must not watch -- unprovisioned"); },
  }));
  assert.equal(idled, true);
  assert.ok(errs.some((l) => l.includes("home-keys.json unreadable")), errs.join("\n"));
});

// ---------- main(): a provisioned tenant starts exactly one HomeLink over the signed connect ----------

test("present keys -> exactly one HomeLink started, dialing the signed link URL with authorization + x-amz-date headers", async () => {
  const dir = tmp();
  let connectCalls = 0;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const fake = new FakeSocketPair();

  await main(baseDeps(dir, {
    makeSocket: (url, headers) => { connectCalls += 1; capturedUrl = url; capturedHeaders = headers; return fake.client; },
  }));

  await fake.server.next(); // hello -- proves the (single) HomeLink actually started and connected

  assert.equal(connectCalls, 1, "exactly one connect/dial");
  assert.equal(capturedUrl, "wss://home.example.com/svc/acme/link");
  assert.ok(capturedHeaders.authorization?.startsWith("AWS4-HMAC-SHA256"), JSON.stringify(capturedHeaders));
  assert.ok(capturedHeaders["x-amz-date"], JSON.stringify(capturedHeaders));
});

// The config getter home-bot wires into HomeLink: OPERATOR_PHONE rides hello.config exactly
// like OPERATOR_EMAIL/OPERATOR_NAME -- trimmed when set, OMITTED entirely when unset or
// whitespace-only (a blank must never tell the DO "there IS an operator phone"). The DO seeds
// it as an ordinary REMOVABLE member (unlike the protected operatorEmail member).
test("hello.config carries OPERATOR_PHONE (trimmed) when set, omits it when unset/blank", async () => {
  const withPhone = new FakeSocketPair();
  await main(baseDeps(tmp(), {
    env: { OPERATOR_EMAIL: "op@x.com", OPERATOR_PHONE: "  +14155551234  " },
    makeSocket: () => withPhone.client,
  }));
  const hello = (await withPhone.server.next()) as { config?: Record<string, unknown> };
  assert.equal(hello.config?.operatorPhone, "+14155551234", "trimmed OPERATOR_PHONE rides the config");
  assert.equal(hello.config?.operatorEmail, "op@x.com");

  const withoutPhone = new FakeSocketPair();
  await main(baseDeps(tmp(), {
    env: { OPERATOR_EMAIL: "op@x.com" },
    makeSocket: () => withoutPhone.client,
  }));
  const hello2 = (await withoutPhone.server.next()) as { config?: Record<string, unknown> };
  assert.equal("operatorPhone" in (hello2.config ?? {}), false, "unset OPERATOR_PHONE -> key absent, not empty string");

  const blankPhone = new FakeSocketPair();
  await main(baseDeps(tmp(), {
    env: { OPERATOR_PHONE: "   " },
    makeSocket: () => blankPhone.client,
  }));
  const hello3 = (await blankPhone.server.next()) as { config?: Record<string, unknown> };
  assert.equal("operatorPhone" in (hello3.config ?? {}), false, "whitespace-only OPERATOR_PHONE -> key absent");
});

test("hello.config carries a presence-marked assistant contact from current tenant env", async () => {
  const configured = new FakeSocketPair();
  await main(baseDeps(tmp(), {
    env: {
      BAXTER_EMAIL: "  smiths@assistant.bax.bot  ",
      SENDBLUE_FROM_NUMBER: "  +15551234567  ",
    },
    makeSocket: () => configured.client,
  }));
  const hello = (await configured.server.next()) as { config?: Record<string, unknown> };
  assert.deepEqual(hello.config?.assistant, {
    email: "smiths@assistant.bax.bot",
    phone: "+15551234567",
  });

  const unavailable = new FakeSocketPair();
  await main(baseDeps(tmp(), {
    env: { BAXTER_EMAIL: "  ", SENDBLUE_FROM_NUMBER: "" },
    makeSocket: () => unavailable.client,
  }));
  const hello2 = (await unavailable.server.next()) as { config?: Record<string, unknown> };
  assert.deepEqual(hello2.config?.assistant, {}, "an empty object is the new-producer marker that clears stale contact");
});

test("main() backfills a legacy id-less checklist's id at startup, before the first publish", async () => {
  const dir = tmp();
  const checklistsPath = join(dir, "checklists.json");
  // A record written before `id` existed -- no `id` field. buildView needs the id for
  // identity-keyed delete-list; the startup no-op mutate persists the backfill.
  writeFileSync(checklistsPath, JSON.stringify([{ slug: "g", name: "G", items: [], created: "", updated: "" }]));
  const fake = new FakeSocketPair();

  await main(baseDeps(dir, { checklistsPath, makeSocket: () => fake.client }));
  await fake.server.next(); // hello -- main() has started (and the backfill mutate has run)

  const stored = JSON.parse(readFileSync(checklistsPath, "utf8"));
  assert.equal(typeof stored[0].id, "string");
  assert.ok(stored[0].id.length > 0, "the id-less list got a persisted id at startup");
});

// ---------- main(): a local checklist-store change reaches the link as 'changed' ----------

test("a checklist-store change drives wired.checkForChanges() -> a 'changed' send over the link", async () => {
  const dir = tmp();
  const checklistsPath = join(dir, "checklists.json");
  writeFileSync(checklistsPath, JSON.stringify([{ id: "l", slug: "g", name: "G", items: [], created: "", updated: "" }]));
  const fake = new FakeSocketPair();
  let onChange: (() => void) | undefined;

  await main(baseDeps(dir, {
    checklistsPath,
    makeSocket: () => fake.client,
    watchChecklists: (_path, cb) => { onChange = cb; return { close() {} }; },
  }));

  await fake.server.next(); // hello

  // Mutate the store (as checklist-cli/the Discord mirror would), then fire the watch
  // callback the way fs.watch would -- driven directly, not via real fs timing.
  writeFileSync(checklistsPath, JSON.stringify([{ id: "l", slug: "g", name: "G", items: [{ id: "a", text: "milk", checked: false, created: "" }], created: "", updated: "" }]));
  assert.ok(onChange, "watchChecklists must have been wired up");
  onChange!();

  const msg = await fake.server.next();
  assert.equal(msg.type, "changed");
});

test("a collection source change republishes its direct visible JSON projection without a model renderer", async () => {
  const dir = tmp();
  const collectionsDir = join(dir, "source-collections");
  const fake = new FakeSocketPair();
  let onChange: (() => void) | undefined;

  await main(baseDeps(dir, {
    collectionsDir,
    makeSocket: () => fake.client,
    // Added with the direct JSON projection: source edits notify the existing
    // digest path immediately; there is no derived file, OpenRouter request, or
    // debounce between a successful save and Home publication.
    watchCollections: (_path: string, callback: () => void) => {
      onChange = callback;
      return { close() {} };
    },
  } as Partial<HomeBotDeps>));
  await fake.server.next(); // hello establishes the initial empty Collections view version

  mkdirSync(collectionsDir, { recursive: true });
  writeFileSync(join(collectionsDir, "kitchen.md"), JSON.stringify([
    { title: "Cabinets", content: "Use **oak**.", notes: "Private vendor follow-up." },
  ]));
  assert.ok(onChange, "the collection source watcher must be wired up");
  onChange!();

  const changed = await fake.server.next();
  assert.equal(changed.type, "changed", "a source change drives wired.checkForChanges -> sendChanged");

  fake.server.send({ v: 1, type: "pull", id: 91 } as any);
  const reply = await fake.server.next() as { type: string; view: { collections: unknown[] } };
  assert.equal(reply.type, "view");
  assert.deepEqual(reply.view.collections, [{
    slug: "kitchen",
    name: "Kitchen",
    items: [{ titleHtml: "<p>Cabinets</p>", contentHtml: "<p>Use <strong>oak</strong>.</p>" }],
  }], "the publisher contains title/content only, not the private note");
  assert.doesNotMatch(JSON.stringify(reply.view.collections), /Private vendor follow-up/);

  // An accepted CAS delete removes the source. The existing directory watcher is the
  // artifact-cleanup path: it causes a fresh Home projection without this Collection.
  const version = readCollection(collectionsDir, "kitchen").version;
  await deleteCollection(collectionsDir, "kitchen", version);
  onChange!();
  const deletionChanged = await fake.server.next();
  assert.equal(deletionChanged.type, "changed", "an accepted source deletion republishes Home");

  fake.server.send({ v: 1, type: "pull", id: 92 } as any);
  const afterDelete = await fake.server.next() as { type: string; view: { collections: unknown[] } };
  assert.equal(afterDelete.type, "view");
  assert.deepEqual(afterDelete.view.collections, [], "the fresh Home view removes the deleted Collection artifact");
});

test("a sort-list command dispatches to the injected categorizer (by kind, not to members) and writes categories", async () => {
  const dir = tmp();
  const checklistsPath = join(dir, "checklists.json");
  writeFileSync(checklistsPath, JSON.stringify([{ id: "wi-1", slug: "g", name: "Groceries", items: [{ id: "a", text: "milk", checked: false, created: "" }], created: "", updated: "" }]));
  const fake = new FakeSocketPair();
  const seen: Array<{ listName: string; ids: string[] }> = [];

  await main(baseDeps(dir, {
    checklistsPath,
    makeSocket: () => fake.client,
    categorize: async (listName, open) => { seen.push({ listName, ids: open.map((i) => i.id) }); return [{ id: "a", category: "Dairy" }]; },
  }));
  await fake.server.next(); // hello

  // The DO pushes a sort-list command down the checklist link (as object.ts sendSortCommand does).
  fake.server.send({ v: 1, type: "command", id: 1, payload: { kind: "sort-list", listId: "wi-1" }, sig: "" } as any);
  // sortListCommand is fire-and-forget (void) and reads/writes the store async.
  // Wait for its observable write rather than relying on an arbitrary timer under a busy full suite.
  await waitUntil(() => JSON.parse(readFileSync(checklistsPath, "utf8"))[0]?.items[0]?.category === "Dairy", 1_000);

  assert.deepEqual(seen, [{ listName: "Groceries", ids: ["a"] }]); // the categorizer ran, on the open item
  const stored = JSON.parse(readFileSync(checklistsPath, "utf8"));
  assert.equal(stored[0].items[0].category, "Dairy"); // and its category was written back
});

test("a remove-recipe command deletes the named recipe file (the /recipes delete button, by kind, not to members)", async () => {
  const dir = tmp();
  const recipesDir = join(dir, "recipes");
  // Seed a valid recipe through the store (so removeRecipe finds a real file to unlink).
  const saved = await saveRecipe("Chili", goodRecipe(), recipesDir);
  assert.ok(!("errors" in saved));
  const seededSlug = listRecipes(recipesDir)[0].slug;
  assert.equal(listRecipes(recipesDir).length, 1);

  const fake = new FakeSocketPair();
  await main(baseDeps(dir, { recipesDir, makeSocket: () => fake.client }));
  await fake.server.next(); // hello

  // The DO pushes a remove-recipe command down the checklist link (object.ts sendRemoveRecipeCommand).
  fake.server.send({ v: 1, type: "command", id: 1, payload: { kind: "remove-recipe", slug: seededSlug }, sig: "" } as any);
  // removeRecipeCommand is fire-and-forget (void) and unlinks async.
  // Wait for the observable deletion rather than relying on an arbitrary timer under a busy full suite.
  await waitUntil(() => listRecipes(recipesDir).length === 0, 1_000);

  assert.equal(listRecipes(recipesDir).length, 0, "the recipe file was removed");
});

test("a tap (inbound intent) never drives checkForChanges through the watcher -- only a local store edit does", async () => {
  // Documents the boundary wireLink already owns (home-mirror.test.ts covers onIntent's
  // apply/ack path in full): the watcher this file wires is for LOCAL edits only, so a tap
  // is never mistaken for a file-watch trigger. Nothing to assert beyond "it wires
  // watchChecklists at all, once" -- covered by the test above; this test just pins that
  // main() never invokes onChange on its own.
  const dir = tmp();
  const fake = new FakeSocketPair();
  let watchCalls = 0;
  await main(baseDeps(dir, {
    makeSocket: () => fake.client,
    watchChecklists: (_path, _cb) => { watchCalls += 1; return { close() {} }; },
  }));
  await fake.server.next(); // hello
  assert.equal(watchCalls, 1, "watchChecklists wired exactly once, and main() itself never calls the callback");
});

// ---------- error containment (review fix 1/3): a bad store must idle/log, never crash ----------
//
// readChecklists (checklist-store.ts) tolerates ENOENT only -- malformed JSON, EACCES, EIO
// all rethrow. The old poll loop wrapped every tick in try/catch (home-mirror.ts's tick()
// driver: logErr + backoff, process stays up); the persistent-link driver runs store/state
// reads in callbacks (the watch callback, HomeLink's getters, wireLink's own startup read)
// where an uncaught throw would surface as an uncaughtException and crash-loop the container
// -- precisely what idleForever/the malformed-keys idle path exists to avoid.

test("a store-change check that throws (corrupt checklists.json) is swallowed and logged, not crashing the surface", async () => {
  const dir = tmp();
  const checklistsPath = join(dir, "checklists.json");
  writeFileSync(checklistsPath, JSON.stringify([{ id: "l", slug: "g", name: "G", items: [], created: "", updated: "" }]));
  const fake = new FakeSocketPair();
  const errs: string[] = [];
  let onChange: (() => void) | undefined;

  await main(baseDeps(dir, {
    checklistsPath,
    makeSocket: () => fake.client,
    watchChecklists: (_path, cb) => { onChange = cb; return { close() {} }; },
    logErr: (m) => errs.push(m),
  }));

  await fake.server.next(); // hello -- startup succeeded against the still-valid store

  // Corrupt the store AFTER startup (readChecklists rethrows a JSON.parse failure -- it
  // only tolerates ENOENT), then fire the watch callback the way fs.watch would.
  writeFileSync(checklistsPath, "{not valid json");
  assert.ok(onChange, "watchChecklists must have been wired up");
  assert.doesNotThrow(() => onChange!());
  assert.ok(errs.some((m) => m.includes("store-change check failed")), errs.join("\n"));
});

test("a corrupt checklist store at startup idles the surface loudly instead of crash-looping main()", async () => {
  const dir = tmp();
  const checklistsPath = join(dir, "checklists.json");
  writeFileSync(checklistsPath, "{not valid json"); // corrupt from the very start
  let idled = false;
  const errs: string[] = [];
  await assert.doesNotReject(main(baseDeps(dir, {
    checklistsPath,
    idle: () => { idled = true; },
    logErr: (m) => errs.push(m),
    watchChecklists: () => { throw new Error("must not watch -- startup failed before reaching the watcher"); },
  })));
  assert.equal(idled, true);
  // Source-agnostic message (review fix C) -- see the next test for why: the try/catch this
  // idles from spans more than just the checklist-store read, so it asserts only the
  // generic "failed to start" wrapper, not a specific claimed cause.
  assert.ok(errs.some((m) => m.includes("family-home surface failed to start")), errs.join("\n"));
});

test("a startup failure with a DIFFERENT cause (a malformed home-keys field, not a bad checklist store) is still idled, and reported with the REAL error -- not a hardcoded 'checklist store' claim", async () => {
  const dir = tmp();
  let idled = false;
  const errs: string[] = [];
  await assert.doesNotReject(main(baseDeps(dir, {
    // loadHomeKeys (home-mirror.ts) only truthy-checks fields -- a non-string endpoint
    // passes that check and only blows up later, inside signedLinkConnect's
    // `keys.endpoint.replace(...)`. The OLD hardcoded "checklist store unreadable" message
    // would have misdirected an operator debugging this straight past the real cause.
    loadHomeKeys: () => ({ endpoint: 5 as unknown as string, tenant: "acme", accessKeyId: "a", secretAccessKey: "b" }),
    idle: () => { idled = true; },
    logErr: (m) => errs.push(m),
    watchChecklists: () => { throw new Error("must not watch -- startup failed before reaching the watcher"); },
  })));
  assert.equal(idled, true);
  assert.ok(
    errs.some((m) => m.includes("family-home surface failed to start") && m.includes("replace is not a function")),
    errs.join("\n"),
  );
  assert.ok(!errs.some((m) => m.includes("checklist store")), "must not claim the checklist store was the cause when it wasn't -- " + errs.join("\n"));
});

// ---------- B4: a startup failure AFTER link.start() must stop the already-started link ----------
//
// Before this fix, the catch below idled the surface but never called link.stop() -- a throw
// between link.start() and the end of the try block (e.g. the watch wiring) left the link
// dialing/reconnecting forever underneath a process that believed it was "idle". stop()
// bumps HomeLink's connectGeneration, so even an already-in-flight async connect() attach is
// discarded (its socket closed) rather than left live.

test("a startup failure AFTER link.start() calls link.stop() -- the link does not keep redialing under an 'idle' surface", async () => {
  const dir = tmp();
  const fake = new FakeSocketPair();
  let idled = false;
  const errs: string[] = [];

  await assert.doesNotReject(main(baseDeps(dir, {
    makeSocket: () => fake.client,
    idle: () => { idled = true; },
    logErr: (m) => errs.push(m),
    // Throws AFTER link.start() has already been called (main()'s try block calls
    // link.start() before wiring the watcher) -- exactly the window B4 covers.
    watchChecklists: () => { throw new Error("watch wiring blew up"); },
  })));

  assert.equal(idled, true);
  assert.ok(errs.some((m) => m.includes("family-home surface failed to start")), errs.join("\n"));

  // The socket never got as far as "open"/hello (stop() invalidated the connect before
  // signing even resolved) -- so the only observable proof of stop() having run is the
  // in-flight connect's late attach being discarded: give the async signed connect a
  // moment to resolve and self-close via HomeLink's generation guard.
  for (let i = 0; i < 20 && !fake.server.closed; i += 1) await fake.flush();
  assert.equal(fake.server.closed, true, "the link's socket was torn down via link.stop(), not left redialing forever");
});

test("a startup failure after the collection watcher starts closes it before idling", async () => {
  const dir = tmp();
  let closes = 0;
  let idled = false;

  await assert.doesNotReject(main(baseDeps(dir, {
    watchCollections: () => ({ close: () => { closes += 1; } }),
    watchRecipes: () => { throw new Error("later recipes wiring failed"); },
    idle: () => { idled = true; },
  })));

  assert.equal(closes, 1, "partial-startup teardown closes the collection watcher exactly once");
  assert.equal(idled, true);
});

test("viewVersion getter falls back to null (not crashing the open handler) if the store goes bad before the first hello is actually sent", async () => {
  const dir = tmp();
  const checklistsPath = join(dir, "checklists.json");
  writeFileSync(checklistsPath, JSON.stringify([{ id: "l", slug: "g", name: "G", items: [], created: "", updated: "" }]));
  const fake = new FakeSocketPair();

  await main(baseDeps(dir, { checklistsPath, makeSocket: () => fake.client }));
  // main() has already returned (its body is synchronous), but the async signed connect()
  // -- and so the FIRST hello, which reads viewVersion() fresh -- hasn't resolved yet.
  // Corrupt the store in that window.
  writeFileSync(checklistsPath, "{not valid json");

  const hello = await fake.server.next();
  assert.equal(hello.type, "hello");
  assert.equal((hello as { viewVersion: unknown }).viewVersion, null, "falls back to null rather than throwing out of the open handler");
});

test("appliedThrough getter falls back to 0 (not crashing the open handler) if statePath is unreadable for a non-ENOENT reason", async () => {
  const dir = tmp();
  const statePath = join(dir, "home-state-is-a-dir"); // a directory, not a file -> EISDIR on read, not ENOENT
  mkdirSync(statePath);
  const fake = new FakeSocketPair();

  await main(baseDeps(dir, { statePath, makeSocket: () => fake.client }));
  const hello = await fake.server.next();
  assert.equal(hello.type, "hello");
  assert.equal((hello as { appliedThrough: unknown }).appliedThrough, 0, "falls back to 0 rather than throwing out of the open handler");
});

// ---------- FSWatcher 'error' handling (review fix 2/3) ----------
//
// watchChecklistStore's try/catch only covers SYNCHRONOUS setup failure (watch() throwing
// outright); an async watcher 'error' (inotify exhaustion, the watched directory vanishing)
// needs its own listener, or it's either an uncaughtException (no listener) or a silent
// process exit the moment this FSWatcher -- the process's sole liveness anchor between
// HomeLink's own (deliberately unref'd) timers -- goes away out from under a live link.
// Tested through the real watchChecklistStore (not main()'s injected watchChecklists seam,
// which every other test in this file uses instead) via its watchFn injection point, so the
// watcher's own filter/debounce/error wiring gets real coverage.

class FakeFSWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
}

test("watchCollections publishes every directory event immediately and is inert after close", () => {
  const dir = tmp();
  const fakeWatcher = new FakeFSWatcher();
  let listener: ((event: string, filename: string | null) => void) | undefined;
  const watchFn = ((_dir: string, cb: (event: string, filename: string | null) => void) => {
    listener = cb;
    return fakeWatcher;
  }) as unknown as typeof watch;
  let calls = 0;
  const { close } = watchCollections(dir, () => { calls += 1; }, watchFn);
  assert.ok(listener);

  // Home's bounded discovery counts every directory entry. A stray-file deletion can
  // bring a Collection back under its 200-entry limit, so it must rebuild just like an
  // atomic source rename -- filtering only canonical `.md` names leaves Home stale.
  listener!("rename", "stray.txt");
  assert.equal(calls, 1, "a non-Collection directory event publishes without a debounce delay");
  listener!("rename", "weekend-plans.md");
  assert.equal(calls, 2, "a successful source save publishes immediately too");
  listener!("rename", null); // conservatively treated as a source change too
  assert.equal(calls, 3, "an unnameable directory event also publishes immediately");

  close();
  assert.equal(fakeWatcher.closed, true);
  listener!("rename", "stray.txt");
  assert.equal(calls, 3, "a late watcher callback cannot republish after teardown");
});

test("watchCollections republishes when a stray deletion brings a Collection back under Home's directory cap", () => {
  const dir = tmp();
  const collectionsDir = join(dir, "collections");
  mkdirSync(collectionsDir, { recursive: true });
  writeFileSync(join(collectionsDir, "target.md"), JSON.stringify([{ title: "Target", content: "visible", notes: "private" }]));
  for (let i = 0; i < MAX_HOME_COLLECTION_DIRECTORY_ENTRIES; i++) {
    writeFileSync(join(collectionsDir, `stray-${i}.txt`), "x");
  }
  let published = buildCollectionsView(collectionsDir);
  assert.equal(published.length, 0, "target starts omitted: target + 200 stray entries exceed discovery's cap");

  const fakeWatcher = new FakeFSWatcher();
  let listener: ((event: string, filename: string | null) => void) | undefined;
  const watchFn = ((_path: string, callback: (event: string, filename: string | null) => void) => {
    listener = callback;
    return fakeWatcher;
  }) as unknown as typeof watch;
  const watcher = watchCollections(collectionsDir, () => { published = buildCollectionsView(collectionsDir); }, watchFn);

  rmSync(join(collectionsDir, `stray-${MAX_HOME_COLLECTION_DIRECTORY_ENTRIES - 1}.txt`));
  assert.ok(listener);
  listener!("rename", `stray-${MAX_HOME_COLLECTION_DIRECTORY_ENTRIES - 1}.txt`);

  assert.deepEqual(published.map((collection) => collection.slug), ["target"],
    "the noncanonical deletion triggers the same immediate Home rebuild as a source save");
  watcher.close();
});

test("watchChecklistStore: a watcher 'error' event logs loudly, de-dupes a repeated fallback timer, and close() clears it (no leaked interval)", () => {
  const dir = tmp();
  const path = join(dir, "checklists.json");
  const fakeWatcher = new FakeFSWatcher();
  const errs: string[] = [];
  const intervalHandles: NodeJS.Timeout[] = [];
  const clearedHandles: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  // Spy on the global timers just long enough to observe the keep-alive fallback firing
  // (and being cleared) -- restored (and every still-live interval cleared) in the finally
  // below so this doesn't leak a real, near-permanent (2^31-1 ms) interval into the rest of
  // the test run.
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const h = realSetInterval(...args);
    intervalHandles.push(h);
    return h;
  }) as typeof setInterval;
  globalThis.clearInterval = ((h?: Parameters<typeof clearInterval>[0]) => {
    if (h !== undefined) clearedHandles.push(h);
    return realClearInterval(h);
  }) as typeof clearInterval;

  try {
    const fakeWatchFn = ((_dir: string, _cb: unknown) => fakeWatcher) as unknown as typeof watch;
    const { close } = watchChecklistStore(path, () => {}, fakeWatchFn, (m: string) => errs.push(m));

    fakeWatcher.emit("error", new Error("EMFILE: too many open files"));
    assert.ok(
      errs.some((m) => m.includes("checklist-store watch died") && m.includes("EMFILE")),
      errs.join("\n"),
    );
    assert.equal(intervalHandles.length, 1, "the fallback keep-alive timer fired exactly once");

    // A repeated 'error' (the watcher can keep emitting) must NOT stack a second interval.
    fakeWatcher.emit("error", new Error("EMFILE again"));
    assert.equal(intervalHandles.length, 1, "a second 'error' does not stack a second keep-alive interval");

    close();
    assert.equal(fakeWatcher.closed, true, "close() still closes the underlying watcher");
    assert.deepEqual(clearedHandles, [intervalHandles[0]], "close() clears the keep-alive interval it created -- no leaked ref'd timer");
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    for (const h of intervalHandles) realClearInterval(h);
  }
});

test("watchChecklistStore: an 'error' that arrives AFTER close() is ignored -- no re-armed, un-clearable keep-alive interval, no log (fix round 3, fix B)", () => {
  // An FSWatcher's 'error' isn't gated on close() having run -- close() doesn't detach
  // listeners, so an error already queued when close() runs can still fire afterward. Before
  // this fix, that ordering (close() -> late 'error') would find keepAlive already null
  // (close() clears whatever's live, then the late handler arms a FRESH interval with the
  // only clearing path -- this same close() -- already spent: permanently leaked.
  const dir = tmp();
  const path = join(dir, "checklists.json");
  const fakeWatcher = new FakeFSWatcher();
  const errs: string[] = [];
  const intervalHandles: NodeJS.Timeout[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const h = realSetInterval(...args);
    intervalHandles.push(h);
    return h;
  }) as typeof setInterval;

  try {
    const fakeWatchFn = ((_dir: string, _cb: unknown) => fakeWatcher) as unknown as typeof watch;
    const { close } = watchChecklistStore(path, () => {}, fakeWatchFn, (m: string) => errs.push(m));

    close(); // no 'error' yet -- keepAlive was never armed, so this clears nothing (fine)
    assert.equal(fakeWatcher.closed, true);
    assert.equal(intervalHandles.length, 0, "nothing armed yet");

    fakeWatcher.emit("error", new Error("EMFILE after close"));

    assert.equal(intervalHandles.length, 0, "no keep-alive interval armed for an error after close() -- it would have been unclearable");
    assert.equal(errs.length, 0, "no log for an error that arrives after close() either -- the watch is already torn down on purpose");
  } finally {
    globalThis.setInterval = realSetInterval;
    for (const h of intervalHandles) clearInterval(h);
  }
});

// ---------- 'change' callback vs close() (fix round 4) ----------
//
// Round 3 gated the 'error' handler on a `closed` flag so an FSWatcher error arriving after
// close() couldn't re-arm an unclearable keep-alive interval. That same "close() means torn
// down" invariant did NOT hold for the OTHER handler -- the 'change' callback passed as
// fs.watch's second constructor argument (captured below via the watchFn seam, distinct from
// FakeFSWatcher's EventEmitter-based 'error' simulation above): a change within
// WATCH_DEBOUNCE_MS before close(), or a 'change' arriving after close() (FSWatcher doesn't
// suppress queued/late events on close() either), could still call onChange() up to
// WATCH_DEBOUNCE_MS after the caller was told the watcher was torn down.

function captureChangeListener(fakeWatcher: FakeFSWatcher): { watchFn: typeof watch; listener: () => ((event: string, filename: string | null) => void) | undefined } {
  let changeListener: ((event: string, filename: string | null) => void) | undefined;
  const watchFn = ((_dir: string, listener: (event: string, filename: string | null) => void) => {
    changeListener = listener;
    return fakeWatcher;
  }) as unknown as typeof watch;
  return { watchFn, listener: () => changeListener };
}

test("watchChecklistStore: close() cancels a PENDING debounced onChange -- it never fires, even past WATCH_DEBOUNCE_MS (fix round 4)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmp();
  const path = join(dir, "checklists.json");
  const fakeWatcher = new FakeFSWatcher();
  const { watchFn, listener } = captureChangeListener(fakeWatcher);
  let onChangeCalls = 0;

  const { close } = watchChecklistStore(path, () => { onChangeCalls += 1; }, watchFn);
  assert.ok(listener(), "watchFn must have been called with a change listener");

  listener()!("rename", "checklists.json"); // a store change arms the debounce timer
  close(); // torn down BEFORE the debounce elapses

  t.mock.timers.tick(WATCH_DEBOUNCE_MS); // advance well past the (would-be) debounce window
  assert.equal(onChangeCalls, 0, "close() must cancel the pending debounced onChange -- it must never fire");
});

test("watchChecklistStore: a 'change' event that arrives AFTER close() is ignored -- onChange never scheduled (fix round 4)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmp();
  const path = join(dir, "checklists.json");
  const fakeWatcher = new FakeFSWatcher();
  const { watchFn, listener } = captureChangeListener(fakeWatcher);
  let onChangeCalls = 0;

  const { close } = watchChecklistStore(path, () => { onChangeCalls += 1; }, watchFn);
  assert.ok(listener());

  close(); // torn down first -- no change has happened yet
  listener()!("rename", "checklists.json"); // FSWatcher doesn't suppress queued/late events on close()

  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(onChangeCalls, 0, "a change arriving after close() must not schedule (or ever fire) onChange");
});

// ---------- applyMembersCommand: DO-pushed members snapshot apply rule (Task 5) ----------

function allowTmp(): string { return join(mkdtempSync(join(tmpdir(), "hb-allow-")), "allowlist.json"); }

test("applyMembersCommand: a mutation with a newer version writes + republishes", () => {
  const p = allowTmp(); let n = 0;
  applyMembersCommand({ senders: ["a@x.com"], recipients: ["a@x.com"], version: 2, reason: "mutation" }, {} as any, p, () => { n++; });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { senders: ["a@x.com"], recipients: ["a@x.com"], version: 2, names: {} });
  assert.equal(n, 1);
});

test("applyMembersCommand persists the names map (sanitized) so mail/SMS/home can attribute senders", () => {
  const p = allowTmp(); let n = 0;
  applyMembersCommand({ senders: ["erik@x.com"], recipients: ["erik@x.com"], version: 2, reason: "sync", names: { "erik@x.com": "Erik", bad: 5 } } as any, {} as any, p, () => { n++; });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).names, { "erik@x.com": "Erik" }, "names round-trip, sanitized to string->string; a non-string value is dropped");
});

test("applyMembersCommand: a mutation with a stale/equal version is ignored", () => {
  const p = allowTmp(); writeFileSync(p, JSON.stringify({ senders: ["a@x.com"], recipients: ["a@x.com"], version: 5 }));
  let n = 0;
  applyMembersCommand({ senders: ["b@x.com"], recipients: ["b@x.com"], version: 5, reason: "mutation" }, {} as any, p, () => { n++; });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).senders, ["a@x.com"]); // unchanged
  assert.equal(n, 0);
});

test("applyMembersCommand: a sync is applied UNCONDITIONALLY even when the file version is higher", () => {
  const p = allowTmp(); writeFileSync(p, JSON.stringify({ senders: ["old@x.com"], recipients: ["old@x.com"], version: 9 }));
  let n = 0;
  applyMembersCommand({ senders: ["new@x.com"], recipients: ["new@x.com"], version: 3, reason: "sync" }, {} as any, p, () => { n++; });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { senders: ["new@x.com"], recipients: ["new@x.com"], version: 3, names: {} });
  assert.equal(n, 1);
});

test("applyMembersCommand: a malformed payload is logged and dropped, never throws", () => {
  const p = allowTmp(); const errs: string[] = [];
  applyMembersCommand({ senders: "nope", version: 9, reason: "sync" }, {} as any, p, () => {}, (m) => errs.push(m));
  assert.equal(errs.length, 1);
});

// fix round 1: typeof s.version === "number" admitted NaN/Infinity/huge doubles -- the same
// class of gap isSafeId (home-link.ts) already guards against on the wire ids. A NaN version
// used to fail the mutation staleness gate OPEN (`NaN <= x` is always false) and, worse, would
// have been applied even under reason:"sync" (which is otherwise unconditional) had the shape
// guard not caught it first -- so both are asserted below, not just the mutation path.

test("applyMembersCommand: a NaN version is dropped even under reason:\"sync\" -- never applied, no write", () => {
  const p = allowTmp(); const errs: string[] = []; let n = 0;
  applyMembersCommand({ senders: ["new@x.com"], recipients: ["new@x.com"], version: NaN, reason: "sync" }, {} as any, p, () => { n++; }, (m) => errs.push(m));
  assert.equal(errs.length, 1);
  assert.equal(n, 0);
  assert.equal(existsSync(p), false, "writeAllowlist must never have run");
});

test("applyMembersCommand: an Infinity version is dropped -- last-applied (the file) is left unchanged", () => {
  const p = allowTmp();
  writeFileSync(p, JSON.stringify({ senders: ["old@x.com"], recipients: ["old@x.com"], version: 5 }));
  const errs: string[] = []; let n = 0;
  applyMembersCommand({ senders: ["new@x.com"], recipients: ["new@x.com"], version: Infinity, reason: "mutation" }, {} as any, p, () => { n++; }, (m) => errs.push(m));
  assert.equal(errs.length, 1);
  assert.equal(n, 0);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { senders: ["old@x.com"], recipients: ["old@x.com"], version: 5 }, "unchanged -- last-applied not lowered or altered");
});

// ---------- applyCalendarFeedsCommand: DO-pushed calendar-feeds snapshot apply rule (Task 6) ----------

function feedsTmp(): string { return join(mkdtempSync(join(tmpdir(), "hb-feeds-")), "calendar-feeds.json"); }

test("applyCalendarFeedsCommand: a sync is applied UNCONDITIONALLY even when its version is LOWER than the stored file (DO-authoritative)", () => {
  const p = feedsTmp();
  writeFileSync(p, JSON.stringify({ urls: ["https://old.example/a.ics"], version: 9 }));
  const errs: string[] = [];
  applyCalendarFeedsCommand({ urls: ["https://new.example/b.ics"], version: 3, reason: "sync" }, p, (m) => errs.push(m));
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { urls: ["https://new.example/b.ics"], version: 3 });
  assert.equal(errs.length, 0);
});

test("applyCalendarFeedsCommand: a mutation with version <= stored is a no-op", () => {
  const p = feedsTmp();
  writeFileSync(p, JSON.stringify({ urls: ["https://old.example/a.ics"], version: 5 }));
  const errs: string[] = [];
  applyCalendarFeedsCommand({ urls: ["https://new.example/b.ics"], version: 5, reason: "mutation" }, p, (m) => errs.push(m));
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { urls: ["https://old.example/a.ics"], version: 5 }, "unchanged");
  assert.equal(errs.length, 0);
});

test("applyCalendarFeedsCommand: a mutation with version > stored writes", () => {
  const p = feedsTmp();
  writeFileSync(p, JSON.stringify({ urls: ["https://old.example/a.ics"], version: 5 }));
  const errs: string[] = [];
  applyCalendarFeedsCommand({ urls: ["https://new.example/b.ics"], version: 6, reason: "mutation" }, p, (m) => errs.push(m));
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { urls: ["https://new.example/b.ics"], version: 6 });
  assert.equal(errs.length, 0);
});

test("applyCalendarFeedsCommand: a malformed payload (urls not an array) is logged and dropped, never writes", () => {
  const p = feedsTmp();
  const errs: string[] = [];
  applyCalendarFeedsCommand({ urls: "nope", version: 3, reason: "sync" }, p, (m) => errs.push(m));
  assert.equal(errs.length, 1);
  assert.equal(existsSync(p), false);
});

test("applyCalendarFeedsCommand: a malformed payload (bad version) is logged and dropped, never writes", () => {
  const p = feedsTmp();
  const errs: string[] = [];
  applyCalendarFeedsCommand({ urls: ["https://x.example/a.ics"], version: NaN, reason: "sync" }, p, (m) => errs.push(m));
  assert.equal(errs.length, 1);
  assert.equal(existsSync(p), false);
});

test("applyCalendarFeedsCommand: a malformed payload (bad reason) is logged and dropped, never writes", () => {
  const p = feedsTmp();
  const errs: string[] = [];
  applyCalendarFeedsCommand({ urls: ["https://x.example/a.ics"], version: 1, reason: "bogus" }, p, (m) => errs.push(m));
  assert.equal(errs.length, 1);
  assert.equal(existsSync(p), false);
});

test("applyCalendarFeedsCommand: non-string urls are filtered out before writing", () => {
  const p = feedsTmp();
  const errs: string[] = [];
  applyCalendarFeedsCommand({ urls: ["https://ok.example/a.ics", 42, null, "https://ok.example/b.ics"], version: 1, reason: "sync" }, p, (m) => errs.push(m));
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { urls: ["https://ok.example/a.ics", "https://ok.example/b.ics"], version: 1 });
  assert.equal(errs.length, 0);
});

// ---------- main()'s onCommand dispatch: routes on payload.kind (Task 6) ----------

test("onCommand dispatch: a kind:\"calendar-feeds\" payload routes to the feed writer, not the allowlist", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const allowlistPath = join(dir, "allowlist.json");
  const fake = new FakeSocketPair();

  await main(baseDeps(dir, { makeSocket: () => fake.client, calendarFeedsPath, allowlistPath }));
  await fake.server.next(); // hello

  fake.server.send({
    v: 1, type: "command", id: 1,
    payload: { kind: "calendar-feeds", urls: ["https://x.example/a.ics"], version: 1, reason: "sync" },
    sig: "test-sig",
  } as any);
  await fake.flush();

  assert.deepEqual(JSON.parse(readFileSync(calendarFeedsPath, "utf8")), { urls: ["https://x.example/a.ics"], version: 1 });
  assert.equal(existsSync(allowlistPath), false, "the members writer must not have fired");
});

test("onCommand dispatch: a members payload (no kind) still routes to applyMembersCommand", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const allowlistPath = join(dir, "allowlist.json");
  const fake = new FakeSocketPair();

  await main(baseDeps(dir, { makeSocket: () => fake.client, calendarFeedsPath, allowlistPath }));
  await fake.server.next(); // hello

  fake.server.send({
    v: 1, type: "command", id: 1,
    payload: { senders: ["a@x.com"], recipients: ["a@x.com"], version: 1, reason: "sync" },
    sig: "test-sig",
  } as any);
  await fake.flush();

  assert.deepEqual(JSON.parse(readFileSync(allowlistPath, "utf8")), { senders: ["a@x.com"], recipients: ["a@x.com"], version: 1, names: {} });
  assert.equal(existsSync(calendarFeedsPath), false, "the calendar-feeds writer must not have fired");
});

test("onCommand dispatch: a kind:\"member-welcome\" payload sends via the injected welcome transport (by kind, not to members)", async () => {
  const dir = tmp();
  const allowlistPath = join(dir, "allowlist.json");
  // The member is already an allowlisted recipient (the members snapshot for this add applied
  // first, on the ordered link socket) -- seed the file so isAllowedRecipient passes.
  // A realistic add: the household already has a named member (Erik) plus the new one (Sam).
  writeFileSync(allowlistPath, JSON.stringify({ senders: [], recipients: ["erik@x.com", "sam@ex.com"], version: 1, names: { "erik@x.com": "Erik" } }));
  const fake = new FakeSocketPair();
  const sent: Array<{ from: string; to: string; subject: string; text: string }> = [];

  await main(baseDeps(dir, {
    makeSocket: () => fake.client,
    allowlistPath,
    env: { BAXTER_EMAIL: "acme@assistant.bax.bot", SENDBLUE_FROM_NUMBER: "+15551234567" },
    welcomeSender: async (m) => { sent.push({ from: m.from, to: m.to, subject: m.subject, text: m.text }); },
  }));
  await fake.server.next(); // hello

  fake.server.send({ v: 1, type: "command", id: 1, payload: { kind: "member-welcome", email: "sam@ex.com", name: "Sam" }, sig: "" } as any);
  await fake.flush();

  assert.equal(sent.length, 1, "the member-welcome routed to the welcome transport, not applyMembersCommand");
  assert.equal(sent[0].from, "Baxter <acme@assistant.bax.bot>");
  assert.equal(sent[0].to, "sam@ex.com");
  assert.equal(sent[0].subject, "You've been added"); // the member-added variant, not the owner welcome
  assert.match(sent[0].text, /You're joining Erik\./); // roster drawn from the allowlist (new member excluded)
});

// ---------- recipes link: onPull scope:"recipe" / scope:"index" / a bad slug (I1, M1, M2) ----------
//
// Everything above exercises only the CHECKLIST link -- recipesDir/makeRecipesSocket are
// left at baseDeps' harmless no-op defaults throughout. Until this section, that meant the
// container half of the recipes protocol seam (home-bot.ts's own recipesLink.onPull
// handler) had NO test at all: a regression there would silently break every recipe detail
// page and the recipes index page while every OTHER test in this suite kept passing. These
// tests drive main() with TWO real FakeSocketPairs -- one per link, mirroring
// HomeBotDeps.makeRecipesSocket's own "never share one fake wire between the two links"
// rationale -- and a seeded recipesDir (via recipes-store.ts's real saveRecipe, the same
// store home-bot.ts itself reads through).

function goodRecipe(): Record<string, unknown> {
  return {
    title: "Weeknight Pasta",
    servings: 4,
    timeToPrepare: 30,
    activeTime: 20,
    cookTime: 10,
    ingredients: ["1 lb pasta", "2 cups sauce"],
    steps: [
      { activeTime: 5, cookTime: 15, ingredients: ["1 lb pasta"], instructions: "Boil the pasta, then combine with sauce." },
    ],
  };
}

// Start main() with both links wired to their own FakeSocketPair, and drain both initial
// hellos, so a test can go straight to server.send()ing a pull on the recipes link.
async function startWithBothLinks(dir: string, recipesDir: string, over: Partial<HomeBotDeps> = {}): Promise<{ fake: FakeSocketPair; recipesFake: FakeSocketPair }> {
  const fake = new FakeSocketPair();
  const recipesFake = new FakeSocketPair();
  await main(baseDeps(dir, {
    recipesDir,
    makeSocket: () => fake.client,
    makeRecipesSocket: () => recipesFake.client,
    ...over,
  }));
  await fake.server.next(); // checklist link hello
  await recipesFake.server.next(); // recipes link hello
  return { fake, recipesFake };
}

test("recipes link: a scope:\"recipe\" pull for a seeded slug replies with a view frame carrying that recipe, echoing the slug", async () => {
  const dir = tmp();
  const recipesDir = join(dir, "recipes");
  await saveRecipe("Weeknight Pasta", goodRecipe(), recipesDir);

  const { recipesFake } = await startWithBothLinks(dir, recipesDir);

  recipesFake.server.send({ v: 1, type: "pull", id: 1, scope: "recipe", slug: "weeknight-pasta" } as any);
  const msg = await recipesFake.server.next();

  assert.equal(msg.type, "view");
  assert.equal((msg as { inReplyTo: number }).inReplyTo, 1);
  assert.equal((msg as { slug?: string }).slug, "weeknight-pasta");
  assert.deepEqual((msg as { view: unknown }).view, { lists: [], recipe: readRecipe("weeknight-pasta", recipesDir) });
});

test("recipes link: a scope:\"index\" pull replies with the recipes index and the matching digest version, no slug", async () => {
  const dir = tmp();
  const recipesDir = join(dir, "recipes");
  await saveRecipe("Weeknight Pasta", goodRecipe(), recipesDir);

  const { recipesFake } = await startWithBothLinks(dir, recipesDir);

  recipesFake.server.send({ v: 1, type: "pull", id: 2, scope: "index" } as any);
  const msg = await recipesFake.server.next();

  const index = listRecipes(recipesDir);
  assert.equal(msg.type, "view");
  assert.equal((msg as { inReplyTo: number }).inReplyTo, 2);
  assert.equal((msg as { slug?: string }).slug, undefined, "the index reply carries no slug");
  assert.deepEqual((msg as { view: unknown }).view, { lists: [], recipes: index });
  assert.equal((msg as { viewVersion: string }).viewVersion, recipesIndexVersion(index));
});

// M1: readRecipe/recipePath (recipes-store.ts) throws for a slug that toSlug-normalizes to
// empty ("**" has no alphanumerics) -- recipePath's own "invalid recipe slug" throw, NOT the
// ENOENT->null path readRecipe already handles for a merely-absent recipe. Before this fix,
// onPull's catch logged and sent NOTHING for this branch, so the DO's per-recipe waiter
// (matched by the echoed slug) would wait out the full pull timeout before 404ing.
test("recipes link: a scope:\"recipe\" pull for a slug that normalizes to empty replies promptly with recipe:null, not silence (M1)", async () => {
  const dir = tmp();
  const recipesDir = join(dir, "recipes");
  const errs: string[] = [];

  const { recipesFake } = await startWithBothLinks(dir, recipesDir, { logErr: (m) => errs.push(m) });

  recipesFake.server.send({ v: 1, type: "pull", id: 3, scope: "recipe", slug: "**" } as any);
  const msg = await recipesFake.server.next();

  assert.equal(msg.type, "view");
  assert.equal((msg as { inReplyTo: number }).inReplyTo, 3);
  assert.equal((msg as { slug?: string }).slug, "**", "the garbage slug is still echoed back, exactly as sent");
  assert.deepEqual((msg as { view: unknown }).view, { lists: [], recipe: null });
  assert.ok(errs.some((m) => m.includes("recipes pull") && m.includes("**")), errs.join("\n"));
});

// ---------- calendar link (home-calendar plan, Task C2) ----------
//
// A THIRD HomeLink connection, over its own dedicated /calendar-link socket -- mirrors the
// "recipes link" section above's own rationale for driving main() with a real FakeSocketPair
// per link under test rather than only the checklist link's default no-op stubs.

// Start main() with the CHECKLIST link and the CALENDAR link both wired to their own
// FakeSocketPair (recipes stays at baseDeps' harmless no-op default), and drain the
// checklist link's hello plus the calendar link's own two priming frames (a `changed`, from
// this file's onOpen priming push, AND `hello` -- see home-bot.ts's own comment on why
// onOpen fires the priming push BEFORE hello is sent, not after). Returns both identified by
// type, not position, since that ordering is deliberately not part of this test's contract.
async function startWithCalendarLink(dir: string, over: Partial<HomeBotDeps> = {}): Promise<{
  fake: FakeSocketPair; calFake: FakeSocketPair; initialHello: unknown; initialChanged: unknown;
}> {
  const fake = new FakeSocketPair();
  const calFake = new FakeSocketPair();
  await main(baseDeps(dir, {
    makeSocket: () => fake.client,
    makeCalendarSocket: () => calFake.client,
    ...over,
  }));
  await fake.server.next(); // checklist link hello
  const first = await calFake.server.next();
  const second = await calFake.server.next();
  const frames = [first, second] as Array<{ type: string }>;
  const initialHello = frames.find((m) => m.type === "hello");
  const initialChanged = frames.find((m) => m.type === "changed");
  return { fake, calFake, initialHello, initialChanged };
}

const receivedFrames = (server: { rawReceived: string[] }): unknown[] => server.rawReceived
  .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
  .flatMap((frame) => Array.isArray(frame) ? frame : []);
const changedFrames = (server: { rawReceived: string[] }): Array<{ type: string }> => receivedFrames(server)
  .filter((frame): frame is { type: string } => (frame as { type?: unknown } | null)?.type === "changed");

// A date guaranteed to fall inside buildCalendarView's 7-day window relative to whenever
// this test suite actually runs (production's onPull/onCommand handlers call `new Date()`
// directly -- see home-bot.ts's own comment on why that's not deps-injected -- so an
// integration-level test through main() must anchor its fixture dates off the real clock,
// unlike calendar-mirror.test.ts's unit tests, which pass an explicit `now`).
function isoTomorrow(): string {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
}

// A recording scheduleCalendarPoll spy: captures (fn, intervalMs) for assertions and never
// invokes fn (the wiring site owns invocation). Dedup for the three calendar-poll tests.
function recordingScheduler(): {
  scheduled: Array<{ fn: () => void; intervalMs: number }>;
  scheduleCalendarPoll: (fn: () => void, intervalMs: number) => () => void;
} {
  const scheduled: Array<{ fn: () => void; intervalMs: number }> = [];
  return { scheduled, scheduleCalendarPoll: (fn, intervalMs) => { scheduled.push({ fn, intervalMs }); return () => {}; } };
}

test("calendar link: connecting primes the DO with an initial 'changed' push, and hello carries the same viewVersion", async () => {
  const dir = tmp();
  const { initialHello, initialChanged } = await startWithCalendarLink(dir);

  assert.ok(initialHello, "a hello frame was sent");
  assert.ok(initialChanged, "an initial priming 'changed' frame was sent");
  const emptyVersion = calendarViewVersion({ lists: [], items: [], tz: "America/Los_Angeles" }); // baseDeps.env is empty -> householdTz terminal fallback
  assert.equal((initialChanged as { viewVersion: string }).viewVersion, emptyVersion, "an empty calendar's digest");
  assert.equal((initialHello as { viewVersion: string | null }).viewVersion, emptyVersion, "hello's own viewVersion getter agrees");
});

test("calendar link: a pull replies with the current merged CalendarView and its digest", async () => {
  const dir = tmp();
  const calendarEventsPath = join(dir, "calendar", "events.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  await addEvent(calendarEventsPath, { title: "Dentist", start: isoTomorrow() });

  const { calFake } = await startWithCalendarLink(dir, { calendarEventsPath, calendarCachePath });

  calFake.server.send({ v: 1, type: "pull", id: 42 } as any);
  const msg = await calFake.server.next();

  assert.equal(msg.type, "view");
  assert.equal((msg as { inReplyTo: number }).inReplyTo, 42);
  const expected = buildCalendarView(new Date(), { ownEventsPath: calendarEventsPath, cachePath: calendarCachePath });
  assert.deepEqual((msg as { view: unknown }).view, expected);
  assert.equal((msg as { viewVersion: string }).viewVersion, calendarViewVersion(expected));
  assert.equal(expected.items.length, 1, "the seeded own event landed inside the 7-day window");
  assert.equal(expected.items[0].title, "Dentist");
  assert.ok(expected.items[0].ics, "an own item carries a prebuilt ics");
});

test("calendar link: onCommand ignores any payload that isn't {kind:\"calendar-refresh\"} -- no poll, no extra push", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  writeFileSync(calendarFeedsPath, JSON.stringify({ urls: ["https://feed.example.com/family.ics"], version: 1 }));
  let fetchCalls = 0;
  const fetchStub: FetchLike = async () => { fetchCalls += 1; throw new Error("must not be called for a non-refresh payload"); };

  const { calFake } = await startWithCalendarLink(dir, { calendarFeedsPath, fetch: fetchStub });

  calFake.server.send({ v: 1, type: "command", id: 1, payload: { kind: "calendar-feeds" }, sig: "" } as any);
  calFake.server.send({ v: 1, type: "command", id: 2, payload: "calendar-refresh", sig: "" } as any);
  calFake.server.send({ v: 1, type: "command", id: 3, payload: null, sig: "" } as any);
  await calFake.flush();
  assert.equal(fetchCalls, 0, "none of the three malformed/wrong-kind payloads triggered a poll");
});

test("calendar link: onCommand polls, writes the cache atomically, and republishes on a valid calendar-refresh", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  const calendarEventsPath = join(dir, "calendar", "events.json");
  writeFileSync(calendarFeedsPath, JSON.stringify({ urls: ["https://feed.example.com/family.ics"], version: 1 }));

  const start = new Date(Date.now() + 24 * 3600 * 1000);
  const fmt = (d: Date): string => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const end = new Date(start.getTime() + 3600 * 1000);
  const feedIcs = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//x//EN",
    "BEGIN:VEVENT", "UID:fam1@family", `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    "SUMMARY:Soccer", "URL:https://calendar.example.com/fam1", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  let fetchCalls = 0;
  const fetchStub: FetchLike = async () => {
    fetchCalls += 1;
    return { status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(feedIcs).buffer } as unknown as Response;
  };

  const { calFake } = await startWithCalendarLink(dir, { calendarFeedsPath, calendarCachePath, calendarEventsPath, fetch: fetchStub });

  calFake.server.send({ v: 1, type: "command", id: 7, payload: { kind: "calendar-refresh" }, sig: "" } as any);
  const msg = await calFake.server.next();

  assert.equal(fetchCalls, 1, "exactly one feed fetch for the one configured url");
  assert.equal(msg.type, "changed", "the refreshed view is republished");
  const cached = JSON.parse(readFileSync(calendarCachePath, "utf8")) as { events: Array<{ uid: string; url: string | null }> };
  assert.equal(cached.events.length, 1);
  assert.equal(cached.events[0].uid, "fam1@family");
  assert.equal(cached.events[0].url, "https://calendar.example.com/fam1");

  const view = buildCalendarView(new Date(), { ownEventsPath: calendarEventsPath, cachePath: calendarCachePath });
  assert.equal((msg as { viewVersion: string }).viewVersion, calendarViewVersion(view));
  const famItem = view.items.find((i) => i.source === "family");
  assert.ok(famItem, "the polled family event is now in the merged view");
  assert.equal(famItem!.url, "https://calendar.example.com/fam1");
});

test("calendar link: onCommand deletes an own event by uid and republishes; a non-matching uid removes nothing", async () => {
  const dir = tmp();
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  const calendarEventsPath = join(dir, "calendar", "events.json");
  const keep = await addEvent(calendarEventsPath, { title: "Keep", start: isoTomorrow() });
  const gone = await addEvent(calendarEventsPath, { title: "Delete me", start: isoTomorrow() });

  const { calFake } = await startWithCalendarLink(dir, { calendarCachePath, calendarEventsPath });

  calFake.server.send({ v: 1, type: "command", id: 20, payload: { kind: "calendar-delete", uid: gone.uid }, sig: "" } as any);
  const msg = await calFake.server.next();
  assert.equal(msg.type, "changed", "the post-delete view is republished");
  assert.deepEqual(readEvents(calendarEventsPath).map((e) => e.uid), [keep.uid], "only the targeted event is gone");

  // A uid that isn't an own event: removeEvent returns false, so nothing is removed AND nothing is
  // republished (the `if (removed)` gate) -- exactly one prior changed frame, from the real delete.
  const changedBefore = changedFrames(calFake.server).length;
  calFake.server.send({ v: 1, type: "command", id: 21, payload: { kind: "calendar-delete", uid: "no-such-uid" }, sig: "" } as any);
  await new Promise((r) => setTimeout(r, 20)); // let the async handler settle
  assert.deepEqual(readEvents(calendarEventsPath).map((e) => e.uid), [keep.uid], "the no-match delete removed nothing");
  assert.equal(changedFrames(calFake.server).length, changedBefore, "no republish for the no-match delete");
});

test("calendar link: onCommand does NOT overwrite the cache when every configured feed fails", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  writeFileSync(calendarFeedsPath, JSON.stringify({ urls: ["https://feed.example.com/family.ics"], version: 1 }));
  mkdirSync(dirname(calendarCachePath), { recursive: true });
  const priorCache = { fetchedAt: "2026-01-01T00:00:00.000Z", events: [{ uid: "stale@family", title: "Stale", location: null, startMs: 0, endMs: null, allDay: false, rrule: null, url: null }] };
  writeFileSync(calendarCachePath, JSON.stringify(priorCache));

  const fetchStub: FetchLike = async () => { throw new Error("network down"); };

  const { calFake } = await startWithCalendarLink(dir, { calendarFeedsPath, calendarCachePath, fetch: fetchStub });

  calFake.server.send({ v: 1, type: "command", id: 8, payload: { kind: "calendar-refresh" }, sig: "" } as any);
  const msg = await calFake.server.next();

  assert.equal(msg.type, "changed", "still republishes -- SOMETHING moves even when the poll itself found nothing new");
  assert.deepEqual(JSON.parse(readFileSync(calendarCachePath, "utf8")), priorCache, "the last-known cache survives an all-feeds-failed refresh");
});

test("calendar link: onCommand skips the cache write but still calls sendChanged when zero feeds are configured", async () => {
  const dir = tmp();
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  let fetchCalls = 0;
  const fetchStub: FetchLike = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called with zero configured feeds");
  };
  const calFake = new FakeSocketPair();

  await main(baseDeps(dir, {
    makeCalendarSocket: () => calFake.client,
    fetch: fetchStub,
  }));
  await calFake.server.next();
  await calFake.server.next();
  const changedBefore = changedFrames(calFake.server).length;

  calFake.server.send({ v: 1, type: "command", id: 9, payload: { kind: "calendar-refresh" }, sig: "" } as any);
  // The poll now round-trips the shared refresh's lock acquisition (several fs
  // macrotask hops) before its zero-feed no-write completes, so settle with the
  // file's bounded flush-poll loop instead of a single flush.
  for (let i = 0; i < 200 && changedFrames(calFake.server).length - changedBefore < 1; i += 1) await calFake.flush();

  assert.equal(fetchCalls, 0, "zero feeds means performPoll never calls fetch");
  assert.equal(existsSync(calendarCachePath), false, "zero feeds do not create or overwrite the cache");
  const changedAfter = changedFrames(calFake.server).length;
  assert.equal(changedAfter - changedBefore, 1, "the zero-feed poll still sends one changed frame");
});

test("calendar link: a calendar-refresh carrying feedUrls polls those, not the on-disk feeds", async () => {
  // The poll-on-feed-add trigger ships the just-mutated feed URLs in the command payload so
  // the poll doesn't race applyCalendarFeedsCommand's write of feeds.json (they travel
  // separate sockets). Proves the override is used: on-disk feeds differ from the payload,
  // and the payload URL is the one fetched.
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  const calendarEventsPath = join(dir, "calendar", "events.json");
  writeFileSync(calendarFeedsPath, JSON.stringify({ urls: ["https://disk.example.com/disk.ics"], version: 1 }));
  const polled: string[] = [];
  const fetchStub: FetchLike = (url: string) => {
    polled.push(url);
    return Promise.resolve({ status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n").buffer } as unknown as Response);
  };
  const { calFake } = await startWithCalendarLink(dir, { calendarFeedsPath, calendarCachePath, calendarEventsPath, fetch: fetchStub });
  calFake.server.send({ v: 1, type: "command", id: 12, payload: { kind: "calendar-refresh", feedUrls: ["https://payload.example.com/payload.ics"] }, sig: "" } as any);
  for (let i = 0; i < 50 && polled.length === 0; i += 1) await calFake.flush();
  assert.equal(polled.length, 1);
  assert.equal(polled[0], "https://payload.example.com/payload.ics", "the payload URL was polled, not the on-disk feed");
});

test("calendarPollIntervalMs > 0 registers the injectable scheduler with exactly that interval", async () => {
  const dir = tmp();
  const intervalMs = 1234;
  const { scheduled, scheduleCalendarPoll } = recordingScheduler();

  await main(baseDeps(dir, {
    calendarPollIntervalMs: intervalMs,
    scheduleCalendarPoll,
  }));

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].intervalMs, intervalMs);
  assert.equal(typeof scheduled[0].fn, "function");
});

test("calendarPollIntervalMs === 0 does NOT register the scheduler and does NOT fire a prime poll", async () => {
  const dir = tmp();
  const { scheduled, scheduleCalendarPoll } = recordingScheduler();
  const { calFake } = await startWithCalendarLink(dir, {
    calendarPollIntervalMs: 0,
    scheduleCalendarPoll,
  });

  const frames = receivedFrames(calFake.server);
  assert.equal(scheduled.length, 0, "zero disables recurring scheduling");
  assert.equal(frames.length, 2, "zero disables the startup prime; only hello and onOpen changed remain");
  assert.equal(changedFrames(calFake.server).length, 1);
});

test("prime poll fires immediately on surface startup when interval > 0", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  const calendarEventsPath = join(dir, "calendar", "events.json");
  writeFileSync(calendarFeedsPath, JSON.stringify({ urls: ["https://feed.example.com/family.ics"], version: 1 }));

  const start = new Date(Date.now() + 24 * 3600 * 1000);
  const fmt = (d: Date): string => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const end = new Date(start.getTime() + 3600 * 1000);
  const feedIcs = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//x//EN",
    "BEGIN:VEVENT", "UID:prime@family", `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    "SUMMARY:Prime poll", "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fetchCalls = 0;
  const fetchStub: FetchLike = async () => {
    fetchCalls += 1;
    await gate;
    return { status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(feedIcs).buffer } as unknown as Response;
  };
  const { scheduled, scheduleCalendarPoll } = recordingScheduler();
  const { calFake } = await startWithCalendarLink(dir, {
    calendarFeedsPath, calendarCachePath, calendarEventsPath,
    calendarPollIntervalMs: 1000,
    scheduleCalendarPoll,
    fetch: fetchStub,
  });

  assert.equal(fetchCalls, 1, "the prime starts immediately, independently of the scheduler");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].intervalMs, 1000);
  release();
  const msg = await calFake.server.next();

  assert.equal(msg.type, "changed", "the completed prime republishes after the socket is open");
  assert.equal(existsSync(calendarCachePath), true);
  const view = buildCalendarView(new Date(), { ownEventsPath: calendarEventsPath, cachePath: calendarCachePath });
  assert.equal((msg as { viewVersion: string }).viewVersion, calendarViewVersion(view));
  const changed = changedFrames(calFake.server);
  assert.equal(changed.length, 2, "exactly one post-open changed frame came from the prime");
});

test("calendar link: a feedUrls-carrying refresh racing an in-flight poll is queued and re-polled", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  writeFileSync(calendarFeedsPath, JSON.stringify({ urls: ["https://disk.example.com/disk.ics"], version: 1 }));

  const polled: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchStub: FetchLike = async (url: string) => {
    polled.push(url);
    await gate;
    return { status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n").buffer } as unknown as Response;
  };
  const { calFake } = await startWithCalendarLink(dir, { calendarFeedsPath, calendarCachePath, calendarPollIntervalMs: 0, fetch: fetchStub });

  // 1. a plain refresh starts the in-flight poll (gated; reads the on-disk feed).
  calFake.server.send({ v: 1, type: "command", id: 30, payload: { kind: "calendar-refresh" }, sig: "" } as any);
  for (let i = 0; i < 50 && polled.length < 1; i += 1) await calFake.flush();
  assert.equal(polled.length, 1);
  assert.equal(polled[0], "https://disk.example.com/disk.ics");

  // 2. while it is in flight, an override-carrying refresh arrives (the poll-on-feed-add path).
  calFake.server.send({ v: 1, type: "command", id: 31, payload: { kind: "calendar-refresh", feedUrls: ["https://payload.example.com/payload.ics"] }, sig: "" } as any);
  for (let i = 0; i < 50; i += 1) await calFake.flush();
  assert.equal(polled.length, 1, "the racing override is queued, not fetched yet");

  // 3. release the in-flight poll; the queued override is re-polled with its own URLs.
  release();
  for (let i = 0; i < 50 && polled.length < 2; i += 1) await calFake.flush();
  assert.equal(polled.length, 2, "the queued override was re-polled after the in-flight poll finished");
  assert.equal(polled[1], "https://payload.example.com/payload.ics");
});

test("calendar link: concurrent refresh commands are coalesced by pollCalendarOnce", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  writeFileSync(calendarFeedsPath, JSON.stringify({ urls: ["https://feed.example.com/family.ics"], version: 1 }));

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fetchCalls = 0;
  const fetchStub: FetchLike = async () => {
    fetchCalls += 1;
    await gate;
    return {
      status: 200,
      headers: new Map(),
      arrayBuffer: async () => new TextEncoder().encode("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n").buffer,
    } as unknown as Response;
  };
  const { calFake } = await startWithCalendarLink(dir, {
    calendarFeedsPath,
    calendarCachePath,
    calendarPollIntervalMs: 0,
    fetch: fetchStub,
  });
  const changedBefore = changedFrames(calFake.server).length;

  // Both commands are delivered while the first poll is suspended on the gated fetch.
  calFake.server.send({ v: 1, type: "command", id: 10, payload: { kind: "calendar-refresh" }, sig: "" } as any);
  calFake.server.send({ v: 1, type: "command", id: 11, payload: { kind: "calendar-refresh" }, sig: "" } as any);
  // The coalescing decision itself is synchronous (pollCalendarOnce sets `polling`
  // before its first await); the fetch begins only after the shared refresh's lock
  // acquisition, so wait for the FIRST fetch to start before counting.
  for (let i = 0; i < 200 && fetchCalls < 1; i += 1) await calFake.flush();
  assert.equal(fetchCalls, 1, "the second refresh is ignored while the first poll is in flight");

  release();
  const msg = await calFake.server.next();
  assert.equal(msg.type, "changed", "the completed poll republishes the view");
  await calFake.flush();

  assert.equal(existsSync(calendarCachePath), true, "the in-flight poll writes the cache");
  const changedAfter = changedFrames(calFake.server).length;
  assert.equal(changedAfter - changedBefore, 1, "coalesced refreshes produce exactly one changed frame");
});

// ---------- main(): a local calendar-file change reaches the calendar link as 'changed' ----------

test("a calendar own-events change drives watchCalendar's onChange -> a 'changed' push on the calendar link", async () => {
  const dir = tmp();
  const calendarEventsPath = join(dir, "calendar", "events.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  const calFake = new FakeSocketPair();
  let onChange: (() => void) | undefined;

  await main(baseDeps(dir, {
    calendarEventsPath, calendarCachePath,
    makeCalendarSocket: () => calFake.client,
    watchCalendar: (_own, _cache, cb) => { onChange = cb; return { close() {} }; },
  }));
  await calFake.server.next(); // the initial priming changed/hello pair (order not asserted here)
  await calFake.server.next();

  await addEvent(calendarEventsPath, { title: "Dentist", start: isoTomorrow() });
  assert.ok(onChange, "watchCalendar must have been wired up");
  onChange!();

  const msg = await calFake.server.next();
  assert.equal(msg.type, "changed");
});

test("a calendar family-cache change also drives watchCalendar's onChange -> a 'changed' push", async () => {
  const dir = tmp();
  const calendarEventsPath = join(dir, "calendar", "events.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  const calFake = new FakeSocketPair();
  let onChange: (() => void) | undefined;
  let watchedOwn = "";
  let watchedCache = "";

  await main(baseDeps(dir, {
    calendarEventsPath, calendarCachePath,
    makeCalendarSocket: () => calFake.client,
    watchCalendar: (own, cache, cb) => { watchedOwn = own; watchedCache = cache; onChange = cb; return { close() {} }; },
  }));
  await calFake.server.next();
  await calFake.server.next();

  assert.equal(watchedOwn, calendarEventsPath, "watchCalendar is wired to the own-events path");
  assert.equal(watchedCache, calendarCachePath, "watchCalendar is wired to the family-cache path");

  mkdirSync(dirname(calendarCachePath), { recursive: true });
  writeFileSync(calendarCachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), events: [] }));
  assert.ok(onChange, "watchCalendar must have been wired up");
  onChange!();

  const msg = await calFake.server.next();
  assert.equal(msg.type, "changed");
});

// ---------- calendar refresh lock contention + shared household tz (system-scheduled-tasks T8) ----------

test("calendar link: a lock-busy refresh degrades -- logErr line, prior cache byte-identical, polling flag released, surface alive", async () => {
  const dir = tmp();
  const calendarFeedsPath = join(dir, "calendar-feeds.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  const calendarEventsPath = join(dir, "calendar", "events.json");
  writeFileSync(calendarFeedsPath, JSON.stringify({ urls: ["https://feed.example.com/family.ics"], version: 1 }));
  mkdirSync(dirname(calendarCachePath), { recursive: true });
  const priorBytes = JSON.stringify({ fetchedAt: "2026-01-01T00:00:00.000Z", events: [{ uid: "keep@family", title: "Keep", location: null, startMs: 1, endMs: null, allDay: false, rrule: null, url: null }] });
  writeFileSync(calendarCachePath, priorBytes);

  const start = new Date(Date.now() + 24 * 3600 * 1000);
  const fmt = (d: Date): string => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const feedIcs = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//x//EN", "BEGIN:VEVENT", "UID:post@family", `DTSTART:${fmt(start)}`, "SUMMARY:After contention", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  let fetchCalls = 0;
  const fetchStub: FetchLike = async () => {
    fetchCalls += 1;
    return { status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(feedIcs).buffer } as unknown as Response;
  };
  const errs: string[] = [];
  const { calFake } = await startWithCalendarLink(dir, {
    calendarFeedsPath, calendarCachePath, calendarEventsPath,
    calendarPollIntervalMs: 0, fetch: fetchStub, logErr: (m) => { errs.push(m); },
  });
  const changedBefore = changedFrames(calFake.server).length;

  // Hold the REAL refresh lock on the same lock target (recent mtime -- not stale
  // within the fixed 480s window), as another process's in-flight refresh would.
  const release = await lockfile.lock(refreshLockTarget(calendarCachePath), { realpath: false, stale: REFRESH_LOCK_STALE_MS, retries: { retries: 0 } });
  try {
    calFake.server.send({ v: 1, type: "command", id: 50, payload: { kind: "calendar-refresh" }, sig: "" } as any);
    // The poll exhausts its bounded acquisition retries (~8s) and degrades through
    // pollCalendarOnce's existing catch: deps.logErr, no cache write, no republish.
    await waitUntil(() => errs.some((m) => m.includes("calendar poll failed")), 15_000);
    assert.ok(errs.some((m) => /calendar poll failed/.test(m) && /lock/.test(m)), "the logErr line names the lock failure");
    assert.equal(readFileSync(calendarCachePath, "utf8"), priorBytes, "the prior cache is byte-identical");
    assert.equal(fetchCalls, 0, "no feed was fetched while the lock was held");
    assert.equal(changedFrames(calFake.server).length, changedBefore, "the degraded poll does not republish");
  } finally {
    await release();
  }

  // The polling flag was released in the finally: a subsequent poll attempt is
  // accepted (not dropped as in-flight), the fetch runs, and the surface -- never
  // crashed -- republishes the refreshed view.
  calFake.server.send({ v: 1, type: "command", id: 51, payload: { kind: "calendar-refresh" }, sig: "" } as any);
  await waitUntil(() => fetchCalls >= 1, 5_000);
  const msg = await calFake.server.next();
  assert.equal(msg.type, "changed", "the accepted poll republishes after contention clears");
  const cached = JSON.parse(readFileSync(calendarCachePath, "utf8")) as { events: Array<{ uid: string }> };
  assert.equal(cached.events[0].uid, "post@family", "the post-contention poll wrote the cache");
});

test("calendar link: the view resolves tz via householdTz (invalid BAXTER_TZ falls back to valid HEARTBEAT_TZ)", async () => {
  const dir = tmp();
  const calendarEventsPath = join(dir, "calendar", "events.json");
  const calendarCachePath = join(dir, "calendar", "family-cache.json");
  const calFake = new FakeSocketPair();

  await main(baseDeps(dir, {
    calendarEventsPath, calendarCachePath,
    env: { BAXTER_TZ: "Not/AZone", HEARTBEAT_TZ: "America/New_York" },
    makeCalendarSocket: () => calFake.client,
  }));
  await calFake.server.next();
  await calFake.server.next();

  calFake.server.send({ v: 1, type: "pull", id: 60 } as any);
  const msg = await calFake.server.next();
  assert.equal(msg.type, "view");
  // The served view's day window is built in the HEARTBEAT_TZ zone (BAXTER_TZ is
  // garbage): Home's calendar display agrees with the digest and the system cron.
  assert.equal(((msg as { view: unknown }).view as { tz: string }).tz, "America/New_York");
});

// ---------- applyMembersCommand + canonical todo lists (checklistsPath opt) ----------
// The members apply is also the trigger for the container-side canonical reconcile: every
// applied snapshot (sync on connect, mutation on edit) mints the flagged household-todo +
// per-member todo lists BEFORE the republish fires, so the view the DO receives already
// carries them. Reconcile failure never blocks the republish.

test("applyMembersCommand with checklistsPath: a sync apply mints the canonical todo lists, then republishes", async () => {
  const dir = tmp(); const p = join(dir, "allowlist.json"); const cp = join(dir, "checklists.json");
  let n = 0;
  await applyMembersCommand(
    { senders: [], recipients: ["op@example.com"], version: 1, reason: "sync", names: { "op@example.com": "Op" } },
    {} as any, p, () => { n++; }, () => {},
    { checklistsPath: cp },
  );
  assert.equal(n, 1, "onApplied fired exactly once, after the reconcile");
  const store = JSON.parse(readFileSync(cp, "utf8")) as { special?: string; memberAddress?: string; name?: string }[];
  assert.ok(store.some((l) => l.special === "household-todo"), "household-todo minted");
  assert.ok(store.some((l) => l.special === "member-todo" && l.memberAddress === "op@example.com" && l.name === "Op-todo"), "operator's todo minted from the names map");
});

test("applyMembersCommand with checklistsPath: a stale mutation neither reconciles nor republishes", async () => {
  const dir = tmp(); const p = join(dir, "allowlist.json"); const cp = join(dir, "checklists.json");
  writeFileSync(p, JSON.stringify({ senders: [], recipients: [], version: 5, names: {} }));
  let n = 0;
  await applyMembersCommand(
    { senders: ["a@x.com"], recipients: ["a@x.com"], version: 2, reason: "mutation" },
    {} as any, p, () => { n++; }, () => {},
    { checklistsPath: cp },
  );
  assert.equal(n, 0, "stale mutation skipped entirely");
  assert.equal(existsSync(cp), false, "no store was minted");
});

test("applyMembersCommand with checklistsPath: a corrupt store logs the reconcile failure but STILL republishes", async () => {
  const dir = tmp(); const p = join(dir, "allowlist.json"); const cp = join(dir, "checklists.json");
  writeFileSync(cp, "not json");
  const errs: string[] = []; let n = 0;
  await applyMembersCommand(
    { senders: [], recipients: ["op@example.com"], version: 1, reason: "sync" },
    {} as any, p, () => { n++; }, (m) => { errs.push(m); },
    { checklistsPath: cp },
  );
  assert.equal(n, 1, "the republish is not held hostage by the reconcile");
  assert.ok(errs.some((m) => m.includes("canonical")), "the failure was logged");
});

test("applyMembersCommand with checklistsPath: removing the last member clears their list's flag (the list survives, ordinary)", async () => {
  const dir = tmp(); const p = join(dir, "allowlist.json"); const cp = join(dir, "checklists.json");
  await applyMembersCommand({ senders: [], recipients: ["op@example.com"], version: 1, reason: "sync", names: { "op@example.com": "Op" } }, {} as any, p, () => {}, () => {}, { checklistsPath: cp });
  await applyMembersCommand({ senders: [], recipients: [], version: 2, reason: "mutation" }, {} as any, p, () => {}, () => {}, { checklistsPath: cp });
  const store = JSON.parse(readFileSync(cp, "utf8")) as { slug?: string; special?: string; memberAddress?: string }[];
  const op = store.find((l) => l.slug === "op-todo");
  assert.ok(op, "the list itself was not deleted");
  assert.equal(op.special, undefined, "flag cleared");
  assert.equal(op.memberAddress, undefined);
  assert.ok(store.some((l) => l.special === "household-todo"), "household-todo stays");
});

test("applyMembersCommand serializes rapid-fire reconciles: two un-awaited applies end at the LAST roster (chain, not lock race)", async () => {
  const dir = tmp(); const p = join(dir, "allowlist.json"); const cp = join(dir, "checklists.json");
  const mk = (who: string, version: number) => ({ senders: [], recipients: [who], version, reason: "mutation" as const, names: {} });
  // Fire both WITHOUT awaiting the first -- the exact race the chain exists to close. The
  // allowlist writes are synchronous and gated (v2 then v3), but the reconciles are async;
  // without arrival-order chaining, proper-lockfile's non-FIFO acquisition could apply the
  // v2 roster's reconcile after v3's, leaving a stale flagged list for the removed member.
  const r1 = applyMembersCommand(mk("a@x.com", 2), {} as any, p, () => {}, () => {}, { checklistsPath: cp }) as Promise<void>;
  const r2 = applyMembersCommand(mk("b@y.com", 3), {} as any, p, () => {}, () => {}, { checklistsPath: cp }) as Promise<void>;
  await Promise.all([r1, r2]);
  const store = JSON.parse(readFileSync(cp, "utf8")) as { special?: string; memberAddress?: string }[];
  const memberLists = store.filter((l) => l.special === "member-todo");
  assert.deepEqual(memberLists.map((l) => l.memberAddress).sort(), ["b@y.com"], "reconciled to the LAST roster only -- a@x.com's list was cleared, not minted");
});

test("wiring: a members sync through the real onCommand mints the canonical lists and republishes (changed) with the flag", async () => {
  const dir = tmp();
  const allowlistPath = join(dir, "allowlist.json");
  const checklistsPath = join(dir, "checklists.json");
  const fake = new FakeSocketPair();

  await main(baseDeps(dir, { makeSocket: () => fake.client, allowlistPath }));
  await fake.server.next(); // hello

  fake.server.send({
    v: 1, type: "command", id: 1,
    payload: { senders: [], recipients: ["op@example.com"], version: 1, reason: "sync", names: { "op@example.com": "Op" } },
    sig: "",
  } as any);

  // The reconcile + republish run async (chained, fire-and-forget on the surface too).
  // Wait on the CONTENT, not file existence: mutate's ensureFile creates the file as "[]"
  // before the locked write + rename lands, so existsSync can pass one beat early.
  const minted = () => { try { return (JSON.parse(readFileSync(checklistsPath, "utf8")) as { special?: string }[]).some((l) => l.special); } catch { return false; } };
  await waitUntil(minted, 5_000);
  const store = JSON.parse(readFileSync(checklistsPath, "utf8")) as { special?: string; name?: string }[];
  assert.ok(store.some((l) => l.special === "household-todo"), "household-todo minted through the real wiring");
  assert.ok(store.some((l) => l.special === "member-todo" && l.name === "Op-todo"), "the operator's todo minted from the pushed names map");
  // The republish: a `changed` frame went back up the link AFTER the mint, so the DO's
  // next view carries the flagged lists.
  await waitUntil(() => fake.server.rawReceived.some((r) => r.includes("\"changed\"")), 5_000);
});
