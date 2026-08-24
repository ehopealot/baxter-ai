// Tests for the family-home mirror: the pure builders (buildView / viewVersion /
// recipientsFromEnv), applyIntent through the checklist lock, and wireLink -- the on-demand
// view build + intent apply/ack wiring that drives the WS link, run against a temp store, no
// network. D1 removed the HTTP poll path (runSyncTick and everything under it) along with its
// tests here; see the SDD ledger for that removal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_HOME_VIEW_BYTES,
  applyIntent,
  buildCollectionsView,
  buildView,
  recipientsFromEnv,
  renderDetailHtml,
  slugify,
  uniqueSlug,
  viewVersion,
  wireLink,
} from "./home-mirror.ts";
import type { HomeLinkPort, Intent, View, ViewCollection, WireLinkDeps } from "./home-mirror.ts";
import type { Checklist, Item } from "./checklist-store.ts";
import type { CollectionListing } from "./collections-cli.ts";
import { defaultReadOps } from "./collection-renderer.ts";
import type { ReadOps } from "./collection-renderer.ts";
import { freshState, loadState } from "./home-state.ts";
import type { HomeState } from "./home-state.ts";

// ---------- fixtures ----------

const tmp = (): string => mkdtempSync(join(tmpdir(), "hm-"));
const emptyCollections = (): ViewCollection[] => [];
// HERMETIC (temp path): every allow-list-touching test/helper below threads this instead of
// relying on the default ALLOWLIST_PATH -- otherwise "no file -> nobody" only passes while the
// runner's homedir happens to have no allowlist file, and reads (or leaks assertions against)
// the operator's REAL allow-list once one is provisioned on a box that runs `make check`.
const noFile = (): string => join(mkdtempSync(join(tmpdir(), "hm-al-")), "allowlist.json");
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
const readStore = (dir: string): Checklist[] => JSON.parse(readFileSync(join(dir, "checklists.json"), "utf8"));

// A minimal fake HomeLinkPort: records what wireLink sends, and lets a test fire pull/
// intent as the DO would over the real link. fireIntent deliberately does NOT await the
// registered callback -- the real HomeLink._onMessage invokes onIntent's callback
// synchronously in a loop over a batched frame and cannot await it either, so mirroring
// that (fire-and-forget) is what actually exercises wireLink's own internal
// serialization. Tests that care about completion await the returned WiredLink's
// flushIntents() instead.
function fakeLink(): {
  link: HomeLinkPort;
  sentViews: Array<{ inReplyTo: number; view: View; viewVersion: string }>;
  acks: number[];
  changed: string[];
  firePull: (pullId: number) => void;
  fireIntent: (intent: Intent) => void;
  fireOpen: () => void;
} {
  const pullHandlers: Array<(pullId: number) => void> = [];
  const intentHandlers: Array<(intent: Intent) => void> = [];
  const openHandlers: Array<() => void> = [];
  const sentViews: Array<{ inReplyTo: number; view: View; viewVersion: string }> = [];
  const acks: number[] = [];
  const changed: string[] = [];
  const link: HomeLinkPort = {
    onPull(cb) { pullHandlers.push(cb); },
    onIntent(cb) { intentHandlers.push(cb); },
    onOpen(cb) { openHandlers.push(cb); },
    sendChanged(v) { changed.push(v); },
    sendView(inReplyTo, view, v) { sentViews.push({ inReplyTo, view, viewVersion: v }); },
    sendAck(a) { acks.push(a); },
  };
  return {
    link, sentViews, acks, changed,
    firePull: (pullId) => { for (const cb of pullHandlers) cb(pullId); },
    fireIntent: (intent) => { for (const cb of intentHandlers) cb(intent); },
    fireOpen: () => { for (const cb of openHandlers) cb(); },
  };
}

// ---------- pure builders ----------

test("buildView: open/total counts, due normalized to null, excludes deleted lists, keeps item ids", () => {
  const lists = [
    cl({ slug: "g", name: "Groceries", items: [item("a", "milk"), item("b", "eggs", { checked: true }), item("c", "bread", { due: "2026-08-01T00:00:00Z" })] }),
    cl({ slug: "old", name: "Old", deleted: true, items: [item("z", "gone")] }),
  ];
  const view = buildView(lists, ["p@x.com"], []);
  assert.equal(view.lists.length, 1); // deleted excluded
  const g = view.lists[0];
  assert.equal(g.id, "g", "the view exposes the stable list id (delete-list targets it by identity)");
  assert.deepEqual([g.open, g.total], [2, 3]);
  assert.deepEqual(g.items.map((i) => i.id), ["a", "b", "c"]);
  assert.equal(g.items[0].due, null);
  assert.equal(g.items[2].due, "2026-08-01T00:00:00Z");
  assert.deepEqual(view.recipients, ["p@x.com"]);
  // The Collections rename: the wire field is `collections`, and an empty projection is
  // represented by an empty array. The exact key-set check pins the whole published shape:
  // the retired pre-rename field is gone and no stray
  // field rides along unversioned.
  assert.ok(Array.isArray(view.collections), "the view carries the collections field");
  assert.deepEqual(view.collections, []);
  assert.deepEqual(Object.keys(view).sort(), ["collections", "lists", "recipients"],
    "the view exposes exactly these fields -- the retired one is gone and nothing stray rides along");
});

test("buildView: exposes item category (normalized to null when absent)", () => {
  const view = buildView([cl({ slug: "g", name: "Groceries", items: [
    item("a", "milk", { category: "Dairy" }),
    item("b", "eggs"),
  ] })], [], []);
  const items = view.lists[0].items;
  assert.equal(items[0].category, "Dairy");
  assert.equal(items[1].category, null);
});

test("buildView: exposes checkedBy (who checked it), normalized to null when absent", () => {
  const view = buildView([cl({ slug: "g", name: "G", items: [
    item("a", "milk", { checked: true, checkedBy: "Erik" }),
    item("b", "eggs", { checked: true }),
  ] })], [], []);
  assert.equal(view.lists[0].items[0].checkedBy, "Erik");
  assert.equal(view.lists[0].items[1].checkedBy, null);
});

test("viewVersion is stable across a no-op rebuild and changes when recipients change (store fixed)", () => {
  const lists = [cl({ slug: "g", items: [item("a", "milk")] })];
  const v1 = viewVersion(buildView(lists, ["a@x.com"], []));
  const v2 = viewVersion(buildView(lists, ["a@x.com"], []));
  assert.equal(v1, v2); // stable
  const v3 = viewVersion(buildView(lists, ["a@x.com", "b@x.com"], []));
  assert.notEqual(v1, v3); // recipients changed -> version changed (the load-bearing point)
});

test("viewVersion changes when a collection changes (collections ride the version)", () => {
  const lists = [cl({ slug: "g", items: [] })];
  const p1: ViewCollection[] = [{ slug: "k", name: "K", items: [{ description: "A", detailHtml: "<h2>a</h2>" }] }];
  const p2: ViewCollection[] = [{ slug: "k", name: "K", items: [{ description: "A", detailHtml: "<h2>b</h2>" }] }];
  assert.notEqual(viewVersion(buildView(lists, [], p1)), viewVersion(buildView(lists, [], p2)));
});

// ---------- Collections publication builder ----------

function collectionListing(slug: string, title = slug): CollectionListing {
  return { slug, title, size: 0, mtime: null };
}

function seedCollectionPair(collectionsDir: string, renderedDir: string, slug: string, source: string, rendered: unknown): void {
  mkdirSync(collectionsDir, { recursive: true });
  mkdirSync(renderedDir, { recursive: true });
  writeFileSync(join(collectionsDir, `${slug}.md`), source);
  writeFileSync(join(renderedDir, `${slug}.json`), typeof rendered === "string" ? rendered : JSON.stringify(rendered));
}

test("buildCollectionsView pins read-free enumeration, filters noncanonical listings before reads, and takes names from fenced source reads", () => {
  const root = tmp();
  const collectionsDir = join(root, "collections");
  const renderedDir = join(root, "rendered");
  seedCollectionPair(collectionsDir, renderedDir, "good", "# Guarded Name\n\nSource", [{ description: "First", detail: "**safe**" }]);
  seedCollectionPair(collectionsDir, renderedDir, "untitled", "No H1 here", [{ description: "Second", detail: "detail" }]);
  seedCollectionPair(collectionsDir, renderedDir, "Bad Name", "# Must Not Read", [{ description: "Bad", detail: "bad" }]);

  const events: string[] = [];
  const readOps: ReadOps = {
    ...defaultReadOps,
    lstat(path) {
      events.push(`read:${path}`);
      return defaultReadOps.lstat(path);
    },
  };
  const listSources = (dir: string, opts: { withTitles?: boolean }): CollectionListing[] => {
    events.push("list");
    assert.equal(dir, collectionsDir);
    assert.deepEqual(opts, { withTitles: false }, "enumeration must be explicitly read-free");
    return [
      collectionListing("good", "STALE LISTING TITLE"),
      collectionListing("Bad Name", "Bad"),
      collectionListing("untitled", "ALSO STALE"),
    ];
  };

  const view = buildCollectionsView(collectionsDir, renderedDir, { readOps, listSources });
  assert.equal(events[0], "list", "enumeration happens before canonical filtering and fenced reads");
  assert.equal(events.some((event) => event.includes("Bad Name")), false, "noncanonical source and derived paths are never read");
  assert.deepEqual(view, [
    { slug: "good", name: "Guarded Name", items: [{ description: "First", detailHtml: "<p><strong>safe</strong></p>" }] },
    { slug: "untitled", name: "untitled", items: [{ description: "Second", detailHtml: "<p>detail</p>" }] },
  ]);
});

