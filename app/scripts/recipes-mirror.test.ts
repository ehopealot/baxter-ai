// Tests for the recipes mirror (home-recipes plan, Task C1): recipesIndexVersion's
// reorder-insensitive canonicalization + change-detection, watchRecipes's debounce/
// dispatch/error-handling (mirroring home-bot.test.ts's watchChecklistStore suite and
// chat-bot.test.ts's chatIndexVersion test), and signedRecipesLinkConnect's URL/signing.
// No intent/dispatch/titling tests -- recipes have none (read-only, no down-link intents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { watch } from "node:fs";
import { recipesIndexVersion, watchRecipes, signedRecipesLinkConnect, WATCH_DEBOUNCE_MS, removeRecipeCommand } from "./recipes-mirror.ts";
import type { WebSocketLike } from "./home-link.ts";
import type { HomeKeys } from "./home-mirror.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "recipes-mirror-"));
}

// ---------- recipesIndexVersion ----------

test("recipesIndexVersion is stable for identical content and changes when a summary field changes", () => {
  const a = recipesIndexVersion([{ slug: "chili", title: "Chili", servings: 4, timeToPrepare: 45, updated: "t" }]);
  const b = recipesIndexVersion([{ slug: "chili", title: "Chili", servings: 4, timeToPrepare: 45, updated: "t" }]);
  const c = recipesIndexVersion([{ slug: "chili", title: "Spicy Chili", servings: 4, timeToPrepare: 45, updated: "t" }]);
  assert.equal(a, b, "identical content hashes identically");
  assert.notEqual(a, c, "a changed title field changes the digest");
});

test("recipesIndexVersion is insensitive to key order within a summary, but sensitive to array order", () => {
  const a = recipesIndexVersion([{ slug: "chili", title: "Chili", servings: 4, timeToPrepare: 45, updated: "t" }]);
  // Same fields, reordered on the object -- the canonicalizer sorts keys, so this must
  // hash identically. TS object literals don't enforce declaration order against an
  // interface, so no cast is needed to write the fields out of their usual order.
  const reordered = recipesIndexVersion([
    { updated: "t", timeToPrepare: 45, servings: 4, title: "Chili", slug: "chili" },
  ]);
  assert.equal(a, reordered, "object key order does not affect the digest");

  const two = [
    { slug: "chili", title: "Chili", servings: 4, timeToPrepare: 45, updated: "t" },
    { slug: "toast", title: "Toast", servings: 1, timeToPrepare: 5, updated: "t" },
  ];
  const swapped = [two[1], two[0]];
  assert.notEqual(
    recipesIndexVersion(two), recipesIndexVersion(swapped),
    "array (recipe) order DOES affect the digest -- unlike object keys, list order is preserved, mirroring chatIndexVersion's own canonicalize",
  );
});

test("recipesIndexVersion defaults to the real listRecipes() when called with no argument", () => {
  // Just proves it doesn't throw / returns a hex digest of the (real, likely-empty in
  // this test env) recipes dir -- the actual content is covered by the explicit-array
  // tests above, which don't touch the filesystem at all.
  const v = recipesIndexVersion();
  assert.match(v, /^[0-9a-f]{64}$/);
});

// ---------- watchRecipes ----------
//
// Mirrors home-bot.test.ts's watchChecklistStore suite: recursive fs.watch (no basename
// filter -- see recipes-mirror.ts's own comment for why, unlike watchChecklistStore's
// single-file watch), leading-edge WATCH_DEBOUNCE_MS fold, 'error' handling with a
// de-duped keep-alive fallback, and close() tearing down cleanly.

class FakeFSWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
}

function captureChangeListener(fakeWatcher: FakeFSWatcher): {
  watchFn: typeof watch;
  listener: () => ((event: string, filename: string | null) => void) | undefined;
} {
  let changeListener: ((event: string, filename: string | null) => void) | undefined;
  const watchFn = ((_dir: string, _opts: unknown, listener: (event: string, filename: string | null) => void) => {
    changeListener = listener;
    return fakeWatcher;
  }) as unknown as typeof watch;
  return { watchFn, listener: () => changeListener };
}

