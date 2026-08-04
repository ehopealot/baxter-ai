#!/usr/bin/env node
// The family-home surface driver (spec §2). A long-running process, gated by the `home`
// token in BAXTER_SURFACES (compose profile) -- deliberately NOT in-process with the agent
// and NOT tied to Discord, so the web page works on a tenant that runs no other surface.
//
// B4: owns the lifecycle of a single persistent HomeLink (home-link.ts) wired to the
// checklist store via wireLink (home-mirror.ts), replacing the old POST /api/sync poll
// loop (runSyncTick, still exported from home-mirror.ts -- D1 retires it later, this file
// just stops calling it). A tap NEVER wakes an LLM run -- there are no model calls here or
// in home-link.ts/home-mirror.ts.
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
// Same credential + service ("home") /api/sync's signedHomeOps uses (home-mirror.ts) --
// NOT "s3" (aws4fetch canonicalizes differently per service; same file's comment) -- against
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
// courtesy against redundant rebuilds, not a correctness requirement.
const WATCH_DEBOUNCE_MS = 200;

// Watch the checklist store for changes and call onChange (leading-edge folded, see
// WATCH_DEBOUNCE_MS). Watches the store's DIRECTORY, not the file itself, and filters by
// basename: fs.watch on a file that gets replaced via rename (exactly what mutate() does)
// is unreliable across the swap on Linux (the watch descriptor is tied to the original
// inode) -- watching the directory and matching the filename survives both the rename-swap
// and the file not existing yet (mkdir'd defensively below, mirroring checklist-store.ts's
// own ensureFile so a brand-new tenant with zero checklists still gets a working watch).
// Also filters out the proper-lockfile lock artifacts and mutate()'s own `.tmp` siblings
// that live in the same directory, so those don't trigger a spurious checkForChanges.
function watchChecklistStore(path: string, onChange: () => void): { close(): void } {
  const dir = dirname(path);
  const name = basename(path);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, (_event, filename) => {
      // A null filename (platform-dependent) can't be filtered -- treat it as a possible
      // change rather than silently drop it; the debounce below still bounds the cost, and
      // checkForChanges is a no-op when nothing actually moved.
      if (filename !== null && filename !== name) return;
      if (timer !== null) return; // leading-edge: a call is already pending, fold this one in
      timer = setTimeout(() => { timer = null; onChange(); }, WATCH_DEBOUNCE_MS);
      timer.unref?.();
    });
    return { close: () => watcher.close() };
  } catch (err) {
    logErr(`home: could not watch the checklist store (${(err as Error).message}) -- local edits won't push a 'changed' notice until the next reconnect`);
    // This watcher's FSWatcher handle is what keeps the process alive between redials
    // (HomeLink's own timers are all unref'd -- see main()'s comment); losing it here would
    // let the process exit from under a live-but-reconnecting link the moment the socket
    // itself isn't held open. A dedicated ref'd fallback timer closes that gap without
    // conflating this with the unprovisioned idle() path (different cause, same "stay up").
    const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
    return { close: () => clearInterval(keepAlive) };
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

  // `wired` is referenced by the getters below before it exists: HomeLink needs the
  // getters at construction time, but wireLink needs the constructed `link`. A `let`
  // forward reference is safe because the getters are only ever INVOKED at connect time
  // (HomeLink._onOpen, on the first connect and every reconnect), always after `wired` has
  // been assigned just below.
  let wired!: WiredLink;
  const link = new HomeLink({
    connect: signedLinkConnect(keys, deps.makeSocket),
    viewVersion: () => wired.currentVersion(),
    appliedThrough: () => loadState(deps.statePath).appliedThrough,
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

  // Push a 'changed' notice whenever the store moves locally (a CLI/Discord-mirror edit --
  // NOT the tap path, which arrives as an inbound `intent` and is already handled by
  // wireLink's onIntent).
  //
  // Deliberately NOT idleForever() on this path -- but the process staying alive is NOT
  // owed to HomeLink's own timers: its heartbeat/reconnect/hbAck timers are all unref'd
  // (home-link.ts -- "a live link must never be the reason the process can't exit", written
  // for a link sharing a process with Discord/mail/etc). This surface is standalone (see
  // this file's header), so what actually refs the event loop through every window --
  // connected, mid-handshake, and backing off between redials alike -- is THIS watcher: a
  // real fs.watch() FSWatcher refs the loop by default (not unref'd here), so it alone keeps
  // the process live end to end. If watchChecklists ever degrades to a no-op (its catch
  // above), that guarantee is gone for whatever's left of the process's life; see that
  // catch's comment.
  deps.watchChecklists(deps.checklistsPath, () => wired.checkForChanges());

  deps.log(`home: family-home surface up (tenant ${keys.tenant}) -> ${keys.endpoint}`);
}

// Only run the daemon when executed directly, not when a test imports main/
// signedLinkConnect (same guard shape as discord-bot.ts/voice-bot.ts).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { logErr(`home: fatal: ${(err as Error).message}`); process.exit(1); });
}
