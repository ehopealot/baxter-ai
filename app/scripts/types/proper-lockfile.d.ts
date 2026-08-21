// Minimal ambient typing for the `proper-lockfile` runtime dependency, which
// ships no types of its own and has no published @types package. Covers the
// surface this repo actually calls: lockfile.lock(path, opts) -> a release
// function (send-state.ts / schedule-store.ts / checklist-store.ts /
// chat-transcript.ts). Only the async, retryable lock is used -- the sync
// `lockSync` was dropped when chat-transcript.ts's index mutations moved to the
// retrying async lock (a no-retry sync lock threw ELOCKED on index contention).
declare module "proper-lockfile" {
  interface LockRetryOptions {
    retries?: number;
    minTimeout?: number;
    maxTimeout?: number;
  }
  interface LockOptions {
    realpath?: boolean;
    stale?: number;
    // Held-lock mtime-refresh interval (ms): while the lock is held, its mtime is
    // refreshed on this cadence so a slow-but-legal holder is never falsely broken
    // as stale (calendar-refresh.ts passes it; proper-lockfile clamps it to stale/2).
    update?: number;
    retries?: LockRetryOptions;
  }
  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  const lockfile: { lock: typeof lock };
  export default lockfile;
}
