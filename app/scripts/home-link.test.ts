// Tests for the core-side home-link WS transport: connect -> hello + immediate
// heartbeat, the ~30s heartbeat cadence, down-message routing (pull -> onPull,
// intent -> onIntent), and (B2) reconnect/backoff/heartbeat-ack liveness. Transport
// only -- no buildView/applyIntent wiring (that's B3); see home-link.ts's header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HomeLink, HB_ACK_TIMEOUT_MS } from "./home-link.ts";
import type { LinkMsg, WebSocketLike } from "./home-link.ts";
import { FakeSocketPair } from "./home-link.testkit.ts";

// A minimal, manually-driven WebSocketLike stub for the reconnect/backoff tests below.
// Unlike FakeSocketPair (which auto-fires "open" and is meant for the hello/heartbeat/
// routing tests), this one does NOTHING until the test calls one of the emit* methods --
// which is exactly what's needed to simulate a connect attempt that fails before ever
// reaching "open" (a refused/timed-out connection), back to back, without a hello/backoff
// reset sneaking in between redials.
class StubSocket implements WebSocketLike {
  listeners: Map<string, Array<(ev?: unknown) => void>> = new Map();
  sent: string[] = [];
  closeCalls = 0;

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: string }) => void): void;
  addEventListener(type: "close", listener: (ev?: unknown) => void): void;
  addEventListener(type: "error", listener: (ev?: unknown) => void): void;
  addEventListener(type: string, listener: (...args: never[]) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener as (ev?: unknown) => void);
    this.listeners.set(type, arr);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  emitOpen(): void {
    for (const l of this.listeners.get("open") ?? []) l();
  }

  emitClose(): void {
    for (const l of this.listeners.get("close") ?? []) l();
  }

  emitError(): void {
    for (const l of this.listeners.get("error") ?? []) l();
  }

  emitMessage(data: string): void {
    for (const l of this.listeners.get("message") ?? []) l({ data });
  }
}

test("sends hello on connect with current cursors", async () => {
  const fake = new FakeSocketPair();
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => "v1", appliedThrough: () => 3 });
  link.start();
  const first = await fake.server.next();
  assert.equal(first.type, "hello");
  assert.equal((first as { viewVersion: unknown }).viewVersion, "v1");
  assert.equal((first as { appliedThrough: unknown }).appliedThrough, 3);
});

test("hello carries protocol:1 and a null viewVersion round-trips (fresh container, never published)", async () => {
  const fake = new FakeSocketPair();
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => null, appliedThrough: () => 0 });
  link.start();
  const first = await fake.server.next();
  assert.deepEqual(first, { v: 1, type: "hello", id: 1, viewVersion: null, appliedThrough: 0, protocol: 1 });
});

test("onOpen fires before hello is sent, on the initial connect", async () => {
  const fake = new FakeSocketPair();
  const events: string[] = [];
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => null, appliedThrough: () => 0 });
  link.onOpen(() => events.push("open"));
  link.start();
  const first = await fake.server.next();
  assert.equal(first.type, "hello", "hello is the first envelope the server sees");
  assert.deepEqual(events, ["open"], "onOpen already fired by the time hello arrived");
});

test("onOpen fires again on every reconnect, not just the first connect", () => {
  const sockets: StubSocket[] = [];
  const opens: number[] = [];
  const link = new HomeLink({
    connect: () => { const s = new StubSocket(); sockets.push(s); return s; },
    viewVersion: () => null,
    appliedThrough: () => 0,
  });
  link.onOpen(() => opens.push(sockets.length));

  link.start();
  sockets[0].emitOpen();
  assert.deepEqual(opens, [1], "fired on the initial connect");

  link.start(); // simulates a driver-initiated reconnect (start() supersedes)
  sockets[1].emitOpen();
  assert.deepEqual(opens, [1, 2], "fired again on the new connection");
});