test("buildCollectionsView default enumeration ignores noncanonical source/derived pairs and pre-existing source symlinks", () => {
  const root = tmp();
  const collectionsDir = join(root, "collections");
  const renderedDir = join(root, "rendered");
  seedCollectionPair(collectionsDir, renderedDir, "good", "# Good", [{ description: "Good", detail: "ok" }]);
  seedCollectionPair(collectionsDir, renderedDir, "Bad Name", "# Bad", [{ description: "Bad", detail: "bad" }]);
  writeFileSync(join(root, "target.md"), "# Linked");
  symlinkSync(join(root, "target.md"), join(collectionsDir, "linked.md"));
  writeFileSync(join(renderedDir, "linked.json"), JSON.stringify([{ description: "Linked", detail: "bad" }]));
  writeFileSync(join(renderedDir, "Other Bad.json"), JSON.stringify([{ description: "Orphan", detail: "bad" }]));

  assert.deepEqual(buildCollectionsView(collectionsDir, renderedDir).map((collection) => collection.slug), ["good"]);
});

test("buildCollectionsView publication-time source fence omits raced-away, unreadable, symlink-swapped, and identity-mismatched sources", () => {
  const cases: Array<{ slug: string; expected: string; prepare?: (sourcePath: string) => void; readOps?: (sourcePath: string) => ReadOps }> = [
    { slug: "gone", expected: "missing" },
    {
      slug: "denied",
      expected: "unreadable",
      prepare: (path) => writeFileSync(path, "# Denied"),
      readOps: (sourcePath) => ({
        ...defaultReadOps,
        lstat(path) {
          if (path === sourcePath) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return defaultReadOps.lstat(path);
        },
      }),
    },
    {
      slug: "linked",
      expected: "symlink",
      prepare: (path) => {
        const target = `${path}.target`;
        writeFileSync(target, "# Target");
        symlinkSync(target, path);
      },
    },
    {
      slug: "raced",
      expected: "mismatch",
      prepare: (path) => writeFileSync(path, "# Raced"),
      readOps: (sourcePath) => ({
        ...defaultReadOps,
        fstat(fd) {
          const stat = defaultReadOps.fstat(fd);
          return new Proxy(stat, { get(target, prop, receiver) { return prop === "ino" ? target.ino + 1 : Reflect.get(target, prop, receiver); } });
        },
      }),
    },
  ];

  for (const scenario of cases) {
    const root = tmp();
    const collectionsDir = join(root, "collections");
    const renderedDir = join(root, "rendered");
    mkdirSync(collectionsDir, { recursive: true });
    mkdirSync(renderedDir, { recursive: true });
    const sourcePath = join(collectionsDir, `${scenario.slug}.md`);
    scenario.prepare?.(sourcePath);
    writeFileSync(join(renderedDir, `${scenario.slug}.json`), JSON.stringify([{ description: "Item", detail: "detail" }]));
    const errors: Array<[string, string]> = [];
    const result = buildCollectionsView(collectionsDir, renderedDir, {
      listSources: () => [collectionListing(scenario.slug, "stale")],
      readOps: scenario.readOps?.(sourcePath),
      onError: (slug, reason) => errors.push([slug, reason]),
    });
    assert.deepEqual(result, [], `${scenario.slug} is omitted`);
    assert.deepEqual(errors, [[scenario.slug, scenario.expected]]);
  }
});

test("buildCollectionsView rejects missing/symlinked derived files and strict-parser fenced or prefixed arrays, while an exact root array passes", () => {
  const root = tmp();
  const collectionsDir = join(root, "collections");
  const renderedDir = join(root, "rendered");
  mkdirSync(collectionsDir, { recursive: true });
  mkdirSync(renderedDir, { recursive: true });
  const valid = JSON.stringify([{ description: "Valid", detail: "detail" }]);
  for (const slug of ["missing", "linked", "fenced", "prefixed", "valid"]) {
    writeFileSync(join(collectionsDir, `${slug}.md`), `# ${slug}`);
  }
  writeFileSync(join(root, "derived-target.json"), valid);
  symlinkSync(join(root, "derived-target.json"), join(renderedDir, "linked.json"));
  writeFileSync(join(renderedDir, "fenced.json"), `\`\`\`json\n${valid}\n\`\`\``);
  writeFileSync(join(renderedDir, "prefixed.json"), `note\n${valid}`);
  writeFileSync(join(renderedDir, "valid.json"), `  ${valid}\n`);
  const errors: Array<[string, string]> = [];

  const view = buildCollectionsView(collectionsDir, renderedDir, { onError: (slug, reason) => errors.push([slug, reason]) });
  assert.deepEqual(view.map((collection) => collection.slug), ["valid"]);
  assert.deepEqual(errors.sort(), [
    ["fenced", "malformed"],
    ["linked", "symlink"],
    ["missing", "missing"],
    ["prefixed", "malformed"],
  ]);
});

test("renderDetailHtml renders ordinary Markdown while neutralizing raw HTML and dangerous protocols", () => {
  const html = renderDetailHtml("**bold** [ok](https://example.com) [js](javascript:alert(1)) [data](data:text/html,bad)\n\n<script>alert(1)</script>");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href="(?:javascript|data):/i);
  assert.match(html, /&lt;script&gt;/, "raw HTML is emitted only as escaped text");
});

test("renderDetailHtml pins safe deterministic output for event HTML, malformed Markdown, entities, lists, and code", () => {
  const detail = [
    "<img src=x onerror=alert(1)>",
    "",
    "**unclosed",
    "",
    "Fish &amp; Chips & stuff",
    "",
    "- one",
    "- two",
    "",
    "Use `code()` now",
    "",
    "```js",
    "const x = 1 < 2;",
    "```",
  ].join("\n");
  const expected = [
    "&lt;img src=x onerror=alert(1)&gt;",
    "<p>**unclosed</p>",
    "<p>Fish &amp; Chips &amp; stuff</p>",
    "<ul>",
    "<li>one</li>",
    "<li>two</li>",
    "</ul>",
    "<p>Use <code>code()</code> now</p>",
    '<pre><code class="language-js">const x = 1 &lt; 2;',
    "</code></pre>",
  ].join("\n");

  const html = renderDetailHtml(detail);
  assert.equal(html, expected, "all supported and malformed constructs have a pinned rendering");
  assert.doesNotMatch(html, /<img\b/i, "the raw event-handler element is escaped, never active HTML");
});

test("recipientsFromEnv unions OPERATOR_EMAIL + ALLOWED_RECIPIENTS, dedupes, sorts; empty -> []", () => {
  const p = noFile(); // no file -> both calls below fall back to the given env (fail-closed chain, temp path)
  assert.deepEqual(recipientsFromEnv({ ALLOWED_RECIPIENTS: "b@x.com, a@x.com", OPERATOR_EMAIL: "a@x.com" }, p), ["a@x.com", "b@x.com"]);
  assert.deepEqual(recipientsFromEnv({}, p), []); // fails closed
});

test("recipientsFromEnv unions OPERATOR_EMAIL, dedupes case-insensitively, sorts (env fallback, temp path)", () => {
  assert.deepEqual(recipientsFromEnv({ ALLOWED_RECIPIENTS: "B@x.com, a@x.com", OPERATOR_EMAIL: "b@x.com" } as any, noFile()),
    ["B@x.com", "a@x.com"]); // "b@x.com" is a case-dupe of "B@x.com"; sorted
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

test("applyIntent: check stamps checkedBy from intent.by, and uncheck clears it", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  await applyIntent(p, { id: 1, kind: "check", listSlug: "g", itemId: "a", at: "2026-08-01T00:00:00Z", by: "Erik" });
  assert.equal(readStore(dir)[0].items[0].checkedBy, "Erik");
  await applyIntent(p, { id: 2, kind: "uncheck", listSlug: "g", itemId: "a" });
  assert.equal(readStore(dir)[0].items[0].checkedBy, undefined);
  // A check with no `by` (CLI/Discord) leaves no attribution.
  await applyIntent(p, { id: 3, kind: "check", listSlug: "g", itemId: "a" });
  assert.equal(readStore(dir)[0].items[0].checkedBy, undefined);
});

test("applyIntent on a missing item OR a missing/deleted list is a no-op, not an error", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] }), cl({ slug: "d", deleted: true, items: [item("x", "gone")] })]);
  await applyIntent(p, { id: 1, kind: "check", listSlug: "g", itemId: "nope" });   // missing item
  await applyIntent(p, { id: 2, kind: "check", listSlug: "ghost", itemId: "a" });  // missing list
  await applyIntent(p, { id: 3, kind: "check", listSlug: "d", itemId: "x" });      // deleted list
  assert.equal(readStore(dir)[0].items[0].checked, false); // nothing changed, nothing threw
});

