// The light-surface supervisor: runs the home/heartbeat/sms/chat daemons as
// supervised async loops in ONE process (compose's `light` service), instead
// of one container per daemon. Each daemon is an infinite-loop main(); the
// supervisor restarts a loop that throws (or impossibly returns) with capped
// exponential backoff, in that surface's own log channel. A loop failure can
// never escape its supervisor, so one surface can't take down the others; a
// process-level fault (uncaughtException/unhandledRejection) is fatal on
// purpose -- the container's restart policy brings the whole set back.
import { pathToFileURL } from "node:url";
import { loggerFor, flushLogs, type SurfaceLogger } from "./runtime.ts";

export const LIGHT_SURFACE_NAMES = ["home", "heartbeat", "sms", "chat"] as const;
export type LightSurface = (typeof LIGHT_SURFACE_NAMES)[number];

type SurfaceMain = (logger: SurfaceLogger) => Promise<void>;

// Which light surfaces a BAXTER_SURFACES value enables. `home` encompasses
// `chat` (previously the Makefile appended the chat profile whenever home was
// listed; that rule now lives here).
export function enabledLightSurfaces(env: NodeJS.ProcessEnv): LightSurface[] {
  const listed = new Set(
    (env.BAXTER_SURFACES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
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
}

async function realMain(surface: LightSurface): Promise<SurfaceMain> {
  switch (surface) {
    case "home": {
      const m = await import("./home-bot.ts");
      return (lg) => m.main({ ...m.defaultDeps(), log: lg.log, logErr: lg.logErr });
    }
    case "heartbeat": {
      const m = await import("./heartbeat.ts");
      return (lg) => m.main({ log: lg.log, logErr: lg.logErr });
    }
    case "sms": {
      const m = await import("./sms-bot.ts");
      return (lg) => m.main({ ...m.defaultDeps(), log: lg.log, logErr: lg.logErr });
    }
    case "chat": {
      const m = await import("./chat-bot.ts");
      return (lg) => m.main({ ...m.defaultDeps(), log: lg.log, logErr: lg.logErr });
    }
  }
}

export async function superviseSurface(surface: LightSurface, deps: SupervisorDeps = {}): Promise<void> {
  const lg = (deps.loggerForSurface ?? loggerFor)(surface);
  const backoff = deps.backoff ?? BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const mainFn = deps.mains?.[surface] ?? (await realMain(surface));
  let attempt = 0;
  for (;;) {
    const startedAt = Date.now();
    try {
      await mainFn(lg);
      lg.logErr(`${surface}: main returned unexpectedly (it is an infinite loop) -- restarting`);
    } catch (err) {
      lg.logErr(`${surface}: crashed (${(err as Error)?.message ?? err}) -- restarting`);
    }
    if (Date.now() - startedAt > STABLE_MS) attempt = 0;
    await sleep(backoff[Math.min(attempt++, backoff.length - 1)]);
  }
}

export async function main(deps: SupervisorDeps = {}): Promise<void> {
  const surfaces = enabledLightSurfaces(process.env);
  const lg = (deps.loggerForSurface ?? loggerFor)("light");
  if (surfaces.length === 0) {
    // Defensive: the Makefile only starts this container when the set is
    // non-empty. Idle rather than exit -- restart:unless-stopped restarts even
    // an exit 0 (flapping), where idling matches the other daemons'
    // not-configured posture.
    lg.log("light: no light surfaces in BAXTER_SURFACES -- idling");
    await (deps.idle ? deps.idle() : new Promise<void>(() => {}));
    return;
  }
  lg.log(`light: supervising [${surfaces.join(", ")}]`);
  await Promise.all(surfaces.map((s) => superviseSurface(s, deps)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const fatal = async (kind: string, err: unknown) => {
    console.error(`light: FATAL ${kind}: ${(err as Error)?.message ?? err}`);
    await flushLogs();
    process.exit(1);
  };
  process.on("uncaughtException", (err) => void fatal("uncaughtException", err));
  process.on("unhandledRejection", (reason) => void fatal("unhandledRejection", reason));
  process.on("SIGTERM", async () => { await flushLogs(); process.exit(0); });
  process.on("SIGINT", async () => { await flushLogs(); process.exit(0); });
  main().catch(async (err) => { await fatal("main", err); });
}
