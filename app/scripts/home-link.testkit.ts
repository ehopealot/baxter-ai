// In-memory duplex WebSocketLike pair for home-link.test.ts. `client` is the
// WebSocketLike HomeLink drives (handed back by the injected `connect()` factory);
// `server` is the test harness's view of the OTHER end of the wire -- the DO's role
// in production -- used to inspect what HomeLink sent and to inject down-messages
// (`pull`/`intent`) the way the DO would. No real socket, no timers of its own: the
// only asynchrony is `queueMicrotask`, so `await`ing `server.next()` (or a plain
// microtask flush) is enough to observe delivery -- no sleep, no fake clock needed
// here (home-link.test.ts's heartbeat-cadence test brings its own mock timer for
// setInterval, which this file doesn't touch).
import type { WebSocketLike, LinkMsg } from "./home-link.ts";

type Listener = (ev: { data: string }) => void;

// One end of the pair. Implements just enough of WebSocketLike for HomeLink to
// drive it: send/close/addEventListener("open"|"message"|"close"). `open` auto-
// fires (async, one microtask out) the moment a listener is registered for it --
// simulating a socket that's already mid-connect when `connect()` hands it back,
// which is what lets the brief's tests call `link.start()` with no separate
// "now open it" step.
class FakeEndpoint implements WebSocketLike {
  peer: FakeEndpoint | null = null;
  listeners: Map<string, Listener[]> = new Map();
  opened = false;

  addEventListener(type: string, listener: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
    if (type === "open" && !this.opened) {
      queueMicrotask(() => {
        this.opened = true;
        listener({ data: "" });
      });
    }
  }

  emit(type: string, data: string): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }

  send(data: string): void {
    // Real WS delivery is async; queueMicrotask mirrors that without a real
    // network hop, and keeps ordering deterministic under `await`.
    queueMicrotask(() => this.peer?.emit("message", data));
  }

  close(): void {
    // Async, like a real WebSocket's close event -- a close() call and the
    // resulting "close" event are not the same tick. That gap is exactly what
    // lets a superseded socket's close outlive a `start()` that already moved
    // on to a new one; home-link.test.ts's supersession test depends on this.
    queueMicrotask(() => {
      this.emit("close", "");
      this.peer?.emit("close", "");
    });
  }
}

// The test-facing view of the "server" (DO) end. Not a WebSocketLike itself --
// `send` here takes a decoded message (mirroring how a test thinks about the
// wire), not a raw string.
export class ServerView {
  #endpoint: FakeEndpoint;
  #queue: LinkMsg[] = [];
  #waiters: Array<(m: LinkMsg) => void> = [];
  // Every raw frame the server received from the client, in order -- including
  // literal "hb" heartbeat frames, which `next()` deliberately does NOT surface
  // (they're not envelope JSON; see decode()'s frame contract in the DO's
  // link-protocol.ts). Tests that care about heartbeat cadence read this.
  rawReceived: string[] = [];

  constructor(endpoint: FakeEndpoint) {
    this.#endpoint = endpoint;
    endpoint.addEventListener("message", ({ data }) => this.#onFrame(data));
  }

  #onFrame(raw: string): void {
    this.rawReceived.push(raw);
    if (raw === "hb") return; // heartbeat, not an envelope frame
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const m of parsed as LinkMsg[]) {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(m);
      else this.#queue.push(m);
    }
  }

  // Resolves with the next up-message (hello/changed/view/ack) HomeLink sent,
  // in order. Never resolves with a raw "hb" frame.
  next(): Promise<LinkMsg> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  // Inject a down-message (pull/intent) as the DO would, wrapped in the
  // one-frame-is-always-an-array envelope the real wire uses.
  send(msg: LinkMsg): void {
    this.#endpoint.send(JSON.stringify([msg]));
  }
}

export class FakeSocketPair {
  client: WebSocketLike;
  server: ServerView;

  constructor() {
    const clientEnd = new FakeEndpoint();
    const serverEnd = new FakeEndpoint();
    clientEnd.peer = serverEnd;
    serverEnd.peer = clientEnd;
    this.client = clientEnd;
    this.server = new ServerView(serverEnd);
  }

  // Let queued microtasks (open auto-fire, message delivery) settle. Prefer
  // awaiting `server.next()` directly where possible; this is for assertions
  // that need "nothing more arrives" rather than "here's the next thing."
  flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
}