test("routes an inbound intent to onIntent", async () => {
  const fake = new FakeSocketPair();
  const seen: unknown[] = [];
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => null, appliedThrough: () => 0 });
  link.onIntent((i) => seen.push(i));
  link.start();
  fake.server.send({ v: 1, type: "intent", id: 1, intent: { id: 9, kind: "check", listSlug: "g", itemId: "i", at: "t" } });
  await fake.flush();
  assert.equal((seen[0] as { id: number }).id, 9);
});

test("routes an inbound pull to onPull, carrying the pull's own id (for the later view's inReplyTo)", async () => {
  const fake = new FakeSocketPair();
  const seen: number[] = [];
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => "v1", appliedThrough: () => 0 });
  link.onPull((pullId) => seen.push(pullId));
  link.start();
  fake.server.send({ v: 1, type: "pull", id: 7 });
  await fake.flush();
  assert.deepEqual(seen, [7]);
});

test("sends an immediate 'hb' heartbeat on open, BEFORE the ~30s interval fires", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fake = new FakeSocketPair();
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => null, appliedThrough: () => 0 });
  link.start();
  await fake.server.next(); // wait for hello, which is sent (synchronously) just before the immediate hb
  const hbCount = () => fake.server.rawReceived.filter((r) => r === "hb").length;
  assert.equal(hbCount(), 1, "hb must be sent on open, not gated behind the interval");
  t.mock.timers.tick(29_999);
  await Promise.resolve(); // let the fake socket's queueMicrotask delivery settle
  assert.equal(hbCount(), 1, "no second hb before ~30s has elapsed");
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(hbCount(), 2, "the interval fires its own hb at ~30s");
});

test("stop() clears the heartbeat interval -- no further hb after stop", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fake = new FakeSocketPair();
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => null, appliedThrough: () => 0 });
  link.start();
  await fake.server.next(); // hello
  link.stop();
  const hbCountBefore = fake.server.rawReceived.filter((r) => r === "hb").length;
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  const hbCountAfter = fake.server.rawReceived.filter((r) => r === "hb").length;
  assert.equal(hbCountAfter, hbCountBefore, "stop() must clear the heartbeat timer");
});

test("malformed intent frames (missing/empty/array/non-safe-integer-id intent) are dropped, not routed to onIntent", async () => {
  const fake = new FakeSocketPair();
  const seen: unknown[] = [];
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => null, appliedThrough: () => 0 });
  link.onIntent((i) => seen.push(i));
  link.start();
  await fake.server.next(); // hello, so the socket is fully open before we inject
  // Deliberately malformed wire input (protocol drift / truncation) -- not valid
  // IntentMsgs, hence the casts; the point is HomeLink must not blow up or forward any of
  // them. Each pins one gap the guard closes: no `intent` field at all, a field-less `{}`,
  // an `[]` (equally "an object" by a bare typeof/non-null check), a non-integer id (the
  // `1e999` -> `Infinity` case), and a huge-but-finite id (`1e300`, which Number.isInteger
  // admits but Number.isSafeInteger does not) -- all of which would permanently wedge a
  // real drain loop's `appliedThrough` cursor rather than fail once.
  fake.server.send({ v: 1, type: "intent", id: 2 } as unknown as LinkMsg);
  fake.server.send({ v: 1, type: "intent", id: 3, intent: {} } as unknown as LinkMsg);
  fake.server.send({ v: 1, type: "intent", id: 4, intent: [] } as unknown as LinkMsg);
  // Raw text, not send(msg): JSON.stringify({id: 1e999}) would serialize the id as
  // `null` (JSON.stringify's behavior for non-finite numbers), which never exercises
  // the Infinity path this case is for. A drifted/malformed real peer sending the
  // literal digits "1e999" is what makes JSON.parse produce Infinity on THIS end.
  fake.server.sendRaw('[{"v":1,"type":"intent","id":5,"intent":{"id":1e999,"kind":"check","listSlug":"g","itemId":"i"}}]');
  // Same reasoning for the huge-but-finite case: 1e300 round-trips through
  // JSON.stringify fine (it's a real double), so this one COULD use send(), but
  // sendRaw keeps both edge cases side by side in the same literal-frame style.
  fake.server.sendRaw('[{"v":1,"type":"intent","id":6,"intent":{"id":1e300,"kind":"check","listSlug":"g","itemId":"i"}}]');
  await fake.flush();
  assert.deepEqual(seen, []);
});

