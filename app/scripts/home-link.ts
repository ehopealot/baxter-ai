// Family-home web mirror -- the core-side WS transport (see docs/family-home-core-spec.md
// and docs/architecture/home.md). D1 retired the old HTTP poll sync this transport replaced
// (home-mirror.ts's now-deleted runSyncTick/HomeOps); the container holds one persistent
// link to the control-plane Durable Object instead of a request/response poll loop.
// home-mirror.ts's `wireLink` (B3) drives this transport's onPull/onIntent callbacks with
// buildView/applyIntent; this file is transport ONLY -- connect, hello, heartbeat, and
// message routing, and reconnect/backoff/liveness (B2). home-bot.ts (B4) owns the lifecycle
// that wires wireLink to a live HomeLink instance.
//
// HARD INVARIANT (spec §5, unchanged from home-mirror.ts): this is plain code start to
// finish. A tap arriving as an inbound `intent` message must NEVER wake an LLM run. There
// are no model calls in this file.
//
// Wire protocol: mirrors the DO's own implementation (workers/home/src/link-protocol.ts)
// locally, exactly as home-mirror.ts:24-34 already mirrors the sync types -- core and the
// DO are separate repos/deploys, so there is no shared import, only a matching contract.
// One difference from that file's `encode`/`decode` (which this module deliberately does
// NOT import, for the same separate-repo reason): a frame is always a JSON array of
// messages, even for a single one, so `[msg]` in / an array out on every text frame. The
// "hb" heartbeat is the one exception -- it is NOT an envelope at all, just the literal
// bytes "hb", because the DO answers it via a platform-level WebSocketRequestResponsePair
// (object.ts's acceptLink) that free-answers "hb" with "hbk" without waking the DO. Wrapping
// it in JSON would silently break that fast path.
import type { View, Intent } from "./home-mirror.ts";
// The item-text cap is the store's own (checklist-store.ts) -- same-repo, so importing it
// keeps the validator honest to the store it feeds rather than re-hardcoding 1000. The worker
// copy of this validator (separate repo, no shared import) mirrors the same literal.
import { MAX_ITEM_TEXT } from "./checklist-store.ts";

// Cap on a create-list `name`. A sane bound so a drifted/oversize name can't bloat the store;
// the worker copy mirrors this literal. (No store constant to borrow -- a list name has no
// existing cap, unlike item text -- so this is defined here and duplicated worker-side.)
const MAX_LIST_NAME = 200;

// ---------- wire types (the contract; mirrors link-protocol.ts's LinkMsg union) ----------

// --- up (container -> home) ---
export interface Hello { v: 1; type: "hello"; id: number; viewVersion: string | null; appliedThrough: number; protocol: 1; config?: { senders: string[]; recipients: string[]; version: number; operatorEmail?: string; operatorName?: string }; }
export interface Changed { v: 1; type: "changed"; id: number; viewVersion: string; }
// `slug` (home-recipes plan, Task C1): a SIBLING field to `chatId`, not a reuse/rename of
// it -- mirrors workers/home/src/link-protocol.ts's own `ViewMsg.slug` exactly, and for
// the same reason given there: `chatId` is threaded through this file's existing
// chat-scoped call sites (chat-bot.ts's onPull), and object.ts's `pendingRecipesPulls`
// on the worker side matches a recipe-scoped waiter by `ViewMsg.slug` specifically (NOT
// by `id`/`inReplyTo` the way the index-scoped waiters are) -- so this is load-bearing,
// not cosmetic: a recipes `sendView` that omitted it would never settle the DO's
// per-recipe pull.
export interface ViewMsg { v: 1; type: "view"; id: number; inReplyTo: number; view: View; viewVersion: string; chatId?: string; slug?: string; }
export interface Ack { v: 1; type: "ack"; id: number; appliedThrough: number; }
// A container -> DO signal that a chat's agent turn has ENDED, whether it replied or
// deliberately didn't (a no-op). A reply already moves state (a CHATS_DIR write -> changed);
// this exists for the no-op case, where nothing else travels the wire, so the browser's typing
// indicator can clear on "turn over" rather than a blind timeout. Chat-only; other surfaces
// never send it.
export interface TurnDone { v: 1; type: "turn-done"; id: number; chatId: string; }
export type UpMsg = Hello | Changed | ViewMsg | Ack | TurnDone;