test("applyIntent add-item: appends an item with a deterministic wi-<id> + checked:false to the matching live list", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  await applyIntent(p, { id: 7, kind: "add-item", listSlug: "g", text: "eggs" });
  const items = readStore(dir)[0].items;
  assert.equal(items.length, 2);
  assert.equal(items[1].text, "eggs");
  assert.equal(items[1].checked, false);
  assert.equal(items[1].id, "wi-7", "id is derived from the intent id, not random -- for redelivery idempotency");
  assert.equal(typeof items[1].created, "string");
});

test("applyIntent add-item: redelivering the SAME intent twice is a true no-op (one item, not two)", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  await applyIntent(p, { id: 7, kind: "add-item", listSlug: "g", text: "eggs" });
  await applyIntent(p, { id: 7, kind: "add-item", listSlug: "g", text: "eggs" }); // redelivery
  const items = readStore(dir)[0].items;
  assert.equal(items.length, 2, "the redelivered add did not append a duplicate");
  assert.equal(items.filter((i) => i.id === "wi-7").length, 1);
});

test("applyIntent add-item: honors intent.at as the item's created timestamp", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [] })]);
  await applyIntent(p, { id: 1, kind: "add-item", listSlug: "g", text: "eggs", at: "2026-08-01T00:00:00Z" });
  assert.equal(readStore(dir)[0].items[0].created, "2026-08-01T00:00:00Z");
});

test("applyIntent add-item: trims the stored text (matches what the CLI would write)", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [] })]);
  await applyIntent(p, { id: 1, kind: "add-item", listSlug: "g", text: "  eggs  " });
  assert.equal(readStore(dir)[0].items[0].text, "eggs");
});

test("applyIntent add-item on an unknown/deleted list is a no-op, not an error", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] }), cl({ slug: "d", deleted: true, items: [] })]);
  await applyIntent(p, { id: 1, kind: "add-item", listSlug: "ghost", text: "x" }); // missing list
  await applyIntent(p, { id: 2, kind: "add-item", listSlug: "d", text: "y" });     // deleted list
  assert.equal(readStore(dir)[0].items.length, 1, "the live list is untouched");
  assert.equal(readStore(dir)[1].items.length, 0, "the deleted list stays empty");
});

test("applyIntent create-list: creates a list with the expected slug + name + empty items + wi-<id>", async () => {
  const dir = tmp();
  const p = seedStore(dir, []);
  await applyIntent(p, { id: 3, kind: "create-list", name: "Camping Trip!" });
  const lists = readStore(dir);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name, "Camping Trip!");
  assert.equal(lists[0].slug, "camping-trip");
  assert.deepEqual(lists[0].items, []);
  assert.equal(lists[0].id, "wi-3", "id is derived from the intent id, for redelivery idempotency");
  assert.equal(typeof lists[0].created, "string");
  assert.equal(typeof lists[0].updated, "string");
});

test("applyIntent create-list: redelivering the SAME intent twice is a true no-op (one list, no name-2)", async () => {
  const dir = tmp();
  const p = seedStore(dir, []);
  await applyIntent(p, { id: 3, kind: "create-list", name: "Camping" });
  await applyIntent(p, { id: 3, kind: "create-list", name: "Camping" }); // redelivery
  const lists = readStore(dir);
  assert.equal(lists.length, 1, "no duplicate list, and uniqueSlug did NOT run again to make camping-2");
  assert.equal(lists[0].slug, "camping");
});

test("applyIntent create-list: honors intent.at for created+updated, and trims the stored name", async () => {
  const dir = tmp();
  const p = seedStore(dir, []);
  await applyIntent(p, { id: 1, kind: "create-list", name: "  Camping  ", at: "2026-08-01T00:00:00Z" });
  const list = readStore(dir)[0];
  assert.equal(list.name, "Camping", "name trimmed before storing");
  assert.equal(list.slug, "camping");
  assert.equal(list.created, "2026-08-01T00:00:00Z");
  assert.equal(list.updated, "2026-08-01T00:00:00Z");
});

test("applyIntent create-list: a name that slugs to an existing list's slug gets a unique -N suffix", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "groceries", name: "Groceries" })]);
  await applyIntent(p, { id: 1, kind: "create-list", name: "Groceries" });
  await applyIntent(p, { id: 2, kind: "create-list", name: "groceries!!!" });
  const slugs = readStore(dir).map((l) => l.slug);
  assert.deepEqual(slugs, ["groceries", "groceries-2", "groceries-3"]);
});

test("applyIntent create-list: a deleted tombstone's slug does NOT force a suffix (only live lists collide)", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "trip", name: "Trip", deleted: true })]);
  await applyIntent(p, { id: 1, kind: "create-list", name: "Trip" });
  const live = readStore(dir).filter((l) => !l.deleted);
  assert.equal(live[0].slug, "trip", "reuses the slug of the drained-away tombstone");
});

test("applyIntent add-item at MAX_ITEMS_PER_LIST is a silent no-op (count stays at the cap)", async () => {
  const dir = tmp();
  const full = Array.from({ length: 1000 }, (_, i) => item(`i${i}`, `t${i}`)); // MAX_ITEMS_PER_LIST
  const p = seedStore(dir, [cl({ slug: "g", items: full })]);
  await applyIntent(p, { id: 1, kind: "add-item", listSlug: "g", text: "overflow" });
  assert.equal(readStore(dir)[0].items.length, 1000, "no append past the cap");
});

test("applyIntent create-list at MAX_CHECKLISTS is a silent no-op (no new list)", async () => {
  const dir = tmp();
  const many = Array.from({ length: 200 }, (_, i) => cl({ slug: `l${i}`, name: `L${i}` })); // MAX_CHECKLISTS
  const p = seedStore(dir, many);
  await applyIntent(p, { id: 1, kind: "create-list", name: "One More" });
  assert.equal(readStore(dir).length, 200, "no new list past the cap");
});

test("applyIntent rename-list: changes only the live list name, retains its slug and id, and is idempotent", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ id: "wi-g", slug: "groceries", name: "Groceries", items: [item("a", "milk")] })]);
  const intent: Intent = { id: 7, kind: "rename-list", listId: "wi-g", name: "  Pantry  ", at: "2026-08-24T00:00:00Z" };
  await applyIntent(p, intent);
  await applyIntent(p, intent); // redelivery must not alter identity or duplicate anything
  const [list] = readStore(dir);
  assert.deepEqual({ id: list.id, slug: list.slug, name: list.name, itemCount: list.items.length },
    { id: "wi-g", slug: "groceries", name: "Pantry", itemCount: 1 });
});

test("applyIntent delete-list: an un-mirrored list is dropped outright (mirrors checklist-cli rm)", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", name: "Groceries", items: [item("a", "milk")] }), cl({ slug: "k", name: "Keep" })]);
  await applyIntent(p, { id: 1, kind: "delete-list", listId: "g" }); // cl() sets id = slug
  const lists = readStore(dir);
  assert.deepEqual(lists.map((l) => l.slug), ["k"], "the un-mirrored list is removed entirely, not tombstoned");
});

test("applyIntent delete-list: a mirrored list is TOMBSTONED (deleted+empty, pendingUnmirror queued for the gateway)", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", name: "Groceries", items: [item("a", "milk", { mirrorMessageId: "m1" }), item("b", "eggs")] })]);
  await applyIntent(p, { id: 1, kind: "delete-list", listId: "g" });
  const list = readStore(dir)[0];
  assert.equal(list.deleted, true, "kept as a tombstone so the gateway can clean its mirror messages");
  assert.deepEqual(list.items, [], "items cleared");
  assert.deepEqual(list.pendingUnmirror, ["m1"], "the posted mirror-message id is queued for unmirror");
});

test("applyIntent delete-list: redelivering the SAME intent is a true no-op (already gone)", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", name: "Groceries", items: [] }), cl({ slug: "k", name: "Keep" })]);
  await applyIntent(p, { id: 1, kind: "delete-list", listId: "g" });
  await applyIntent(p, { id: 1, kind: "delete-list", listId: "g" }); // redelivery
  assert.deepEqual(readStore(dir).map((l) => l.slug), ["k"], "second delete found nothing and no-op'd, didn't throw");
});

test("applyIntent delete-list keys on the STABLE id, so a replayed delete cannot destroy a recreated same-slug list", async () => {
  const dir = tmp();
  // The original list (id wi-1) was deleted; a new list reused slug "g" with a fresh id wi-2.
  const p = seedStore(dir, [cl({ id: "wi-2", slug: "g", name: "Groceries (new)", items: [item("x", "kale")] })]);
  await applyIntent(p, { id: 1, kind: "delete-list", listId: "wi-1" }); // stale replay of the OLD delete
  const lists = readStore(dir);
  assert.deepEqual(lists.map((l) => l.id), ["wi-2"], "the recreated list (different id) survives the slug-reusing replay");
  assert.equal(lists[0].deleted, undefined);
});

test("applyIntent delete-list on an unknown or already-deleted list is a no-op, not an error", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", name: "Groceries" }), cl({ slug: "d", deleted: true })]);
  await applyIntent(p, { id: 1, kind: "delete-list", listId: "nope" }); // unknown id
  await applyIntent(p, { id: 2, kind: "delete-list", listId: "d" });    // already deleted (filtered by !deleted)
  assert.deepEqual(readStore(dir).map((l) => l.slug), ["g", "d"], "nothing removed, nothing threw");
});

