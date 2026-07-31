// Tests for the family-home mirror: the pure builders (buildView / viewVersion /
// resolvePollAfterMs / recipientsFromEnv), applyIntent through the checklist lock, and the
// full runSyncTick orchestration -- every happy AND failure path from the spec's §Testing
// list, run against a fake HomeOps + a temp store, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildView, viewVersion, resolvePollAfterMs, recipientsFromEnv, applyIntent,
  runSyncTick, freshMemo, SyncHttpError, STOP_SYNCING,
} from "./home-mirror.ts";
import type { HomeOps, SyncRequest, SyncResponse, TickDeps, ViewProject } from "./home-mirror.ts";
import type { Checklist, Item } from "./checklist-store.ts";
import { loadState, freshState } from "./home-state.ts";
import type { HomeState } from "./home-state.ts";

// ---------- fixtures ----------

const NOW = 1_700_000_000_000;
const tmp = (): string => mkdtempSync(join(tmpdir(), "hm-"));
const item = (id: string, text: string, o: Partial<Item> = {}): Item => ({ id, text, checked: false, created: "", ...o });
const cl = (o: Partial<Checklist>): Checklist => ({ id: o.slug ?? "l", slug: "l", name: "L", items: [], created: "", updated: "", ...o });

function seedStore(dir: string, lists: Checklist[]): string {
  const p = join(dir, "checklists.json");
  writeFileSync(p, JSON.stringify(lists));
  return p;
}
function seedState(dir: string, over: Partial<HomeState> = {}): string {
  const p = join(dir, "home-state.json");
  if (Object.keys(over).length) writeFileSync(p, JSON.stringify({ ...freshState(), ...over }));
  return p;
}

// A fake HomeOps driven by a per-call handler; records the requests it saw.
function fakeOps(handler: (req: SyncRequest, call: number) => SyncResponse): { ops: HomeOps; calls: SyncRequest[] } {
  const calls: SyncRequest[] = [];
  const ops: HomeOps = { async sync(req) { const n = calls.length; calls.push(JSON.parse(JSON.stringify(req))); return handler(req, n); } };
  return { ops, calls };
}

function makeDeps(ops: HomeOps, dir: string, over: Partial<TickDeps> = {}): { deps: TickDeps; alerts: string[]; logs: string[]; errs: string[] } {
  const alerts: string[] = [], logs: string[] = [], errs: string[] = [];
  const deps: TickDeps = {
    ops,
    checklistsPath: join(dir, "checklists.json"),
    statePath: join(dir, "home-state.json"),
    buildProjects: () => [],
    env: {},
    now: () => NOW,
    log: (m) => logs.push(m),
    logErr: (m) => errs.push(m),
    alert: (m) => alerts.push(m),
    ...over,
  };
  return { deps, alerts, logs, errs };
}
const readStore = (dir: string): Checklist[] => JSON.parse(readFileSync(join(dir, "checklists.json"), "utf8"));

// ---------- pure builders ----------

test("buildView: open/total counts, due normalized to null, excludes deleted lists, keeps item ids", () => {
  const lists = [
    cl({ slug: "g", name: "Groceries", items: [item("a", "milk"), item("b", "eggs", { checked: true }), item("c", "bread", { due: "2026-08-01T00:00:00Z" })] }),
    cl({ slug: "old", name: "Old", deleted: true, items: [item("z", "gone")] }),
  ];
  const view = buildView(lists, ["p@x.com"], []);
  assert.equal(view.lists.length, 1); // deleted excluded
  const g = view.lists[0];
  assert.deepEqual([g.open, g.total], [2, 3]);
  assert.deepEqual(g.items.map((i) => i.id), ["a", "b", "c"]);
  assert.equal(g.items[0].due, null);
  assert.equal(g.items[2].due, "2026-08-01T00:00:00Z");
  assert.deepEqual(view.recipients, ["p@x.com"]);
});

