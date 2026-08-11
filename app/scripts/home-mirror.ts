// Family-home web mirror -- the CORE side (see docs/family-home-core-spec.md, superseded for
// the wire channel by docs/superpowers/specs/2026-08-03-home-websocket-transport-design.md).
// The checklist store stays the source of truth; the web page is a THIRD reflective mirror of
// it (alongside the CLI and the Discord channel). A control-plane Cloudflare Durable Object
// holds a published copy of the view plus a queue of pending taps; this module publishes
// the view and drains the taps, applying each through the SAME proper-lockfile mutate() the
// CLI uses -- that shared gate is why three writers are safe.
//
// D1 retired the HTTP poll path (runSyncTick and everything under it) that used to live in
// this file alongside wireLink -- the WebSocket link (home-link.ts's HomeLink, wired here via
// wireLink) is now the sole core<->DO channel. What remains: pure builders shared by both the
// link's onPull/onIntent handlers and the (now-gone) poll tick, plus wireLink itself.
//
// HARD INVARIANT (spec §5, operator-confirmed): draining and applying a tap is plain code
// start to finish. A tap must NEVER wake an LLM run. There are no model calls in this file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readChecklists, mutate, newItemId, MAX_ITEMS_PER_LIST, MAX_CHECKLISTS } from "./checklist-store.ts";
import type { Checklist } from "./checklist-store.ts";
import { loadState, saveState, freshState } from "./home-state.ts";
import type { HomeState } from "./home-state.ts";
import { HOME_KEYS_PATH, ALLOWLIST_PATH } from "./paths.ts";
import { loadAllowlist } from "./allowlist.ts";

// ---------- wire types (the contract, spec §Contract) ----------

export interface ViewItem { id: string; text: string; checked: boolean; due: string | null; category: string | null; }
// `id` is the stable store id (never the mutable slug). Exposed so the delete-list intent
// can target it by IDENTITY -- a replayed delete then can't hit a recreated same-slug list
// (its id differs), the same idempotency add-item/create-list get from `wi-<id>`. Symmetric
// with ViewItem.id, which the check intent already targets.
export interface ViewList { id: string; slug: string; name: string; open: number; total: number; items: ViewItem[]; }
export interface ViewProject { slug: string; name: string; html: string; }
export interface View { lists: ViewList[]; projects: ViewProject[]; recipients: string[]; }

// Intent kinds the DO pushes down the link, applied by applyIntent below (spec
// 2026-08-04-home-list-mutations-design.md). ALL kinds are idempotent on redelivery, which
// wireLink's persist-before-ack machinery relies on: check/uncheck re-apply is a no-op;
// add-item/create-list mint a deterministic record id from the intent id (`wi-<id>`) and
// no-op if that record already exists, so a redelivered add/create is a true no-op too. A
// discriminated union on `kind`, so applyIntent's switch narrows to the right fields and
// home-link.ts's isIntentLike can validate per-kind. The worker mirrors this exact shape
// (no shared import, verified by matching tests) -- keep it byte-consistent.
export interface CheckIntent { id: number; kind: "check" | "uncheck"; listSlug: string; itemId: string; at?: string; }
export interface AddItemIntent { id: number; kind: "add-item"; listSlug: string; text: string; at?: string; }
export interface CreateListIntent { id: number; kind: "create-list"; name: string; at?: string; }
export interface DeleteListIntent { id: number; kind: "delete-list"; listId: string; at?: string; }
// recreate-list: retire the list (by STABLE id) and replace it with a same-slug/name/channel
// list holding all-open copies of its items -- a "start this list over" reset that wipes the
// completion state while keeping the items. Idempotent like the others: the fresh list's id is
// deterministic (`wi-<id>`), so a redelivered recreate finds it and no-ops.
export interface RecreateListIntent { id: number; kind: "recreate-list"; listId: string; at?: string; }
// remove-item: delete one item (by listSlug + itemId) from a live list -- the home "Edit"
// mode's per-item trash. Naturally idempotent on redelivery: a filter-by-id find of an
// already-removed item is a no-op, so unlike add-item it needs no deterministic id.
export interface RemoveItemIntent { id: number; kind: "remove-item"; listSlug: string; itemId: string; at?: string; }
export type Intent = CheckIntent | AddItemIntent | CreateListIntent | DeleteListIntent | RecreateListIntent | RemoveItemIntent;