test("applyIntent recreate-list: drops the old un-mirrored list, adds a same-slug wi-<id> copy with all items unchecked", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ id: "old", slug: "g", name: "Groceries", items: [
    item("a", "milk", { checked: true, checkedAt: "2026-01-01T00:00:00Z", due: "2026-09-01T00:00:00Z" }),
    item("b", "eggs"),
  ] })]);
  await applyIntent(p, { id: 5, kind: "recreate-list", listId: "old", at: "2026-08-11T00:00:00Z" });
  const lists = readStore(dir);
  assert.equal(lists.length, 1, "old dropped outright (no mirror to drain), one fresh list");
  const fresh = lists[0];
  assert.equal(fresh.id, "wi-5", "deterministic fresh-list id from the intent id");
  assert.equal(fresh.slug, "g");
  assert.equal(fresh.name, "Groceries");
  assert.equal(fresh.created, "2026-08-11T00:00:00Z");
  assert.deepEqual(fresh.items.map((i) => ({ text: i.text, checked: i.checked, due: i.due ?? null })), [
    { text: "milk", checked: false, due: "2026-09-01T00:00:00Z" }, // due preserved
    { text: "eggs", checked: false, due: null },
  ]);
  assert.equal(fresh.items.every((i) => i.checkedAt === undefined), true, "completion wiped");
  assert.equal(fresh.items.every((i) => /^[0-9a-f]{16}$/.test(i.id)), true, "fresh item ids, not the old ones");
});

test("applyIntent recreate-list: a mirrored list is TOMBSTONED to drain its channel, and the fresh copy re-binds the channel", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ id: "old", slug: "g", name: "Groceries", channelId: "c1", items: [
    item("a", "milk", { checked: true, mirrorMessageId: "m1" }),
    item("b", "eggs"),
  ] })]);
  await applyIntent(p, { id: 9, kind: "recreate-list", listId: "old" });
  const lists = readStore(dir);
  assert.equal(lists.length, 2);
  const tomb = lists.find((l) => l.id === "old")!;
  assert.equal(tomb.deleted, true);
  assert.deepEqual(tomb.items, []);
  assert.deepEqual(tomb.pendingUnmirror, ["m1"], "posted mirror message queued for the gateway to delete in c1");
  const fresh = lists.find((l) => l.id === "wi-9")!;
  assert.equal(fresh.slug, "g");
  assert.equal(fresh.channelId, "c1", "re-bound to the same channel, fresh");
  assert.deepEqual(fresh.items.map((i) => ({ text: i.text, checked: i.checked })), [
    { text: "milk", checked: false },
    { text: "eggs", checked: false },
  ]);
  assert.equal(fresh.items[0].mirrorMessageId, undefined, "no carried-over mirror binding");
});

test("applyIntent recreate-list: redelivering the SAME intent is a true no-op (the fresh wi-<id> already exists)", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ id: "old", slug: "g", name: "Groceries", items: [item("a", "milk")] })]);
  await applyIntent(p, { id: 5, kind: "recreate-list", listId: "old" });
  const firstIds = readStore(dir).map((l) => l.id);
  await applyIntent(p, { id: 5, kind: "recreate-list", listId: "old" }); // redelivery
  assert.deepEqual(readStore(dir).map((l) => l.id), firstIds, "no second copy, old not re-retired");
  assert.equal(readStore(dir).length, 1);
});

test("applyIntent recreate-list keys on the STABLE id, so a stale replay can't reset a recreated same-slug list", async () => {
  const dir = tmp();
  // The original (id wi-1) is gone; a newer list reused slug "g" with fresh id wi-2.
  const p = seedStore(dir, [cl({ id: "wi-2", slug: "g", name: "Groceries (new)", items: [item("x", "kale", { checked: true })] })]);
  await applyIntent(p, { id: 1, kind: "recreate-list", listId: "wi-1" }); // stale replay targeting the OLD id
  const lists = readStore(dir);
  assert.deepEqual(lists.map((l) => l.id), ["wi-2"], "the current list survives untouched");
  assert.equal(lists[0].items[0].checked, true, "its completion state is NOT reset by the stale replay");
});

test("applyIntent recreate-list on an unknown or already-deleted list is a no-op, not an error", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ id: "g", slug: "g", name: "Groceries" }), cl({ id: "d", slug: "d", deleted: true })]);
  await applyIntent(p, { id: 1, kind: "recreate-list", listId: "nope" }); // unknown id
  await applyIntent(p, { id: 2, kind: "recreate-list", listId: "d" });    // already deleted (filtered by !deleted)
  assert.deepEqual(readStore(dir).map((l) => l.id), ["g", "d"], "nothing added, nothing threw");
});

test("applyIntent remove-item: drops the item by id, queues its mirror message, and is idempotent on redelivery", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", name: "Groceries", items: [
    item("a", "milk", { mirrorMessageId: "m1" }),
    item("b", "eggs"),
  ] })]);
  await applyIntent(p, { id: 1, kind: "remove-item", listSlug: "g", itemId: "a" });
  let list = readStore(dir)[0];
  assert.deepEqual(list.items.map((i) => i.id), ["b"], "milk removed, eggs kept");
  assert.deepEqual(list.pendingUnmirror, ["m1"], "the posted mirror message is queued for the gateway");
  await applyIntent(p, { id: 1, kind: "remove-item", listSlug: "g", itemId: "a" }); // redelivery
  list = readStore(dir)[0];
  assert.deepEqual(list.items.map((i) => i.id), ["b"], "redelivery is a no-op (item already gone)");
  assert.deepEqual(list.pendingUnmirror, ["m1"], "no duplicate unmirror queued");
});

test("applyIntent remove-item on a missing item OR a missing/deleted list is a no-op, not an error", async () => {
  const dir = tmp();
  const p = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] }), cl({ slug: "d", deleted: true, items: [item("x", "gone")] })]);
  await applyIntent(p, { id: 1, kind: "remove-item", listSlug: "g", itemId: "nope" });   // missing item
  await applyIntent(p, { id: 2, kind: "remove-item", listSlug: "ghost", itemId: "a" });  // missing list
  await applyIntent(p, { id: 3, kind: "remove-item", listSlug: "d", itemId: "x" });      // deleted list
  assert.deepEqual(readStore(dir).find((l) => l.slug === "g")!.items.map((i) => i.id), ["a"], "nothing removed, nothing threw");
});

// A cap-hit no-op is a SUCCESSFUL apply, so wireLink must still ACK it (advance
// appliedThrough), never leave it pending -- otherwise the DO redelivers it forever.

test("wireLink: a cap-hit add-item is acked normally (no-op counts as applied, not failed)", async () => {
  const dir = tmp();
  const full = Array.from({ length: 1000 }, (_, i) => item(`i${i}`, `t${i}`));
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: full })]);
  const statePath = seedState(dir); // appliedThrough starts at 0
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 1, kind: "add-item", listSlug: "g", text: "overflow" });
  await wired.flushIntents();

  assert.equal(readStore(dir)[0].items.length, 1000, "still at the cap, nothing appended");
  assert.equal(loadState(statePath).appliedThrough, 1, "acked -- not left pending for redelivery");
  assert.deepEqual(acks, [1]);
});

test("wireLink: a cap-hit create-list is acked normally (no-op counts as applied, not failed)", async () => {
  const dir = tmp();
  const many = Array.from({ length: 200 }, (_, i) => cl({ slug: `l${i}`, name: `L${i}` }));
  const checklistsPath = seedStore(dir, many);
  const statePath = seedState(dir);
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 1, kind: "create-list", name: "One More" });
  await wired.flushIntents();

  assert.equal(readStore(dir).length, 200, "still at the cap, no list created");
  assert.equal(loadState(statePath).appliedThrough, 1, "acked -- not left pending for redelivery");
  assert.deepEqual(acks, [1]);
});

// Redelivery guard (review a8f620e) -- the cheap fast-path atop the identity-keyed delete
// (review 95e17d3): an intent at/below appliedThrough is skipped (still re-acked). Here the
// stale delete's listId MATCHES the current list, so WITHOUT the guard applyIntent would
// delete it -- the guard is what saves it. (Identity-keying is the deeper safety net; this
// pins the fast-path.)

test("wireLink: a redelivered delete-list at/below appliedThrough is skipped, not re-applied", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ id: "wi-1", slug: "g", name: "Groceries", items: [item("a", "milk")] })]);
  const statePath = seedState(dir, { appliedThrough: 1 });
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 1, kind: "delete-list", listId: "wi-1" }); // stale redelivery; id matches the live list
  await wired.flushIntents();

  assert.deepEqual(readStore(dir).map((l) => l.slug), ["g"], "the list survived -- the stale redelivery was skipped");
  assert.equal(readStore(dir)[0].deleted, undefined, "and was not tombstoned");
  assert.deepEqual(acks, [1], "still re-acked so the DO stops redelivering");
});

test("wireLink: a fresh delete-list (id > appliedThrough) applies and acks", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ id: "wi-1", slug: "g", name: "G", items: [] }), cl({ slug: "k", name: "K" })]);
  const statePath = seedState(dir); // appliedThrough 0
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 1, kind: "delete-list", listId: "wi-1" });
  await wired.flushIntents();

  assert.deepEqual(readStore(dir).map((l) => l.slug), ["k"], "the fresh delete removed the list");
  assert.deepEqual(acks, [1]);
  assert.equal(loadState(statePath).appliedThrough, 1);
});