test("viewVersion is stable across a no-op rebuild and changes when recipients change (store fixed)", () => {
  const lists = [cl({ slug: "g", items: [item("a", "milk")] })];
  const v1 = viewVersion(buildView(lists, ["a@x.com"], []));
  const v2 = viewVersion(buildView(lists, ["a@x.com"], []));
  assert.equal(v1, v2); // stable
  const v3 = viewVersion(buildView(lists, ["a@x.com", "b@x.com"], []));
  assert.notEqual(v1, v3); // recipients changed -> version changed (the load-bearing point)
});

test("viewVersion changes when a project changes (projects ride the version)", () => {
  const lists = [cl({ slug: "g", items: [] })];
  const p1: ViewProject[] = [{ slug: "k", name: "K", html: "<h2>a</h2>" }];
  const p2: ViewProject[] = [{ slug: "k", name: "K", html: "<h2>b</h2>" }];
  assert.notEqual(viewVersion(buildView(lists, [], p1)), viewVersion(buildView(lists, [], p2)));
});

test("resolvePollAfterMs clamps a finite number to [2s,60s]; absent/non-numeric use the idle rung", () => {
  assert.equal(resolvePollAfterMs(0, true), 2000);       // clamp up, never a hot loop
  assert.equal(resolvePollAfterMs(-5, true), 2000);
  assert.equal(resolvePollAfterMs(3600, true), 60000);   // clamp down
  assert.equal(resolvePollAfterMs(5, true), 5000);
  assert.equal(resolvePollAfterMs(undefined, true), 60000);  // absent + responded -> 60s idle
  assert.equal(resolvePollAfterMs("2", true), 60000);        // non-number -> 60s (never a stale 2s)
  assert.equal(resolvePollAfterMs(NaN, true), 60000);
  assert.equal(resolvePollAfterMs(undefined, false), 30000); // before the first response -> 30s
});

test("recipientsFromEnv unions OPERATOR_EMAIL + ALLOWED_RECIPIENTS, dedupes, sorts; empty -> []", () => {
  assert.deepEqual(recipientsFromEnv({ ALLOWED_RECIPIENTS: "b@x.com, a@x.com", OPERATOR_EMAIL: "a@x.com" }), ["a@x.com", "b@x.com"]);
  assert.deepEqual(recipientsFromEnv({}), []); // fails closed
});

// ---------- applyIntent ----------

test("applyIntent: check sets checked+checkedAt, is idempotent, and uncheck clears", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  await applyIntent(p, { id: 1, kind: "check", listSlug: "g", itemId: "a", at: "2026-08-01T00:00:00Z" });
  assert.equal(readStore(dir)[0].items[0].checked, true);
  assert.equal(readStore(dir)[0].items[0].checkedAt, "2026-08-01T00:00:00Z");
  await applyIntent(p, { id: 2, kind: "check", listSlug: "g", itemId: "a" }); // idempotent, no throw
  assert.equal(readStore(dir)[0].items[0].checked, true);
  await applyIntent(p, { id: 3, kind: "uncheck", listSlug: "g", itemId: "a" });
  assert.equal(readStore(dir)[0].items[0].checked, false);
  assert.equal(readStore(dir)[0].items[0].checkedAt, undefined);
});

test("applyIntent on a missing item OR a missing/deleted list is a no-op, not an error", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] }), cl({ slug: "d", deleted: true, items: [item("x", "gone")] })]);
  await applyIntent(p, { id: 1, kind: "check", listSlug: "g", itemId: "nope" });   // missing item
  await applyIntent(p, { id: 2, kind: "check", listSlug: "ghost", itemId: "a" });  // missing list
  await applyIntent(p, { id: 3, kind: "check", listSlug: "d", itemId: "x" });      // deleted list
  assert.equal(readStore(dir)[0].items[0].checked, false); // nothing changed, nothing threw
});

// ---------- runSyncTick: happy paths ----------

