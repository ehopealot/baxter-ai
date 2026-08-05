// Minimal ambient typing for the `proper-lockfile` runtime dependency, which
// ships no types of its own and has no published @types package. Covers the
// surface this repo actually calls: lockfile.lock(path, opts) -> a release
// function (send-state.ts / schedule-store.ts / checklist-store.ts), plus the
// sync variant lockfile.lockSync(path, opts) -> a sync release function
// (chat-transcript.ts's index mutations, which are synchronous per its
// interface -- note lockSync's `options` must NOT set `retries`, since
// proper-lockfile's sync adapter throws if it does).
declare module "proper-lockfile" {
  interface LockRetryOptions {
    retries?: number;
    minTimeout?: number;
    maxTimeout?: number;
  }
  interface LockOptions {
    realpath?: boolean;
    stale?: number;
    retries?: LockRetryOptions;
  }
  interface LockSyncOptions {
    realpath?: boolean;
    stale?: number;
  }
  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  function lockSync(file: string, options?: LockSyncOptions): () => void;
  const lockfile: { lock: typeof lock; lockSync: typeof lockSync };
  export default lockfile;
}
