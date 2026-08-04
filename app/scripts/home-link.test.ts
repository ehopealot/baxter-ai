// Tests for the core-side home-link WS transport: connect -> hello + immediate
// heartbeat, the ~30s heartbeat cadence, and down-message routing (pull ->
// onPull, intent -> onIntent). Transport only -- no buildView/applyIntent wiring
// (that's B3) and no reconnect/backoff (B2); see home-link.ts's header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HomeLink } from "./home-link.ts";
import type { LinkMsg } from "./home-link.ts";
import { FakeSocketPair } from "./home-link.testkit.ts";

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

test("malformed intent frames (missing/empty/array/non-integer-id intent) are dropped, not routed to onIntent", async () => {
  const fake = new FakeSocketPair();
  const seen: unknown[] = [];
  const link = new HomeLink({ connect: () => fake.client, viewVersion: () => null, appliedThrough: () => 0 });
  link.onIntent((i) => seen.push(i));
  link.start();
  await fake.server.next(); // hello, so the socket is fully open before we inject
  // Deliberately malformed wire input (protocol drift / truncation) -- not valid
  // IntentMsgs, hence the casts; the point is HomeLink must not blow up or forward any of
  // them. Each pins one gap the guard closes: no `intent` field at all, a field-less `{}`,
  // an `[]` (equally "an object" by a bare typeof/non-null check), and a non-integer id
  // (the `1e999` -> `Infinity` case -- worse than id-less, since it would permanently wedge
  // a real drain loop's `appliedThrough` cursor rather than fail once).
  fake.server.send({ v: 1, type: "intent", id: 2 } as unknown as LinkMsg);
  fake.server.send({ v: 1, type: "intent", id: 3, intent: {} } as unknown as LinkMsg);
  fake.server.send({ v: 1, type: "intent", id: 4, intent: [] } as unknown as LinkMsg);
  // Raw text, not send(msg): JSON.stringify({id: 1e999}) would serialize the id as
  // `null` (JSON.stringify's behavior for non-finite numbers), which never exercises
  // the Infinity path this case is for. A drifted/malformed real peer sending the
  // literal digits "1e999" is what makes JSON.parse produce Infinity on THIS end.
  fake.server.sendRaw('[{"v":1,"type":"intent","id":5,"intent":{"id":1e999,"kind":"check","listSlug":"g","itemId":"i"}}]');
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