test("watchRecipes: a change event is folded (leading-edge) into a single debounced onChange call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  const fakeWatcher = new FakeFSWatcher();
  const { watchFn, listener } = captureChangeListener(fakeWatcher);
  let onChangeCalls = 0;

  const { close } = watchRecipes(dir, () => { onChangeCalls += 1; }, watchFn);
  assert.ok(listener(), "watchFn must have been called with a change listener");

  // Three rapid events (a save's temp+rename, say) fold into one call.
  listener()!("rename", "chili.json");
  listener()!("change", "chili.json");
  listener()!("rename", "chili.json");
  assert.equal(onChangeCalls, 0, "onChange must not fire before the debounce elapses");

  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(onChangeCalls, 1, "three rapid events fold into exactly one onChange call");

  close();
});

test("watchRecipes: a later change, after the debounce window has cleared, dispatches again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  const fakeWatcher = new FakeFSWatcher();
  const { watchFn, listener } = captureChangeListener(fakeWatcher);
  let onChangeCalls = 0;

  const { close } = watchRecipes(dir, () => { onChangeCalls += 1; }, watchFn);
  listener()!("rename", "chili.json");
  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(onChangeCalls, 1);

  listener()!("rename", "toast.json");
  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(onChangeCalls, 2, "a change after the timer cleared schedules a fresh debounce");

  close();
});

test("watchRecipes: close() cancels a PENDING debounced onChange -- it never fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  const fakeWatcher = new FakeFSWatcher();
  const { watchFn, listener } = captureChangeListener(fakeWatcher);
  let onChangeCalls = 0;

  const { close } = watchRecipes(dir, () => { onChangeCalls += 1; }, watchFn);
  listener()!("rename", "chili.json");
  close();

  t.mock.timers.tick(WATCH_DEBOUNCE_MS);
  assert.equal(onChangeCalls, 0, "close() must cancel the pending debounced onChange");
  assert.equal(fakeWatcher.closed, true);
});

test("watchRecipes: a watcher 'error' event logs loudly and de-dupes a repeated fallback timer; close() clears it", () => {
  const dir = tmpDir();
  const fakeWatcher = new FakeFSWatcher();
  const errs: string[] = [];
  const intervalHandles: NodeJS.Timeout[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const h = realSetInterval(...args);
    intervalHandles.push(h);
    return h;
  }) as typeof setInterval;

  try {
    const fakeWatchFn = ((_dir: string, _opts: unknown, _cb: unknown) => fakeWatcher) as unknown as typeof watch;
    const { close } = watchRecipes(dir, () => {}, fakeWatchFn, (m: string) => errs.push(m));

    fakeWatcher.emit("error", new Error("EMFILE: too many open files"));
    assert.ok(errs.some((m) => m.includes("recipes-dir watch died") && m.includes("EMFILE")), errs.join("\n"));
    assert.equal(intervalHandles.length, 1, "the fallback keep-alive timer fired exactly once");

    fakeWatcher.emit("error", new Error("EMFILE again"));
    assert.equal(intervalHandles.length, 1, "a second 'error' does not stack a second keep-alive interval");

    close();
    assert.equal(fakeWatcher.closed, true);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    for (const h of intervalHandles) realClearInterval(h);
  }
});

test("watchRecipes: a synchronous watch() failure logs and falls back to a keep-alive interval, cleared by close()", () => {
  const dir = tmpDir();
  const errs: string[] = [];
  const intervalHandles: NodeJS.Timeout[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const h = realSetInterval(...args);
    intervalHandles.push(h);
    return h;
  }) as typeof setInterval;

  try {
    const throwingWatchFn = (() => { throw new Error("EMFILE at setup"); }) as unknown as typeof watch;
    const { close } = watchRecipes(dir, () => {}, throwingWatchFn, (m: string) => errs.push(m));
    assert.ok(errs.some((m) => m.includes("could not watch the recipes dir") && m.includes("EMFILE")), errs.join("\n"));
    assert.equal(intervalHandles.length, 1);
    close();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    for (const h of intervalHandles) realClearInterval(h);
  }
});

