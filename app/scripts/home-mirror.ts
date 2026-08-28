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
import type { LightLifecycle } from "./light-lifecycle.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { micromark } from "micromark";
import { readChecklists, mutate, newItemId, retireList, MAX_ITEMS_PER_LIST, MAX_CHECKLISTS } from "./checklist-store.ts";
import type { Checklist } from "./checklist-store.ts";
import { defaultReadOps, parseStoredCollection, readFileFenced } from "./collection-renderer.ts";
import type { ReadOps } from "./collection-renderer.ts";
import { isCanonicalSlug, listCollections } from "./collections-cli.ts";
import type { CollectionListing } from "./collections-cli.ts";
import { loadState, saveState, freshState } from "./home-state.ts";
import type { HomeState } from "./home-state.ts";
import { ALLOWLIST_PATH, COLLECTIONS_DIR, COLLECTIONS_RENDERED_DIR, HOME_KEYS_PATH } from "./paths.ts";
import { loadAllowlist } from "./allowlist.ts";

// ---------- wire types (the contract, spec §Contract) ----------

export interface ViewItem { id: string; text: string; checked: boolean; due: string | null; category: string | null; checkedBy: string | null; }
// `id` is the stable store id (never the mutable slug). Exposed so the delete-list intent
// can target it by IDENTITY -- a replayed delete then can't hit a recreated same-slug list
// (its id differs), the same idempotency add-item/create-list get from `wi-<id>`. Symmetric
// with ViewItem.id, which the check intent already targets.
export interface ViewList {
  id: string; slug: string; name: string; open: number; total: number; items: ViewItem[];
  // The canonical todo-list flag riding the view ADDITIVELY (absent = ordinary list, so an
  // older DO that doesn't know the field simply renders it as any other list). The DO uses
  // it ONLY to suppress the delete affordance and show an explainer; the container never
  // enforces deletion (see Checklist.special's own comment).
  special?: "household-todo" | "member-todo";
}
export interface ViewCollectionItem { description: string; detailHtml: string; }
export interface ViewCollection { slug: string; name: string; items: ViewCollectionItem[]; }
export interface View { lists: ViewList[]; collections: ViewCollection[]; recipients: string[]; }

export const MAX_HOME_VIEW_BYTES = 1.5 * 1024 * 1024;

// Intent kinds the DO pushes down the link, applied by applyIntent below (spec
// 2026-08-04-home-list-mutations-design.md). ALL kinds are idempotent on redelivery, which
// wireLink's persist-before-ack machinery relies on: check/uncheck re-apply is a no-op;
// add-item/create-list mint a deterministic record id from the intent id (`wi-<id>`) and
// no-op if that record already exists, so a redelivered add/create is a true no-op too. A
// discriminated union on `kind`, so applyIntent's switch narrows to the right fields and
// home-link.ts's isIntentLike can validate per-kind. The worker mirrors this exact shape
// (no shared import, verified by matching tests) -- keep it byte-consistent.
export interface CheckIntent { id: number; kind: "check" | "uncheck"; listSlug: string; itemId: string; at?: string; by?: string; }
export interface AddItemIntent { id: number; kind: "add-item"; listSlug: string; text: string; at?: string; }
export interface CreateListIntent { id: number; kind: "create-list"; name: string; at?: string; }
export interface DeleteListIntent { id: number; kind: "delete-list"; listId: string; at?: string; }
// recreate-list: retire the list (by STABLE id) and replace it with a same-slug/name/channel
// list holding all-open copies of its items -- a "start this list over" reset that wipes the
// completion state while keeping the items. Idempotent like the others: the fresh list's id is
// deterministic (`wi-<id>`), so a redelivered recreate finds it and no-ops.
export interface RecreateListIntent { id: number; kind: "recreate-list"; listId: string; at?: string; }
// rename-list changes display text only; its stable id prevents a stale replay from renaming a replacement.
export interface RenameListIntent { id: number; kind: "rename-list"; listId: string; name: string; at?: string; }
// remove-item: delete one item (by listSlug + itemId) from a live list -- the home "Edit"
// mode's per-item trash. Naturally idempotent on redelivery: a filter-by-id find of an
// already-removed item is a no-op, so unlike add-item it needs no deterministic id.
export interface RemoveItemIntent { id: number; kind: "remove-item"; listSlug: string; itemId: string; at?: string; }
export type Intent = CheckIntent | AddItemIntent | CreateListIntent | DeleteListIntent | RecreateListIntent | RenameListIntent | RemoveItemIntent;

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
export function buildView(lists: Checklist[], recipients: string[], collections: ViewCollection[]): View {
  const viewLists: ViewList[] = lists
    .filter((l) => !l.deleted)
    .map((l) => {
      const items: ViewItem[] = l.items.map((i) => ({ id: i.id, text: i.text, checked: i.checked, due: i.due ?? null, category: i.category ?? null, checkedBy: i.checkedBy ?? null }));
      return { id: l.id, slug: l.slug, name: l.name, open: items.filter((i) => !i.checked).length, total: items.length, items, ...(l.special ? { special: l.special } : {}) };
    });
  return { lists: viewLists, collections, recipients };
}

