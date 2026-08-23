// Consolidated automatic morning task. Calendar selection is deliberately done
// before any recipient work: an unreadable calendar is retryable, never an
// excuse to send a Friday/Monday fallback.
import { householdTz } from "./household-tz.ts";
import { refreshCalendars, readFamilyCacheEvents } from "./calendar-refresh.ts";
import { feedUrls, type FetchLike } from "./calendar-cli.ts";
import { readEvents } from "./calendar-store.ts";
import { selectDigestEvents } from "./digest-agenda.ts";
import { loaderDiagnosticSink } from "./check-in-context.ts";
import { CALENDAR_CACHE_PATH, CALENDAR_EVENTS_PATH, CALENDAR_FEEDS_PATH } from "./paths.ts";
import { dailyCalendarDigestDefinition, type DigestDeps } from "./daily-calendar-digest.ts";
import { weeklyHouseholdCheckInDefinition, type WeeklyCheckInDeps } from "./weekly-household-check-in.ts";
import type { Task } from "./schedule-store.ts";
import type { SystemTaskContext, SystemTaskDefinition, SystemTaskResult } from "./system-tasks.ts";

export type MorningMode = "calendar" | "friday" | "monday" | "none";
export interface MorningCheckInDeps extends Partial<DigestDeps> {
  readFamilyCacheImpl?: WeeklyCheckInDeps["readFamilyCacheImpl"];
  feedUrlsImpl?: WeeklyCheckInDeps["feedUrlsImpl"];
  readOwnEventsImpl?: WeeklyCheckInDeps["readOwnEventsImpl"];
  fetchFn?: FetchLike;
  ownEventsPath?: string;
  cachePath?: string;
  feedsPath?: string;
  env?: NodeJS.ProcessEnv;
}

function weekday(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
}

/** Decide the mode from one refresh/read/selection attempt. Exported so the
 * security-critical no-fallback-on-calendar-error boundary is unit-testable. */
export async function selectMorningMode(ctx: SystemTaskContext, deps: MorningCheckInDeps = {}): Promise<MorningMode | null> {
  const env = deps.env ?? process.env;
  const tz = householdTz(env);
  const cachePath = deps.cachePath ?? CALENDAR_CACHE_PATH;
  const feedsPath = deps.feedsPath ?? CALENDAR_FEEDS_PATH;
  const diagnostic = loaderDiagnosticSink("morning check-in", ctx.log);
  let family: Awaited<ReturnType<typeof readFamilyCacheEvents>>;
  let familyEligible: boolean;
  try {
    const refreshed = await (deps.refreshImpl ?? refreshCalendars)({ fetchFn: deps.fetchFn ?? fetch, cachePath, feedsPath, diagnostic });
    family = refreshed.familySnapshot;
    familyEligible = refreshed.urls.length > 0;
  } catch {
    // Retained cache is the only allowed refresh degradation. A malformed cache
    // still reaches selection; own/read/selection failures below are retryable.
    try {
      family = (deps.readFamilyCacheImpl ?? readFamilyCacheEvents)(cachePath);
      familyEligible = (deps.feedUrlsImpl ?? feedUrls)(feedsPath, diagnostic).length > 0;
    } catch {
      ctx.log("morning check-in: calendar refresh/cache unavailable");
      return null;
    }
  }
  let own;
  try { own = (deps.readOwnEventsImpl ?? readEvents)(deps.ownEventsPath ?? CALENDAR_EVENTS_PATH); }
  catch { ctx.log("morning check-in: calendar read unavailable"); return null; }
  try {
    const events = selectDigestEvents(own, family, { now: ctx.now, tz, familyEligible });
    if (events.length) return "calendar";
  } catch { ctx.log("morning check-in: calendar selection unavailable"); return null; }
  const day = weekday(ctx.now, tz);
  return day === "Friday" ? "friday" : day === "Monday" ? "monday" : "none";
}

export function morningCheckInDefinition(deps: MorningCheckInDeps = {}): SystemTaskDefinition<"morning-check-in"> {
  return {
    key: "morning-check-in",
    desc: "Morning calendar and household check-in",
    cron: "0 8 * * *",
    window: { startHour: 8, minuteSlots: 60, cutoffHour: 12 },
    async execute(task: Task, ctx: SystemTaskContext): Promise<SystemTaskResult> {
      const mode = await selectMorningMode(ctx, deps);
      if (mode === null) return { ok: false, agentRun: false, detail: "calendar unavailable" };
      if (mode === "none") return { ok: true, agentRun: false, detail: "no qualifying events" };
      // Existing mature handlers retain recipient, admission, quota, greeting and
      // delivery isolation. The preflight above is the sole mode authority.
      if (mode === "calendar") return dailyCalendarDigestDefinition(deps).execute(task, ctx);
      return weeklyHouseholdCheckInDefinition(mode, deps as Partial<WeeklyCheckInDeps>).execute(task, ctx);
    },
  };
}