// ---------- signedRecipesLinkConnect ----------

const KEYS: HomeKeys = { endpoint: "https://home.example.com/svc/acme", tenant: "acme", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-key" };

test("signedRecipesLinkConnect targets wss://<host>/svc/<tenant>/recipes-link and signs a fresh SigV4 GET on every dial", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const stub: WebSocketLike = { send() {}, close() {}, addEventListener() {} };
  const connect = signedRecipesLinkConnect(KEYS, (url, headers) => { calls.push({ url, headers }); return stub; });

  await connect();
  await connect(); // a second dial -- proves signing happens fresh each call, not once at construction

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "wss://home.example.com/svc/acme/recipes-link");
    assert.ok(call.headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/"), JSON.stringify(call.headers));
    assert.match(call.headers.authorization, /SignedHeaders=host;x-amz-date,/);
    assert.match(call.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
  }
});

test("signedRecipesLinkConnect maps an http endpoint to ws (not wss)", async () => {
  const httpKeys: HomeKeys = { ...KEYS, endpoint: "http://localhost:8787/svc/acme/" };
  let seenUrl = "";
  const stub: WebSocketLike = { send() {}, close() {}, addEventListener() {} };
  const connect = signedRecipesLinkConnect(httpKeys, (url) => { seenUrl = url; return stub; });
  await connect();
  assert.equal(seenUrl, "ws://localhost:8787/svc/acme/recipes-link");
});

// ---------- removeRecipeCommand (the /recipes delete button) ----------

test("removeRecipeCommand deletes the named recipe via the injected remover and logs the removal", async () => {
  const calls: Array<{ slug: string; dir: string }> = [];
  const logs: string[] = [], errs: string[] = [];
  const remove = async (slug: string, dir: string) => { calls.push({ slug, dir }); return slug; };
  await removeRecipeCommand({ kind: "remove-recipe", slug: "chili" }, "/state/recipes", (m) => logs.push(m), (m) => errs.push(m), remove);
  assert.deepEqual(calls, [{ slug: "chili", dir: "/state/recipes" }]);
  assert.equal(errs.length, 0);
  assert.match(logs.join("\n"), /removed recipe "chili"/);
});

test("removeRecipeCommand on an unknown slug logs 'unknown' (not an error) -- remover returned null", async () => {
  const logs: string[] = [], errs: string[] = [];
  const remove = async () => null;
  await removeRecipeCommand({ kind: "remove-recipe", slug: "ghost" }, "/state/recipes", (m) => logs.push(m), (m) => errs.push(m), remove);
  assert.equal(errs.length, 0);
  assert.match(logs.join("\n"), /unknown slug "ghost"/);
});

test("removeRecipeCommand ignores a malformed payload (wrong kind, missing/blank slug) without calling the remover", async () => {
  for (const bad of [
    { kind: "sort-list", listId: "x" },
    { kind: "remove-recipe" },
    { kind: "remove-recipe", slug: "" },
    { kind: "remove-recipe", slug: "   " },
    { kind: "remove-recipe", slug: 5 },
    null,
    "string",
  ]) {
    let called = false;
    const errs: string[] = [];
    await removeRecipeCommand(bad as unknown, "/state/recipes", () => {}, (m) => errs.push(m), async () => { called = true; return "x"; });
    assert.equal(called, false, `remover must not run for ${JSON.stringify(bad)}`);
    assert.equal(errs.length, 1, `malformed payload logs exactly one error for ${JSON.stringify(bad)}`);
    assert.match(errs[0], /malformed remove-recipe/);
  }
});

test("removeRecipeCommand swallows a remover that throws, logging an error (a command has no ack)", async () => {
  const errs: string[] = [];
  const remove = async () => { throw new Error("disk gone"); };
  await assert.doesNotReject(() =>
    removeRecipeCommand({ kind: "remove-recipe", slug: "chili" }, "/state/recipes", () => {}, (m) => errs.push(m), remove));
  assert.match(errs.join("\n"), /remove-recipe failed: disk gone/);
});