test("a pull frame with a non-safe-integer id (Infinity or a huge finite double) is dropped, not routed to onPull", async () => {
  const fake = new FakeSocketPair();
  const seen: number[] = [];
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => null, appliedThrough: () => 0 });
  link.onPull((pullId) => seen.push(pullId));
  link.start();
  await fake.server.next(); // hello
  // Same threat as the intent-id cases above, on the sibling pull branch: pull's id is
  // later echoed back as a view's inReplyTo, and Infinity serializes as `null` on that
  // reply -- a reply the DO can't correlate to anything.
  fake.server.sendRaw('[{"v":1,"type":"pull","id":1e999}]');
  fake.server.sendRaw('[{"v":1,"type":"pull","id":1e300}]');
  await fake.flush();
  assert.deepEqual(seen, []);
});

test("start() supersedes: closes the previous socket, and a superseded socket's LATE close does not kill the new socket's heartbeat", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fakeA = new FakeSocketPair();
  const fakeB = new FakeSocketPair();
  const sockets = [fakeA.client, fakeB.client];
  let i = 0;
  const link = new HomeLink({ connect: () => sockets[i++], viewVersion: () => null, appliedThrough: () => 0 });

  link.start(); // connects A
  await fakeA.server.next(); // hello on A; A's heartbeat is now armed

  link.start(); // supersedes: should close A, then connect B
  await fakeB.server.next(); // hello on B; B's heartbeat is now armed
  assert.equal(fakeA.server.closed, true, "start() must close the superseded socket, not just neutralize it");

  // Simulate A's underlying close event landing well after B is already live --
  // independent of whatever close() start() already issued against A above (a
  // real WebSocket's close is async and can lag by an arbitrary amount).
  fakeA.client.close();
  await Promise.resolve();
  await Promise.resolve();

  const hbCountB = () => fakeB.server.rawReceived.filter((r) => r === "hb").length;
  assert.equal(hbCountB(), 1, "just the immediate hb on B so far");
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(hbCountB(), 2, "B's heartbeat interval must survive A's late close");
});

test("sendChanged / sendView / sendAck frame the right envelope with monotonically increasing up-ids", async () => {
  const fake = new FakeSocketPair();
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => "v1", appliedThrough: () => 0 });
  link.start();
  const hello = await fake.server.next();
  assert.equal(hello.id, 1);

  link.sendChanged("v2");
  const changed = await fake.server.next();
  assert.deepEqual(changed, { v: 1, type: "changed", id: 2, viewVersion: "v2" });

  const view = { lists: [], projects: [], recipients: [] as string[] };
  link.sendView(7, view, "v2");
  const viewMsg = await fake.server.next();
  assert.deepEqual(viewMsg, { v: 1, type: "view", id: 3, inReplyTo: 7, view, viewVersion: "v2" });

  link.sendAck(5);
  const ack = await fake.server.next();
  assert.deepEqual(ack, { v: 1, type: "ack", id: 4, appliedThrough: 5 });
});

// ---------- B2: reconnect + exponential backoff + heartbeat-ack liveness ----------

test("close before ever opening (repeated connect failures): backoff grows 30s -> 60s -> 120s -> 240s -> capped 300s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: StubSocket[] = [];
  const link = new HomeLink({
    connect: () => { const s = new StubSocket(); sockets.push(s); return s; },
    viewVersion: () => null,
    appliedThrough: () => 0,
  });

  link.start();
  assert.equal(sockets.length, 1);
  sockets[0].emitClose(); // fails before ever opening -- no hello, so no backoff reset

  t.mock.timers.tick(29_999);
  assert.equal(sockets.length, 1, "no redial before 30s");
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 2, "redial at 30s");

  sockets[1].emitClose();
  t.mock.timers.tick(59_999);
  assert.equal(sockets.length, 2, "no redial before 60s");
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 3, "next redial at 60s");

  sockets[2].emitClose();
  t.mock.timers.tick(119_999);
  assert.equal(sockets.length, 3, "no redial before 120s");
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 4, "next redial at 120s");

  sockets[3].emitClose();
  t.mock.timers.tick(239_999);
  assert.equal(sockets.length, 4, "no redial before 240s");
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 5, "next redial at 240s");

  sockets[4].emitClose();
  t.mock.timers.tick(299_999);
  assert.equal(sockets.length, 5, "no redial before 300s");
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 6, "capped at 300s");

  sockets[5].emitClose();
  t.mock.timers.tick(300_000); // the very next failure redials at 300s again, not 600s -- proves the cap holds
  assert.equal(sockets.length, 7, "stays capped at 300s on the next failure too");
});

