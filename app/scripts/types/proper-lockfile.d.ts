// Minimal ambient typing for the `proper-lockfile` runtime dependency, which
// ships no types of its own and has no published @types package. Covers only
// the surface this repo actually calls (send-state.ts / schedule-store.ts):
// lockfile.lock(path, opts) -> a release function.
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
  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  const lockfile: { lock: typeof lock };
  export default lockfile;
}
