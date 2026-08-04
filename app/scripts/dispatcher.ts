// Shared per-key dispatcher: debounce rapid items per key, serialize runs within
// a key (no talking over itself), cap global concurrency, and enforce a per-key
// hourly run budget. Extracted from discord-bot.ts so multiple surfaces (Discord,
// SMS) can reuse the same machinery. The base coalesce is a generic latest-wins;
// surfaces that need richer merging (e.g. Discord's media-carry-forward) subclass
// and override _coalesce.
import { logErr } from "./runtime.ts";

export interface ChannelDispatcherOptions<T> {
  debounceMs: number;
  maxConcurrent: number;
  runFn: (channelId: string, item: T) => Promise<void> | void;
  maxRunsPerWindow?: number;
  windowMs?: number;
}

// Coalesces rapid items per key (debounce), serializes runs within a key (no
// talking over itself), and caps global concurrency. runFn does the actual work
// for a key's latest item.
export class ChannelDispatcher<T> {
  debounceMs: number;
  maxConcurrent: number;
  runFn: (channelId: string, item: T) => Promise<void> | void;
  maxRunsPerWindow: number;
  windowMs: number;
  runStarts: Map<string, number[]>;
  timers: Map<string, NodeJS.Timeout>;
  latest: Map<string, T>;
  busy: Set<string>;
  queued: Map<string, T>;
  active: number;
  waiting: Map<string, T>;

  constructor({ debounceMs, maxConcurrent, runFn, maxRunsPerWindow = 0, windowMs = 60 * 60 * 1000 }: ChannelDispatcherOptions<T>) {
    this.debounceMs = debounceMs;
    this.maxConcurrent = maxConcurrent;
    this.runFn = runFn;
    // Per-CHANNEL rate budget: at most maxRunsPerWindow runs started per budget
    // key per windowMs. 0 disables it (the default, so tests are unaffected
    // unless they opt in; both production dispatchers pass
    // MAX_RUNS_PER_CHANNEL_PER_HOUR). The budget key comes from _budgetKey (the
    // dispatch key by default; ReactionDispatcher overrides it to the channelId
    // so reactions are bounded per channel, not per reacted-message). runStarts
    // tracks recent start timestamps per budget key, pruned to the window.
    this.maxRunsPerWindow = maxRunsPerWindow;
    this.windowMs = windowMs;
    this.runStarts = new Map(); // budgetKey -> [start timestamps within the window]
    this.timers = new Map();   // channelId -> debounce timer
    this.latest = new Map();   // channelId -> latest message during debounce
    this.busy = new Set();     // channelIds with an active run
    this.queued = new Map();   // channelId -> latest message queued behind an active run
    this.active = 0;           // global active runs
    this.waiting = new Map();  // channelId -> latest message waiting on the global cap
  }

  // The key a run counts against for the rate budget. Default: the dispatch key
  // (channelId for the message dispatcher). ReactionDispatcher overrides it to the
  // channelId (its dispatch key is the messageId) so reaction runs are bounded
  // per channel -- otherwise a reactor spreading across N of Baxter's old messages
  // gets N separate budgets and the aggregate is unbounded.
  _budgetKey(dispatchKey: string, _item: T): string {
    return dispatchKey;
  }

  // True if this budget key has already used its run budget for the current
  // window. Sweeps the WHOLE map each call (pruning expired starts, dropping
  // now-empty keys) so it can't grow unbounded across many transient channels --
  // after the sweep the map only holds keys with a run in the last window, which
  // is small, so the full scan is cheap at this scale.
  _overBudget(budgetKey: string): boolean {
    if (!this.maxRunsPerWindow) return false; // budget disabled
    const cutoff = Date.now() - this.windowMs;
    for (const [k, starts] of this.runStarts) {
      const kept = starts.filter((t) => t > cutoff);
      if (kept.length) this.runStarts.set(k, kept);
      else this.runStarts.delete(k);
    }
    return (this.runStarts.get(budgetKey)?.length ?? 0) >= this.maxRunsPerWindow;
  }

