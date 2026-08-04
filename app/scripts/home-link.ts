// Family-home web mirror -- the core-side WS transport (see docs/family-home-core-spec.md
// and docs/architecture/home.md). This is the WS-backed replacement for HomeOps's polling
// sync (home-mirror.ts:38): the container holds one persistent link to the control-plane
// Durable Object instead of a request/response poll loop. Later tasks (B3) wire this to
// buildView/applyIntent; this file is transport ONLY -- connect, hello, heartbeat, and
// message routing. No reconnect/backoff (B2) and no home-bot swap (B4).
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

// Guards the `intent` field an inbound IntentMsg carries before it's forwarded to onIntent,
// matching the depth of the sibling `pull` branch's `typeof m.id === "number"` check (not just
// "is an object", which still admits `[]`/`{}`). `id` specifically, because B3's future drain
// loop (mirroring home-mirror.ts's runSyncTick) keys `appliedThrough` off `intent.id` -- an
// id-less intent object would silently corrupt that cursor for every intent after it, rather
// than failing loudly on just the one malformed frame. `Number.isInteger`, not `typeof ===
// "number"`: a drifted/malformed peer's `1e999` parses to `Infinity`, which the looser check
// would admit -- setting the cursor to `Infinity` permanently filters out every later intent
// (`i.id > Infinity` is never true), worse than the id-less case this guard already fixes.
function isIntentLike(v: unknown): v is Intent {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Number.isInteger((v as { id?: unknown }).id);
}

const HEARTBEAT_MS = 30_000;

export interface HomeLinkDeps {
  connect: () => WebSocketLike;
  // Cursor getters, read fresh on every connect (spec: hello always carries the CURRENT
  // cursors, not a snapshot taken at construction time -- start() may run long after these
  // deps were built).
  viewVersion: () => string | null;
  appliedThrough: () => number;
}

// The WS-backed HomeOps-adjacent transport. Owns exactly one socket at a time: `start()`
// connects, sends `hello`, then an immediate `hb` heartbeat followed by the ~30s interval;
// inbound `pull`/`intent` route to the registered callbacks; `view`/`ack` are outbound only
// (the DO never sends them to us). No reconnect logic here -- B2 owns retrying start() after
// a close/error; this class just tears its own state down cleanly on stop() or a socket close.
export class HomeLink {
  deps: HomeLinkDeps;
  socket: WebSocketLike | null;
  upId: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pullCb: ((pullId: number) => void) | null;
  intentCb: ((intent: Intent) => void) | null;

  constructor(deps: HomeLinkDeps) {
    this.deps = deps;
    this.socket = null;
    this.upId = 0;
    this.heartbeatTimer = null;
    this.pullCb = null;
    this.intentCb = null;
  }

  start(): void {
    this._clearHeartbeat(); // guard against a stray double-start leaking a timer
    this.socket?.close(); // supersede any previous socket -- "owns exactly one at a time"
    const socket = this.deps.connect();
    this.socket = socket;
    // Every handler is guarded by identity against the socket it was registered on.
    // A real WebSocket's events (especially `close`) can arrive asynchronously, so a
    // superseded socket's late `close` must NOT clear the CURRENT socket's heartbeat
    // (that would silently kill a healthy link's heartbeat -- exactly the staleness
    // failure the immediate-hb above exists to avoid), and its late `open`/`message`
    // must not re-arm a timer or route a duplicate pull/intent onto the live link.
    socket.addEventListener("open", () => { if (this.socket === socket) this._onOpen(); });
    socket.addEventListener("message", (ev) => { if (this.socket === socket) this._onMessage(ev.data); });
    socket.addEventListener("close", () => { if (this.socket === socket) this._clearHeartbeat(); });
  }

  stop(): void {
    this._clearHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  onPull(cb: (pullId: number) => void): void {
    this.pullCb = cb;
  }

  onIntent(cb: (intent: Intent) => void): void {
    this.intentCb = cb;
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
    this._sendEnvelope({
      v: 1,
      type: "hello",
      id: this._nextId(),
      viewVersion: this.deps.viewVersion(),
      appliedThrough: this.deps.appliedThrough(),
      protocol: 1,
    });
    this._sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_MS);
    // unref: a live link must never be the reason the process can't exit (the surface
    // process has other real work -- Discord/mail/etc -- keeping it alive; this timer
    // alone shouldn't). Also keeps a test that forgets to call stop() from hanging.
    this.heartbeatTimer.unref?.();
  }

  _onMessage(raw: string): void {
    if (raw === "hb" || raw === "hbk") return; // heartbeat frames, not envelope JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // malformed frame -- not this layer's job to recover; B2 territory
    }
    if (!Array.isArray(parsed)) return;
    for (const m of parsed as Array<Record<string, unknown>>) {
      if (m && m.type === "pull" && typeof m.id === "number") this.pullCb?.(m.id);
      else if (m && m.type === "intent" && isIntentLike(m.intent)) this.intentCb?.(m.intent);
    }
  }

  _nextId(): number {
    this.upId += 1;
    return this.upId;
  }

  _sendHeartbeat(): void {
    this.socket?.send("hb");
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
}