// ---------- slugify / uniqueSlug units ----------

test("slugify: lowercases, collapses punctuation/space runs to single -, trims edges", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Weekend   Trip!!  "), "weekend-trip");
  assert.equal(slugify("A/B & C"), "a-b-c");
  assert.equal(slugify("--Leading and trailing--"), "leading-and-trailing");
});

test("slugify: an emptyish / un-sluggable name falls back to a non-empty default", () => {
  assert.equal(slugify(""), "list");
  assert.equal(slugify("!!!"), "list");
  assert.equal(slugify("   "), "list");
  assert.equal(slugify("😀"), "list");
});

test("uniqueSlug: returns base when free, suffixes -2/-3 on live collisions, ignores deleted", () => {
  const lists = [cl({ slug: "a" }), cl({ slug: "a-2" }), cl({ slug: "gone", deleted: true })];
  assert.equal(uniqueSlug("b", lists), "b");
  assert.equal(uniqueSlug("a", lists), "a-3");
  assert.equal(uniqueSlug("gone", lists), "gone", "a deleted slug does not collide");
});

// ---------- wireLink: on-demand view build + intent apply/ack over the link ----------

function wlDeps(dir: string, checklistsPath: string, statePath: string, over: { logs?: string[]; allowlistPath?: string } = {}): WireLinkDeps {
  const errs = over.logs ?? [];
  // allowlistPath defaults to a fresh temp/no-file path (never the real default ALLOWLIST_PATH),
  // so every wireLink test built via this helper stays hermetic without threading it by hand.
  return { checklistsPath, statePath, buildCollections: emptyCollections, env: {} as NodeJS.ProcessEnv, logErr: (m: string) => errs.push(m), allowlistPath: over.allowlistPath ?? noFile() };
}

test("wireLink: a pull builds the view fresh and replies via sendView with the pull's own id as inReplyTo", () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link, sentViews, firePull } = fakeLink();
  wireLink(link, wlDeps(dir, checklistsPath, statePath));

  firePull(42);

  assert.equal(sentViews.length, 1);
  assert.equal(sentViews[0].inReplyTo, 42, "the pull's id, echoed as inReplyTo");
  assert.deepEqual(sentViews[0].view.lists[0].items.map((i) => i.id), ["a"]);
  assert.equal(sentViews[0].viewVersion, viewVersion(sentViews[0].view), "version matches the sent view");
});

test("wireLink payload fallback publishes no Collections all-or-none while preserving lists/recipients and versioning the fallback", () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link, sentViews, firePull } = fakeLink();
  const deps = wlDeps(dir, checklistsPath, statePath);
  deps.env = { OPERATOR_EMAIL: "operator@example.com" };
  deps.buildCollections = () => [{
    slug: "huge",
    name: "Huge",
    items: [{ description: "Huge", detailHtml: "x".repeat(MAX_HOME_VIEW_BYTES) }],
  }];
  wireLink(link, deps);

  firePull(7);

  assert.equal(sentViews.length, 1);
  const sent = sentViews[0];
  assert.deepEqual(sent.view.collections, [], "oversize Collections are removed as a whole, never truncated");
  assert.deepEqual(sent.view.lists[0].items.map((entry) => entry.text), ["milk"]);
  assert.deepEqual(sent.view.recipients, ["operator@example.com"]);
  assert.equal(sent.viewVersion, viewVersion(sent.view), "the digest is computed from the fallback actually sent");
  assert.ok(new TextEncoder().encode(JSON.stringify(sent.view)).length <= MAX_HOME_VIEW_BYTES);
});

test("wireLink includes the complete Collections view at the exact inclusive payload cap", () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link, sentViews, firePull } = fakeLink();
  const recipients = ["operator@example.com"];
  const collection: ViewCollection = {
    slug: "exact",
    name: "Exact",
    items: [{ description: "At cap", detailHtml: "" }],
  };
  const baseView = buildView(readStore(dir), recipients, [collection]);
  const baseBytes = new TextEncoder().encode(JSON.stringify(baseView)).length;
  collection.items[0].detailHtml = "x".repeat(MAX_HOME_VIEW_BYTES - baseBytes);
  const completeView = buildView(readStore(dir), recipients, [collection]);
  assert.equal(new TextEncoder().encode(JSON.stringify(completeView)).length, MAX_HOME_VIEW_BYTES,
    "the complete serialized View shape is exactly at the UTF-8 cap");

  const deps = wlDeps(dir, checklistsPath, statePath);
  deps.env = { OPERATOR_EMAIL: recipients[0] };
  deps.buildCollections = () => [collection];
  wireLink(link, deps);
  firePull(8);

  assert.equal(sentViews.length, 1);
  assert.deepEqual(sentViews[0].view, completeView, "the inclusive cap retains the complete view, including Collections");
  assert.deepEqual(sentViews[0].view.collections, [collection]);
  assert.equal(sentViews[0].viewVersion, viewVersion(completeView), "the complete exact-cap view is the versioned view");
});

test("wireLink payload fallback republishes Collections normally after a later under-cap change", () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [] })]);
  const statePath = seedState(dir);
  const { link, changed, sentViews, firePull } = fakeLink();
  let collections: ViewCollection[] = [{
    slug: "huge",
    name: "Huge",
    items: [{ description: "Huge", detailHtml: "x".repeat(MAX_HOME_VIEW_BYTES) }],
  }];
  const deps = wlDeps(dir, checklistsPath, statePath);
  deps.buildCollections = () => collections;
  const wired = wireLink(link, deps);

  wired.checkForChanges();
  assert.deepEqual(changed, [], "the unchanged oversize fallback is stable");

  collections = [{ slug: "small", name: "Small", items: [{ description: "Item", detailHtml: "<p>ok</p>" }] }];
  wired.checkForChanges();
  const expected = buildView(readStore(dir), [], collections);
  assert.deepEqual(changed, [viewVersion(expected)], "coming under cap changes back to the complete view version");

  firePull(8);
  assert.deepEqual(sentViews[0].view.collections, collections, "the complete under-cap Collections return on the next publication");
  assert.equal(sentViews[0].viewVersion, viewVersion(expected));
});

// --- B1: onPull containment (C2/core-C2 -- a corrupt/unreadable store at pull time must
// not crash the surface; the DO's bounded pull-timeout -> serve-stale-cache is the
// designed degradation) --------------------------------------------------------------

test("wireLink: onPull's buildCurrentView throwing (a corrupt/unreadable store) does not crash -- logs and skips sendView", () => {
  const dir = tmp();
  // Constructed against a VALID, readable store (wireLink's own initial baseline read
  // must succeed, matching production -- home-bot.ts's outer try/catch is the thing
  // that covers a throw AT CONSTRUCTION time; this test is about a failure that
  // surfaces LATER, on a pull, which is B1's actual gap).
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link, sentViews, firePull } = fakeLink();
  const errs: string[] = [];
  const deps = wlDeps(dir, checklistsPath, statePath, { logs: errs });
  wireLink(link, deps);

  // NOW corrupt the store the same deterministic way the intent-failure tests do: a
  // plain file occupying a path segment readChecklists needs to be a directory, so
  // readFileSync throws ENOTDIR -- standing in for any real corrupt-JSON/EACCES/EIO
  // failure. wireLink reads deps.checklistsPath fresh on every call, so mutating this
  // same deps object reaches the already-registered onPull handler.
  const blocker = join(dir, "blocker-pull");
  writeFileSync(blocker, "x");
  deps.checklistsPath = join(blocker, "checklists.json");

  assert.doesNotThrow(() => firePull(1), "no throw escapes onPull's callback");
  assert.equal(sentViews.length, 0, "no view sent on failure -- the DO's pull-timeout serves stale cache instead");
  assert.equal(errs.length, 1, "the failure is logged, not silent");
  assert.match(errs[0], /pull 1 failed/);
});

test("wireLink: onPull recovers on the NEXT pull once the store is readable again (a transient failure, not a permanent one)", () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link, sentViews, firePull } = fakeLink();
  const errs: string[] = [];
  const deps = wlDeps(dir, checklistsPath, statePath, { logs: errs });
  wireLink(link, deps);

  const blocker = join(dir, "blocker-pull-2");
  writeFileSync(blocker, "x");
  deps.checklistsPath = join(blocker, "checklists.json");
  firePull(1);
  assert.equal(sentViews.length, 0);

  // "Repair" the store: point checklistsPath back at the real, readable file.
  deps.checklistsPath = checklistsPath;
  firePull(2);
  assert.equal(sentViews.length, 1, "the very next pull succeeds normally once the store is readable again");
  assert.equal(sentViews[0].inReplyTo, 2);
});

test("wireLink: a pull after a store change carries the FRESH view, not a stale cached one", () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link, sentViews, firePull } = fakeLink();
  wireLink(link, wlDeps(dir, checklistsPath, statePath));

  firePull(1);
  assert.equal(sentViews[0].view.lists[0].items[0].checked, false);

  seedStore(dir, [cl({ slug: "g", items: [item("a", "milk", { checked: true })] })]);
  firePull(2);
  assert.equal(sentViews[1].view.lists[0].items[0].checked, true, "on-demand: rebuilt from the store, not cached from the first pull");
});

