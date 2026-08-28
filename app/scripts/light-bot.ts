// The light-surface supervisor: runs the mail/home/heartbeat/sms/chat daemons
// in ONE process (compose's `light` service), instead of one container per daemon.
// Each daemon's main() takes one of two shapes: mail/home/sms/chat wire their
// event-driven handlers (their link, an fs.watch, a ref'd keep-alive timer) and
// RETURN -- they then stay resident in the shared event loop on those handles,
// exactly as they do standalone; heartbeat runs a genuine for(;;) that never
// returns. So a clean return means "started", not "exited". The supervisor
// restarts only a surface whose main() THROWS during startup, with capped
// exponential backoff in that surface's own log channel; a clean return ends
// supervision of that surface. A startup failure can never escape its
// supervisor, so one surface can't take down the others; a process-level fault
// (uncaughtException/unhandledRejection) is fatal on purpose -- the container's
// restart policy brings the whole set back.
import { pathToFileURL } from "node:url";
import { loggerFor, flushLogs, type SurfaceLogger } from "./runtime.ts";
import { lifecycleControl, workerControlFromEnv, type WorkerControlLifecycle } from "./worker-control.ts";
import { LightLifecycle } from "./light-lifecycle.ts";

export const LIGHT_SURFACE_NAMES = ["mail", "home", "heartbeat", "sms", "chat"] as const;
export type LightSurface = (typeof LIGHT_SURFACE_NAMES)[number];

type SurfaceMain = (logger: SurfaceLogger, lifecycle: LightLifecycle, onDurableProgress: (highWater: number) => void) => Promise<void>;

// The default surface set, mirroring the Makefile's `?=` default (discord is
// not a light surface, so only the five survive the filter). The make
// level only selects compose PROFILES -- which containers start -- and this
// container's sole runtime source for the set is env_file (app/.env, where the
// line ships commented out). So when BAXTER_SURFACES is ABSENT from the env,
// this default runs the whole default fleet's light set (all five) instead of
// silently idling. An explicitly SET value keeps full semantics: blank or a
// value naming none of the five starts no light surface (a deliberate off
// switch).
const DEFAULT_SURFACES = "sms,chat,home,mail,heartbeat";

// Which light surfaces a BAXTER_SURFACES value enables. `home` encompasses
// `chat` (previously the Makefile appended the chat profile whenever home was
// listed; that rule now lives here). An absent value means the default fleet.
export function enabledLightSurfaces(env: NodeJS.ProcessEnv): LightSurface[] {
  const listed = new Set(
    (env.BAXTER_SURFACES ?? DEFAULT_SURFACES).split(",").map((s) => s.trim()).filter(Boolean),
  );
  if (listed.has("home")) listed.add("chat");
  return LIGHT_SURFACE_NAMES.filter((s) => listed.has(s));
}

const BACKOFF_MS = [1000, 2000, 5000, 15000, 60000] as const;
const STABLE_MS = 5 * 60 * 1000; // a loop this old is healthy; reset its backoff

export interface SupervisorDeps {
  mains?: Partial<Record<LightSurface, SurfaceMain>>; // tests inject fakes
  backoff?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  loggerForSurface?: (surface: string) => SurfaceLogger;
  idle?: () => Promise<void>; // tests substitute a resolving promise
  lifecycle?: LightLifecycle;
  workerControl?: WorkerControlLifecycle;
}

async function realMain(surface: LightSurface): Promise<SurfaceMain> {
  switch (surface) {
    case "mail": {
      const m = await import("./mail-bot.ts");
      return (lg, lifecycle, onDurableProgress) => m.main({ ...m.defaultDeps(), log: lg.log, logErr: lg.logErr, lifecycle, onDurableProgress });
    }
    case "home": {
      const m = await import("./home-bot.ts");
      return (lg, lifecycle) => m.main({ ...m.defaultDeps(), log: lg.log, logErr: lg.logErr, lifecycle });
    }
    case "heartbeat": {
      const m = await import("./heartbeat.ts");
      return (lg, lifecycle) => m.main({ log: lg.log, logErr: lg.logErr, lifecycle });
    }
    case "sms": {
      const m = await import("./sms-bot.ts");
      return (lg, lifecycle, onDurableProgress) => m.main({ ...m.defaultDeps(), log: lg.log, logErr: lg.logErr, lifecycle, onDurableProgress });
    }
    case "chat": {
      const m = await import("./chat-bot.ts");
      return (lg, lifecycle, onDurableProgress) => m.main({ ...m.defaultDeps(), log: lg.log, logErr: lg.logErr, lifecycle, onDurableProgress });
    }
  }
}

export async function superviseSurface(surface: LightSurface, deps: SupervisorDeps = {}, lifecycle = deps.lifecycle ?? new LightLifecycle(), onDurableProgress: (highWater: number) => void = () => {}): Promise<void> {
  const lg = (deps.loggerForSurface ?? loggerFor)(surface);
  const backoff = deps.backoff ?? BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    const startedAt = Date.now();
    try {
      // Resolve the surface's main() INSIDE the try, so a module-load failure
      // (a broken/partial image, a top-level throw in the bot module) is isolated
      // to THIS surface -- it backs off and logs to its own channel while the
      // siblings keep serving -- instead of rejecting out of the caller's
      // Promise.all and cycling the whole container. (ESM caches a rejected
      // dynamic import, so this retry won't self-heal a genuinely broken module;
      // a container restart clears the cache. The goal here is isolation, so the
      // header's "one surface can't take down the others" holds for load failures
      // too, not in-process recovery.)
      const mainFn = deps.mains?.[surface] ?? (await realMain(surface));
      await mainFn(lg, lifecycle, onDurableProgress);
      // A clean return means the surface wired its handlers and is now resident
      // (home/sms/chat), or -- for a genuine for(;;) main like heartbeat -- we
      // never get here. Either way there is nothing to restart: stop supervising.
      // Residency invariant: a light surface's main() must EITHER loop forever
      // (heartbeat) OR leave a ref'd handle (link/fs.watch/timer) before returning;
      // one that returned without wiring one would be logged "started" yet be dead.
      lg.log(`${surface}: started`);
      return;
    } catch (err) {
      lg.logErr(`${surface}: crashed during startup (${(err as Error)?.message ?? err}) -- restarting`);
    }
    if (Date.now() - startedAt > STABLE_MS) attempt = 0;
    await sleep(backoff[Math.min(attempt++, backoff.length - 1)]);
  }
}

