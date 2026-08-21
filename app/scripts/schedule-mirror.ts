// Builds the read-only, family-facing view of scheduled tasks that the home worker's
// /scheduled page renders. Mirrors calendar-mirror.ts: the wire type is defined LOCALLY
// (core and the DO are separate deploys), carries the `lists: []` filler the shared
// link-protocol view gate requires, and resolves tz via the ONE shared householdTz
// chain (household-tz.ts) so the calendar and schedule pages agree. Deliberately omits
// the internal `task` prompt and `deliver` target.
import { createHash } from "node:crypto";
import { readTasks } from "./schedule-store.ts";
import { householdTz } from "./household-tz.ts";
import { systemTaskEnabled } from "./system-tasks.ts";

export interface ScheduleViewItem {
  desc: string; // user-facing label; "(no description)" when the task has none
  nextRun: string; // task.next_run_at, absolute UTC ISO
  recurring: boolean; // !!task.cron
  // Runtime-owned system tasks (2026-08-20 system scheduled tasks): additive fields,
  // optional across rolling deploys -- the worker normalizes absence defensively
  // (schedule-link.ts: absent system means false, absent enabled means true).
  // `enabled` is emitted ONLY from the strict systemTaskEnabled check (literal
  // system.enabled === true), so a malformed persisted value can never surface as
  // enabled:true; a force-disabled unknown-key record still shows system:true,
  // enabled:false, keeping it visible for diagnosis.
  system: boolean;
  enabled: boolean;
}
// `lists: []` is a required filler (link-protocol.ts's shared view gate), not real payload.
export interface ScheduleView { lists: []; items: ScheduleViewItem[]; tz: string; }

export async function buildScheduleView(): Promise<ScheduleView> {
  const tz = householdTz(process.env);
  const tasks = await readTasks();
  const mapped = tasks
    // Skip tasks whose next_run_at isn't a parseable instant. schedule-cli always
    // writes a valid ISO next_run_at, so this only fires on a corrupt/hand-edited
    // store -- but an unparseable value sorts as NaN (unstable order) and renders
    // as a blank time on /scheduled (a row that looks like a bug). Dropping it at
    // the source keeps the worker mirror dumb (it never has to guard NaN).
    .filter((t) => typeof t.next_run_at === "string" && !Number.isNaN(Date.parse(t.next_run_at)))
    .map((t) => ({
      desc: t.desc && t.desc.trim() ? t.desc : "(no description)",
      nextRun: t.next_run_at,
      recurring: !!t.cron,
      system: !!t.system,
      enabled: t.system ? systemTaskEnabled(t) : true,
    }));
  // Producer-authoritative ordering (the worker renders arrival order): enabled
  // items -- every ordinary task plus enabled system tasks -- soonest-first by
  // nextRun, then disabled system items last by description so the page never
  // interleaves inactive rows with actionable ones; equal descriptions tie-break
  // on nextRun for a fully deterministic order.
  const enabled = mapped
    .filter((i) => i.enabled)
    .sort((a, b) => new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime());
  const disabled = mapped
    .filter((i) => !i.enabled)
    .sort((a, b) => (a.desc < b.desc ? -1 : a.desc > b.desc ? 1 : a.nextRun < b.nextRun ? -1 : a.nextRun > b.nextRun ? 1 : 0));
  return { lists: [], items: [...enabled, ...disabled], tz };
}

// A LOCAL copy of calendar-mirror.ts's canonicalize + viewVersion (same "stable digest of the
// view" contract): the container sends this string in its hello/changed/view envelopes and the
// worker's reduceChanged compares it to skip no-op re-pulls.
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}
export function scheduleViewVersion(view: ScheduleView): string {
  return createHash("sha256").update(canonicalize(view)).digest("hex");
}