test("first tick publishes the full view, applies intents in id order, persists appliedThrough per intent", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk"), item("b", "eggs")] })]);
  seedState(dir);
  const { ops, calls } = fakeOps((req, n) => n === 0
    ? { viewVersion: req.viewVersion, intents: [{ id: 3, kind: "check", listSlug: "g", itemId: "b" }, { id: 2, kind: "check", listSlug: "g", itemId: "a" }], pollAfterSeconds: 5 }
    : { viewVersion: req.viewVersion });
  const { deps } = makeDeps(ops, dir);
  const delay = await runSyncTick(deps, freshMemo());
  assert.ok(calls[0].view, "first tick sends the view");
  assert.equal(delay, 5000);
  const store = readStore(dir);
  assert.deepEqual(store[0].items.map((i) => i.checked), [true, true]); // both applied
  assert.equal(loadState(deps.statePath).appliedThrough, 3); // highest id, applied in order
});

test("an unchanged view is omitted on the next tick (but taps still drain)", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  seedState(dir);
  const { ops, calls } = fakeOps((req) => ({ viewVersion: req.viewVersion }));
  const { deps } = makeDeps(ops, dir);
  const memo = freshMemo();
  await runSyncTick(deps, memo);
  await runSyncTick(deps, memo);
  assert.ok(calls[0].view, "first tick publishes");
  assert.equal(calls[1].view, undefined, "second tick omits the unchanged view");
});

test("a gap in intent ids applies without error", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk"), item("b", "eggs")] })]);
  seedState(dir);
  const { ops } = fakeOps((req, n) => n === 0
    ? { viewVersion: req.viewVersion, intents: [{ id: 5, kind: "check", listSlug: "g", itemId: "a" }, { id: 7, kind: "check", listSlug: "g", itemId: "b" }] }
    : { viewVersion: req.viewVersion });
  const { deps } = makeDeps(ops, dir);
  await runSyncTick(deps, freshMemo());
  assert.deepEqual(readStore(dir)[0].items.map((i) => i.checked), [true, true]);
  assert.equal(loadState(deps.statePath).appliedThrough, 7); // gap (5->7) is fine
});

test("an intent for a deleted item advances appliedThrough without error", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [] })]); // item 'gone' isn't here
  seedState(dir);
  const { ops } = fakeOps((req, n) => n === 0
    ? { viewVersion: req.viewVersion, intents: [{ id: 9, kind: "check", listSlug: "g", itemId: "gone" }] }
    : { viewVersion: req.viewVersion });
  const { deps } = makeDeps(ops, dir);
  await runSyncTick(deps, freshMemo());
  assert.equal(loadState(deps.statePath).appliedThrough, 9); // moot tap still advances
});

test("redelivering an already-applied intent (crash-dup) is idempotent and does not error", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk", { checked: true, checkedAt: "t" })] })]);
  seedState(dir, { appliedThrough: 2 }); // as if a crash persisted 2 but item 3 already applied
  const { ops } = fakeOps((req, n) => n === 0
    ? { viewVersion: req.viewVersion, intents: [{ id: 3, kind: "check", listSlug: "g", itemId: "a" }] }
    : { viewVersion: req.viewVersion });
  const { deps } = makeDeps(ops, dir);
  await runSyncTick(deps, freshMemo());
  assert.equal(readStore(dir)[0].items[0].checked, true); // still checked, no error
  assert.equal(loadState(deps.statePath).appliedThrough, 3);
});

// ---------- runSyncTick: DO state-loss echoes ----------

test("an echoed viewVersion that differs from what was published forces a republish next tick", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  seedState(dir);
  const { ops, calls } = fakeOps(() => ({ viewVersion: "stale-do-version" })); // never matches
  const { deps } = makeDeps(ops, dir);
  const memo = freshMemo();
  await runSyncTick(deps, memo); // publishes
  await runSyncTick(deps, memo); // view unchanged, but echo mismatched -> forced
  assert.ok(calls[1].view, "mismatched echo forces the full view again");
});

