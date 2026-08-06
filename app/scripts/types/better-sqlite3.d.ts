// Minimal ambient typing for the `better-sqlite3` runtime dependency, which
// ships no types of its own (no `types` field, no bundled .d.ts) and this repo
// doesn't pull in the separately-published (and version-lagging) DefinitelyTyped
// package for it. Covers only the surface mail-state-sqlite.ts actually calls:
// construct, pragma/exec, prepare().get()/.all()/.run(), transaction(), close().
declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Database {
    pragma(source: string): unknown;
    exec(source: string): this;
    prepare(source: string): Statement;
    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
    close(): this;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