// --- down (home -> container) ---
// scope/chatId (Task 2.1): optional, additive fields scoping a pull to either the
// checklist index (the default -- every existing checklist caller omits both) or a
// single chat conversation's transcript. Mirrors workers/home/src/link-protocol.ts's
// Pull exactly. WIRED THROUGH as of Task 3.2: `_onMessage` forwards `scope`/`chatId`
// to `pullCb` (loosely validated -- an unrecognized `scope` value comes through as
// undefined rather than being trusted verbatim), and `sendView` takes an optional
// trailing `chatId` so a reply to a chat-scoped pull can carry it back out. The
// checklist link (home-bot.ts's wireLink) still omits both on every pull it sends and
// ignores the extra callback args it now receives, so it's unaffected; the chat link
// (chat-bot.ts) is the first real consumer -- its `onPull` branches on `scope` to
// answer with either the chat index (`{chats: ChatMeta[]}`) or one chat's transcript
// (`{messages: ChatMessage[]}`, with `chatId` echoed back via `sendView`'s new param).
//
// `"recipe"` + `slug` (home-recipes plan, Task C1): a THIRD scope, widened the same way
// `link-protocol.ts` widens it on the worker side -- `slug` is a sibling field to
// `chatId` (see `ViewMsg.slug`'s comment above for why this isn't a rename/reuse), and
// the recipes link (recipes-mirror.ts) is the consumer, mirroring the chat branch above
// but with no intent/dispatch counterpart (recipes are read-only).
export interface Pull { v: 1; type: "pull"; id: number; scope?: "index" | "chat" | "recipe"; chatId?: string; slug?: string; }
export interface IntentMsg { v: 1; type: "intent"; id: number; intent: Intent; }
export interface Command { v: 1; type: "command"; id: number; payload: unknown; sig: string; }
export type DownMsg = Pull | IntentMsg | Command;

export type LinkMsg = UpMsg | DownMsg;

// ---------- the injectable socket seam ----------

// The subset of the standard WebSocket client API HomeLink drives. Node 22 has a global
// `WebSocket` (undici) that satisfies this structurally -- no `ws` package, no adapter --
// so the real `connect` a caller supplies can just be `() => new WebSocket(url)`. Tests
// inject `FakeSocketPair` (home-link.testkit.ts) instead.
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: string }) => void): void;
  addEventListener(type: "close", listener: (ev?: unknown) => void): void;
  addEventListener(type: "error", listener: (ev?: unknown) => void): void;
}

// A wire id worth trusting: a JS-safe integer. Shared by BOTH inbound id sites -- the
// pull message's own `id` (echoed back later as a view's `inReplyTo`) and the intent's
// `id` (wireLink's onIntent, home-mirror.ts, pins `appliedThrough` to it) -- so the two
// branches can't silently drift apart in how deep they check, the way they already once
// did in this file's history. `Number.isSafeInteger`, not `Number.isInteger`: a
// drifted/malformed peer's literal `1e999` parses to `Infinity`, which `Number.isInteger`
// rejects but which a bare `typeof === "number"` would admit; `Number.isSafeInteger` goes
// one step further and ALSO rejects huge-but-finite doubles (>= 2^53) that
// `Number.isInteger` still admits -- those wedge the same cursor permanently
// (`i.id > 1e300` is never true again either), just without the serializes-as-null tell
// Infinity has. This bounds, but cannot fully eliminate, a drifted peer pinning a cursor
// at a plausible-looking large id; treating an implausible id jump as suspect rather than
// trusting any admitted id unconditionally is wireLink's problem, not this transport
// layer's.
function isSafeId(v: unknown): v is number {
  return Number.isSafeInteger(v);
}

// Guards the `intent` field an inbound IntentMsg carries before it's forwarded to
// onIntent -- not just "is an object" (which still admits `[]`/`{}`), but that its `id`
// is one worth trusting (see isSafeId above), AND that every other field applyIntent
// (home-mirror.ts) reads is the shape it expects. An id-less/malformed intent object
// would corrupt wireLink's appliedThrough cursor for every intent after it (the
// original reason for this guard); the field-level checks below close a second, later-
// found gap -- `kind`/`listSlug`/`itemId`/`at` used to pass through completely
// unchecked once `id` looked safe. A drifted (but authenticated -- this only ever
// receives from the SigV4-verified DO) peer sending `kind: "toggle"` would silently
// mean "uncheck" (applyIntent treats anything that isn't literally "check" as an
// uncheck), and a non-string `at` would land in checklists.json's `checkedAt` field,
// read by every other surface (the CLI, Discord mirror, the rendered pages). `at` is
// the one field that's legally ABSENT (spec §3 -- applyIntent falls back to
// `new Date().toISOString()`), so it's checked string-or-absent, not required.
function isIntentLike(v: unknown): v is Intent {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as { id?: unknown; kind?: unknown; listSlug?: unknown; listId?: unknown; itemId?: unknown; text?: unknown; name?: unknown; at?: unknown; by?: unknown };
  if (!isSafeId(o.id)) return false;
  // `at` is the one field legally ABSENT on EVERY kind (spec §3 -- applyIntent falls back to
  // new Date()), so it's checked once here, string-or-absent, across all kinds.
  if (o.at !== undefined && typeof o.at !== "string") return false;
  // `by` (check/uncheck attribution) is optional too -- string-or-absent, checked once here. A
  // non-string (or an oversize name from a drifted DO) would land in checklists.json's checkedBy,
  // render on the completed item, and bloat every published view -- so cap it like name/text.
  if (o.by !== undefined && (typeof o.by !== "string" || o.by.length > MAX_LIST_NAME)) return false;
  switch (o.kind) {
    // check/uncheck: unchanged -- listSlug + itemId, both strings.
    case "check":
    case "uncheck":
      return typeof o.listSlug === "string" && typeof o.itemId === "string";
    // remove-item: delete one item -- same listSlug + itemId shape as check/uncheck (the "Edit"
    // mode trash). applyIntent finds the item and drops it; a vanished item is a no-op there.
    case "remove-item":
      return typeof o.listSlug === "string" && typeof o.itemId === "string";
    // add-item: a live-list append. Needs listSlug + a non-empty text within the store's
    // MAX_ITEM_TEXT cap (reject empty/oversize before it reaches applyIntent's mutate);
    // no itemId (the store mints one).
    case "add-item":
      // trim().length so a whitespace-only text is rejected (matches checklist-cli, which
      // trims + rejects blanks); the raw (untrimmed) length is what the MAX cap bounds.
      return typeof o.listSlug === "string"
        && typeof o.text === "string" && o.text.trim().length > 0 && o.text.length <= MAX_ITEM_TEXT;
    // create-list: needs a non-empty name within MAX_LIST_NAME; no listSlug/itemId (the slug
    // is derived from the name container-side).
    case "create-list":
      return typeof o.name === "string" && o.name.trim().length > 0 && o.name.length <= MAX_LIST_NAME;
    // delete-list: needs listId (the STABLE store id of the list to remove -- not the mutable
    // slug; see ViewList.id / applyIntent). applyIntent finds the list by id and mirrors
    // checklist-cli rm; an id that matches nothing is a tolerant no-op there.
    case "delete-list":
      return typeof o.listId === "string";
    // recreate-list: needs listId (the STABLE store id of the list to reset -- same identity
    // discipline as delete-list). applyIntent finds the list by id, retires it, and pushes a
    // same-slug replacement; an id that matches nothing is a tolerant no-op there.
    case "recreate-list":
      return typeof o.listId === "string";
    default:
      return false;
  }
}