// Derived Collection details are untrusted model output. micromark escapes raw HTML when
// allowDangerousHtml is false and suppresses dangerous link/image protocols when
// allowDangerousProtocol is false. Keep both explicit at this publication trust boundary.
export function renderDetailHtml(detail: string): string {
  return micromark(detail, { allowDangerousHtml: false, allowDangerousProtocol: false });
}

// Build the read-only Collections projection. Enumeration is deliberately metadata-only;
// every source that survives canonical filtering is re-read at publication time through the
// shared lstat/open/fstat identity fence, as is its derived JSON partner.
export function buildCollectionsView(
  collectionsDir: string = COLLECTIONS_DIR,
  renderedDir: string = COLLECTIONS_RENDERED_DIR,
  opts: {
    onError?: (slug: string, reasonClass: string) => void;
    readOps?: ReadOps;
    listSources?: (dir: string, opts: { withTitles?: boolean }) => CollectionListing[];
  } = {},
): ViewCollection[] {
  const readOps = opts.readOps ?? defaultReadOps;
  const listings = (opts.listSources ?? listCollections)(collectionsDir, { withTitles: false });
  const collections: ViewCollection[] = [];

  for (const listing of listings) {
    const { slug } = listing;
    if (!isCanonicalSlug(slug)) continue;

    const source = readFileFenced(join(collectionsDir, `${slug}.md`), readOps);
    if (!source.ok) {
      opts.onError?.(slug, source.reason);
      continue;
    }
    const sourceText = source.bytes.toString("utf8");
    const heading = sourceText.match(/^#[ \t]+(.+?)[ \t]*$/m);
    const name = heading ? heading[1] : slug;

    const derived = readFileFenced(join(renderedDir, `${slug}.json`), readOps);
    if (!derived.ok) {
      opts.onError?.(slug, derived.reason);
      continue;
    }
    const stored = parseStoredCollection(derived.bytes.toString("utf8"));
    if (!stored) {
      opts.onError?.(slug, "malformed");
      continue;
    }

    collections.push({
      slug,
      name,
      items: stored.map((item) => ({ description: item.description, detailHtml: renderDetailHtml(item.detail) })),
    });
  }

  return collections;
}

// Deterministic serialization: sort object keys recursively, preserve array order. Two views
// that differ only in key insertion order digest the same; any content change (a list, an
// item, a collection, OR a recipient) changes the digest. Distinct from a digest of
// checklists.json -- recipients come from env and collection HTML from files, so a store-only
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

// Longest a derived list slug may be -- matches collections-cli's MAX_SLUG_LEN so slugs stay a
// consistent length class across surfaces.
export const MAX_LIST_SLUG_LEN = 64;

// Derive a URL/store slug from a create-list name: lowercase, every run of non-alphanumerics
// collapses to a single "-", leading/trailing "-" trimmed, capped. Unlike collections-cli's
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
            if (checked) {
              item.checkedAt = intent.at || new Date().toISOString();
              if (intent.by) item.checkedBy = intent.by; else delete item.checkedBy; // stamp who checked it (home UI)
            } else {
              delete item.checkedAt;
              delete item.checkedBy;
            }
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
      case "rename-list": {
        const list = lists.find((l) => l.id === intent.listId && !l.deleted);
        if (list) {
          const name = intent.name.trim();
          if (list.name !== name) {
            list.name = name;
            list.updated = intent.at || new Date().toISOString();
          }
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
        // Otherwise retire it exactly as checklist-cli's `rm` does (tombstone-if-draining, else
        // drop by id) -- the shared retireList helper. Its own clock (new Date()), since a delete
        // carries no replacement `now`.
        const list = lists.find((l) => l.id === intent.listId && !l.deleted);
        if (!list) break;
        return { lists: retireList(lists, list, new Date().toISOString()), value: null };
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
        const fresh: Checklist = { id: newId, slug: old.slug, name: old.name, ...(old.channelId ? { channelId: old.channelId } : {}), ...(old.special ? { special: old.special } : {}), ...(old.memberAddress ? { memberAddress: old.memberAddress } : {}), items, created: now, updated: now };
        // Retire the old (completed) list the same mirror-safe way delete-list does (tombstone to
        // drain the channel, else drop), then append the fresh same-slug copy -- which coexists
        // with a draining tombstone by design (both matched by stable id, never slug).
        return { lists: [...retireList(lists, old, now), fresh], value: null };
      }
    }
    return { lists, value: null };
  });
}

