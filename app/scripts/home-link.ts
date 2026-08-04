// Family-home web mirror -- the core-side WS transport (see docs/family-home-core-spec.md
// and docs/architecture/home.md). This is the WS-backed replacement for HomeOps's polling
// sync (home-mirror.ts:38): the container holds one persistent link to the control-plane
// Durable Object instead of a request/response poll loop. Later tasks (B3) wire this to
// buildView/applyIntent; this file is transport ONLY -- connect, hello, heartbeat, and
// message routing, and (B2) reconnect/backoff/liveness. No home-bot swap (B4) here.
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

// ---------- wire types (the contract; mirrors link-protocol.ts's LinkMsg union) ----------

// --- up (container -> home) ---
export interface Hello { v: 1; type: "hello"; id: number; viewVersion: string | null; appliedThrough: number; protocol: 1; }
export interface Changed { v: 1; type: "changed"; id: number; viewVersion: string; }
export interface ViewMsg { v: 1; type: "view"; id: number; inReplyTo: number; view: View; viewVersion: string; }
export interface Ack { v: 1; type: "ack"; id: number; appliedThrough: number; }
export type UpMsg = Hello | Changed | ViewMsg | Ack;

// --- down (home -> container) ---
export interface Pull { v: 1; type: "pull"; id: number; }
export interface IntentMsg { v: 1; type: "intent"; id: number; intent: Intent; }
export type DownMsg = Pull | IntentMsg;

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
// `id` (B3's future drain loop pins `appliedThrough` to it, mirroring home-mirror.ts's
// runSyncTick) -- so the two branches can't silently drift apart in how deep they check,
// the way they already once did in this file's history. `Number.isSafeInteger`, not
// `Number.isInteger`: a drifted/malformed peer's literal `1e999` parses to `Infinity`,
// which `Number.isInteger` rejects but which a bare `typeof === "number"` would admit;
// `Number.isSafeInteger` goes one step further and ALSO rejects huge-but-finite doubles
// (>= 2^53) that `Number.isInteger` still admits -- those wedge the same cursor
// permanently (`i.id > 1e300` is never true again either), just without the
// serializes-as-null tell Infinity has. This bounds, but cannot fully eliminate, a
// drifted peer pinning a cursor at a plausible-looking large id; a future drain loop
// should treat an implausible id jump as suspect rather than trust any admitted id
// unconditionally -- that's B3's problem, not this transport layer's.
function isSafeId(v: unknown): v is number {
  return Number.isSafeInteger(v);
}

// Guards the `intent` field an inbound IntentMsg carries before it's forwarded to
// onIntent -- not just "is an object" (which still admits `[]`/`{}`), but that its `id`
// is one worth trusting (see isSafeId above). An id-less/malformed intent object would
// otherwise corrupt B3's future appliedThrough cursor for every intent after it.
function isIntentLike(v: unknown): v is Intent {
  return typeof v === "object" && v !== null && !Array.isArray(v) && isSafeId((v as { id?: unknown }).id);
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

export interface HomeLinkDeps {
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
}

// The WS-backed HomeOps-adjacent transport. Owns exactly one socket at a time: `start()`
// connects, sends `hello`, then an immediate `hb` heartbeat followed by the ~30s interval;
// inbound `pull`/`intent` route to the registered callbacks; `view`/`ack` are outbound only
// (the DO never sends them to us). On a `close`/`error`, OR a missed heartbeat-ack (no
// `"hbk"` within HB_ACK_TIMEOUT_MS of an `"hb"` send -- see _sendHeartbeat), it redials via
// `start()` itself (already supersession-safe) after an exponential backoff (BACKOFF_START_MS
// .. BACKOFF_CAP_MS, reset on the first "hbk" round-trip on a fresh connection -- same
// grow/cap shape as home-mirror.ts's handleSyncError, but see the constants' comment above
// for why the reset trigger is the round-trip, not the one-way `hello` send). stop() tears
// everything down cleanly and cancels any pending redial.
export class HomeLink {
  deps: HomeLinkDeps;
  socket: WebSocketLike | null;
  upId: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pullCb: ((pullId: number) => void) | null;
  intentCb: ((intent: Intent) => void) | null;
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

  constructor(deps: HomeLinkDeps) {
    this.deps = deps;
    this.socket = null;
    this.upId = 0;
    this.heartbeatTimer = null;
    this.pullCb = null;
    this.intentCb = null;
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

  onPull(cb: (pullId: number) => void): void {
    this.pullCb = cb;
  }

  onIntent(cb: (intent: Intent) => void): void {
    this.intentCb = cb;
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

  sendView(inReplyTo: number, view: View, viewVersion: string): void {
    this._sendEnvelope({ v: 1, type: "view", id: this._nextId(), inReplyTo, view, viewVersion });
  }

  sendAck(appliedThrough: number): void {
    this._sendEnvelope({ v: 1, type: "ack", id: this._nextId(), appliedThrough });
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
    this._sendEnvelope({
      v: 1,
      type: "hello",
      id: this._nextId(),
      viewVersion: this.deps.viewVersion(),
      appliedThrough: this.deps.appliedThrough(),
      protocol: 1,
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
      if (m && m.type === "pull" && isSafeId(m.id)) this.pullCb?.(m.id);
      else if (m && m.type === "intent" && isIntentLike(m.intent)) this.intentCb?.(m.intent);
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