test("wireLink: an inbound intent applies through the shared store lock, persists appliedThrough, then acks with the advanced cursor", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir); // appliedThrough starts at 0
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 1, kind: "check", listSlug: "g", itemId: "a" }); // contiguous: 0+1
  await wired.flushIntents();

  assert.equal(readStore(dir)[0].items[0].checked, true, "applied through applyIntent/mutate()");
  assert.equal(loadState(statePath).appliedThrough, 1, "persisted durably to STATE_DIR");
  assert.deepEqual(acks, [1]);
});

test("wireLink: an older, already-passed intent id (a redelivered dup) is SKIPPED and does not retreat the cursor", async () => {
  const dir = tmp();
  // Original intent 3 checked "b"; the operator LATER unchecked it (so it's stored unchecked
  // now, appliedThrough at 5). A stale redelivery of intent 3 must be SKIPPED -- re-applying
  // the check would clobber the operator's later uncheck. Seeding "b" unchecked makes this
  // test discriminating: it fails if the guard is removed (a re-applied check would flip it).
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk"), item("b", "eggs")] })]);
  const statePath = seedState(dir, { appliedThrough: 5 });
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 3, kind: "check", listSlug: "g", itemId: "b" }); // older than the cursor -- a redelivered dup
  await wired.flushIntents();

  assert.equal(readStore(dir)[0].items[1].checked, false, "skipped -- the operator's later uncheck is not clobbered by the stale re-check");
  assert.equal(loadState(statePath).appliedThrough, 5, "cursor stays at the highest id already seen, never retreats");
  assert.deepEqual(acks, [5], "re-acked so the DO stops redelivering");
});

test("wireLink: a contiguous success advances the cursor normally", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir, { appliedThrough: 4 });
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 5, kind: "check", listSlug: "g", itemId: "a" }); // 4+1: contiguous
  await wired.flushIntents();

  assert.equal(loadState(statePath).appliedThrough, 5);
  assert.deepEqual(acks, [5]);
});

test("wireLink: a genuine DO-side gap (id > appliedThrough+1, no prior local failure) still advances the cursor -- ids may legitimately have gaps", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir, { appliedThrough: 4 });
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  // id 5 was never delivered at all (e.g. the DO's pending[] evicted it, or -- once A7
  // lands -- the down-push's own independent nextDownId allocation) -- as opposed to
  // being delivered and failing locally. This connection never saw 5, so failedFloor is
  // still Infinity and the gap must NOT wedge the cursor.
  fireIntent({ id: 6, kind: "check", listSlug: "g", itemId: "a" });
  await wired.flushIntents();

  assert.equal(readStore(dir)[0].items[0].checked, true, "apply(6) succeeds and lands on the store");
  assert.equal(loadState(statePath).appliedThrough, 6, "no locally-observed failure is blocking anything -- the gap advances");
  assert.deepEqual(acks, [6]);
});

test("wireLink: a reconnect (onOpen) clears failedFloor, so the failed id's eventual redelivered success un-wedges the cursor", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk"), item("b", "eggs")] })]);
  const statePath = seedState(dir, { appliedThrough: 4 });
  const { link, acks, fireIntent, fireOpen } = fakeLink();
  const errs: string[] = [];
  const deps = wlDeps(dir, checklistsPath, statePath, { logs: errs });
  const wired = wireLink(link, deps);

  // 5 fails locally (floor=5); 6 arrives after and is withheld above the floor -- same
  // shape as the CRITICAL batch test.
  const blocker = join(dir, "blocker-reconnect");
  writeFileSync(blocker, "x");
  deps.checklistsPath = join(blocker, "checklists.json");
  fireIntent({ id: 5, kind: "check", listSlug: "g", itemId: "a" });
  await wired.flushIntents();
  deps.checklistsPath = checklistsPath;
  fireIntent({ id: 6, kind: "check", listSlug: "g", itemId: "b" });
  await wired.flushIntents();
  assert.equal(loadState(statePath).appliedThrough, 4, "withheld, as in the CRITICAL batch test");

  // Reconnect: hello's redelivery is a full ascending replay from the DO's own cursor
  // (still 4), so 5 (still genuinely pending on the DO) comes down again FIRST, on the
  // new connection, and this time succeeds.
  fireOpen();
  fireIntent({ id: 5, kind: "check", listSlug: "g", itemId: "a" });
  await wired.flushIntents();
  assert.equal(loadState(statePath).appliedThrough, 5, "the floor's own id succeeded -- the cursor un-wedges");
  assert.deepEqual(acks, [4, 5], "5's earlier failure never acked at all -- only 6's withheld ack(4), then 5's own ack(5)");

  // ...and now that the floor is clear, 6 (redelivered again too) can advance normally.
  fireIntent({ id: 6, kind: "check", listSlug: "g", itemId: "b" });
  await wired.flushIntents();
  assert.equal(loadState(statePath).appliedThrough, 6);
  assert.deepEqual(acks, [4, 5, 6]);
});

test("wireLink CRITICAL: onOpen's failedFloor clear does not race an old-connection intent still draining through the chain", async () => {
  // If the clear were a bare `failedFloor = Infinity` outside intentChain (the bug fix
  // round 1 found), firing onOpen while intent 6's job is already queued-but-not-yet-run
  // would let 6 see the ALREADY-cleared floor and cumulatively ack past the still-failed
  // 5. Chaining the clear through intentChain instead guarantees it lands strictly after
  // every intent queued before it -- this test fires onOpen immediately after queuing 6,
  // with no await in between, to pin exactly that ordering.
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk"), item("b", "eggs")] })]);
  const statePath = seedState(dir, { appliedThrough: 4 });
  const { link, acks, fireIntent, fireOpen } = fakeLink();
  const errs: string[] = [];
  const deps = wlDeps(dir, checklistsPath, statePath, { logs: errs });
  const wired = wireLink(link, deps);

  const blocker = join(dir, "blocker-race");
  writeFileSync(blocker, "x");
  deps.checklistsPath = join(blocker, "checklists.json");
  fireIntent({ id: 5, kind: "check", listSlug: "g", itemId: "a" });
  await wired.flushIntents(); // 5 fails and settles -- floor=5
  deps.checklistsPath = checklistsPath; // 6 will succeed

  // Queue 6, then immediately fire onOpen -- no await between them, so 6's chain step is
  // still pending (not yet run) at the moment onOpen's clear is chained on.
  fireIntent({ id: 6, kind: "check", listSlug: "g", itemId: "b" });
  fireOpen();
  await wired.flushIntents();

  assert.equal(loadState(statePath).appliedThrough, 4, "6 ran BEFORE the chained clear -- still saw floor=5, withheld");
  assert.deepEqual(acks, [4], "5 never acked at all (failed); 6's withheld ack(4); the clear itself sends nothing");
});

test("wireLink CRITICAL: batch [5,6] with 5 failing keeps appliedThrough at 4 -- 6's success must NOT cumulatively ack past the lost 5", async () => {
  // This is the 73f4510 bug this fix targets: acks are cumulative on the DO, so acking 6
  // after a bare Math.max(4, 6) = 6 would make the DO drop 5 forever, even though 5 never
  // applied. The contiguous-frontier rule must withhold the cursor at 4 for BOTH: intent 5
  // (fails to apply) and intent 6 (succeeds, but is now a gap since 5 didn't land).
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk"), item("b", "eggs")] })]);
  const statePath = seedState(dir, { appliedThrough: 4 });
  const { link, acks, fireIntent } = fakeLink();
  const errs: string[] = [];
  const deps = wlDeps(dir, checklistsPath, statePath, { logs: errs });
  const wired = wireLink(link, deps);

  // Force intent 5's applyIntent to reject deterministically (same ENOTDIR trick as the
  // dedicated failure test below), then restore a valid path before 6 is processed.
  const blocker = join(dir, "blocker5");
  writeFileSync(blocker, "x");
  deps.checklistsPath = join(blocker, "checklists.json");
  fireIntent({ id: 5, kind: "check", listSlug: "g", itemId: "a" });
  await wired.flushIntents(); // let 5 fail and settle before 6 arrives
  deps.checklistsPath = checklistsPath; // restore -- 6 will succeed

  fireIntent({ id: 6, kind: "check", listSlug: "g", itemId: "b" });
  await wired.flushIntents();

  assert.equal(errs.length, 1, "5's failure was logged");
  assert.match(errs[0], /intent 5 failed/);
  assert.equal(readStore(dir)[0].items[1].checked, true, "6 itself still applies to the store");
  assert.equal(loadState(statePath).appliedThrough, 4, "cursor never advances past 4 -- 5 is not lost");
  assert.deepEqual(acks, [4], "only 6's ack fires (5 never acked at all); it acks the unchanged cursor 4, never dropping 5 on the DO");
});

test("wireLink: intents delivered together (as the real batched-frame transport does) are applied in the order onIntent received them, not raced", async () => {
  // Mirrors home-link.ts's own batching: HomeLink._onMessage loops over every message in
  // one frame and invokes onIntent's callback synchronously for each, back to back, with
  // no await between them. A check(id 5) immediately followed by an uncheck(id 6) of the
  // SAME item, delivered that way, must land unchecked (id 6's result) -- not racily
  // reordered by proper-lockfile's non-FIFO retry-based lock acquisition.
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir, { appliedThrough: 4 }); // so 5 is contiguous
  const { link, acks, fireIntent } = fakeLink();
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 5, kind: "check", listSlug: "g", itemId: "a" });
  fireIntent({ id: 6, kind: "uncheck", listSlug: "g", itemId: "a" });
  await wired.flushIntents();

  assert.equal(readStore(dir)[0].items[0].checked, false, "the later uncheck(6) wins -- applied strictly after check(5), not racing it");
  assert.equal(loadState(statePath).appliedThrough, 6);
  assert.deepEqual(acks, [5, 6], "acked in the order received, each only after its own persist");
});