// Guards an inbound command frame before it's forwarded to onCommand -- same
// discipline as isIntentLike above, applied to command's much thinner shape.
// `payload` is `unknown` end to end (link-protocol.ts's own `command` validation
// likewise only checks it's PRESENT, never its shape -- the DO-specific payload shape
// is the caller's concern, not the transport's); `sig` is the one field actually
// type-checked here, mirroring intent's `id`/`kind`/etc. field-level checks. NOTE: the
// DO currently sends `sig: ""` -- per-message signing is intentionally unused for now
// (the SigV4 channel handshake authenticates the whole link instead), so an empty
// string is a WELL-FORMED sig and must pass this gate; this guard is about shape, not
// verification, and keeps the door open for real per-message verification later
// without a wire-format change.
function isCommandLike(m: Record<string, unknown>): m is { payload: unknown; sig: string } {
  return "payload" in m && typeof m.sig === "string";
}

const HEARTBEAT_MS = 30_000;

// Reconnect backoff -- same shape as home-mirror.ts's handleSyncError (BACKOFF_START_MS /
// BACKOFF_CAP_MS): 0 is the "no failure yet" sentinel, the first failure backs off
// BACKOFF_START_MS, and each subsequent one doubles, capped at BACKOFF_CAP_MS. Reset to 0
// on the first "hbk" round-trip on a fresh connection (see _onMessage) -- NOT on the `hello`
// send itself. `hello` is one-way and proves nothing about the far end; a connection that
// opens, sends hello, and is immediately dropped (a half-broken network, a proxy that
// completes the handshake then resets) would reset on every single cycle if `hello` alone
// counted, pinning the redial rate at BACKOFF_START_MS forever and defeating the entire
// point of an exponential cap. `hbk` is the DO's own auto-answer to the immediate post-hello
// `hb` (see the immediate-hb comment in _onOpen) -- NOTE this is a platform-level
// WebSocketRequestResponsePair (this file's header, "without waking the DO"), so it proves
// TRANSPORT round-trip liveness only, not that the DO application layer accepted the `hello`
// (a post-accept app-level rejection, if one exists, would still free-answer `hbk` and reset
// backoff here). That's a real but narrower gap than the one this reset fixes -- ordinary
// network flaps, the actual failure mode observed -- and cheaper to close later (e.g. only
// resetting once a connection survives a full HEARTBEAT_MS past open) than to over-build now.
const BACKOFF_START_MS = 30_000;
const BACKOFF_CAP_MS = 300_000; // 5 minutes

// How long to wait for the DO's auto-answered "hbk" after sending "hb" before treating the
// link as dead. Mirrors the DO's own STALE_MS (workers/home/src/object.ts) -- "a small
// multiple [of the ~30s cadence] gives room for one or two missed beats" before either side
// gives up on the other. Exported so tests can compute boundaries off this value rather than
// a copied literal (same reasoning STALE_MS itself is exported for).
export const HB_ACK_TIMEOUT_MS = 90_000;

