// Tests for the family-home surface driver's lifecycle (B4): idle-if-unprovisioned is
// preserved, a provisioned tenant starts exactly one HomeLink dialing a correctly SigV4-
// signed wss://.../svc/<tenant>/link, and a local checklist-store change reaches the link
// as a 'changed' push. Light -- most logic (HomeLink's transport, wireLink's apply/ack) is
// already pinned in home-link.test.ts/home-mirror.test.ts; this file is the wiring only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { watch } from "node:fs";
import { main, signedLinkConnect, watchChecklistStore } from "./home-bot.ts";
import type { HomeBotDeps } from "./home-bot.ts";
import type { WebSocketLike } from "./home-link.ts";
import type { HomeKeys } from "./home-mirror.ts";
import { FakeSocketPair } from "./home-link.testkit.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "hb-"));
const KEYS: HomeKeys = { endpoint: "https://home.example.com", tenant: "acme", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-key" };

function noopWatch(): { close(): void } { return { close() {} }; }
function baseDeps(dir: string, over: Partial<HomeBotDeps> = {}): HomeBotDeps {
  return {
    loadHomeKeys: () => KEYS,
    checklistsPath: join(dir, "checklists.json"),
    statePath: join(dir, "home-state.json"),
    env: {},
    watchChecklists: noopWatch,
    idle: () => { throw new Error("must not idle -- keys were present"); },
    log: () => {},
    logErr: () => {},
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
  const httpKeys: HomeKeys = { ...KEYS, endpoint: "http://localhost:8787/" }; // trailing slash, like a real endpoint value
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