// ---------- canonical todo lists (2026-08-24; email-keyed per person 2026-08-25) ----------

// The membership snapshot the reconcile is driven by: the SAME shape applyMembersCommand
// just sanitized and wrote to the allowlist file (senders/recipients/names), so the mint
// always runs against exactly the membership the DO pushed.
export interface CanonicalRoster { senders: string[]; recipients: string[]; names: Record<string, string>; }

// The label half of "<label>-todo" for a member with NO display name: the email local-part.
// Pure and total -- never throws, always non-empty for a non-empty email.
function memberTodoLabel(email: string): string {
  const local = email.split("@")[0].trim();
  return local || email;
}

// The membership the reconcile mints against: ONE person per distinct EMAIL row in the
// roster (union of senders+recipients, deduped by trimmed lowercase). The roster also
// carries a phone row per member (deriveSnapshot pushes every contact method); phones are
// deliberately IGNORED -- email is the login identity and every member has exactly one, so
// keying by email alone yields one todo list per PERSON and makes an address-labeled
// "brunosemail@gmail.com-todo" impossible (the 2026-08-24 release bug: the per-row mint
// gave a member with email+phone TWO lists, the second falling back to its raw address as
// the label). Sorted by email (codepoint, not localeCompare -- the file's determinism
// discipline, see recipientsFromEnv) so label allocation is machine-independent and
// identical across runs. Labels: the member's display name (the names map) else the
// local-part; two DIFFERENT members sharing a name are allocated "Sam" and "Sam-2"
// (operator 2026-08-25).
function canonicalPersons(roster: CanonicalRoster): { email: string; label: string }[] {
  const labelByEmail = new Map<string, string>(); // canonical email -> label (first row wins)
  for (const a of [...roster.senders, ...roster.recipients]) {
    if (typeof a !== "string") continue;
    const email = a.trim().toLowerCase();
    if (!email || !email.includes("@") || labelByEmail.has(email)) continue;
    const n = roster.names?.[a] ?? roster.names?.[email];
    labelByEmail.set(email, (typeof n === "string" && n.trim()) || memberTodoLabel(email));
  }
  const out = [...labelByEmail.entries()].map(([email, label]) => ({ email, label }));
  out.sort((x, y) => (x.email < y.email ? -1 : x.email > y.email ? 1 : 0));
  const used = new Set<string>();
  for (const p of out) {
    let label = p.label;
    for (let n = 2; used.has(label.toLowerCase()); n++) label = `${p.label}-${n}`;
    p.label = label;
    used.add(label.toLowerCase());
  }
  return out;
}