test("a null echoed viewVersion resets appliedThrough to 0 AND forces a republish", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  seedState(dir, { appliedThrough: 5 });
  const { ops, calls } = fakeOps(() => ({ viewVersion: null, intents: [] }));
  const { deps } = makeDeps(ops, dir);
  const memo = freshMemo();
  await runSyncTick(deps, memo);
  assert.equal(loadState(deps.statePath).appliedThrough, 0, "null echo == storage lost -> reset counter");
  await runSyncTick(deps, memo);
  assert.ok(calls[1].view, "null echo also forces a republish");
});

// ---------- runSyncTick: status codes ----------

test("403 stops the sync loop (fatal config) and alerts", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [] })]);
  seedState(dir);
  const { ops } = fakeOps(() => { throw new SyncHttpError(403); });
  const { deps, alerts } = makeDeps(ops, dir);
  assert.equal(await runSyncTick(deps, freshMemo()), STOP_SYNCING);
  assert.match(alerts.join(" "), /tenant mismatch/);
});

test("409 resets appliedThrough to 0 and retries (idempotent redelivery next tick)", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  seedState(dir, { appliedThrough: 5 });
  const { ops } = fakeOps((req, n) => {
    if (n === 0) throw new SyncHttpError(409);
    return { viewVersion: req.viewVersion, intents: [{ id: 1, kind: "check", listSlug: "g", itemId: "a" }] };
  });
  const { deps } = makeDeps(ops, dir);
  const memo = freshMemo();
  await runSyncTick(deps, memo);
  assert.equal(loadState(deps.statePath).appliedThrough, 0, "409 resets the counter");
  await runSyncTick(deps, memo);
  assert.equal(readStore(dir)[0].items[0].checked, true, "redelivery re-applies idempotently");
  assert.equal(loadState(deps.statePath).appliedThrough, 1);
});

test("appliedThrough == DO's highest id returns 200 (not 409) and does NOT reset the counter", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [] })]);
  seedState(dir, { appliedThrough: 5 });
  // The DO's highest issued id is exactly 5: it answers 200 with no new intents, not 409.
  const { ops } = fakeOps((req) => ({ viewVersion: req.viewVersion, intents: [] }));
  const { deps } = makeDeps(ops, dir);
  await runSyncTick(deps, freshMemo());
  assert.equal(loadState(deps.statePath).appliedThrough, 5, "the boundary is not a reset");
});

test("repeated 401 backs off exponentially rather than retrying every tick, and alerts at 10", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [] })]);
  seedState(dir);
  const { ops } = fakeOps(() => { throw new SyncHttpError(401); });
  const { deps, alerts } = makeDeps(ops, dir);
  const memo = freshMemo();
  const delays: number[] = [];
  for (let i = 0; i < 11; i++) delays.push(await runSyncTick(deps, memo));
  assert.deepEqual(delays.slice(0, 4), [30000, 60000, 120000, 240000]); // exponential
  assert.equal(delays[4], 300000); // capped at 5 min
  assert.equal(delays[10], 300000); // stays capped
  assert.equal(alerts.filter((a) => /consecutive 401/.test(a)).length, 1, "alert fires once at 10");
});

test("a network error (no status) backs off too", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [] })]);
  seedState(dir);
  const { ops } = fakeOps(() => { throw new Error("ECONNREFUSED"); });
  const { deps } = makeDeps(ops, dir);
  assert.equal(await runSyncTick(deps, freshMemo()), 30000);
});

// ---------- runSyncTick: 413 latches ----------

const oneProject = (): ViewProject[] => [{ slug: "k", name: "Kitchen", html: "<h2>big</h2>" }];

test("413 on a view with projects publishes projects:[] this tick and does NOT resend the oversized body next tick", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  seedState(dir);
  const { ops, calls } = fakeOps((req, n) => {
    if (n === 0) throw new SyncHttpError(413); // full view (with projects) too big
    return { viewVersion: req.viewVersion }; // stripped publish + later ticks succeed
  });
  const { deps, alerts } = makeDeps(ops, dir, { buildProjects: oneProject });
  const memo = freshMemo();
  await runSyncTick(deps, memo);
  assert.equal(calls[0].view?.projects.length, 1, "first attempt carried the real projects");
  assert.equal(calls[1].view?.projects.length, 0, "immediately republished stripped");
  assert.notEqual(loadState(deps.statePath).oversizedProjectsDigest, null, "projects latched");
  assert.match(alerts.join(" "), /413/);
  await runSyncTick(deps, memo);
  assert.equal(calls[2]?.view, undefined, "next tick omits the (latched, unchanged) view -- does not resend the oversized body");
});

