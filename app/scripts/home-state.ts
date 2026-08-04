// The family-home surface's DURABLE sync state (see paths.ts HOME_STATE_PATH). Unlike the
// checklist store this has a SINGLE writer -- wireLink's onIntent (home-mirror.ts) -- so a
// plain atomic temp+rename write is enough; no proper-lockfile. The one field left:
//
//  - appliedThrough      highest intent id durably applied. Persisted PER-INTENT (not per
//                        batch) so a crash duplicates at most one idempotent check/uncheck.
//                        Read by wireLink's onIntent (advance+persist+ack) and by
//                        home-bot.ts's `appliedThrough` getter (the cursor a fresh `hello`
//                        reports on every connect/reconnect).
//
// D1 (the transport flip's final task) retired the HTTP poll path (runSyncTick and the
// request/response publish cycle it drove) that the other five fields this file used to
// carry existed for: `publishedVersion` (omit-when-unchanged + DO-state-loss detection over
// the poll's echoed version -- both now live on the link's `hello`/`view` exchange instead,
// see home-mirror.ts's wireLink comment on why that's NOT the same guarantee as this field
// used to be), and the `oversizedProjectsDigest`/`projectsLatchAt`/`pubFatalVersion`/
// `pubFatalAt` 413-latch machinery (no `413` exists on the link path to latch against --
// see the transport design's §9 on what simplifies). Dropped outright per the clean-cutover
// policy (pre-production, single operator): `loadState` backfills missing fields from
// `freshState()`, so an on-disk file still carrying the old shape loads fine, its now-unused
// extra keys simply along for the ride and never read.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { HOME_STATE_PATH } from "./paths.ts";

export interface HomeState {
  appliedThrough: number;
}

export function freshState(): HomeState {
  return { appliedThrough: 0 };
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
