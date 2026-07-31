// The family-home surface's DURABLE sync state (see paths.ts HOME_STATE_PATH). Unlike the
// checklist store this has a SINGLE writer -- the home surface's own tick loop -- so a plain
// atomic temp+rename write is enough; no proper-lockfile. Everything here must survive a
// crash/restart, which is the whole point of persisting it rather than holding it in memory:
//
//  - appliedThrough      highest intent id durably applied. Persisted PER-INTENT (not per
//                        batch) so a crash duplicates at most one idempotent check/uncheck.
//  - publishedVersion    digest of the view core last SUCCESSFULLY published (a 200). Used to
//                        omit the view when unchanged, and to detect DO state loss via the
//                        echoed version. Never the digest of a body that was merely sent
//                        (a 413/429/dropped body is not "accepted").
//  - oversizedProjectsDigest / projectsLatchAt   the 413 latch: while a freshly-built
//                        `projects` array digests to this, publish with `projects: []` instead
//                        of re-sending the oversized body. Re-probed hourly (projectsLatchAt).
//  - pubFatalVersion / pubFatalAt   the doubly-413 latch: set when even a `projects: []` view
//                        was rejected (lists themselves overflow). Drain-only (view omitted)
//                        until the built view's version changes or the hourly re-probe.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { HOME_STATE_PATH } from "./paths.ts";

export interface HomeState {
  appliedThrough: number;
  publishedVersion: string | null;
  oversizedProjectsDigest: string | null;
  projectsLatchAt: number | null;
  pubFatalVersion: string | null;
  pubFatalAt: number | null;
}

export function freshState(): HomeState {
  return { appliedThrough: 0, publishedVersion: null, oversizedProjectsDigest: null, projectsLatchAt: null, pubFatalVersion: null, pubFatalAt: null };
}

// Read the state, tolerating a missing OR malformed file (fall back to fresh -- a corrupt
// cursor must not wedge the surface; the worst case is re-publishing + redelivering
// idempotent taps). Missing fields are backfilled from freshState so an older on-disk shape
// upgrades cleanly.
export function loadState(path: string = HOME_STATE_PATH): HomeState {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return freshState();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HomeState> | null;
    if (!parsed || typeof parsed !== "object") return freshState();
    return { ...freshState(), ...parsed };
  } catch {
    return freshState();
  }
}

export function saveState(state: HomeState, path: string = HOME_STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
