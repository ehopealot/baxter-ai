#!/usr/bin/env node
// The family-home surface driver (spec §2). A long-running process, gated by the `home`
// token in BAXTER_SURFACES (compose profile) -- deliberately NOT in-process with the agent
// and NOT tied to Discord, so the web page works on a tenant that runs no other surface.
//
// Owns the lifecycle of a single persistent HomeLink (home-link.ts) wired to the checklist
// store via wireLink (home-mirror.ts): the signed WS connect (signedLinkConnect below), the
// checklist-dir fs.watch that triggers wireLink's checkForChanges, and liveness. D1 retired
// the old POST /api/sync poll loop (runSyncTick) this replaced -- the link is now the sole
// core->DO channel. A tap NEVER wakes an LLM run -- there are no model calls here or in
// home-link.ts/home-mirror.ts.
import { AwsClient } from "aws4fetch";
import { watch, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { HomeLink } from "./home-link.ts";
import type { WebSocketLike } from "./home-link.ts";
import { loadHomeKeys, wireLink, loadState } from "./home-mirror.ts";
import type { HomeKeys, WiredLink } from "./home-mirror.ts";
import { CHECKLISTS_PATH, HOME_STATE_PATH } from "./paths.ts";
import { log, logErr } from "./runtime.ts";

// Keep the process ALIVE (event loop non-empty) without doing anything. "Idle" must mean a
// live-but-quiet container, NOT an exited one: under compose's `restart: unless-stopped`,
// returning from main() exits the process (the log shipper's flush timer -- log-shipper.ts,
// via runtime.ts -- is unref'd, so nothing else holds the loop) and Docker restart-loops it,
// re-logging the idle line / re-firing the fatal alert once a minute forever. A ref'd timer
// parks us instead. (The unprovisioned + fatal-config paths idle this way; the operator
// fixes the cause and restarts the surface.)
function idleForever(): void { setInterval(() => {}, 2 ** 31 - 1); }

// Build the connect() HomeLink drives: a fresh SigV4-signed GET "upgrade" per dial. The
// signature MUST be signed fresh on every call (not once at construction) -- x-amz-date
// has a ±15-min skew window (workers/home/src/verify.ts's MAX_SKEW_MS), and a pre-signed
// header would go stale across a long-lived process's eventual reconnects. That's why this
// returns a closure that signs INSIDE itself, and why home-link.ts's HomeLinkDeps.connect
// now accepts an async return (see that file's B4 commit) rather than this file trying to
// sign synchronously -- reimplementing SigV4 by hand to dodge the await would duplicate
// aws4fetch's canonicalization outside the one library both this container and the DO
// already trust (see verify.ts's own header comment on why re-deriving SigV4 is a mistake
// made once already).
//
// Same credential + service ("home") the retired /api/sync poll path used -- NOT "s3"
// (aws4fetch canonicalizes differently per service; see workers/home/src/verify.ts's header
// comment) -- against
// wss://<endpoint host>/svc/<tenant>/link, the Authorization-header SigV4 path (not query
// presign), matching workers/home/src/object.ts's linkUpgrade -> linkRefusal -> verifySync,
// which re-signs and compares against the EXACT request URL it receives (index.ts forwards
// /svc/<id>/... completely unmodified -- see that file's own comment on why that's load-
// bearing). No body on a GET (verifySync/aws4fetch forbid a body on GET/HEAD, and the
// payload-hash check falls back to hashing "" either way -- see linkRefusal's comment), so
// SignedHeaders stays `host;x-amz-date`, same as the sync path.
//
// `makeSocket` is an injectable seam (default: the Node 22 global WebSocket, undici 6.24.1,
// which accepts `{headers}` -- confirmed; do NOT add the `ws` package) so tests can capture
// the signed (url, headers) a dial would use without opening a real socket.
export function signedLinkConnect(
  keys: HomeKeys,
  makeSocket: (url: string, headers: Record<string, string>) => WebSocketLike =
    (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike,
): () => Promise<WebSocketLike> {
  const aws = new AwsClient({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: "auto", service: "home" });
  const linkUrl = `${keys.endpoint.replace(/\/+$/, "")}/svc/${keys.tenant}/link`;
  const wssUrl = linkUrl.replace(/^http/, "ws"); // https -> wss, http -> ws
  return async () => {
    // Signed HERE, per call -- see this function's header comment.
    const signed = await aws.sign(linkUrl, { method: "GET" });
    const headers: Record<string, string> = {
      authorization: signed.headers.get("authorization") ?? "",
      "x-amz-date": signed.headers.get("x-amz-date") ?? "",
    };
    return makeSocket(wssUrl, headers);
  };
}

// How long to fold repeated fs.watch events for one on-disk change into a single
// checkForChanges() call. checklist-store.ts's mutate() writes via a tmp file + rename
// (not an in-place write), which typically fires the directory watch twice per mutation
// (the tmp file's own create, then the rename); wireLink's checkForChanges is naturally
// idempotent (it only sends when the digest actually moved), so this debounce is a
// courtesy against redundant rebuilds, not a correctness requirement. Exported so tests
// can compute boundaries off this value rather than a copied literal.
export const WATCH_DEBOUNCE_MS = 200;

// Re-anchor the process's liveness with a dedicated ref'd fallback timer, kept separate
// from the unprovisioned idle() path (different cause -- the watch is gone, not the whole
// surface unprovisioned -- same "stay up" outcome). Used both when watch() fails
// synchronously (below) and when an already-running watcher dies via its own 'error' event
// (watchChecklistStore's watcher.on("error", ...) below) -- see main()'s comment on why
// this watcher's open fs handle is what actually keeps a standalone home-bot process alive
// between HomeLink's own (deliberately unref'd) timers.
function keepAliveFallback(): ReturnType<typeof setInterval> {
  return setInterval(() => {}, 2 ** 31 - 1);
}

// Watch the checklist store for changes and call onChange (leading-edge folded, see
// WATCH_DEBOUNCE_MS). Watches the store's DIRECTORY, not the file itself, and filters by
// basename: fs.watch on a file that gets replaced via rename (exactly what mutate() does)
// is unreliable across the swap on Linux (the watch descriptor is tied to the original
// inode) -- watching the directory and matching the filename survives both the rename-swap
// and the file not existing yet (mkdir'd defensively below, mirroring checklist-store.ts's
// own ensureFile so a brand-new tenant with zero checklists still gets a working watch).
// Also filters out the proper-lockfile lock artifacts and mutate()'s own `.tmp` siblings
// that live in the same directory, so those don't trigger a spurious checkForChanges.
//
// `watchFn`/`logErrFn` are injectable seams (default: the real `node:fs` watch / this
// file's logErr) so tests can drive the watcher's own error handling directly, rather than
// only through main()'s higher-level `watchChecklists` HomeBotDeps field (which every other
// test in this file replaces wholesale).
export function watchChecklistStore(
  path: string,
  onChange: () => void,
  watchFn: typeof watch = watch,
  logErrFn: (m: string) => void = logErr,
): { close(): void } {
  const dir = dirname(path);
  const name = basename(path);
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Shared by BOTH failure paths below (synchronous setup failure, and the watcher's own
  // async 'error') so a single close() can always clear whichever fallback is currently
  // live -- see each site's own comment for why de-duping/clearing matters.
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  // Gates BOTH handlers below -- the 'change' callback and the 'error' listener (fix round
  // 3, fix B; fix round 4 extends the SAME flag to 'change') -- against an event arriving
  // after close(). Neither fs.watch's raw listener nor an EventEmitter's 'error' is
  // suppressed by close(): the FSWatcher doesn't detach listeners or drop already-queued
  // events just because the caller tore it down. Without this, "close() means torn down"
  // would hold for the fallback-interval half of this function (round 3) but not the
  // debounced-onChange half -- a change within WATCH_DEBOUNCE_MS of close(), or one that
  // arrives after, could still call onChange() up to WATCH_DEBOUNCE_MS post-close. Declared
  // before watchFn() is called (not merely before first use -- no TDZ issue either way,
  // since both callbacks only ever run asynchronously) so the ordering reads as the single
  // teardown contract it is, not two independently-timed patches.
  let closed = false;
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watchFn(dir, (_event, filename) => {
      if (closed) return; // torn down on purpose -- see the `closed` flag's comment above
      // A null filename (platform-dependent) can't be filtered -- treat it as a possible
      // change rather than silently drop it; the debounce below still bounds the cost, and
      // checkForChanges is a no-op when nothing actually moved.
      if (filename !== null && filename !== name) return;
      if (timer !== null) return; // leading-edge: a call is already pending, fold this one in
      timer = setTimeout(() => { timer = null; onChange(); }, WATCH_DEBOUNCE_MS);
      timer.unref?.();
    });
    // An ASYNC watcher error (inotify exhaustion, the watched directory vanishing, ...) is
    // NOT the same failure as the synchronous setup failure the catch below handles -- with
    // no listener here it's either an uncaughtException (Node emits 'error' on an
    // EventEmitter with no listener as a thrown exception) or, worse, a silent process exit
    // the moment this FSWatcher -- the process's sole liveness anchor between HomeLink's own
    // unref'd timers -- goes away out from under a live-but-reconnecting link.
    watcher.on("error", (err: Error) => {
      if (closed) return; // torn down on purpose -- see the `closed` flag's comment above
      logErrFn(`home: checklist-store watch died (${err.message}) -- local edits won't push a 'changed' notice until restart`);
      // De-dupe: a watcher can keep emitting 'error' (e.g. a directory that stays gone),
      // and each occurrence used to start its OWN interval -- every one permanently ref'd,
      // stacking one leaked fallback timer per emission. Only the first needs to re-anchor.
      if (keepAlive === null) keepAlive = keepAliveFallback();
    });
    // close() must clear keepAlive AND the pending debounce timer, not just the watcher --
    // both are captured by reference (`let`s, not per-branch consts), so this sees whatever
    // either handler above set, even if it fired after this function returned but before
    // close() was called. The `closed = true` above also stops either handler from doing
    // any further work from this point on, closing the "close() means torn down" contract
    // for both halves of this function symmetrically.
    return { close: () => {
      closed = true;
      watcher.close();
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (keepAlive !== null) clearInterval(keepAlive);
    } };
  } catch (err) {
    logErrFn(`home: could not watch the checklist store (${(err as Error).message}) -- local edits won't push a 'changed' notice until the next reconnect`);
    keepAlive = keepAliveFallback();
    return { close: () => { if (keepAlive !== null) clearInterval(keepAlive); } };
  }
}

// Injected surface for tests (mirrors B1/B2's fake-`connect` style). Production defaults
// live in `main`'s call below; every field here is overridable so a test can fake keys,
// capture the signed connect's inputs without a real socket, or drive the watcher
// deterministically instead of waiting on real fs timing.
export interface HomeBotDeps {
  loadHomeKeys: () => HomeKeys;
  checklistsPath: string;
  statePath: string;
  env: NodeJS.ProcessEnv;
  makeSocket?: (url: string, headers: Record<string, string>) => WebSocketLike;
  watchChecklists: (path: string, onChange: () => void) => { close(): void };
  idle: () => void;
  log: (m: string) => void;
  logErr: (m: string) => void;
}

function defaultDeps(): HomeBotDeps {
  return {
    loadHomeKeys: () => loadHomeKeys(),
    checklistsPath: CHECKLISTS_PATH,
    statePath: HOME_STATE_PATH,
    env: process.env,
    watchChecklists: watchChecklistStore,
    idle: idleForever,
    log,
    logErr,
  };
}

export async function main(deps: HomeBotDeps = defaultDeps()): Promise<void> {
  let keys: HomeKeys;
  try {
    keys = deps.loadHomeKeys();
  } catch (err) {
    // Absent credential -> log once and idle (do NOT crash the container). A malformed file
    // is treated the same way: idle loudly rather than crash-loop the surface.
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") deps.log("home: no home-keys.json -- family-home surface idle (provision with `baxctl home <id>`)");
    else deps.logErr(`home: home-keys.json unreadable (${e.message}) -- family-home surface idle until it's fixed`);
    deps.idle();
    return;
  }

  // Everything from here through the watch setup reads the checklist store synchronously
  // (wireLink's initial digest below) -- a malformed/unreadable store (readChecklists
  // tolerates ENOENT only; a corrupt JSON file, EACCES, EIO all rethrow -- checklist-
  // store.ts) must idle the surface the same loud way an unreadable home-keys.json does
  // above, NOT crash-loop the container. The OLD poll loop wrapped every tick in try/catch
  // for exactly this reason (home-mirror.ts's tick() driver: logErr + backoff, process
  // stays up); this is that same containment, applied to startup.
  try {
    // `wired` is referenced by the getters below before it exists: HomeLink needs the
    // getters at construction time, but wireLink needs the constructed `link`. A `let`
    // forward reference is safe because the getters are only ever INVOKED at connect time
    // (HomeLink._onOpen, on the first connect and every reconnect), always after `wired`
    // has been assigned just below.
    let wired!: WiredLink;
    const link = new HomeLink({
      connect: signedLinkConnect(keys, deps.makeSocket),
      // Both getters run inside HomeLink's own open-handling (_onOpen) -- on every connect
      // AND every reconnect, OUTSIDE this try/catch's synchronous scope by the time they
      // fire (an exception thrown from an async event callback is not caught by an
      // enclosing try/catch from an earlier tick). Each needs its own guard: a throw here
      // means the store/state file went bad SOMETIME AFTER startup succeeded (e.g. a
      // mid-run permissions change), not the at-startup case the outer try/catch covers.
      // Both fallbacks are protocol-legal and safe -- a null viewVersion just makes the DO
      // issue a pull, and appliedThrough:0 just makes it redeliver from the start, the
      // same idempotent tolerance the retired poll path's own 409 handling relied on.
      viewVersion: () => { try { return wired.currentVersion(); } catch { return null; } },
      appliedThrough: () => { try { return loadState(deps.statePath).appliedThrough; } catch { return 0; } },
    });
    wired = wireLink(link, {
      checklistsPath: deps.checklistsPath,
      statePath: deps.statePath,
      // v1 ships lists-only: projects are stubbed (spec §4), same as the old poll path.
      buildProjects: () => [],
      env: deps.env,
      logErr: deps.logErr,
    });

    link.start();

    // Push a 'changed' notice whenever the store moves locally (a CLI/Discord-mirror edit
    // -- NOT the tap path, which arrives as an inbound `intent` and is already handled by
    // wireLink's onIntent).
    //
    // Deliberately NOT idleForever() on this path -- but the process staying alive is NOT
    // owed to HomeLink's own timers: its heartbeat/reconnect/hbAck timers are all unref'd
    // (home-link.ts -- "a live link must never be the reason the process can't exit",
    // written for a link sharing a process with Discord/mail/etc). This surface is
    // standalone (see this file's header), so what actually refs the event loop through
    // every window -- connected, mid-handshake, and backing off between redials alike -- is
    // THIS watcher: a real fs.watch() FSWatcher refs the loop by default (not unref'd
    // here), so it alone keeps the process live end to end. If watchChecklists ever
    // degrades to a fallback timer (its catch/'error' handling), that guarantee is carried
    // by the fallback instead; see watchChecklistStore's own comments.
    deps.watchChecklists(deps.checklistsPath, () => {
      // A failed change-check (the store going bad mid-run, same class of failure as the
      // getters above) must not crash the surface -- swallow + log loudly, matching the
      // old poll loop's per-tick containment.
      try {
        wired.checkForChanges();
      } catch (err) {
        deps.logErr(`home: store-change check failed: ${(err as Error).message}`);
      }
    });

    deps.log(`home: family-home surface up (tenant ${keys.tenant}) -> ${keys.endpoint}`);
  } catch (err) {
    // Source-agnostic on purpose: this try spans signedLinkConnect/HomeLink construction,
    // wireLink's initial store read, link.start(), and the watch wiring -- NOT only the
    // checklist store. loadHomeKeys only truthy-checks fields (home-mirror.ts), so e.g. a
    // non-string `endpoint` passes that check and only throws later, inside
    // signedLinkConnect's `keys.endpoint.replace(...)` -- a hardcoded "checklist store
    // unreadable" claim here would send the operator debugging the wrong file. Report the
    // real error message and let it speak for itself.
    deps.logErr(`home: family-home surface failed to start (${(err as Error).message}) -- idle until it's fixed`);
    deps.idle();
  }
}

// Only run the daemon when executed directly, not when a test imports main/
// signedLinkConnect (same guard shape as discord-bot.ts/voice-bot.ts).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { logErr(`home: fatal: ${(err as Error).message}`); process.exit(1); });
}
