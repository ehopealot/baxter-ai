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
import { watch, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { HomeLink } from "./home-link.ts";
import type { WebSocketLike } from "./home-link.ts";
import { loadHomeKeys, wireLink, loadState } from "./home-mirror.ts";
import type { HomeKeys, WiredLink } from "./home-mirror.ts";
import { mutate } from "./checklist-store.ts";
import { loadAllowlist, writeAllowlist, isSafeVersion, parseNames } from "./allowlist.ts";
import { loadCalendarFeeds, writeCalendarFeeds } from "./calendar-feeds.ts";
import { recipesIndexVersion, signedRecipesLinkConnect, watchRecipes } from "./recipes-mirror.ts";
import { listRecipes, readRecipe } from "./recipes-store.ts";
import {
  buildCalendarView, calendarViewVersion, watchCalendar, signedCalendarLinkConnect, isCalendarRefresh, calendarRefreshFeedUrls,
} from "./calendar-mirror.ts";
import type { CalendarViewDeps } from "./calendar-mirror.ts";
import { performPoll, feedUrls } from "./calendar-cli.ts";
import type { FetchLike } from "./calendar-cli.ts";
import { envInt } from "./schedule-store.ts";
import {
  CHECKLISTS_PATH, HOME_STATE_PATH, ALLOWLIST_PATH, CALENDAR_FEEDS_PATH, RECIPES_DIR,
  CALENDAR_EVENTS_PATH, CALENDAR_CACHE_PATH,
} from "./paths.ts";
import { log, logErr, flushLogs } from "./runtime.ts";

// Keep the process ALIVE (event loop non-empty) without doing anything. "Idle" must mean a
// live-but-quiet container, NOT an exited one: under compose's `restart: unless-stopped`,
// returning from main() exits the process (the log shipper's flush timer -- log-shipper.ts,
// via runtime.ts -- is unref'd, so nothing else holds the loop) and Docker restart-loops it,
// re-logging the idle line / re-firing the fatal alert once a minute forever. A ref'd timer
// parks us instead. (The unprovisioned + fatal-config paths idle this way; the operator
// fixes the cause and restarts the surface.)
function idleForever(): void { setInterval(() => {}, 2 ** 31 - 1); }

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const h = setInterval(fn, ms);
  return () => clearInterval(h);
};

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
// wss://<tenant-scoped endpoint>/link (the endpoint already ends in /svc/<id>), the Authorization-header SigV4 path (not query
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
  // keys.endpoint is ALREADY tenant-scoped -- baxctl writes it as https://home.<domain>/svc/<id>
  // (the same value the old poll path appended "/api/sync" to). So the link appends just "/link".
  // Appending "/svc/<tenant>" here doubles it -> https://.../svc/<id>/svc/<id>/link -> the DO's
  // /svc/<id>/ router sees sub="svc/<id>/link" (not "link"), never matches linkUpgrade, 404s the
  // upgrade, and the container silently reconnect-loops while home serves an ever-staler view.
  const linkUrl = `${keys.endpoint.replace(/\/+$/, "")}/link`;
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