// How long a dial is allowed to take before giving up on it (B4). NOT a guard against the
// connect() PROMISE hanging -- for the real caller (home-bot.ts's signedLinkConnect),
// `await aws.sign(...)` is local WebCrypto (no network), so that promise always settles
// quickly; a hand-rolled future async connect() that genuinely does block on the network
// before returning is still covered as a secondary case (see start()'s dialTimer comment).
// The load-bearing window this actually bounds is what happens AFTER the socket is
// constructed and attached: `new WebSocket(...)` returns immediately in CONNECTING state,
// and the real DNS/TCP/TLS/WS-upgrade dial happens after that, entirely outside this
// promise -- heartbeatTimer/hbAckTimer only arm once _onOpen fires, so a socket that
// attaches but never reaches "open" (a black-holed route, a server that accepts TCP but
// stalls the WS upgrade) would otherwise wedge the link forever with no backoff, no
// redial, and no liveness. Same order of magnitude as BACKOFF_START_MS, well under
// HB_ACK_TIMEOUT_MS. Exported so tests can compute boundaries off this value rather than a
// copied literal.
export const CONNECT_TIMEOUT_MS = 30_000;

export interface HomeLinkDeps<TIntent = Intent> {
  // May return a WebSocketLike directly OR a Promise<WebSocketLike> (B4: the real
  // connect signs a fresh SigV4 request per dial -- aws4fetch's aws.sign() is async --
  // so the signature isn't stale by the time it's used, per verify.ts's MAX_SKEW_MS).
  // start() below detects which shape it got: a sync return is attached in the SAME
  // tick (byte-for-byte the old behavior, so every sync-connect test above is
  // unaffected), an async one is awaited, with a generation guard so a start() that
  // supersedes an in-flight connect() never lets its late socket attach.
  connect: () => WebSocketLike | Promise<WebSocketLike>;
  // Cursor getters, read fresh on every connect (spec: hello always carries the CURRENT
  // cursors, not a snapshot taken at construction time -- start() may run long after these
  // deps were built).
  viewVersion: () => string | null;
  appliedThrough: () => number;
  // B1 belt-and-braces: called if a registered onPull/onIntent callback throws inside
  // _onMessage's per-message dispatch loop. Optional (defaults to a no-op below) so
  // every existing caller/test is unaffected; home-bot.ts wires its own logErr in
  // production. wireLink's own onPull already contains itself (home-mirror.ts) -- this
  // is the second, transport-level layer so NO future callback (any onPull/onIntent a
  // caller registers) can crash the link or truncate a batch, not just this one today.
  logErr?: (m: string) => void;
  // Read fresh in _onOpen and attached to every hello (connect + reconnect). Absent =>
  // hello carries no config. operatorEmail (optional) lets the DO seed the operator as the SOLE
  // protected member; version lets a reseeded DO adopt the file's version (never seed below it).
  config?: () => { senders: string[]; recipients: string[]; version: number; operatorEmail?: string; operatorName?: string };
  // Task 3.2: the intent shape/validator this link accepts is now INJECTABLE, not
  // hardcoded to the checklist `isIntentLike` -- the chat-link socket (chat-bot.ts)
  // carries a structurally DIFFERENT intent union (create-chat/send-message, see
  // chat-bot.ts's ChatIntent), and reusing this same transport class for it (rather
  // than forking a second copy of the whole hello/heartbeat/reconnect machinery) means
  // `_onMessage`'s intent-frame gate must defer to the caller's own domain validator.
  // Defaults to the checklist `isIntentLike` below, so every EXISTING caller (home-bot,
  // sms-bot -- neither of which sets this) is byte-for-byte unaffected. `TIntent`
  // defaults to the checklist `Intent`, so an unparameterized `new HomeLink({...})`
  // (every call site before this task) still type-checks exactly as before.
  isIntent?: (v: unknown) => v is TIntent;
}

// The WS-backed transport -- the sole core<->DO channel since D1 retired the old HTTP poll
// path. Owns exactly one socket at a time: `start()` connects, sends `hello`, then an
// immediate `hb` heartbeat followed by the ~30s interval; inbound `pull`/`intent` route to
// the registered callbacks; `view`/`ack` are outbound only (the DO never sends them to us).
// On a `close`/`error`, OR a missed heartbeat-ack (no `"hbk"` within HB_ACK_TIMEOUT_MS of an
// `"hb"` send -- see _sendHeartbeat), it redials via `start()` itself (already
// supersession-safe) after an exponential backoff (BACKOFF_START_MS .. BACKOFF_CAP_MS, reset
// on the first "hbk" round-trip on a fresh connection -- see the constants' comment above
// for why the reset trigger is the round-trip, not the one-way `hello` send). stop() tears
// everything down cleanly and cancels any pending redial.
export class HomeLink<TIntent = Intent> {
  deps: HomeLinkDeps<TIntent>;
  socket: WebSocketLike | null;
  upId: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  // scope/chatId (Task 3.2): threads the down-direction pull's optional Task 2.1 fields
  // through to the callback -- see HomeLinkDeps.isIntent's comment for why this class is
  // now shared, generically, by both the checklist link and the chat link. Every existing
  // registrant (home-mirror.ts's wireLink) passes a 1-arg `(pullId) => {...}`, which JS/TS
  // both accept against a callback type declaring MORE (optional) parameters -- so this is
  // additive and byte-for-byte backward compatible for every caller that ignores them.
  // `slug` (home-recipes plan, Task C1): a trailing 4th param, additive the same way --
  // the checklist and chat callbacks both ignore it, and the recipes link (recipes-
  // mirror.ts) is the one consumer that reads it (see `Pull.slug`'s comment above).
  pullCb: ((pullId: number, scope?: "index" | "chat" | "recipe" | "usage", chatId?: string, slug?: string) => void) | null;
  intentCb: ((intent: TIntent) => void) | null;
  commandCb: ((payload: unknown, sig: string) => void) | null;
  openCb: (() => void) | null;
  // Reconnect/liveness state (B2). backoffMs is the home-mirror-style sentinel: 0 means "no
  // failure since the last confirmed round-trip (an "hbk")", so the next one starts fresh at
  // BACKOFF_START_MS rather than continuing to grow.
  backoffMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  hbAckTimer: ReturnType<typeof setTimeout> | null;
  // Bumped on every start()/stop() call (B4). An in-flight async connect() closes over
  // the generation it was issued under; when it resolves, a mismatch means a LATER
  // start() (a supersede) or a stop() already moved on, so the late socket is closed
  // and discarded rather than attached -- the same "owns exactly one socket at a time"
  // invariant the sync path already got for free from running start() to completion
  // before returning.
  connectGeneration: number;
  // The open-deadline timer for the CURRENT async dial (B4 fix round 2). Armed once, in
  // start()'s async branch, and stays armed THROUGH promise settlement and _attach -- it is
  // cleared only by _onOpen (the dial succeeded) or by a superseding start()/stop() (see
  // CONNECT_TIMEOUT_MS's comment for why the window it bounds runs past settlement).
  dialTimer: ReturnType<typeof setTimeout> | null;