test("a socket 'error' event (not just close) also redials, on the same backoff schedule", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: StubSocket[] = [];
  const link = new HomeLink({
    connect: () => { const s = new StubSocket(); sockets.push(s); return s; },
    viewVersion: () => null,
    appliedThrough: () => 0,
  });
  link.start();
  sockets[0].emitError();
  t.mock.timers.tick(29_999);
  assert.equal(sockets.length, 1, "no redial before 30s");
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 2, "redial after 30s on error, same as close");
});

test("open + hello with NO 'hbk' does not reset backoff: it keeps growing 30s -> 60s -> 120s -> 240s -> capped 300s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  // 7 real connections, each of which opens and sends hello (so this is NOT the "never
  // reaches open" case the earlier StubSocket test covers) -- but none of which ever gets an
  // "hbk" back. If hello-send alone reset the backoff, every one of these would redial at a
  // flat 30s forever; the point of this test is that it does NOT.
  const fakes = Array.from({ length: 7 }, () => new FakeSocketPair());
  let i = 0;
  const link = new HomeLink({ connect: () => fakes[i++].client, viewVersion: () => null, appliedThrough: () => 0 });

  async function openThenDieWithNoHbk(n: number): Promise<void> {
    await fakes[n].server.next(); // hello -- deliberately never answered with "hbk"
    fakes[n].client.close();
    await Promise.resolve();
    await Promise.resolve(); // let the close event land
  }

  link.start();
  await openThenDieWithNoHbk(0);
  t.mock.timers.tick(29_999);
  assert.equal(i, 1, "no redial before 30s");
  t.mock.timers.tick(1);
  assert.equal(i, 2, "redial at 30s");

  await openThenDieWithNoHbk(1);
  t.mock.timers.tick(59_999);
  assert.equal(i, 2, "no redial before 60s -- if hello alone reset the backoff this would already be pinned at 30s");
  t.mock.timers.tick(1);
  assert.equal(i, 3, "next redial at 60s, not a repeated 30s -- hello alone did NOT reset it");

  await openThenDieWithNoHbk(2);
  t.mock.timers.tick(119_999);
  assert.equal(i, 3, "no redial before 120s");
  t.mock.timers.tick(1);
  assert.equal(i, 4, "next redial at 120s");

  await openThenDieWithNoHbk(3);
  t.mock.timers.tick(239_999);
  assert.equal(i, 4, "no redial before 240s");
  t.mock.timers.tick(1);
  assert.equal(i, 5, "next redial at 240s");

  await openThenDieWithNoHbk(4);
  t.mock.timers.tick(299_999);
  assert.equal(i, 5, "no redial before 300s");
  t.mock.timers.tick(1);
  assert.equal(i, 6, "capped at 300s");

  await openThenDieWithNoHbk(5);
  t.mock.timers.tick(300_000); // the next failure redials at 300s again, not 600s -- the cap holds
  assert.equal(i, 7, "stays capped at 300s -- never resets, since no hbk ever arrived");
});