test("413 on the projects:[] publish too -> pubFatal drain-only, does not latch the stripped array, still drains taps", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  seedState(dir);
  // ANY publish (a request carrying a view) 413s -- the lists themselves overflow. Drain-only
  // (no view) succeeds; the drain carries a tap to prove taps still apply while publish is broken.
  const { ops, calls } = fakeOps((req, n) => {
    if (req.view) throw new SyncHttpError(413);
    return { viewVersion: req.viewVersion, intents: n === 2 ? [{ id: 1, kind: "check", listSlug: "g", itemId: "a" }] : [] };
  });
  const { deps } = makeDeps(ops, dir, { buildProjects: oneProject });
  await runSyncTick(deps, freshMemo()); // full(413) -> stripped(413) -> drain(200, applies tap)
  assert.notEqual(loadState(deps.statePath).pubFatalVersion, null, "doubly-413 -> pubFatal recorded");
  assert.equal(calls[0].view?.projects.length, 1, "full attempt carried the real projects");
  assert.equal(calls[1].view?.projects.length, 0, "stripped attempt carried projects:[]");
  assert.equal(calls[2].view, undefined, "third call is drain-only (view omitted)");
  assert.equal(readStore(dir)[0].items[0].checked, true, "taps still drain while the publish path is broken");
});

test("pubFatal holds (drain-only, no republish attempt) while the built view is unchanged", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  seedState(dir);
  const { ops, calls } = fakeOps((req) => {
    if (req.view) throw new SyncHttpError(413);
    return { viewVersion: req.viewVersion }; // drain-only, NO intents -> the store never changes
  });
  const { deps } = makeDeps(ops, dir, { buildProjects: oneProject });
  const memo = freshMemo();
  await runSyncTick(deps, memo); // full(413), stripped(413), drain(200) = 3 calls
  await runSyncTick(deps, memo); // view unchanged + pubFatal -> a single drain-only, no publish retry
  assert.equal(calls.length, 4, "exactly one drain-only on the second tick (no publish retries while pubFatal holds)");
  assert.equal(calls[3].view, undefined);
});

test("the projects latch re-probes after an hour and clears once the full body fits", async () => {
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  seedState(dir);
  let clock = NOW;
  const { ops, calls } = fakeOps((req, n) => {
    if (n === 0) throw new SyncHttpError(413); // first full publish 413s
    return { viewVersion: req.viewVersion }; // stripped ok; later the full body fits
  });
  const { deps } = makeDeps(ops, dir, { buildProjects: oneProject, now: () => clock });
  const memo = freshMemo();
  await runSyncTick(deps, memo); // latch projects
  assert.notEqual(loadState(deps.statePath).oversizedProjectsDigest, null);
  clock = NOW + 3_600_001; // > 1h later
  await runSyncTick(deps, memo); // re-probe: retries the full body, which now fits (200)
  const lastWithView = calls.filter((c) => c.view).pop();
  assert.equal(lastWithView?.view?.projects.length, 1, "re-probe retried the full projects body");
  assert.equal(loadState(deps.statePath).oversizedProjectsDigest, null, "latch cleared once it fit");
});

test("a fatal 403 tick writes no state file churn beyond what a stop needs", async () => {
  // Guards that STOP_SYNCING short-circuits before intent application.
  const dir = tmp();
  seedStore(dir, [cl({ slug: "g", items: [] })]);
  const { ops } = fakeOps(() => { throw new SyncHttpError(403); });
  const { deps } = makeDeps(ops, dir);
  assert.equal(await runSyncTick(deps, freshMemo()), STOP_SYNCING);
  assert.equal(existsSync(deps.statePath), false); // nothing to persist on a fatal stop
});