test("wireLink: a failed intent (mutate() rejects) skips the ack and logs, without crashing or ack'ing a mismatched cursor", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link, acks, fireIntent } = fakeLink();
  const errs: string[] = [];
  const deps = wlDeps(dir, checklistsPath, statePath, { logs: errs });
  const wired = wireLink(link, deps); // constructed against a valid, readable store

  // Force the NEXT applyIntent's mutate() to reject deterministically: point
  // checklistsPath at a location where a plain FILE occupies a path segment mutate()'s
  // ensureFile() needs to be a directory, so mkdirSync(..., {recursive:true}) throws
  // ENOTDIR -- standing in for any real transient failure (e.g. lock contention with the
  // CLI/Discord mirror). wireLink reads deps.checklistsPath fresh on every call (not a
  // captured copy), so mutating the same deps object here reaches the handler already
  // registered.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x");
  deps.checklistsPath = join(blocker, "checklists.json");

  fireIntent({ id: 1, kind: "check", listSlug: "g", itemId: "a" });
  await wired.flushIntents();

  assert.deepEqual(acks, [], "no ack sent for a failed apply -- the DO will redeliver");
  assert.equal(errs.length, 1, "the failure is logged, not swallowed");
  assert.match(errs[0], /intent 1 failed/);
});

test("wireLink CRITICAL: appliedThrough is durable on disk BEFORE sendAck is invoked (persist-before-ack)", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir); // appliedThrough starts at 0
  const { link, fireIntent } = fakeLink();
  const observedAtAckTime: Array<number | null> = [];
  const realSendAck = link.sendAck.bind(link);
  link.sendAck = (appliedThrough: number) => {
    // The whole redelivery model's safety rests on this: by the moment sendAck fires, the
    // cursor must already be durable, so a crash right after this call can never leave the
    // DO believing a tap was applied that STATE_DIR doesn't also know about.
    observedAtAckTime.push(loadState(statePath).appliedThrough);
    realSendAck(appliedThrough);
  };
  const wired = wireLink(link, wlDeps(dir, checklistsPath, statePath));

  fireIntent({ id: 1, kind: "check", listSlug: "g", itemId: "a" }); // contiguous: 0+1
  await wired.flushIntents();

  assert.deepEqual(observedAtAckTime, [1], "on-disk cursor already advanced to 1 at the moment sendAck ran");
});

test("wireLink: checkForChanges emits `changed` with the new version once the store changes, and nothing on a no-op rebuild", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link, changed } = fakeLink();
  const deps = wlDeps(dir, checklistsPath, statePath);
  const wired = wireLink(link, deps);

  wired.checkForChanges();
  assert.deepEqual(changed, [], "no-op rebuild (nothing changed since wireLink's baseline) sends nothing");

  await applyIntent(checklistsPath, { id: 1, kind: "check", listSlug: "g", itemId: "a" });
  wired.checkForChanges();
  const expected = viewVersion(buildView(readStore(dir), recipientsFromEnv(deps.env, deps.allowlistPath), []));
  assert.deepEqual(changed, [expected]);

  wired.checkForChanges(); // called again with no further change
  assert.deepEqual(changed, [expected], "still just the one `changed` -- the digest is unchanged");
});

test("wireLink: currentVersion() reports the LIVE store digest on demand, independent of checkForChanges's cached baseline", async () => {
  const dir = tmp();
  const checklistsPath = seedStore(dir, [cl({ slug: "g", items: [item("a", "milk")] })]);
  const statePath = seedState(dir);
  const { link } = fakeLink();
  const deps = wlDeps(dir, checklistsPath, statePath);
  const wired = wireLink(link, deps);

  const v0 = wired.currentVersion();
  assert.equal(v0, viewVersion(buildView(readStore(dir), recipientsFromEnv(deps.env, deps.allowlistPath), [])));

  await applyIntent(checklistsPath, { id: 1, kind: "check", listSlug: "g", itemId: "a" });
  const v1 = wired.currentVersion();
  assert.notEqual(v1, v0, "reflects the store change immediately, without needing checkForChanges() called first");
});


// ---------- canonical todo lists (reconcileCanonicalLists / reconcileCanonicalChecklists) ----------
//
// The membership-driven mint/clear of the two canonical list kinds: every tenant gets a
// flagged "household-todo" plus one flagged "<member>-todo" per PERSON, minted by the
// CONTAINER (never the DO) whenever the members snapshot is applied. A person is their
// EMAIL -- the login identity, exactly one per member -- so the roster's extra phone rows
// are ignored and one member gets ONE list, never an address-labeled duplicate (the
// 2026-08-24 release bug). Removing a member clears their list's flag (it becomes an
// ordinary, deletable list) and nothing else.

import { reconcileCanonicalLists, reconcileCanonicalChecklists } from "./home-mirror.ts";

const roster = (senders: string[], recipients: string[], names: Record<string, string> = {}) => ({ senders, recipients, names });

test("reconcileCanonicalLists: a member with email + phone rows is ONE person -- ONE todo list keyed by the email (no address-labeled duplicate)", () => {
  // The 2026-08-24 release bug: brunosemail@gmail.com and +15551234567 are Bruno's two
  // contact rows, but the per-row mint produced BOTH "Bruno-todo" AND
  // "brunosemail@gmail.com-todo". Roster shape is exactly what deriveSnapshot pushes.
  const { lists, changed } = reconcileCanonicalLists(
    [],
    roster(["brunosemail@gmail.com", "+15551234567"], ["brunosemail@gmail.com", "+15551234567"], {
      "brunosemail@gmail.com": "Bruno",
      "+15551234567": "Bruno",
    }),
  );
  assert.equal(changed, true);
  const memberTodos = lists.filter((l) => l.special === "member-todo");
  assert.equal(memberTodos.length, 1, "one list per person, not one per contact row");
  assert.equal(memberTodos[0].name, "Bruno-todo");
  assert.equal(memberTodos[0].slug, "bruno-todo");
  assert.equal(memberTodos[0].memberAddress, "brunosemail@gmail.com");
  assert.equal(lists.some((l) => l.name.includes("@")), false, "no list is named after a raw address");
  assert.equal(lists.filter((l) => l.special === "household-todo").length, 1);
});

test("reconcileCanonicalLists: idempotent -- a second run over its own output changes nothing (phone rows present)", () => {
  const r = roster(["brunosemail@gmail.com", "+15551234567"], ["brunosemail@gmail.com", "+15551234567"], {
    "brunosemail@gmail.com": "Bruno",
    "+15551234567": "Bruno",
  });
  const first = reconcileCanonicalLists([], r);
  const second = reconcileCanonicalLists(first.lists, r);
  assert.equal(second.changed, false);
  assert.equal(second.lists.filter((l) => l.special === "member-todo").length, 1);
});

test("reconcileCanonicalLists: a provision-shaped roster mints household-todo + <operator>-todo, both flagged", () => {
  const { lists, changed } = reconcileCanonicalLists([], roster([], ["op@example.com"], { "op@example.com": "Op" }));
  assert.equal(changed, true);
  assert.equal(lists.length, 2);
  const hh = lists.find((l) => l.special === "household-todo")!;
  assert.equal(hh.name, "household-todo");
  assert.equal(hh.slug, "household-todo");
  assert.equal(hh.memberAddress, undefined);
  const op = lists.find((l) => l.special === "member-todo")!;
  assert.equal(op.name, "Op-todo");
  assert.equal(op.slug, "op-todo");
  assert.equal(op.memberAddress, "op@example.com");
});

test("reconcileCanonicalLists: idempotent -- a second run over its own output changes nothing", () => {
  const first = reconcileCanonicalLists([], roster(["a@x.com"], ["a@x.com", "b@y.com"]));
  const second = reconcileCanonicalLists(first.lists, roster(["a@x.com"], ["a@x.com", "b@y.com"]));
  assert.equal(second.changed, false);
  assert.equal(second.lists.length, first.lists.length);
});

test("reconcileCanonicalLists: a removed member's list loses its flag (and ONLY the flag) -- the list itself survives", () => {
  const seeded = reconcileCanonicalLists([], roster([], ["op@example.com"])).lists;
  seeded.find((l) => l.special === "member-todo")!.items.push(item("i1", "mow the lawn"));
  const after = reconcileCanonicalLists(seeded, roster([], []));
  assert.equal(after.changed, true);
  const opList = after.lists.find((l) => l.slug === "op-todo")!;
  assert.equal(opList.special, undefined);
  assert.equal(opList.memberAddress, undefined);
  assert.equal(opList.items.length, 1); // untouched beyond the flag
  const hh = after.lists.find((l) => l.special === "household-todo")!;
  assert.ok(hh, "household-todo stays flagged with an empty roster");
});