test("the first 'hbk' on a fresh connection resets backoff -- the next close redials at 30s again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const fakeA = new FakeSocketPair();
  const fakeB = new FakeSocketPair();
  const fakeC = new FakeSocketPair();
  const sockets = [fakeA.client, fakeB.client, fakeC.client];
  let i = 0;
  const link = new HomeLink({ connect: () => sockets[i++], viewVersion: () => null, appliedThrough: () => 0 });

  link.start(); // connects A
  await fakeA.server.next(); // hello on A
  fakeA.server.sendRaw("hbk"); // the DO's round-trip answer to the immediate hb -- THIS resets backoff
  await Promise.resolve();
  await Promise.resolve();

  fakeA.client.close(); // A dies
  await Promise.resolve();
  await Promise.resolve(); // let A's close event land (FakeEndpoint.close is one microtask out)

  t.mock.timers.tick(29_999);
  assert.equal(i, 1, "not yet redialed");
  t.mock.timers.tick(1); // 30s total -> redial connects B
  assert.equal(i, 2, "redial at 30s after A's close");
  await fakeB.server.next(); // hello on B
  fakeB.server.sendRaw("hbk"); // B's round trip -- resets backoff again
  await Promise.resolve();
  await Promise.resolve();

  fakeB.client.close(); // B dies
  await Promise.resolve();
  await Promise.resolve();

  t.mock.timers.tick(29_999);
  assert.equal(i, 2, "not yet redialed");
  t.mock.timers.tick(1); // 30s again, NOT 60s -- proves the hbk-triggered reset actually took effect
  assert.equal(i, 3, "redial at 30s again after B's close, not a continued-growing 60s");
  await fakeC.server.next(); // hello on C, confirming the link is genuinely alive again
});

test("a missed heartbeat-ack (no 'hbk' within the liveness window) triggers a reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const fakeA = new FakeSocketPair();
  const fakeB = new FakeSocketPair();
  const sockets = [fakeA.client, fakeB.client];
  let i = 0;
  const link = new HomeLink({ connect: () => sockets[i++], viewVersion: () => null, appliedThrough: () => 0 });

  link.start();
  await fakeA.server.next(); // hello on A; the immediate hb right after it arms the ack-wait timer

  // Deliberately never reply "hbk" -- A is a half-open connection: still "open" from the
  // transport's own perspective, but nothing is actually answering the heartbeat.
  t.mock.timers.tick(HB_ACK_TIMEOUT_MS - 1);
  assert.equal(i, 1, "not yet redialed -- still within the liveness window");
  t.mock.timers.tick(1); // HB_ACK_TIMEOUT_MS elapsed with no "hbk" -- declared dead
  await Promise.resolve();
  await Promise.resolve(); // let the best-effort socket.close() microtask land
  assert.equal(fakeA.server.closed, true, "the dead socket is closed once liveness gives up on it");
  assert.equal(i, 1, "the redial itself still goes through the normal backoff, not immediate");

  t.mock.timers.tick(29_999);
  assert.equal(i, 1, "still backing off");
  t.mock.timers.tick(1); // the 30s backoff (from the missed-hbk) elapses -> redial
  assert.equal(i, 2, "redials after the missed-hbk backoff");
  await fakeB.server.next(); // B connects and sends hello, proving the link is alive again
});

test("a timely 'hbk' clears the liveness timer -- no false-positive redial", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const fake = new FakeSocketPair();
  let connectCount = 0;
  const link = new HomeLink({ connect: () => { connectCount++; return fake.client; }, viewVersion: () => null, appliedThrough: () => 0 });

  link.start(); // connectCount becomes 1
  await fake.server.next(); // hello; the immediate hb right after arms the ack-wait timer
  fake.server.sendRaw("hbk"); // the DO's free-answer, exactly as production delivers it
  // NOT fake.flush(): it resolves via a real setTimeout(0), which this test's mock timers
  // (apis: ["setTimeout", "setInterval"]) intercept -- it would never fire without an
  // explicit tick. A couple of microtask flushes are enough for the queueMicrotask-based
  // send/delivery in home-link.testkit.ts to settle.
  await Promise.resolve();
  await Promise.resolve();

  // Just under HB_ACK_TIMEOUT_MS: past where the (now-cleared) original ack-wait timer would
  // have fired, and still under where the ~30s-later interval hb's OWN fresh timer would.
  t.mock.timers.tick(HB_ACK_TIMEOUT_MS - 1);
  assert.equal(connectCount, 1, "a live, acked link never redials");
});
