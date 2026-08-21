// The ONE shared household-timezone resolver (system-scheduled-tasks plan, T2), so
// calendar display (calendar-mirror/home-bot), the daily calendar digest, the
// system-task cron/reconciliation gate, and the /scheduled page (schedule-mirror)
// always agree on one zone: valid BAXTER_TZ -> valid HEARTBEAT_TZ -> America/Los_Angeles.
// Validation is validTz (below, exported as the ONE shared copy -- calendar-mirror.ts
// resolves deps.tz through it too), a try/catch Intl.DateTimeFormat construction, so a
// typo'd env value can never throw out of callers -- it falls through.
// Adoption is per-task (T4/T8/T9/T11/T12/T13); nothing in here reads a path or clock.
const FALLBACK_TZ = "America/Los_Angeles";

// `tz` when Intl accepts it, undefined otherwise (never throws -- garbage falls through).
export function validTz(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return undefined; }
}

export function householdTz(env: NodeJS.ProcessEnv = process.env): string {
  return validTz(env.BAXTER_TZ) ?? validTz(env.HEARTBEAT_TZ) ?? FALLBACK_TZ;
}