// Mint/adopt/clear the canonical todo lists against a roster. Rules (operator-approved
// 2026-08-24; email-keyed 2026-08-25):
// - Exactly one live flagged "household-todo" list; mint (name "household-todo", uniqueSlug
//   against a user-made same-slug list -- the ordinary list is NOT adopted and stays deletable)
//   whenever none exists.
// - One live flagged "member-todo" list per PERSON (one per distinct roster email), named
//   "<label>-todo" and keyed by memberAddress = the member's email. Keying by the invariant
//   email means a renamed member keeps their SAME list (renamed in place), and a member
//   leaving the roster loses ONLY their list's flag -- the list itself, items and all,
//   becomes an ordinary deletable list. A store minted by the 2026-08-24 release heals the
//   same way: a live member-todo list keyed by anything that is not a current member email
//   -- a phone key, a removed member, a missing key (defensive) -- is unflagged. Tombstoned
//   lists are left alone: they are on their way out, matched by stable id elsewhere.
// - The cap follows create-list's posture: at MAX_CHECKLISTS live lists a mint is silently
//   skipped (self-heals on the next apply once space frees up).
// Pure: persistence belongs to reconcileCanonicalChecklists below. Idempotent by
// construction -- a second run over its own output changes nothing.
export function reconcileCanonicalLists(lists: Checklist[], roster: CanonicalRoster): { lists: Checklist[]; changed: boolean } {
  const persons = canonicalPersons(roster);
  const byEmail = new Map(persons.map((p) => [p.email, p]));
  let changed = false;
  const now = new Date().toISOString();
  const clear = (l: Checklist): Checklist => {
    changed = true;
    const copy = { ...l };
    delete copy.special;
    delete copy.memberAddress;
    copy.updated = now;
    return copy;
  };
  // CLAIM: attach each live member-todo list to the person its key names -- a live list
  // keyed by a phone (the legacy per-row mint), a removed member, or nothing (defensive)
  // is unflagged here.
  const claimed = new Map<{ email: string; label: string }, number[]>(); // person -> indices into next
  const next = lists.map((l, i) => {
    if (l.special !== "member-todo" || l.deleted) return l;
    const p = l.memberAddress ? byEmail.get(l.memberAddress.trim().toLowerCase()) : undefined;
    if (!p) return clear(l);
    const idxs = claimed.get(p);
    if (idxs) idxs.push(i); else claimed.set(p, [i]);
    return l;
  });
  // A person claimed by several lists (duplicate keys -- not mintable by this code, only by
  // hand-edited stores) keeps the one already named "<label>-todo", else the first; the
  // rest are unflagged.
  const keep = new Map<{ email: string; label: string }, number>();
  for (const [p, idxs] of claimed) {
    const want = `${p.label}-todo`;
    const k = idxs.find((i) => next[i].name === want) ?? idxs[0];
    keep.set(p, k);
    for (const i of idxs) if (i !== k) next[i] = clear(next[i]);
  }
  // ADOPT/RENAME: a kept list always reads "<label>-todo" -- a renamed member (or a
  // re-allocated label) renames their list IN PLACE, keeping its id, items and channel.
  // The slug is re-derived against every OTHER list so it stays unique without suffixing
  // against the list's own old slug.
  for (const [p, i] of keep) {
    const want = `${p.label}-todo`;
    if (next[i].name === want) continue;
    changed = true;
    next[i] = { ...next[i], name: want, slug: uniqueSlug(slugify(want), next.filter((_, j) => j !== i)), updated: now };
  }
  const liveCount = () => next.filter((l) => !l.deleted).length;
  if (!next.some((l) => !l.deleted && l.special === "household-todo") && liveCount() < MAX_CHECKLISTS) {
    next.push({ id: newItemId(), slug: uniqueSlug(slugify("household-todo"), next), name: "household-todo", items: [], created: now, updated: now, special: "household-todo" });
    changed = true;
  }
  for (const p of persons) {
    if (keep.has(p)) continue;
    if (liveCount() >= MAX_CHECKLISTS) break;
    const name = `${p.label}-todo`;
    next.push({ id: newItemId(), slug: uniqueSlug(slugify(name), next), name, items: [], created: now, updated: now, special: "member-todo", memberAddress: p.email });
    changed = true;
  }
  return { lists: next, changed };
}

// The persisting half: one reconcile through the shared proper-lockfile mutate, so it
// serializes against checklist-cli, the Discord mirror, and inbound intents. Returns
// whether anything changed (the caller logs + republishes either way -- a reconcile failure
// must never hold the members republish hostage; it self-heals on the next apply).
export async function reconcileCanonicalChecklists(path: string, roster: CanonicalRoster): Promise<boolean> {
  return mutate(path, (cur) => {
    const r = reconcileCanonicalLists(cur, roster);
    return { lists: r.lists, value: r.changed };
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
  buildCollections: () => ViewCollection[];
  env: NodeJS.ProcessEnv;
  logErr: (m: string) => void; // a skipped ack must be loud, not silent.
  allowlistPath?: string; // forwarded to recipientsFromEnv -- default ALLOWLIST_PATH; injectable for hermetic tests
  lifecycle?: LightLifecycle;
  onDurableProgress?: (highWater: number) => void;
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
  const lists = readChecklists(deps.checklistsPath);
  const recipients = recipientsFromEnv(deps.env, deps.allowlistPath);
  const view = buildView(lists, recipients, deps.buildCollections());
  if (new TextEncoder().encode(JSON.stringify(view)).length > MAX_HOME_VIEW_BYTES) {
    return buildView(lists, recipients, []);
  }
  return view;
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
    const release = deps.lifecycle?.admit("home:pull");
    if (deps.lifecycle && !release) return;
    try {
      const view = buildCurrentView(deps);
      link.sendView(pullId, view, viewVersion(view));
    } catch (err) {
      deps.logErr(`home: pull ${pullId} failed -- serving stale via DO timeout: ${(err as Error).message}`);
    } finally { release?.(); }
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
    const release = deps.lifecycle?.admit("home:intent-open-barrier");
    if (deps.lifecycle && !release) return;
    intentChain = intentChain.then(() => {
      failedFloor = Infinity;
    }).finally(() => release?.());
  });

  link.onIntent((intent) => {
    const release = deps.lifecycle?.admit("home:intent");
    if (deps.lifecycle && !release) return;
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
        deps.onDurableProgress?.(state.appliedThrough);
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
      })
      .finally(() => release?.());
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