// Apply a members snapshot the DO pushed down the link. reason:"sync" is the connect-time
// authoritative push and is applied UNCONDITIONALLY -- it must win even if the file's persisted
// version is higher (the DO-storage-wipe case, where the DO reseeds below the file). reason:
// "mutation" is a live edit and is applied only if version > what we already wrote (idempotent
// redelivery within a connection). On apply, writeAllowlist persists it and onApplied() fires a
// view republish so View.recipients (the login allow-list) goes back up the link immediately.
// Never throws: a malformed frame is logged and dropped.
export function applyMembersCommand(
  payload: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  onApplied: () => void,
  logErrFn: (m: string) => void = logErr,
): void {
  try {
    const s = payload as { senders?: unknown; recipients?: unknown; version?: unknown; reason?: unknown };
    // isSafeVersion (allowlist.ts -- shared with loadAllowlist's own version coercion, so the
    // read and write sides of the version contract can't drift apart), not typeof === "number":
    // a bare typeof check admits NaN, Infinity, and huge-but-finite doubles, same class of gap
    // isSafeId (home-link.ts) guards against on the wire ids. Consequences if admitted here: NaN
    // fails the mutation staleness gate open (`NaN <= x` is always false), and writeAllowlist
    // would then persist `"version": null` (JSON.stringify of a non-finite number), which
    // loadAllowlist coerces back to 0 on the next read -- silently defeating the
    // never-seed-below-the-file guarantee. A finite-but-absurd value (e.g. 1e300) would instead
    // wedge every later legitimate mutation (`<=` always true) until the next reconnect sync
    // heals it. The `>= 0` half matches the version-0 seed floor -- a negative version can never
    // be legitimate.
    if (!Array.isArray(s.senders) || !Array.isArray(s.recipients) ||
        !isSafeVersion(s.version) ||
        (s.reason !== "sync" && s.reason !== "mutation")) {
      logErrFn("home: ignoring malformed members command payload");
      return;
    }
    // The "last applied" version comes from loadAllowlist(env, path).version -- the file's own
    // version, or 0 when the file is absent/corrupt (loadAllowlist falls back to the env seed,
    // whose version is 0). A corrupt file therefore reads as version 0, so ANY mutation beats it
    // and re-establishes a good file -- benign, deliberate; do not "fix" this to preserve a
    // corrupt file's unreadable version.
    if (s.reason === "mutation" && s.version <= loadAllowlist(env, path).version) return; // stale/equal -> no-op
    writeAllowlist({
      senders: s.senders.filter((x): x is string => typeof x === "string"),
      recipients: s.recipients.filter((x): x is string => typeof x === "string"),
      version: s.version,
      // The DO's address -> name map (deriveSnapshot), persisted so mail/SMS/home can
      // attribute who is writing. Sanitized to string->string; a payload without it (older
      // DO) yields {}. Not a security gate -- senders/recipients still decide access.
      names: parseNames((s as { names?: unknown }).names),
    }, path);
    onApplied();
  } catch (err) {
    logErrFn(`home: applying members command failed: ${(err as Error).message}`);
  }
}