// ---------- pure builders (exported for tests) ----------

// The login allow-list: OPERATOR_EMAIL ∪ the shared allowlist.json recipients (fresh via
// loadAllowlist, file -> ALLOWED_RECIPIENTS env seed -> [] fail-closed), matching core's mail
// send side (resolveRecipient/allowedRecipients). Deduped case-insensitively and SORTED so
// this is a set semantically -- reordering the source must not change viewVersion and
// republish. Empty ⇒ nobody can log in (fails closed, exactly like the send side).
export function recipientsFromEnv(env: NodeJS.ProcessEnv = process.env, path: string = ALLOWLIST_PATH): string[] {
  const raw = loadAllowlist(env, path).recipients.slice(); // fresh each call: file -> env seed -> []
  const op = (env.OPERATOR_EMAIL || "").trim();
  if (op) raw.push(op);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) { const k = r.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out.sort();
}

// Build the published view from the store. Only live (non-deleted) lists; items keep the
// store's own ids (the DO addresses taps by listSlug + itemId). `due` is normalized to null.
export function buildView(lists: Checklist[], recipients: string[], projects: ViewProject[]): View {
  const viewLists: ViewList[] = lists
    .filter((l) => !l.deleted)
    .map((l) => {
      const items: ViewItem[] = l.items.map((i) => ({ id: i.id, text: i.text, checked: i.checked, due: i.due ?? null, category: i.category ?? null }));
      return { id: l.id, slug: l.slug, name: l.name, open: items.filter((i) => !i.checked).length, total: items.length, items };
    });
  return { lists: viewLists, projects, recipients };
}

// Deterministic serialization: sort object keys recursively, preserve array order. Two views
// that differ only in key insertion order digest the same; any content change (a list, an
// item, a project, OR a recipient) changes the digest. Distinct from a digest of
// checklists.json -- recipients come from env and project HTML from files, so a store-only
// digest would never republish an ALLOWED_RECIPIENTS change (spec §2, the load-bearing point).
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}
export function viewVersion(view: View): string {
  return createHash("sha256").update(canonicalize(view)).digest("hex");
}

// ---------- slug helper (exported for tests) ----------

// Longest a derived list slug may be -- matches projects-cli's MAX_SLUG_LEN so slugs stay a
// consistent length class across surfaces.
export const MAX_LIST_SLUG_LEN = 64;

// Derive a URL/store slug from a create-list name: lowercase, every run of non-alphanumerics
// collapses to a single "-", leading/trailing "-" trimmed, capped. Unlike projects-cli's
// slugify (which THROWS when a name has no slug-able chars), this FALLS BACK to a non-empty
// default -- a create-list intent from an emoji-only or punctuation-only name must still
// produce a usable list rather than wedge the web surface. Exported so the fallback + collapse
// rules are unit-testable.
export function slugify(name: string): string {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LIST_SLUG_LEN)
    .replace(/-+$/g, ""); // the slice can leave a trailing hyphen
  return slug || "list";
}

