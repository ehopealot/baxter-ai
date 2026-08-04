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
import { readChecklists, mutate } from "./checklist-store.ts";
import type { Checklist } from "./checklist-store.ts";
import { loadState, saveState, freshState } from "./home-state.ts";
import type { HomeState } from "./home-state.ts";
import { HOME_KEYS_PATH, ALLOWLIST_PATH } from "./paths.ts";
import { loadAllowlist } from "./allowlist.ts";

// ---------- wire types (the contract, spec §Contract) ----------

export interface ViewItem { id: string; text: string; checked: boolean; due: string | null; }
export interface ViewList { slug: string; name: string; open: number; total: number; items: ViewItem[]; }
export interface ViewProject { slug: string; name: string; html: string; }
export interface View { lists: ViewList[]; projects: ViewProject[]; recipients: string[]; }

// Only two intent kinds ever, both idempotent (spec §3).
export interface Intent { id: number; kind: "check" | "uncheck"; listSlug: string; itemId: string; at?: string; }

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
      const items: ViewItem[] = l.items.map((i) => ({ id: i.id, text: i.text, checked: i.checked, due: i.due ?? null }));
      return { slug: l.slug, name: l.name, open: items.filter((i) => !i.checked).length, total: items.length, items };
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

// ---------- applying a tap (through the shared checklist lock) ----------

// Apply one check/uncheck through the SAME mutate() the CLI uses. Idempotent, and a no-op if
// the list or item is gone (the operator deleted it; the tap is moot -- exactly as a removed
// item's reminder self-cancels). Never throws for a missing target.
export async function applyIntent(path: string, intent: Intent): Promise<void> {
  await mutate(path, (lists) => {
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
  const recipients = deps.allowlistPath === undefined ? recipientsFromEnv(deps.env) : recipientsFromEnv(deps.env, deps.allowlistPath);
  return buildView(readChecklists(deps.checklistsPath), recipients, deps.buildProjects());
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
        await applyIntent(deps.checklistsPath, intent);
        const state = loadState(deps.statePath);
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