// Apply a calendar-feeds snapshot the DO pushed down the link (payload.kind ===
// "calendar-feeds"). Same shape of guard + staleness gate as applyMembersCommand:
// reason:"sync" (connect-time) always applies -- the DO is authoritative, incl. the storage-
// wipe case where it reseeds below our file; reason:"mutation" applies only if version >
// what we already wrote (idempotent redelivery within a connection). isSafeVersion (shared
// with the read side) rejects NaN/Infinity/negative/fractional so a poisoned version can't
// wedge the gate. Errors are swallowed+logged (same as applyMembersCommand): a bad frame
// must not take the surface down.
export function applyCalendarFeedsCommand(payload: unknown, path: string, logErrFn: (m: string) => void): void {
  try {
    const s = payload as { urls?: unknown; version?: unknown; reason?: unknown };
    if (!Array.isArray(s.urls) || !isSafeVersion(s.version) || (s.reason !== "sync" && s.reason !== "mutation")) {
      logErrFn("home: ignoring malformed calendar-feeds command payload");
      return;
    }
    if (s.reason === "mutation" && s.version <= loadCalendarFeeds(path).version) return; // stale/equal -> no-op
    writeCalendarFeeds({ urls: s.urls.filter((x): x is string => typeof x === "string"), version: s.version }, path);
  } catch (err) {
    logErrFn(`home: applying calendar-feeds command failed: ${(err as Error).message}`);
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
  allowlistPath: string; // forwarded into wireLink AND used by applyMembersCommand/config; default ALLOWLIST_PATH; injectable for hermetic tests
  calendarFeedsPath: string; // forwarded to applyCalendarFeedsCommand; default CALENDAR_FEEDS_PATH; injectable for tests
  // Recipes mirror (home-recipes plan, Task C1): a SECOND HomeLink connection, over its
  // own dedicated socket -- mirrors checklistsPath/watchChecklists/makeSocket above, one
  // field per role. recipesDir defaults to RECIPES_DIR; injectable so tests never touch
  // the real state dir. makeRecipesSocket is DELIBERATELY separate from makeSocket (not
  // reused) -- reusing it would attach BOTH HomeLink instances to the same fake wire in
  // any test that sets makeSocket to a constant stub, cross-wiring the checklist and
  // recipes links' messages onto each other.
  recipesDir: string;
  makeRecipesSocket?: (url: string, headers: Record<string, string>) => WebSocketLike;
  watchRecipes: (dir: string, onChange: () => void) => { close(): void };

  // Calendar mirror (home-calendar plan, Task C2): a THIRD HomeLink connection, over its
  // own dedicated socket -- one field per role, mirroring the recipes fields above.
  // calendarEventsPath/calendarCachePath default to CALENDAR_EVENTS_PATH/CALENDAR_CACHE_PATH;
  // injectable so tests never touch the real state dir. makeCalendarSocket is DELIBERATELY
  // separate from makeSocket/makeRecipesSocket (not reused) -- see makeRecipesSocket's own
  // comment for why sharing one fake wire across links cross-delivers their messages.
  // `fetch` is the injectable seam performPoll's onCommand handler uses (default: the real
  // global fetch) so tests never hit the network.
  calendarEventsPath: string;
  calendarCachePath: string;
  makeCalendarSocket?: (url: string, headers: Record<string, string>) => WebSocketLike;
  watchCalendar: (ownPath: string, cachePath: string, onChange: () => void) => { close(): void };
  calendarPollIntervalMs: number;
  scheduleCalendarPoll?: (fn: () => void, intervalMs: number) => () => void;
  fetch: FetchLike;
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
    allowlistPath: ALLOWLIST_PATH,
    calendarFeedsPath: CALENDAR_FEEDS_PATH,
    recipesDir: RECIPES_DIR,
    watchRecipes,
    calendarEventsPath: CALENDAR_EVENTS_PATH,
    calendarCachePath: CALENDAR_CACHE_PATH,
    watchCalendar,
    calendarPollIntervalMs: (() => {
      // envInt throws on a non-integer/negative value; home-bot's contract is to idle loudly
      // on bad config (not crash-loop under compose's restart:unless-stopped), so degrade to
      // poll-disabled + log. Clamp to 2^31-1 ms: anything larger overflows setInterval's
      // 32-bit signed delay (Node clamps out-of-range delays to 1ms -> hot-spin).
      try { return Math.min(envInt("CALENDAR_POLL_INTERVAL_SECONDS", 3600) * 1000, 2147483647); }
      catch (err) { logErr(`home: CALENDAR_POLL_INTERVAL_SECONDS invalid (${(err as Error).message}); calendar auto-poll disabled`); return 0; }
    })(),
    fetch: fetch as FetchLike,
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
  // B4: hoisted above the try block (not `const` inside it) so the catch below can reach
  // it. Without this, a throw AFTER link.start() succeeds -- e.g. the watch wiring a few
  // lines down -- left the already-dialing/redialing link with nothing to stop it: the
  // process "idles" while the link keeps trying forever underneath. `link.stop()` in the
  // catch (guarded, since a throw BEFORE `new HomeLink(...)` -- e.g. a bad home-keys field
  // reaching signedLinkConnect at construction -- leaves this still undefined) makes the
  // catch's implicit claim ("nothing is still running") true by construction.
  let link: HomeLink | undefined;
  // Recipes mirror (home-recipes plan, Task C1): hoisted alongside `link` for the same
  // reason -- see the comment above `let link` for the full B4 rationale (unchanged here,
  // just a second HomeLink instance).
  let recipesLink: HomeLink | undefined;
  // Calendar mirror (home-calendar plan, Task C2): hoisted alongside `link`/`recipesLink`
  // for the same B4 reason -- see the comment above `let link` for the full rationale.
  let calendarLink: HomeLink | undefined;
  // The recurring calendar-poll scheduler's clearer, retained so the catch below can tear
  // it down (the same B4 "nothing still running after the catch" contract the links satisfy
  // via their own ?.stop()). Only assigned when calendarPollIntervalMs > 0.
  let cancelCalendarPoll: (() => void) | undefined;
  try {
    // Persist the store's id backfill BEFORE the first buildView, exactly as reconcile does
    // (checklist-store.ts mutate() mints an id for any record written before `id` existed).
    // buildView now reads l.id (ViewList.id, for identity-keyed delete-list -- review 95e17d3),
    // and it reads from a raw readChecklists() that does NOT backfill; without this a legacy
    // id-less list would publish with no id, so a delete tap couldn't form a valid listId and
    // would be silently dropped. A no-op mutate through the lock does the backfill + persist.
    // Inside the try so a corrupt/unreadable store idles the surface the same loud way the
    // header comment describes, rather than crash-looping.
    await mutate(deps.checklistsPath, (lists) => ({ lists, value: null }));

    // `wired` is referenced by the getters below before it exists: HomeLink needs the
    // getters at construction time, but wireLink needs the constructed `link`. A `let`
    // forward reference is safe because the getters are only ever INVOKED at connect time
    // (HomeLink._onOpen, on the first connect and every reconnect), always after `wired`
    // has been assigned just below.
    let wired!: WiredLink;
    link = new HomeLink({
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
      // B1 belt-and-braces: HomeLink's own per-message dispatch containment logs
      // through this when a callback throws (see home-link.ts's _onMessage).
      logErr: deps.logErr,
      // Read fresh on every (re)connect, like the two getters above. Reports the file's OWN
      // membership/version via loadAllowlist's read chain (file when present&parseable, else the
      // env seed, whose version is 0) -- deliberately NOT the raw ALLOWED_* env vars and WITHOUT
      // the read-time OPERATOR_EMAIL union View.recipients applies, so a reseeded DO adopts live
      // file membership, not a stale env snapshot or a doubly-unioned operator address.
      // operatorEmail is omitted entirely when unset -- a home-only tenant with no mail surface
      // is legal (spec-delta B), and an empty string would wrongly tell the DO "there IS an
      // operator, and it's blank."
      config: () => {
        const a = loadAllowlist(deps.env, deps.allowlistPath);
        const op = (deps.env.OPERATOR_EMAIL || "").trim();
        // operatorName (optional): the operator's display name for the DO's protected member
        // (seedMembers). Omitted when unset -- an empty string would seed a blank name. Does
        // NOT affect membership/version, only the display label, so it rides the config like
        // operatorEmail without changing recipients.
        const opName = (deps.env.OPERATOR_NAME || "").trim();
        return { senders: a.senders, recipients: a.recipients, version: a.version, ...(op ? { operatorEmail: op } : {}), ...(opName ? { operatorName: opName } : {}) };
      },
    });
    wired = wireLink(link, {
      checklistsPath: deps.checklistsPath,
      statePath: deps.statePath,
      // v1 ships lists-only: projects are stubbed (spec §4), same as the old poll path.
      buildProjects: () => [],
      env: deps.env,
      logErr: deps.logErr,
      allowlistPath: deps.allowlistPath,
    });

    // The DO's authoritative members snapshot, pushed down as a `command` frame -- see
    // applyMembersCommand's own header comment for the sync/mutation apply rule. On apply,
    // re-run checkForChanges() so View.recipients (built fresh off the allowlist file each
    // time, via recipientsFromEnv) republishes with the new membership immediately, not just
    // on the next local checklist edit or reconnect.
    link.onCommand((payload) => {
      // Discriminate command kinds on the one link socket. The members push carries NO `kind`
      // (unchanged), so anything that isn't explicitly "calendar-feeds" routes to members.
      if ((payload as { kind?: unknown })?.kind === "calendar-feeds") {
        applyCalendarFeedsCommand(payload, deps.calendarFeedsPath, deps.logErr);
        return;
      }
      applyMembersCommand(
        payload, deps.env, deps.allowlistPath,
        () => { try { wired.checkForChanges(); } catch (err) { deps.logErr(`home: republish after members command failed: ${(err as Error).message}`); } },
        deps.logErr, // keep the 5th logErrFn arg the current call passes -- the deps-injection contract hermetic tests rely on
      );
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

    // ---------- recipes link (home-recipes plan, Task C1) ----------
    //
    // A SECOND HomeLink connection in this SAME daemon, over its own dedicated
    // /recipes-link socket -- see recipes-mirror.ts's own header for the "why fold into
    // home-bot.ts rather than a new surface" rationale. Read-only: no onIntent
    // registration at all (recipes never receive down-link intents -- there is nothing
    // for one to mean). `makeRecipesSocket` is a SEPARATE seam from `makeSocket` above
    // (see HomeBotDeps' own comment) so the two links never share one fake wire in tests.
    recipesLink = new HomeLink({
      connect: signedRecipesLinkConnect(keys, deps.makeRecipesSocket),
      // Guarded the same way the checklist link's own viewVersion getter is (a throw here
      // means the recipes dir went bad SOMETIME AFTER startup, e.g. a mid-run permissions
      // change) -- falls back to null, which just makes the DO issue an index pull.
      viewVersion: () => { try { return recipesIndexVersion(listRecipes(deps.recipesDir)); } catch { return null; } },
      // Ignored entirely by the worker's reduceHello for this channel -- recipes carry no
      // down-direction intent to redeliver, so there is no cursor for this to mean
      // anything about (see recipes-link.ts's own reduceHello comment, worker side). A
      // fixed 0 is exactly as meaningful as any other integer here.
      appliedThrough: () => 0,
      logErr: deps.logErr,
    });

    // scope:"index" (or absent -- never sent by this read-only channel's own peer, but
    // treated the same as the checklist link treats an absent scope) answers with the
    // summary list; scope:"recipe" answers with one recipe's detail, keyed by slug. `lists:
    // []` is REQUIRED filler, not dead weight -- the worker's shared decode() validates
    // EVERY non-null `view` frame by requiring `Array.isArray(view.lists)` (see
    // chat-bot.ts's own onPull for the identical filler and the same reason). The
    // recipe-scoped reply's `slug` argument to sendView is LOAD-BEARING, not cosmetic --
    // see home-link.ts's ViewMsg.slug/sendView comments: object.ts's pendingRecipesPulls
    // matches a per-recipe waiter by that echoed slug, not by inReplyTo alone.
    recipesLink.onPull((pullId, scope, _chatId, slug) => {
      try {
        if (scope === "recipe" && slug) {
          recipesLink!.sendView(pullId, { lists: [], recipe: readRecipe(slug, deps.recipesDir) }, "", undefined, slug);
        } else {
          // M2 (review fix): read the index ONCE and reuse it for both the payload and
          // its digest -- the previous two-call version (listRecipes(...) here, then
          // AGAIN inside recipesIndexVersion(listRecipes(...))) let a concurrent write
          // between the two calls publish a viewVersion that didn't actually match the
          // `recipes` payload it was sent alongside.
          const index = listRecipes(deps.recipesDir);
          recipesLink!.sendView(pullId, { lists: [], recipes: index }, recipesIndexVersion(index));
        }
      } catch (err) {
        // M1 (review fix): a scope:"recipe" pull that lands here means readRecipe/
        // recipePath THREW -- a slug that toSlug-normalizes to empty (recipePath's own
        // "invalid recipe slug" throw) or a corrupt recipe file (JSON.parse's
        // SyntaxError) -- NOT the ENOENT->null path readRecipe already handles itself.
        // Silence here would leave the DO's per-recipe waiter (object.ts's
        // pendingRecipesPulls, matched by the ECHOED SLUG -- see sendView's own comment)
        // hanging for the full PULL_TIMEOUT_MS before 404ing: an authenticated family
        // member could hold DO requests open for ~5s apiece just by hammering
        // /recipes/<garbage-slug>. Reply promptly with recipe:null -- the SAME shape
        // readRecipe's own ENOENT->null fallback gives a legitimately-missing recipe --
        // so the DO 404s immediately instead of timing out. There is no "stale" value to
        // fall back to here the way the index branch below can claim (a failed recipe
        // pull never had a prior recipe to serve), so the log below says so plainly
        // rather than reusing the index branch's "serving stale via DO timeout" wording,
        // which was never true for this branch.
        if (scope === "recipe" && slug) {
          recipesLink!.sendView(pullId, { lists: [], recipe: null }, "", undefined, slug);
          deps.logErr(`home: recipes pull ${pullId} (slug ${slug}) failed -- replied recipe:null: ${(err as Error).message}`);
        } else {
          deps.logErr(`home: recipes pull ${pullId} failed -- serving stale via DO timeout: ${(err as Error).message}`);
        }
      }
    });

    recipesLink.start();

    // Prime the DO with the current index right after connect: hello's own viewVersion
    // mismatch already triggers this (a fresh/reseeded DO's recipesIndexVersion is null,
    // never equal to a real digest -- see recipes-link.ts's reduceHello, worker side, the
    // same mechanism the checklist link and chat-bot.ts's own link rely on to prime
    // without an explicit extra push here), so no separate sendChanged call is needed on
    // startup -- only on a LATER local change, wired via watchRecipes below.
    deps.watchRecipes(deps.recipesDir, () => {
      try {
        recipesLink!.sendChanged(recipesIndexVersion(listRecipes(deps.recipesDir)));
      } catch (err) {
        deps.logErr(`home: recipes sendChanged failed: ${(err as Error).message}`);
      }
    });

    // ---------- calendar link (home-calendar plan, Task C2) ----------
    //
    // A THIRD HomeLink connection in this SAME daemon, over its own dedicated
    // /calendar-link socket -- see calendar-mirror.ts's own header for the "why fold into
    // home-bot.ts rather than a new surface" rationale (identical to recipes'). Unlike
    // recipes (index+pull), this rides the CHECKLIST'S whole-view push transport: onPull
    // answers with the current merged 7-day CalendarView, and a local/family-cache change
    // pushes a `changed` notice via watchCalendar below. Read-only: no onIntent
    // registration (there are no calendar intents) -- but it DOES register onCommand, for
    // the single authenticated `calendar-refresh` request the DO's "Add to calendar" POST
    // sends (spec: "no other down-channel surface").
    const calDeps: CalendarViewDeps = { ownEventsPath: deps.calendarEventsPath, cachePath: deps.calendarCachePath };
    calendarLink = new HomeLink({
      connect: signedCalendarLinkConnect(keys, deps.makeCalendarSocket),
      // Guarded the same way the checklist/recipes links' own viewVersion getters are (a
      // throw here means the own-events store or family cache went bad SOMETIME AFTER
      // startup) -- falls back to null, which just makes the DO issue a pull.
      viewVersion: () => { try { return calendarViewVersion(buildCalendarView(new Date(), calDeps)); } catch { return null; } },
      // Ignored by the worker's reduceHello for this channel, same as the recipes link --
      // calendar carries no down-direction INTENT to redeliver (the refresh command is a
      // one-shot request, not a cursor-tracked queue). A fixed 0 is exactly as meaningful
      // as any other integer here.
      appliedThrough: () => 0,
      logErr: deps.logErr,
    });

    // Answer every pull with the CURRENT merged view (on-demand, no cached copy) --
    // mirrors wireLink's own checklist onPull (home-mirror.ts) exactly, just for the
    // calendar's own builder. Contained the same way: a bad store/cache must not crash the
    // surface over a single pull; log loudly and let the DO's own bounded pull-timeout ->
    // serve-stale-cache degradation (design §7.2) take over instead.
    calendarLink.onPull((pullId) => {
      try {
        const view = buildCalendarView(new Date(), calDeps);
        calendarLink!.sendView(pullId, view, calendarViewVersion(view));
      } catch (err) {
        deps.logErr(`home: calendar pull ${pullId} failed -- serving stale via DO timeout: ${(err as Error).message}`);
      }
    });

    // The calendar-refresh command, startup prime, and recurring scheduler all delegate to
    // this poll. It runs a real feed poll (performPoll, the same helper calendar-cli's own
    // `poll` verb uses), writes the cache atomically (tmp+rename, mirroring calendar-cli's
    // poll -- readers of the cache file never see a half-write), and ONLY overwrites it if
    // at least one feed succeeded -- a transient outage of every feed must not wipe the
    // last-known family calendar out from under the merged view (mirrors calendar-cli's own
    // poll guard). Re-publishes the (possibly refreshed) view afterward either way, so a
    // family member sees SOMETHING move even on a poll that changed nothing.
    let polling = false;
    let queuedOverride: string[] | null = null;
    // overrideUrls: a poll-on-feed-add carries the just-mutated feed URLs in the command
    // payload (see onCommand below) so the poll doesn't race applyCalendarFeedsCommand's
    // write of feeds.json on the separate "link" socket. Undefined (hourly tick, prime,
    // page Refresh button) -> read the configured feeds off disk as before. A refresh that
    // arrives while a poll is in flight is COALESCED -- except an override, which may carry
    // URLs the in-flight poll didn't see (it can have read feeds.json before the new feed's
    // write landed); that is queued and re-polled when the in-flight poll finishes rather
    // than dropped (else a just-added feed waits for the next hourly tick). Last-wins
    // overwriting of queuedOverride is safe because the worker always sends the FULL
    // post-mutation feed list, never a delta (workers/home/src/object.ts).
    const pollCalendarOnce = async (overrideUrls?: string[]): Promise<void> => {
      if (polling) { if (overrideUrls) queuedOverride = overrideUrls; return; }
      polling = true;
      try {
        const urls = overrideUrls ?? feedUrls(deps.calendarFeedsPath);
        const { events, errors } = await performPoll(urls, deps.fetch);
        // EXACTLY calendar-cli's own `poll` verb's guard (calendar-cli.ts): only overwrite
        // when at least one feed succeeded. Deliberately NOT `urls.length === 0 || ...` --
        // zero configured feeds must ALSO skip the write (errors.length(0) < urls.length(0)
        // is already false), matching the CLI's own "no feeds configured -- nothing to poll"
        // early return, which never touches the cache file either. Writing an empty cache
        // here on a zero-feed refresh would wipe out a previously-populated cache from a
        // feed that's since been removed from feeds.json but whose last-known events a
        // family member might still expect to see.
        if (errors.length < urls.length) {
          mkdirSync(dirname(deps.calendarCachePath), { recursive: true });
          const tmp = `${deps.calendarCachePath}.${process.pid}.${Date.now()}.tmp`;
          writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), events }, null, 2));
          renameSync(tmp, deps.calendarCachePath);
        }
        calendarLink!.sendChanged(calendarViewVersion(buildCalendarView(new Date(), calDeps)));
      } catch (err) {
        deps.logErr(`home: calendar poll failed: ${(err as Error).message}`);
      } finally {
        polling = false;
        if (queuedOverride) {
          const next = queuedOverride;
          queuedOverride = null;
          void pollCalendarOnce(next);
        }
      }
    };

    calendarLink.onCommand((payload) => {
      // isCalendarRefresh guards the command; calendarRefreshFeedUrls pulls the optional
      // override. pollCalendarOnce owns its own try/catch and never rejects, so there is no
      // outer catch here (the old "calendar-refresh command failed" log was unreachable).
      // Fire-and-forget, like every other push on this link.
      if (isCalendarRefresh(payload)) void pollCalendarOnce(calendarRefreshFeedUrls(payload));
    });

    // Prime the DO with the current view right after connect (spec: "Prime with an initial
    // sendChanged after connect") -- belt-and-braces alongside the viewVersion getter above
    // (a fresh/reseeded DO's own stored calendarViewVersion is null, never equal to a real
    // digest, so hello's own mismatch would already trigger a pull; this makes the push
    // explicit rather than relying on that alone). Wired via onOpen, NOT a bare call right
    // after start() below -- connect() is async (a fresh SigV4 signature per dial, see
    // signedCalendarLinkConnect's own header comment), so the underlying socket is not yet
    // attached in the same synchronous tick start() runs in; a call here would silently
    // send into a still-null socket. onOpen fires once the socket is actually attached AND
    // open, on the initial connect AND every reconnect -- registered BEFORE start() so it
    // can't race the very first open.
    calendarLink.onOpen(() => {
      try {
        calendarLink!.sendChanged(calendarViewVersion(buildCalendarView(new Date(), calDeps)));
      } catch (err) {
        deps.logErr(`home: initial calendar sendChanged failed: ${(err as Error).message}`);
      }
    });

    calendarLink.start();

    // Push a 'changed' notice whenever EITHER the own-events store or the family cache
    // moves locally -- a calendar-cli add/remove, OR the daemon's own recurring
    // pollCalendarOnce updating the cache (the same cache file the calendar-refresh
    // command writes).
    deps.watchCalendar(deps.calendarEventsPath, deps.calendarCachePath, () => {
      try {
        calendarLink!.sendChanged(calendarViewVersion(buildCalendarView(new Date(), calDeps)));
      } catch (err) {
        deps.logErr(`home: calendar sendChanged failed: ${(err as Error).message}`);
      }
    });

    if (deps.calendarPollIntervalMs > 0) {
      void pollCalendarOnce();
      cancelCalendarPoll = (deps.scheduleCalendarPoll ?? defaultSchedule)(() => { void pollCalendarOnce(); }, deps.calendarPollIntervalMs);
    }

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
    // B4: stop an already-started link before idling -- see the `let link` hoist comment
    // above for why this must not be a bare `link.stop()`. Guarded: a throw before
    // `new HomeLink(...)` (e.g. inside signedLinkConnect's own construction, or a bad
    // home-keys field it reaches synchronously) leaves `link` still undefined here, and
    // there is nothing to stop.
    link?.stop();
    // Same guard, same reason, for the recipes link (home-recipes plan, Task C1) -- a
    // throw between its own `new HomeLink(...)`/`start()` and the end of the try block
    // (e.g. the checklist watch wiring, which runs before it) must not leave it dialing
    // forever under a surface that believes it's idle.
    recipesLink?.stop();
    // Same guard, same reason, for the calendar link (home-calendar plan, Task C2).
    calendarLink?.stop();
    // And the recurring poll scheduler it wired (only set when interval > 0; guarded for a
    // throw before the wiring site, same B4 reason).
    cancelCalendarPoll?.();
    deps.idle();
  }
}

// Only run the daemon when executed directly, not when a test imports main/
// signedLinkConnect (same guard shape as discord-bot.ts/voice-bot.ts).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // await flushLogs() so the fatal line reaches the Discord mirror before exit: logErr only
  // BUFFERS it, so a synchronous process.exit() would kill the shipper first (bounded flush).
  main().catch(async (err) => { logErr(`home: fatal: ${(err as Error).message}`); await flushLogs(); process.exit(1); });
}