// A ref'd no-op timer that holds the Node event loop open. A never-resolving
// promise refs NOTHING, so an `await new Promise(()=>{})` idle would let the loop
// drain and the process exit 0 -- which `restart: unless-stopped` then flaps. This
// is the same keep-alive the event-driven light bots use (their idleForever;
// heartbeat, the fifth surface, instead loops forever in its main()).
const DRAIN_TIMEOUT_MS = 25_000;

/** Close intake, wait a bounded interval for finite work, then ask the runner.
 * A wake racing the final check denies exit and reopens intake for new work. */
export async function drainForExit(lifecycle: LightLifecycle, control: WorkerControlLifecycle, timeoutMs = DRAIN_TIMEOUT_MS): Promise<boolean> {
  lifecycle.closeIntake();
  await control.drain();
  await Promise.race([
    lifecycle.drain(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  const permitted = await control.exitPermitted();
  if (permitted) lifecycle.closeSources();
  else lifecycle.reopenIntake();
  return permitted;
}

export function keepAliveTimer(): NodeJS.Timeout {
  return setInterval(() => {}, 2 ** 31 - 1);
}

// Park the supervisor forever: an injected idle (tests) or, in production, a ref'd
// timer holding the loop open plus a never-resolving await. Never returns in prod.
function parkForever(deps: SupervisorDeps): Promise<void> {
  if (deps.idle) return deps.idle();
  keepAliveTimer();
  return new Promise<void>(() => {});
}

export async function main(deps: SupervisorDeps = {}): Promise<void> {
  // Constructing worker control is also the worker-mode Claude refusal. Resident
  // containers have no control socket and retain their historical behavior.
  const configured = workerControlFromEnv(process.env);
  const control = deps.workerControl ?? lifecycleControl(configured.client, configured.binding);
  const lifecycle = deps.lifecycle ?? new LightLifecycle();
  await control.hello();
  if (configured.binding) {
    const renewTimer = setInterval(() => {
      void lifecycle.track("worker-control:renew", () => control.renew()).catch((error) => {
        (deps.loggerForSurface ?? loggerFor)("light").logErr(`light: lease renew failed: ${(error as Error).message}`);
      });
    }, 30_000);
    renewTimer.unref?.();
    lifecycle.source("worker-control:renew-timer", () => clearInterval(renewTimer));
  }
  shutdownLight = () => drainForExit(lifecycle, control);
  const reportCoverage = (queue: "mail" | "sms" | "chat" | "home") => (highWater: number): void => {
    // Called only by a surface after its admission/cursor transaction returns.
    // Keep the control RPC in finite accounting too: SIGTERM waits for it rather
    // than racing a successful durable admission with process exit.
    void lifecycle.track(`worker-control:coverage:${queue}`, () => control.coverage({ queue, highWater })).catch((error) => {
      (deps.loggerForSurface ?? loggerFor)("light").logErr(`light: ${queue} coverage failed: ${(error as Error).message}`);
    });
  };
  const surfaces = enabledLightSurfaces(process.env);
  const lg = (deps.loggerForSurface ?? loggerFor)("light");
  if (surfaces.length === 0) {
    // The env explicitly listed no light surface (a set value that is blank or
    // names none of the five -- absent means the default fleet's light set,
    // all five). Idle rather than exit -- restart:unless-stopped restarts even
    // an exit 0 (flapping), where idling matches the other daemons'
    // not-configured posture.
    lg.log("light: no light surfaces in BAXTER_SURFACES -- idling");
    await parkForever(deps); // ref'd timer, so we idle rather than exit 0 + flap
    return;
  }
  lg.log(`light: supervising [${surfaces.join(", ")}]`);
  await Promise.all(surfaces.map((s) => superviseSurface(s, deps, lifecycle, s === "mail" || s === "sms" || s === "chat" ? reportCoverage(s) : () => {})));
  // Reached only when every supervised surface's main() returned cleanly (all are
  // event-driven and now resident; none is a for(;;) like heartbeat, which would
  // keep the Promise.all pending forever). Park so the supervisor process stays up,
  // matching the empty-set posture above rather than exiting into a restart flap.
  await parkForever(deps);
}

let shutdownLight: (() => Promise<boolean>) | undefined;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const fatal = async (kind: string, err: unknown) => {
    console.error(`light: FATAL ${kind}: ${(err as Error)?.message ?? err}`);
    await flushLogs();
    process.exit(1);
  };
  process.on("uncaughtException", (err) => void fatal("uncaughtException", err));
  process.on("unhandledRejection", (reason) => void fatal("unhandledRejection", reason));
  const terminate = async () => {
    try {
      const permitted = await (shutdownLight?.() ?? Promise.resolve(true));
      if (!permitted) return;
      await flushLogs(); process.exit(0);
    } catch (err) { await fatal("shutdown", err); }
  };
  process.on("SIGTERM", () => { void terminate(); });
  process.on("SIGINT", () => { void terminate(); });
  main().catch(async (err) => { await fatal("main", err); });
}
