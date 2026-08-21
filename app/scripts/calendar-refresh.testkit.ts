import type { FetchLike } from "./calendar-cli.ts";

// Shared partial Response double: readCapped consumes the arrayBuffer fallback.
export function stubFetch({ status = 200, body = "" }: { status?: number; body?: string } = {}): FetchLike {
  return (async () => ({ status, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(body).buffer })) as unknown as FetchLike;
}

// Shared real-timer polling for refresh-lock contention fixtures. These tests
// assert eventual outcomes across proper-lockfile's real backoff, never timing.
export async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
