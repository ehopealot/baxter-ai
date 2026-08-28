import { providerFetch } from "./provider-lease-transport.ts";

// Best-effort shipping of a daemon's log lines to a Discord channel via a webhook
// (one webhook per daemon -> its own #baxter-logs-* channel). Chosen over posting
// through the bot: a webhook is decoupled from the bot token (the mail daemon has
// none), from the bot's daily send cap, and from its message logic -- a log firehose
// shouldn't touch any of that.
//
// Contract: ship() NEVER throws and NEVER routes its own failures back through the
// daemon logger (that would loop) -- a failed post is dropped with a single
// console.error. Lines are buffered and flushed batched (a timer + a size cap) as
// fenced code blocks, chunked to Discord's 2000-char message limit. An unset webhook
// yields a no-op shipper. Pure-ish + fetch/timer injectable for tests.

const CHUNK_BUDGET = 1900; // leave room under Discord's 2000 for the ``` fences

// Pack lines into <=CHUNK_BUDGET-char blocks (one over-long line is truncated, never
// split mid-way in a way that drops the rest silently -- it's capped with an ellipsis).
export function packLines(lines: string[], budget: number = CHUNK_BUDGET): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const raw of lines) {
    const line = raw.length > budget ? raw.slice(0, budget - 1) + "…" : raw;
    if (cur && cur.length + 1 + line.length > budget) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// The webhook POST function, injectable for tests -- a fake need only resolve
// something carrying an optional numeric `status` (or reject, to exercise the
// swallow-and-log path). Production defaults to the worker lease transport.
export type LogShipperFetch = (url: string, init: RequestInit) => Promise<{ status?: number }>;

export interface LogShipperOptions {
  webhookUrl?: string;
  flushMs?: number;
  maxBuffer?: number; // force a flush once this many lines pile up between ticks
  fetchFn?: LogShipperFetch;
}

export interface LogShipper {
  ship(line: string): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export function createDiscordLogShipper({
  webhookUrl,
  flushMs = 2000,
  maxBuffer = 100,
  fetchFn = providerFetch,
}: LogShipperOptions = {}): LogShipper {
  if (!webhookUrl) return { ship() {}, flush: async () => {}, stop: async () => {} };
  const url: string = webhookUrl; // re-bind so the narrowing survives into the nested closures below

  let buf: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let sending: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushMs);
    timer.unref?.(); // don't keep the process alive just for the log flush
  };

  async function postChunk(content: string): Promise<void> {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      // 429 (rate limited) / any non-2xx: drop this batch. Logs remain in
      // `docker logs`; the channel is a convenience mirror, not the source of truth.
      if (res && typeof res.status === "number" && res.status >= 400) {
        console.error(`[log-shipper] webhook HTTP ${res.status}`);
      }
    } catch (e) {
      // NEVER via logErr -- that would ship this line and can loop.
      const err = e as { message?: string } | undefined;
      console.error(`[log-shipper] post failed: ${err?.message ?? e}`);
    }
  }

  function flush(): Promise<void> {
    if (!buf.length) return sending;
    const lines = buf;
    buf = [];
    const chunks = packLines(lines);
    // Serialize posts on one chain: preserves order and avoids a concurrent burst
    // that would trip the webhook rate limit harder.
    sending = chunks.reduce(
      (p, c) => p.then(() => postChunk("```\n" + c + "\n```")),
      sending,
    );
    return sending;
  }

  function ship(line: string): void {
    buf.push(String(line));
    if (buf.length >= maxBuffer) flush();
    else schedule();
  }

  async function stop(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await flush();
  }

  return { ship, flush, stop };
}