  _recordRun(budgetKey: string): void {
    if (!this.maxRunsPerWindow) return;
    const arr = this.runStarts.get(budgetKey) || [];
    arr.push(Date.now());
    this.runStarts.set(budgetKey, arr);
  }

  // Coalesce a key's pending item with a newer one. The base default is
  // latest-wins -- surfaces that need richer merging (e.g. Discord's decision
  // escalation + media carry-forward) subclass and override this entirely.
  _coalesce(_prev: T, next: T): T { return next; }

  _merge(map: Map<string, T>, channelId: string, item: T): void {
    const prev = map.get(channelId);
    map.set(channelId, prev ? this._coalesce(prev, item) : item);
  }

  notify(channelId: string, item: T): void {
    this._merge(this.latest, channelId, item);
    clearTimeout(this.timers.get(channelId));
    this.timers.set(channelId, setTimeout(() => {
      this.timers.delete(channelId);
      const merged = this.latest.get(channelId);
      this.latest.delete(channelId);
      this._enqueue(channelId, merged as T);
    }, this.debounceMs));
  }

  _enqueue(channelId: string, item: T): void {
    // Shed the trigger entirely once its budget key is over the hourly budget --
    // the loop terminator. Dropping here (rather than queuing) is what actually
    // stops a bot ping-pong: every fresh message flows through here, so a runaway
    // channel stops spawning runs while other channels are untouched.
    const budgetKey = this._budgetKey(channelId, item);
    if (this._overBudget(budgetKey)) {
      logErr(`[${budgetKey}] per-channel run budget reached (${this.maxRunsPerWindow}/${Math.round(this.windowMs / 60000)}m); dropping trigger`);
      return;
    }
    if (this.busy.has(channelId)) { this._merge(this.queued, channelId, item); return; }
    // Keyed by channel so a later message escalates/replaces (not appends) the
    // waiting entry -- otherwise a channel could sit in the queue twice and a
    // stale entry could clobber a newer one.
    if (this.waiting.has(channelId) || this.active >= this.maxConcurrent) { this._merge(this.waiting, channelId, item); return; }
    this._start(channelId, item);
  }

  _start(channelId: string, message: T): void {
    this.busy.add(channelId);
    this._recordRun(this._budgetKey(channelId, message)); // count against the per-channel budget
    this.active++;
    Promise.resolve()
      .then(() => this.runFn(channelId, message))
      .catch((err: unknown) => {
        const e = err as { message?: unknown } | undefined;
        logErr(`[${channelId}] run failed: ${e?.message ?? err}`);
      })
      .finally(() => {
        this.busy.delete(channelId);
        this.active--;
        // Put this channel's own follow-up at the BACK of waiting (don't
        // dispatch it directly -- that would steal the freed slot and starve
        // other waiters).
        const q = this.queued.get(channelId);
        if (q !== undefined) { this.queued.delete(channelId); this._merge(this.waiting, channelId, q); }
        // Start the front waiter into the freed slot, RE-CHECKING the budget as we
        // go. A waiter was admitted while its budget key was under budget, but when
        // the dispatch key != budget key (ReactionDispatcher: many messageId
        // waiters share one channel budget) a burst can park a backlog that an
        // unconditional drain would run past the cap. Drop over-budget waiters
        // (they can't run this window, and skipping them stops an over-budget key
        // from head-blocking others) and start the first eligible one.
        for (const [key, item] of this.waiting) {
          this.waiting.delete(key);
          const bk = this._budgetKey(key, item);
          if (this._overBudget(bk)) {
            logErr(`[${bk}] per-channel run budget reached (${this.maxRunsPerWindow}/${Math.round(this.windowMs / 60000)}m); dropping queued trigger`);
            continue;
          }
          this._start(key, item);
          break;
        }
      });
  }
}