test("reconcileCanonicalLists: a member in senders-only still gets their list (membership is the union)", () => {
  const { lists } = reconcileCanonicalLists([], roster(["sam@x.com"], []));
  assert.ok(lists.some((l) => l.special === "member-todo" && l.memberAddress === "sam@x.com"));
});

test("reconcileCanonicalLists: an unnamed member's label is the email local part; a PHONE-only row mints nothing", () => {
  const { lists } = reconcileCanonicalLists([], roster([], ["dana@z.com", "+15551234567"]));
  const memberTodos = lists.filter((l) => l.special === "member-todo");
  assert.equal(memberTodos.length, 1);
  assert.equal(memberTodos[0].name, "dana-todo");
  assert.equal(memberTodos[0].memberAddress, "dana@z.com");
});

test("reconcileCanonicalLists: two DIFFERENT members sharing a display name are split -- 'Sam-todo' and 'Sam-2-todo'", () => {
  // Both Sams also carry phone rows -- ignored, like every phone row. sam2@y.com sorts
  // before sam@x.com (codepoint: '2' < '@'), so sam2 gets the bare "Sam".
  const { lists } = reconcileCanonicalLists(
    [],
    roster([], ["sam@x.com", "+15550000001", "sam2@y.com", "+15550000002"], {
      "sam@x.com": "Sam", "+15550000001": "Sam", "sam2@y.com": "Sam", "+15550000002": "Sam",
    }),
  );
  const memberTodos = lists.filter((l) => l.special === "member-todo");
  assert.equal(memberTodos.length, 2);
  assert.deepEqual(memberTodos.map((l) => l.name).sort(), ["Sam-2-todo", "Sam-todo"]);
  assert.deepEqual(memberTodos.map((l) => l.slug).sort(), ["sam-2-todo", "sam-todo"]);
  assert.equal(memberTodos.find((l) => l.name === "Sam-todo")!.memberAddress, "sam2@y.com");
  assert.equal(memberTodos.find((l) => l.name === "Sam-2-todo")!.memberAddress, "sam@x.com");
  assert.equal(lists.some((l) => l.name.includes("@")), false, "no raw-address list names");
});

test("reconcileCanonicalLists: LEGACY per-row mint heals -- the email-keyed list is adopted and renamed, the phone-keyed duplicate is unflagged", () => {
  // Exactly what the 2026-08-24 release minted for Bruno: the phone row sorted first and
  // claimed the name label; the email row fell back to its full address as the label.
  const legacy: Checklist[] = [
    { id: "l1", slug: "bruno-todo", name: "Bruno-todo", special: "member-todo", memberAddress: "+15551234567", items: [], created: "", updated: "" },
    { id: "l2", slug: "brunosemail-gmail-com-todo", name: "brunosemail@gmail.com-todo", special: "member-todo", memberAddress: "brunosemail@gmail.com", items: [item("i1", "mow the lawn")], created: "", updated: "" },
  ];
  const { lists, changed } = reconcileCanonicalLists(legacy, roster([], ["brunosemail@gmail.com", "+15551234567"], {
    "brunosemail@gmail.com": "Bruno", "+15551234567": "Bruno",
  }));
  assert.equal(changed, true);
  const flagged = lists.filter((l) => l.special === "member-todo");
  assert.equal(flagged.length, 1, "exactly one flagged list survives -- one per person");
  assert.equal(flagged[0].id, "l2", "the email-keyed list is the one kept (email is the invariant identity)");
  assert.equal(flagged[0].name, "Bruno-todo", "renamed to the person's label");
  assert.equal(flagged[0].memberAddress, "brunosemail@gmail.com");
  assert.equal(flagged[0].items.length, 1, "items untouched by the adoption");
  assert.equal(flagged[0].slug, "bruno-todo-2", "slug re-derived -- the retired duplicate still holds bruno-todo until the family deletes it");
  const dup = lists.find((l) => l.id === "l1")!;
  assert.equal(dup.special, undefined, "the phone-keyed duplicate becomes an ordinary list (deletable in the DO UI)");
  assert.equal(dup.name, "Bruno-todo", "the unflagged list's name is left alone");
});

test("reconcileCanonicalLists: a renamed member keeps their SAME list (matched by email) and the list is renamed in place", () => {
  const seeded = reconcileCanonicalLists([], roster([], ["brunosemail@gmail.com"], { "brunosemail@gmail.com": "Bruno" })).lists;
  const original = seeded.find((l) => l.special === "member-todo")!;
  const after = reconcileCanonicalLists(seeded, roster([], ["brunosemail@gmail.com"], { "brunosemail@gmail.com": "Bruno Mars" }));
  assert.equal(after.changed, true);
  const renamed = after.lists.find((l) => l.id === original.id)!;
  assert.equal(renamed.special, "member-todo");
  assert.equal(renamed.name, "Bruno Mars-todo");
  assert.equal(renamed.slug, "bruno-mars-todo");
  assert.equal(after.lists.filter((l) => l.special === "member-todo").length, 1, "no duplicate mint -- the same list was adopted");
});

test("reconcileCanonicalLists: a user-made same-slug list is NOT adopted -- the canonical mint gets its own unique slug", () => {
  const userMade: Checklist[] = [{ id: "u1", slug: "household-todo", name: "household-todo", items: [], created: "", updated: "" }];
  const { lists } = reconcileCanonicalLists(userMade, roster([], ["op@example.com"]));
  const flagged = lists.filter((l) => l.special === "household-todo");
  assert.equal(flagged.length, 1);
  assert.notEqual(flagged[0].slug, "household-todo", "uniqueSlug moved the mint off the taken slug");
  assert.equal(lists.find((l) => l.id === "u1")!.special, undefined, "the ordinary list stays ordinary");
});

test("reconcileCanonicalLists: at the checklist cap nothing is minted (silent skip, mirrors create-list's posture)", () => {
  const full: Checklist[] = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, slug: `f${i}`, name: `f${i}`, items: [], created: "", updated: "" }));
  const { lists, changed } = reconcileCanonicalLists(full, roster([], ["op@example.com"]));
  assert.equal(changed, false);
  assert.equal(lists.length, 200);
  assert.equal(lists.some((l) => l.special), false);
});

test("buildView carries special on flagged lists and omits it otherwise (the DO's only signal)", () => {
  const lists = reconcileCanonicalLists([], roster([], ["op@example.com"])).lists;
  const view = buildView(lists, ["op@example.com"], emptyCollections());
  assert.equal(view.lists.find((l) => l.slug === "household-todo")!.special, "household-todo");
  assert.equal(view.lists.find((l) => l.slug === "op-todo")!.special, "member-todo");
  const plain = buildView([{ id: "p", slug: "p", name: "p", items: [], created: "", updated: "" }], [], emptyCollections());
  assert.equal("special" in plain.lists[0], false);
});

test("applyIntent recreate-list PRESERVES special/memberAddress on the fresh copy (a reset todo list must not lose its protection or duplicate-mint)", async () => {
  const dir = tmp();
  const seeded = reconcileCanonicalLists([], roster([], ["op@example.com"])).lists;
  const old = seeded.find((l) => l.special === "member-todo")!;
  const p = seedStore(dir, seeded);
  await applyIntent(p, { id: 9, kind: "recreate-list", listId: old.id, at: "2026-08-20T00:00:00Z" });
  const fresh = readStore(dir).find((l) => l.id === "wi-9")!;
  assert.equal(fresh.special, "member-todo");
  assert.equal(fresh.memberAddress, "op@example.com");
});

test("applyIntent delete-list still retires a special list -- the container deliberately does not enforce the rule", async () => {
  const dir = tmp();
  const seeded = reconcileCanonicalLists([], roster([], ["op@example.com"])).lists;
  const hh = seeded.find((l) => l.special === "household-todo")!;
  const p = seedStore(dir, seeded);
  await applyIntent(p, { id: 10, kind: "delete-list", listId: hh.id, at: "2026-08-20T00:00:00Z" });
  assert.equal(readStore(dir).some((l) => l.id === hh.id && !l.deleted), false);
});

test("reconcileCanonicalChecklists: IO wrapper mints through the store lock on an absent store, then no-ops", async () => {
  const dir = tmp();
  const p = join(dir, "checklists.json");
  const changed1 = await reconcileCanonicalChecklists(p, roster([], ["op@example.com"]));
  assert.equal(changed1, true);
  const store = JSON.parse(readFileSync(p, "utf8")) as Checklist[];
  assert.ok(store.some((l) => l.special === "household-todo"));
  assert.ok(store.some((l) => l.special === "member-todo"));
  const changed2 = await reconcileCanonicalChecklists(p, roster([], ["op@example.com"]));
  assert.equal(changed2, false);
});

test("reconcileCanonicalLists: at MAX-1 live lists the household mint takes the last slot and member mints are skipped", () => {
  const cap = 200;
  const near: Checklist[] = Array.from({ length: cap - 1 }, (_, i) => ({ id: `f${i}`, slug: `f${i}`, name: `f${i}`, items: [], created: "", updated: "" }));
  const { lists, changed } = reconcileCanonicalLists(near, roster([], ["op@example.com"]));
  assert.equal(changed, true);
  assert.equal(lists.length, cap);
  assert.equal(lists.filter((l) => l.special === "household-todo").length, 1, "household-first priority at the boundary");
  assert.equal(lists.some((l) => l.special === "member-todo"), false, "member mint silently skipped, mirrors create-list's cap posture");
});