  constructor(deps: HomeLinkDeps<TIntent>) {
    this.deps = deps;
    this.socket = null;
    this.upId = 0;
    this.heartbeatTimer = null;
    this.pullCb = null;
    this.intentCb = null;
    this.commandCb = null;
    this.openCb = null;
    this.backoffMs = 0;
    this.reconnectTimer = null;
    this.hbAckTimer = null;
    this.connectGeneration = 0;
    this.dialTimer = null;
  }

  start(): void {
    this._clearReconnectTimer(); // a (re)connect attempt supersedes any pending scheduled redial
    this._clearHeartbeat(); // guard against a stray double-start leaking a timer
    this._clearHbAckTimer();
    this._clearDialTimer(); // a fresh dial supersedes any previous one's open-deadline too
    this.socket?.close(); // supersede any previous socket -- "owns exactly one at a time"
    this.socket = null;
    const gen = ++this.connectGeneration;
    let result: WebSocketLike | Promise<WebSocketLike>;
    try {
      result = this.deps.connect();
    } catch {
      // connect() itself threw synchronously (e.g. a sync signer failed) -- same
      // recovery as a socket that dies before ever opening: back off and redial.
      this._scheduleReconnect();
      return;
    }
    // Sync connect() (every test above, and any non-signing caller): attach in the
    // SAME tick, byte-for-byte the pre-B4 behavior. Async connect() (the real signed
    // one): await it, then attach ONLY if nothing superseded this attempt meanwhile.
    if (result && typeof (result as Promise<WebSocketLike>).then === "function") {
      const pending = result as Promise<WebSocketLike>;
      // Bound the WHOLE dial, from here through the socket reaching "open" -- see
      // CONNECT_TIMEOUT_MS's comment for why that window runs past this promise settling,
      // not just up to it. Deliberately NOT cleared on resolve (contrast the pre-fix-
      // round-2 version of this code): _onOpen clears it once the dial actually succeeds;
      // a superseding start()/stop() clears it via their own preambles. On fire, two
      // cases, told apart by whether a socket ever got attached:
      //  - this.socket !== null: the promise resolved and _attach ran, but "open" never
      //    fired (a black-holed route, a stalled WS upgrade) -- tear the stuck socket
      //    down and redial, the same recovery _onMissedHbk uses for a half-open socket.
      //  - this.socket === null: the promise itself never settled -- invalidate the
      //    attempt via the generation counter (same discard mechanism _attach already
      //    applies to a late resolve/reject) and redial.
      this.dialTimer = setTimeout(() => {
        this.dialTimer = null;
        if (this.socket !== null) {
          const stuck = this.socket;
          this._teardownSocket();
          try { stuck.close(); } catch { /* best-effort, like _onMissedHbk */ }
          this._scheduleReconnect();
          return;
        }
        if (gen !== this.connectGeneration) return; // superseded meanwhile; nothing to do
        this.connectGeneration++; // a late resolve now closes the socket instead of attaching
        this._scheduleReconnect();
      }, CONNECT_TIMEOUT_MS);
      this.dialTimer.unref?.(); // match the other timers' unref discipline
      pending.then(
        (socket) => this._attach(socket, gen), // dialTimer stays armed through attach -- see above
        () => {
          // Generation-guarded BEFORE touching the shared timer (fix round 3, fix A):
          // dialTimer is now instance state, not a closure-local handle, so an unconditional
          // clear here would wipe out a LATER dial's own open-deadline if this promise
          // rejects late, after a redial has already superseded it (e.g. this dial's own
          // timeout already bumped the generation and scheduled the redial that's now
          // using dialTimer for ITS attempt). When gen is stale, THIS dial's timer has
          // necessarily already been cleared (a superseding start()/stop() preamble) or
          // already fired (the timeout callback nulls it and bumps the generation itself)
          // -- so skipping the clear here leaks nothing.
          if (gen !== this.connectGeneration) return;
          this._clearDialTimer();
          this._scheduleReconnect();
        },
      );
    } else {
      this._attach(result as WebSocketLike, gen);
    }
  }