// Make `base` unique among the NON-DELETED lists' slugs, suffixing -2, -3, ... on collision.
// Deleted tombstones are ignored -- same coexistence rule as checklist-cli's `make` (a
// same-slug rm-tombstone drains + drops independently, matched by stable id, not slug).
export function uniqueSlug(base: string, lists: Checklist[]): string {
  const taken = new Set(lists.filter((l) => !l.deleted).map((l) => l.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------- applying an intent (through the shared checklist lock) ----------

// Apply one intent through the SAME mutate() the CLI uses. check/uncheck are idempotent, and a
// no-op if the list or item is gone (the operator deleted it; the tap is moot -- exactly as a
// removed item's reminder self-cancels). add-item appends to a live list (no-op if the list is
// missing/deleted, same tolerance as check). create-list appends a new list with a unique slug
// derived from the name. Mirrors checklist-cli's item/list creation exactly for the required
// Item/Checklist fields. Never throws for a missing target.
export async function applyIntent(path: string, intent: Intent): Promise<void> {
  await mutate(path, (lists) => {
    switch (intent.kind) {
      case "check":
      case "uncheck": {
        const list = lists.find((l) => l.slug === intent.listSlug && !l.deleted);
        const item = list?.items.find((i) => i.id === intent.itemId);
        if (item && list) {
          const checked = intent.kind === "check";
          if (item.checked !== checked) {
            item.checked = checked;
            if (checked) item.checkedAt = intent.at || new Date().toISOString();
            else delete item.checkedAt;
            list.updated = new Date().toISOString();
          }
        }
        break;
      }
      case "add-item": {
        const list = lists.find((l) => l.slug === intent.listSlug && !l.deleted);
        // Deterministic id from the DO's monotonic intent id (NOT newItemId()), so a
        // redelivered add -- the DO redelivers when apply succeeded but the ack didn't land
        // (persist-before-ack / crash) -- is a TRUE no-op: the exists-check below finds the
        // already-appended item and does nothing, instead of appending a duplicate. This is
        // the "applyIntent is idempotent" guarantee wireLink's ack machinery relies on.
        const itemId = `wi-${intent.id}`;
        // Silent no-op past the per-list item cap, mirroring checklist-cli's `add` (which
        // throws there). A cap-hit / already-present no-op is still a SUCCESSFUL apply --
        // nothing to do -- so wireLink acks it normally; only a genuine error skips the ack.
        if (list && list.items.length < MAX_ITEMS_PER_LIST && !list.items.some((i) => i.id === itemId)) {
          list.items.push({ id: itemId, text: intent.text.trim(), checked: false, created: intent.at || new Date().toISOString() });
          list.updated = new Date().toISOString();
        }
        break;
      }
      case "remove-item": {
        // Delete one item from a live list, mirroring checklist-cli's `remove`: queue its
        // posted mirror message for the gateway to delete (no-op if un-mirrored), then drop it
        // by id. No-op if the list or item is already gone -- so a redelivered remove (apply
        // succeeded, ack didn't land) finds nothing and is a true idempotent no-op, no
        // deterministic id required (the filter-by-id below can't match twice).
        const list = lists.find((l) => l.slug === intent.listSlug && !l.deleted);
        const item = list?.items.find((i) => i.id === intent.itemId);
        if (list && item) {
          if (item.mirrorMessageId) list.pendingUnmirror = [...(list.pendingUnmirror ?? []), item.mirrorMessageId];
          list.items = list.items.filter((i) => i.id !== item.id);
          list.updated = new Date().toISOString();
        }
        break;
      }
      case "create-list": {
        // Deterministic id from the intent id, same idempotency rationale as add-item above:
        // a redelivered create-list finds the already-made list by this stable id and no-ops,
        // instead of re-running uniqueSlug and creating a duplicate "name-2".
        const listId = `wi-${intent.id}`;
        // Silent no-op past the checklist cap (non-deleted only), mirroring checklist-cli's
        // `make`. Like add-item, a cap-hit / already-present no-op is a success that still acks.
        if (lists.filter((l) => !l.deleted).length < MAX_CHECKLISTS && !lists.some((l) => l.id === listId)) {
          const now = intent.at || new Date().toISOString();
          const name = intent.name.trim();
          const slug = uniqueSlug(slugify(name), lists);
          lists.push({ id: listId, slug, name, items: [], created: now, updated: now });
        }
        break;
      }
      case "delete-list": {
        // Find the list by STABLE ID, not slug (review 95e17d3): the slug is mutable/reusable,
        // so a replayed delete keyed on slug could destroy a DIFFERENT list that reused the
        // slug after the original was removed (the cursor guard in wireLink narrows but can't
        // fully close that window -- a delete whose ack was withheld by failedFloor sits above
        // the cursor). Keying on the immutable store id makes a redelivered delete a true
        // no-op regardless of cursor state -- the recreated list's id (`wi-<newer>` or a
        // CLI-minted id) can never match. Same identity-idempotency add-item/create-list get.
        //
        // Otherwise mirror checklist-cli's `rm` exactly. queueUnmirror is private to that CLI,
        // so replicate its two lines inline (same pattern as add-item/create-list replicating
        // make/add): queue any posted mirror-message ids for the gateway, then TOMBSTONE the
        // list if it has messages to drain (deleted + empty), else drop it OUTRIGHT (filter by
        // id -- a same-slug tombstone draining alongside a recreation isn't stranded).
        const list = lists.find((l) => l.id === intent.listId && !l.deleted);
        if (!list) break;
        const ids = list.items.map((i) => i.mirrorMessageId).filter((x): x is string => !!x);
        if (ids.length) list.pendingUnmirror = [...(list.pendingUnmirror ?? []), ...ids];
        if ((list.pendingUnmirror?.length ?? 0) > 0) {
          list.deleted = true;
          list.items = [];
          list.updated = new Date().toISOString();
          break; // tombstoned in place -> common return below
        }
        return { lists: lists.filter((l) => l.id !== list.id), value: null }; // dropped outright
      }
      case "recreate-list": {
        // Deterministic fresh-list id, same idempotency rationale as create-list: a
        // redelivered recreate finds the already-made replacement by this id and no-ops --
        // it does NOT retire the (new) list again or spawn a second copy.
        const newId = `wi-${intent.id}`;
        if (lists.some((l) => l.id === newId)) break;
        // Target the OLD list by stable id, not slug (a slug reuse can't misfire). A missing
        // target -- deleted, or already retired by a prior apply of THIS intent (in which case
        // newId exists and we returned above) -- is a tolerant no-op, same as delete-list.
        const old = lists.find((l) => l.id === intent.listId && !l.deleted);
        if (!old) break;
        const now = intent.at || new Date().toISOString();
        // Fresh, all-open item copies: same text/due, new ids, no completion (checkedAt) or
        // mirror (mirrorMessageId/mirrorChecked) state. Bounded by the old list, already within
        // MAX_ITEMS_PER_LIST, so no cap re-check is needed.
        const items = old.items.map((i) => ({ id: newItemId(), text: i.text, checked: false, ...(i.category ? { category: i.category } : {}), ...(i.due ? { due: i.due } : {}), created: now }));
        const fresh: Checklist = { id: newId, slug: old.slug, name: old.name, ...(old.channelId ? { channelId: old.channelId } : {}), items, created: now, updated: now };
        // Retire the old (completed) list exactly as delete-list does: queue its posted mirror
        // messages for the gateway, then tombstone it if any need draining (so the channel is
        // cleared before drop), else drop it outright. The fresh same-slug list coexists with a
        // draining tombstone by design -- both are matched by stable id, never slug.
        const ids = old.items.map((i) => i.mirrorMessageId).filter((x): x is string => !!x);
        if (ids.length) old.pendingUnmirror = [...(old.pendingUnmirror ?? []), ...ids];
        if ((old.pendingUnmirror?.length ?? 0) > 0) {
          old.deleted = true;
          old.items = [];
          old.updated = now;
          return { lists: [...lists, fresh], value: null }; // tombstone drains; fresh coexists
        }
        return { lists: [...lists.filter((l) => l.id !== old.id), fresh], value: null }; // dropped outright, replaced
      }
    }
    return { lists, value: null };
  });
}

// ---------- wiring the link (B3): on-demand view build + intent apply/ack ----------

// The minimal HomeLink surface wireLink drives -- structurally satisfied by the real
// HomeLink (home-link.ts) and by a small fake in tests, so wiring can be unit-tested
// without dragging in the socket/reconnect machinery that class also owns.
export interface HomeLinkPort {
  onPull(cb: (pullId: number) => void): void;
  onIntent(cb: (intent: Intent) => void): void;
  // Fires on every fresh connection (initial connect AND every reconnect), before hello's
  // redelivered intents can arrive. wireLink uses this to clear its `failedFloor` -- see
  // the onIntent comment below for why that's safe.
  onOpen(cb: () => void): void;
  sendChanged(viewVersion: string): void;
  sendView(inReplyTo: number, view: View, viewVersion: string): void;
  sendAck(appliedThrough: number): void;
}

export interface WireLinkDeps {
  checklistsPath: string;
  statePath: string;
  buildProjects: () => ViewProject[]; // v1 stub: () => [].
  env: NodeJS.ProcessEnv;
  logErr: (m: string) => void; // a skipped ack must be loud, not silent.
  allowlistPath?: string; // forwarded to recipientsFromEnv -- default ALLOWLIST_PATH; injectable for hermetic tests
}

// What wireLink hands back:
//  - checkForChanges: a manual trigger for store-change detection. wireLink itself starts
//    no fs.watch/timer -- hooking this up to an actual on-disk change signal is the
//    driver's job (home-bot.ts's B4 lifecycle swap), deliberately out of scope here so the
//    detector stays a plain, synchronously-testable function.
//  - currentVersion: the live view digest, recomputed on demand (NOT the cached
//    "last changed-notified" version) -- the seam B4 needs to wire HomeLinkDeps.viewVersion
//    (home-link.ts), which must always read the CURRENT cursor fresh on every connect.
//  - flushIntents: resolves once every intent handed to onIntent so far has finished being
//    applied/persisted/acked (or skipped+logged on failure). The real transport never
//    awaits onIntent itself (HomeLink._onMessage invokes it synchronously in a loop over a
//    batched frame), so this is the only way a caller can observe completion -- used by
//    this file's own tests to exercise the serialized-intent behavior deterministically.
export interface WiredLink {
  checkForChanges(): void;
  currentVersion(): string;
  flushIntents(): Promise<void>;
}

function buildCurrentView(deps: WireLinkDeps): View {
  return buildView(readChecklists(deps.checklistsPath), recipientsFromEnv(deps.env, deps.allowlistPath), deps.buildProjects());
}

// Connect a HomeLink(-like) transport to the pure builders + the checklist store. Three
// behaviors:
//  - onPull: build the view FRESH from the store + env on every pull (on-demand, no cached
//    copy) and reply with the pull's own id as inReplyTo (per home-link.ts's contract).
//  - onIntent: apply the tap through the SAME mutate() applyIntent above always has,
//    advance + persist the appliedThrough cursor, THEN ack.
//    Persist-before-ack is mandatory, not stylistic: the DO redelivers based on its OWN
//    cursor, not ours, so redelivery is idempotent -- but only if the container's on-disk
//    cursor is never ahead of what it told the DO. Ack first and crash before the write
//    lands, and the next hello reports a stale appliedThrough while the DO has already
//    dropped those intents from its queue -- the tap is lost for good. Persist-then-ack
//    means a crash here just redelivers (applyIntent is idempotent), never loses one.
//  - checkForChanges: recompute the view digest and sendChanged only when it moved, so a
//    no-op rebuild sends nothing. Kept as in-memory "last sent" state, NOT persisted to
//    home-state.json (which, since B2's cleanup, holds only appliedThrough): the old
//    poll-era publishedVersion field it might otherwise live beside meant "the version the
//    DO has CONFIRMED" for a full publish/ack round trip, a stronger guarantee than a
//    fire-and-forget `changed` notification here actually has -- conflating the two was
//    never right, and now there is nowhere on disk to conflate it WITH.
export function wireLink(link: HomeLinkPort, deps: WireLinkDeps): WiredLink {
  let lastVersion = viewVersion(buildCurrentView(deps));
  // Serializes intent handling. The real transport calls onIntent's callback SYNCHRONOUSLY
  // in a loop over one batched frame (HomeLink._onMessage), and the port's callback type is
  // void-returning -- it cannot await -- so without this chain, two intents delivered
  // together would race applyIntent's proper-lockfile lock (whose retry-based acquisition
  // is not FIFO) AND the loadState/Math.max/saveState read-modify-write on appliedThrough,
  // losing the strict id-order guarantee the persist-before-ack ordering depends on.
  // Chaining makes every intent wait for the previous one's persist+ack to finish first.
  let intentChain: Promise<void> = Promise.resolve();

  // The lowest id this CONNECTION has seen delivered and fail to apply, still unresolved
  // (Infinity = none outstanding). This is what distinguishes the two kinds of "gap" the
  // DO's ack contract has to cope with (spec: appliedThrough acks are CUMULATIVE --
  // sending N tells the DO to delete every intent id <= N):
  //  (a) DELIVERED-then-failed (applyIntent threw -- e.g. proper-lockfile contention with
  //      the CLI/Discord mirror): the DO still holds this intent in pending[]. Acking past
  //      it on a later success would cumulatively delete it from the DO's queue despite it
  //      never having actually applied -- the bug this file was fixed for. Must withhold.
  //  (b) NEVER delivered at all: the DO's pending[] queue can be evicted or expire (D1
  //      removed workers/home/src/do.ts's prune()/MAX_PENDING/MAX_PENDING_AGE_MS along with
  //      the poll path that was their only caller -- pending[] is currently unbounded until
  //      A7 re-introduces pruning on the link path, but "ids may have gaps -- a gap is not
  //      an error, apply what arrives" (docs/family-home-core-spec.md §Contract) already
  //      covers whatever eviction mechanism exists or doesn't). That id will NEVER be
  //      redelivered; withholding forever here would wedge appliedThrough permanently and
  //      pin the DO into redelivering the whole backlog on every future hello. Must advance
  //      across it unconditionally (below, `state.appliedThrough = intent.id`).
  // A plain "N === appliedThrough+1" check can't tell these apart -- both look identical
  // (an id arrives that isn't immediately next). failedFloor can, because case (a) is
  // something THIS process directly observed and case (b) is something it never saw at
  // all. Cleared on every fresh connection (link.onOpen below): hello's redelivery is a
  // full ascending replay from the DO's own stored cursor, so a still-pending failed
  // intent comes down again FIRST on the new connection and re-marks the floor if it fails
  // again; one that's since expired/evicted simply never reappears, and clearing the floor
  // is exactly what lets the cursor advance past that now-permanent gap instead of wedging.
  let failedFloor = Infinity;

  // B1: contained. buildCurrentView -> readChecklists tolerates ENOENT only; corrupt
  // JSON, EACCES, EIO all rethrow. This runs synchronously from HomeLink._onMessage,
  // invoked inside the WebSocket "message" event listener -- an uncaught throw here is
  // an uncaughtException that takes the whole surface process down over a single bad
  // pull, not just the pull itself. Skip sendView on failure and log loudly instead;
  // the DO's own bounded pull-timeout -> serve-stale-cache (design §7.2) is exactly the
  // degradation this is meant to fall back to, not a crash.
  link.onPull((pullId) => {
    try {
      const view = buildCurrentView(deps);
      link.sendView(pullId, view, viewVersion(view));
    } catch (err) {
      deps.logErr(`home: pull ${pullId} failed -- serving stale via DO timeout: ${(err as Error).message}`);
    }
  });

  // Chained through intentChain, NOT a bare assignment: onOpen can fire while an
  // old-connection intent (queued before the reconnect) is still draining through the
  // chain. Clearing failedFloor synchronously would let that still-in-flight job -- whose
  // failure hasn't resolved yet -- see the ALREADY-cleared floor and cumulatively ack past
  // itself, resurrecting the exact bug this file exists to fix. Chaining guarantees the
  // clear only takes effect after every intent from the OLD connection has finished, and
  // strictly before any redelivered intent from the NEW one (which is only ever queued
  // after onOpen has fired, since hello's redelivery follows _onOpen in home-link.ts).
  link.onOpen(() => {
    intentChain = intentChain.then(() => {
      failedFloor = Infinity;
    });
  });

  link.onIntent((intent) => {
    intentChain = intentChain
      .then(async () => {
        const state = loadState(deps.statePath);
        // REDELIVERY GUARD (review a8f620e) -- now a cheap FAST-PATH, not correctness-critical:
        // every intent kind is idempotent on redelivery on its own (check/uncheck re-apply is a
        // no-op; add-item/create-list key on `wi-<id>`; delete-list keys on the stable list id
        // since review 95e17d3, so a slug-reusing replay can't hit a recreated list). This guard
        // just SKIPS re-applying anything at/below the durably-applied cursor -- persist-before-ack
        // (saveState runs BEFORE sendAck below) means the on-disk appliedThrough is never ahead of
        // what applied, so the skip is sound -- and STILL re-acks so a lost ack stops the DO
        // redelivering. A locally-FAILED intent never advances the cursor (see the catch --
        // failedFloor withholds it), so a genuinely-unapplied intent is never wrongly skipped.
        // Beyond the fast-path it also stops a stale check redelivery from clobbering an
        // operator's later uncheck (the applyIntent-level idempotency doesn't cover that).
        if (intent.id <= state.appliedThrough) {
          link.sendAck(state.appliedThrough);
          return;
        }
        await applyIntent(deps.checklistsPath, intent);
        // Advance at-or-below any outstanding local failure (handles the plain contiguous
        // case AND a genuine DO-side gap -- case (b) above); Math.max (not a bare assign)
        // still guards against a stale redelivered dup retreating the cursor. Strictly
        // ABOVE the floor, withhold -- case (a) above -- there is still an unresolved
        // failure the DO hasn't been told to drop yet, so acking past it would be the
        // cumulative-ack bug this fixes. The floor itself is deliberately NEVER cleared
        // here on an `intent.id === failedFloor` success: in-spec, ids strictly ascend
        // within one connection, so the floor's own id can only ever reappear via a fresh
        // connection's redelivery -- already handled by onOpen's clear above, so this
        // branch never fires there. Clearing it here too would only matter for an
        // out-of-protocol same-connection duplicate, where it's actively unsound: a HIGHER
        // still-unresolved failure (discarded by the catch's Math.min, see below) would
        // get cumulatively acked away by a later success once this lower one resolves.
        // Leaving the floor set until the next reconnect is always the safe direction --
        // delayed acks, never a lost tap.
        if (intent.id <= failedFloor) {
          state.appliedThrough = Math.max(state.appliedThrough, intent.id);
        }
        saveState(state, deps.statePath); // durable BEFORE the ack below -- see header comment
        link.sendAck(state.appliedThrough);
      })
      .catch((err) => {
        // Skip the ack, don't crash the surface: the DO redelivers based on its OWN
        // cursor and applyIntent is idempotent, so the safe response to a transient
        // failure (e.g. proper-lockfile contention with the CLI/Discord mirror, or a
        // non-ENOENT fs error from loadState) is to log loudly and let redelivery
        // happen, rather than let an unhandled rejection take the whole process down
        // under Node's default policy.
        failedFloor = Math.min(failedFloor, intent.id);
        deps.logErr(`home: intent ${intent.id} failed -- skipping ack, the DO will redeliver it: ${(err as Error).message}`);
      });
  });

  return {
    checkForChanges(): void {
      const version = viewVersion(buildCurrentView(deps));
      if (version !== lastVersion) {
        lastVersion = version;
        link.sendChanged(version);
      }
    },
    currentVersion: () => viewVersion(buildCurrentView(deps)),
    flushIntents: () => intentChain,
  };
}

// ---------- credentials ----------

export interface HomeKeys { endpoint: string; tenant: string; accessKeyId: string; secretAccessKey: string; }

// Read home-keys.json. Throws ENOENT (caller idles the surface) or a descriptive error on a
// malformed file. Placement/shape class matches calendar-cli's loadKeys.
export function loadHomeKeys(path: string = HOME_KEYS_PATH): HomeKeys {
  const raw = readFileSync(path, "utf8");
  const k = JSON.parse(raw) as Partial<HomeKeys>;
  for (const f of ["endpoint", "tenant", "accessKeyId", "secretAccessKey"] as const) {
    if (!k[f]) throw new Error(`home-keys.json is missing "${f}"`);
  }
  return k as HomeKeys;
}

// Re-exported so the driver imports state helpers from one place.
export { loadState, saveState, freshState };
export type { HomeState };
