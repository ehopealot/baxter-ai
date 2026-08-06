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
import { mutate } from "./checklist-store.ts";
import { loadAllowlist, writeAllowlist, isSafeVersion } from "./allowlist.ts";
import { loadCalendarFeeds, writeCalendarFeeds } from "./calendar-feeds.ts";
import { CHECKLISTS_PATH, HOME_STATE_PATH, ALLOWLIST_PATH, CALENDAR_FEEDS_PATH } from "./paths.ts";
import { log, logErr, flushLogs } from "./runtime.ts";

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