  // Wire up a freshly connected socket's listeners -- shared by both the sync and
  // async connect() paths. `gen` is the generation start() issued this connect
  // attempt under; a mismatch (checked ONLY on the async path, where time can pass
  // between connect() being called and this running) means a later start()/stop()
  // already moved on, so the socket is closed unused rather than attached.
  _attach(socket: WebSocketLike, gen: number): void {
    if (gen !== this.connectGeneration) {
      try { socket.close(); } catch { /* already gone; nothing to attach anyway */ }
      return;
    }
    this.socket = socket;
    // Every handler is guarded by identity against the socket it was registered on.
    // A real WebSocket's events (especially `close`) can arrive asynchronously, so a
    // superseded socket's late `close` must NOT clear the CURRENT socket's heartbeat
    // (that would silently kill a healthy link's heartbeat -- exactly the staleness
    // failure the immediate-hb above exists to avoid), and its late `open`/`message`
    // must not re-arm a timer or route a duplicate pull/intent onto the live link.
    // close/error route through _onDisconnect, which carries its own identity guard.
    socket.addEventListener("open", () => { if (this.socket === socket) this._onOpen(); });
    socket.addEventListener("message", (ev) => { if (this.socket === socket) this._onMessage(ev.data); });
    socket.addEventListener("close", () => this._onDisconnect(socket));
    socket.addEventListener("error", () => this._onDisconnect(socket));
  }

  stop(): void {
    this._clearReconnectTimer(); // an explicit stop() must cancel any redial already scheduled
    this._clearHeartbeat();
    this._clearHbAckTimer();
    this._clearDialTimer(); // cancel any pending open-deadline too -- stop() means stop
    this.connectGeneration++; // invalidate any in-flight async connect() -- it must not attach post-stop
    this.socket?.close();
    this.socket = null;
  }

  onPull(cb: (pullId: number, scope?: "index" | "chat" | "recipe" | "usage", chatId?: string, slug?: string) => void): void {
    this.pullCb = cb;
  }

  onIntent(cb: (intent: TIntent) => void): void {
    this.intentCb = cb;
  }

  onCommand(cb: (payload: unknown, sig: string) => void): void {
    this.commandCb = cb;
  }

  // Fires on every fresh connection (initial start() AND every reconnect), before hello's
  // redelivered intents can arrive -- see _onOpen. wireLink (home-mirror.ts) uses this to
  // clear its `failedFloor`: a locally-failed intent that's still genuinely pending on the
  // DO comes back down first on THIS connection's hello (ascending replay), so clearing
  // early is safe; one that's since expired/evicted simply never reappears, and clearing
  // the floor is exactly what lets the cursor advance across that now-permanent gap.
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }

  sendChanged(viewVersion: string): void {
    this._sendEnvelope({ v: 1, type: "changed", id: this._nextId(), viewVersion });
  }

  // `view` is `unknown`, not the checklist `View` -- Task 3.2's chat-scoped sendView
  // carries a structurally different envelope (`{chats: ChatMeta[]}` for scope:"index",
  // `{messages: ChatMessage[]}` for scope:"chat" -- see chat-link.ts's reduceView/
  // handleChatMessage on the DO side), so this method stays a thin, type-agnostic wire
  // encoder; it's cast to `View` only when constructing the envelope below (a JSON
  // wire boundary, not a real type guarantee -- same discipline `isIntent`'s injected
  // validator relies on the CALLER to uphold). `chatId` is optional and omitted from
  // the wire when absent (JSON.stringify drops undefined-valued keys), so every
  // existing 3-arg call site (home-mirror.ts's wireLink) is unaffected. `slug` (home-
  // recipes plan, Task C1) is a trailing 5th param, additive the same way -- but unlike
  // `chatId`, it is LOAD-BEARING on the worker side: object.ts's `pendingRecipesPulls`
  // matches a recipe-scoped pull's waiter by `ViewMsg.slug` itself (see `ViewMsg.slug`'s
  // own comment above), not by `inReplyTo`, so recipes-mirror.ts's onPull handler MUST
  // pass it when answering a `scope:"recipe"` pull or the DO's `freshRecipe` awaits
  // until its timeout and returns `null` even though the container answered correctly.
  sendView(inReplyTo: number, view: unknown, viewVersion: string, chatId?: string, slug?: string): void {
    this._sendEnvelope({ v: 1, type: "view", id: this._nextId(), inReplyTo, view: view as View, viewVersion, chatId, slug });
  }

  sendAck(appliedThrough: number): void {
    this._sendEnvelope({ v: 1, type: "ack", id: this._nextId(), appliedThrough });
  }

  // Fire-and-forget "this chat's turn is over" signal (see TurnDone). Like sendChanged, there is
  // no reply on this wire and a torn-down socket is a no-op -- a missed one just means that turn's
  // typing indicator falls back to the browser's backstop timeout.
  sendTurnDone(chatId: string): void {
    this._sendEnvelope({ v: 1, type: "turn-done", id: this._nextId(), chatId });
  }

  // Open: hello with the CURRENT cursors (read now, not at construction), then the
  // immediate hb, THEN start the ~30s interval. Order matters -- see the B-phase
  // obligation in this repo's task brief: without the immediate hb, a freshly
  // (re)connected link reads as stale to the DO's linkStale for up to a full interval.
  _onOpen(): void {
    // The dial succeeded -- the connecting->open window CONNECT_TIMEOUT_MS/dialTimer
    // guards is over. Clear it FIRST: everything below can (in principle, via openCb) run
    // arbitrary registered code, and a stale open-deadline must not survive into a link
    // that's now genuinely live.
    this._clearDialTimer();
    // Fire BEFORE hello: both are synchronous, so this is purely ordering-for-clarity (no
    // message from this connection can arrive before hello is sent anyway), but it keeps
    // the "clear local failure state, THEN ask for redelivery" narrative honest.
    this.openCb?.();
    // B1-style containment (same invariant as the per-message callback guards in
    // _onMessage): deps.config() is caller-supplied code, and a throw here is NOT
    // inside any try/catch by default -- this runs straight out of the "open" event
    // listener, so an uncaught throw would escape as an uncaughtException (or, in a
    // browser-style runtime, silently abort the listener) and leave the link wedged
    // half-open: socket connected, but hello never sent and heartbeat/hbAck never
    // armed (both happen below this point). Read into a guarded local and fall back
    // to a config-less hello on failure rather than let a bad config() supplier take
    // the whole link down.
    let cfg: { senders: string[]; recipients: string[]; version: number; operatorEmail?: string; operatorName?: string } | undefined;
    try {
      cfg = this.deps.config?.();
    } catch (err) {
      (this.deps.logErr ?? (() => {}))(
        `home-link: deps.config() threw -- sending hello without config: ${(err as Error).message}`,
      );
      cfg = undefined;
    }
    this._sendEnvelope({
      v: 1, type: "hello", id: this._nextId(),
      viewVersion: this.deps.viewVersion(), appliedThrough: this.deps.appliedThrough(), protocol: 1,
      config: cfg,
    });
    // Deliberately NOT resetting backoffMs here: hello is one-way and proves nothing about
    // the far end (see the BACKOFF_START_MS/BACKOFF_CAP_MS comment above). The reset lives
    // in _onMessage's "hbk" branch instead, gated on an actual round trip.
    this._sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_MS);
    // unref: a live link must never be the reason the process can't exit (the surface
    // process has other real work -- Discord/mail/etc -- keeping it alive; this timer
    // alone shouldn't). Also keeps a test that forgets to call stop() from hanging.
    this.heartbeatTimer.unref?.();
  }

  _onMessage(raw: string): void {
    if (raw === "hb") return; // heartbeat frame, not envelope JSON (we don't expect to receive one)
    if (raw === "hbk") {
      // The DO's round-trip answer to our "hb" -- proof (not just an unanswered send) that
      // this connection genuinely works. Clears the liveness ack-wait AND resets the
      // reconnect backoff, so a link that keeps round-tripping never inherits a grown delay
      // from an earlier, unrelated failure; a link that never round-trips (open, hello,
      // dropped) keeps backing off instead of flapping at BACKOFF_START_MS forever.
      this._clearHbAckTimer();
      this.backoffMs = 0;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // malformed frame -- not this layer's job to recover
    }
    if (!Array.isArray(parsed)) return;
    for (const m of parsed as Array<Record<string, unknown>>) {
      // B1 belt-and-braces: each message's callback runs in its own try/catch, so one
      // throwing pull/intent handler cannot crash the transport (this runs inside the
      // WebSocket "message" event listener -- an uncaught throw here is an
      // uncaughtException) NOR silently drop every later message in the SAME batched
      // frame (a bare loop with no per-iteration guard would stop dead on the first
      // throw). wireLink's own onPull (home-mirror.ts) already contains itself for
      // today's one registered callback; this is the transport's own backstop for any
      // callback, present or future.
      try {
        if (m && m.type === "pull" && isSafeId(m.id)) {
          // scope/chatId (Task 3.2, Task 2.1's fields finally wired through): forwarded
          // as-received, loosely validated (a malformed/absent scope or chatId just comes
          // through as undefined -- the checklist link's callback ignores both extra args,
          // same as before this task; the chat-bot's callback is the one that actually acts
          // on them). No isSafeId-style hard rejection here: an unrecognized scope value is
          // the caller's concern to fall back on, mirroring how a missing scope has always
          // meant "index" by convention (Pull's own `scope?` doc comment).
          const scope = m.scope === "index" || m.scope === "chat" || m.scope === "recipe" || m.scope === "usage" ? m.scope : undefined;
          const chatId = typeof m.chatId === "string" ? m.chatId : undefined;
          const slug = typeof m.slug === "string" ? m.slug : undefined;
          this.pullCb?.(m.id, scope, chatId, slug);
        }
        else if (m && m.type === "intent") {
          // A malformed intent frame (the validator rejects a drifted peer's
          // kind/listSlug/itemId/at, not just a bad id) must NOT be dropped silently:
          // when the next valid intent applies, wireLink acks cumulatively (Math.max),
          // telling the DO to delete this dropped id too -- the tap is lost for good.
          // Log it loudly (the same "a skipped tap must be loud" rule wireLink follows),
          // even though no producer sends intents until A7.
          //
          // The validator itself is INJECTABLE (deps.isIntent, Task 3.2) -- see
          // HomeLinkDeps.isIntent's comment for why: this same class now backs both the
          // checklist link (home-bot.ts, unset -- defaults to the checklist isIntentLike)
          // and the chat link (chat-bot.ts, sets isChatIntentLike). The cast is a wire-
          // boundary cast, not a real type guarantee -- exactly like sendView's `view`
          // above -- because a generic default parameter can't be proven equal to the
          // module-private `isIntentLike`'s own asserted type at compile time.
          const isIntent = this.deps.isIntent ?? (isIntentLike as unknown as (v: unknown) => v is TIntent);
          if (isIntent(m.intent)) this.intentCb?.(m.intent);
          else (this.deps.logErr ?? (() => {}))(
            "home-link: dropped a malformed intent frame (peer drift?) -- it will be cumulatively acked away, not applied",
          );
        }
        else if (m && m.type === "command") {
          if (isCommandLike(m)) this.commandCb?.(m.payload, m.sig);
          else (this.deps.logErr ?? (() => {}))(
            "home-link: dropped a malformed command frame (missing payload or non-string sig), not forwarded",
          );
        }
      } catch (err) {
        (this.deps.logErr ?? (() => {}))(
          `home-link: a "${String(m?.type)}" callback threw -- skipping it, continuing the batch: ${(err as Error).message}`,
        );
      }
    }
  }

  // A close/error on the CURRENT socket (identity-guarded -- a superseded socket's late
  // event must not tear down or reschedule against the live one) tears down local state and
  // schedules a redial. Also reached (via _onMissedHbk) when we declare a socket dead
  // ourselves rather than being told.
  _onDisconnect(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
    this._teardownSocket();
    this._scheduleReconnect();
  }

  // Fired when HB_ACK_TIMEOUT_MS has elapsed since an "hb" with no "hbk" seen since. The
  // socket may still look "open" from the transport's own perspective (this is exactly the
  // half-open-connection case liveness exists to catch), so we declare it dead ourselves:
  // tear down, best-effort close it, and redial -- same path a real close/error takes.
  _onMissedHbk(socket: WebSocketLike): void {
    this.hbAckTimer = null;
    if (this.socket !== socket) return; // stale timer from an already-superseded socket
    this._teardownSocket();
    socket.close(); // best-effort; its own close event is now a no-op (this.socket is null)
    this._scheduleReconnect();
  }

  _scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return; // already scheduled
    this.backoffMs = this.backoffMs === 0 ? BACKOFF_START_MS : Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, this.backoffMs);
    this.reconnectTimer.unref?.(); // a pending redial must never be the reason the process can't exit
  }

  _nextId(): number {
    this.upId += 1;
    return this.upId;
  }

  _sendHeartbeat(): void {
    const socket = this.socket;
    socket?.send("hb");
    // Liveness: arm a fresh ack-wait ONLY if none is already outstanding. A still-pending
    // timer from an earlier unacked hb must keep counting toward its ORIGINAL deadline --
    // if every ~30s hb rearmed it, a truly dead link's timer would never reach
    // HB_ACK_TIMEOUT_MS at all (each new hb would push the deadline back out before the old
    // one could fire).
    if (socket !== null && this.hbAckTimer === null) {
      this.hbAckTimer = setTimeout(() => this._onMissedHbk(socket), HB_ACK_TIMEOUT_MS);
      this.hbAckTimer.unref?.();
    }
  }

  _sendEnvelope(msg: UpMsg): void {
    this.socket?.send(JSON.stringify([msg]));
  }

  _clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _clearHbAckTimer(): void {
    if (this.hbAckTimer !== null) {
      clearTimeout(this.hbAckTimer);
      this.hbAckTimer = null;
    }
  }

  _clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _clearDialTimer(): void {
    if (this.dialTimer !== null) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
  }

  // Shared by _onDisconnect, _onMissedHbk, and the dialTimer's own stuck-socket branch:
  // clear the heartbeat + ack-wait + open-deadline timers and drop the dead socket
  // reference (does NOT touch reconnectTimer -- scheduling that is the caller's job, via
  // _scheduleReconnect). Clearing dialTimer here too closes a race the other two callers
  // would otherwise open: a close/error landing on an attached-but-not-yet-open socket
  // already redials via _scheduleReconnect, so the still-armed open-deadline has nothing
  // left to guard -- left alone, it would later fire against a null this.socket and bump
  // connectGeneration a second, redundant time (harmless, since nothing depends on its
  // exact value beyond equality, but needless).
  _teardownSocket(): void {
    this._clearHeartbeat();
    this._clearHbAckTimer();
    this._clearDialTimer();
    this.socket = null;
  }
}
