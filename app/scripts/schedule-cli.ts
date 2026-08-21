#!/usr/bin/env node
// Baxter's only interface to the schedule. Locked/atomic via schedule-store;
// enforces the rate limits (min recurrence, max tasks) at add time. Never lets
// the run raw-edit schedule.json.
import { pathToFileURL } from "node:url";
import type { Task, TaskDeliver } from "./schedule-store.ts";
import {
  mutate, readTasks, mintTaskId, resolveNextRun, cronMinGapMinutes, envInt,
} from "./schedule-store.ts";
import { hasTranscript, isStrictGroupId, smsGroupSummaries } from "./sms-transcript.ts";
import { householdTz } from "./household-tz.ts";
import { SYSTEM_TASKS, canonicalSystemId, findSystemDef, systemTaskEnabled, type SystemTaskDefinition } from "./system-tasks.ts";
import { reconcileSystemTasks, refuseOnCollision } from "./system-reconcile.ts";

const MIN_INTERVAL = envInt("HEARTBEAT_MIN_INTERVAL_MINUTES", 60);
const MAX_TASKS = envInt("HEARTBEAT_MAX_TASKS", 100);
const FALLBACK_TZ = process.env.HEARTBEAT_TZ || "America/Los_Angeles";

export interface ParsedAdd {
  task: string;
  desc: string;
  cron: string | null;
  at: string | null;
  tz: string | null;
  deliver: TaskDeliver | null;
}

export function parseAdd(argv: string[]): ParsedAdd {
  const [task, ...rest] = argv;
  if (!task || task.startsWith("--")) throw new Error("task description required as the first argument");
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--cron" || k === "--at" || k === "--tz" || k === "--desc" || k === "--discord" || k === "--email" || k === "--sms" || k === "--sms-group") {
      if (i + 1 >= rest.length) throw new Error(`missing value for ${k}`);
      flags[k] = rest[++i];
    } else throw new Error(`unknown argument: ${k}`);
  }
  if (!!flags["--cron"] === !!flags["--at"]) throw new Error("exactly one of --cron or --at is required");
  // Delivery flags count by PRESENCE in the mutual-exclusion check, and --sms-group
  // constructs its deliver target whenever present -- `--sms-group ''` is an explicit
  // (invalid) target that must reach assertSmsGroupDeliverable's strict gate and be
  // refused before any mutation, never silently degrade to `deliver: null` (spec
  // 2026-08-18-scheduled-sms-group-delivery §Error handling). The --discord/--email/--sms
  // TARGETS below keep their pre-existing value-truthiness semantics (empty values there
  // are pre-feature behavior, out of scope).
  const DELIVERY_FLAGS = ["--discord", "--email", "--sms", "--sms-group"];
  if (DELIVERY_FLAGS.filter((k) => k in flags).length > 1) {
    throw new Error("at most one delivery target (--discord, --email, --sms, or --sms-group)");
  }
  const desc = (flags["--desc"] ?? "").trim();
  if (!desc) throw new Error('--desc "<label>" is required (the user-facing description shown on the home page)');
  const deliver: TaskDeliver | null = flags["--discord"] ? { surface: "discord", target: flags["--discord"] }
    : flags["--email"] ? { surface: "mail", target: flags["--email"] }
    : flags["--sms"] ? { surface: "sms", target: flags["--sms"] }
    : "--sms-group" in flags ? { surface: "sms-group", target: flags["--sms-group"] } : null;
  return { task, desc, cron: flags["--cron"] || null, at: flags["--at"] || null, tz: flags["--tz"] || null, deliver };
}

// --sms-group admission (spec 2026-08-18-scheduled-sms-group-delivery §Schedule creation
// and persistence): checked BEFORE the mutate below, so a refusal leaves schedule.json
// untouched. (1) the strict shared predicate, then (2) hasTranscript("group:<id>") -- the
// transcript is the authorization source, so only a group Baxter has actually received is
// schedulable. Strict validation precedes the lookup, which therefore always resolves the
// exact strict g-<id>.jsonl file, never a gx-* quarantine transcript.
function assertSmsGroupDeliverable(deliver: TaskDeliver | null): void {
  if (!deliver || deliver.surface !== "sms-group") return;
  if (!isStrictGroupId(deliver.target)) throw new Error(`--sms-group refused: ${JSON.stringify(deliver.target)} is not a valid group id`);
  if (!hasTranscript(`group:${deliver.target}`)) throw new Error(`--sms-group refused: group ${deliver.target} has no transcript (never received) — run \`schedule-cli groups\` to list schedulable groups`);
}

// Only CANONICAL registered system records (exact canonical id AND matching
// system.key for a registered key) are exempt from the HEARTBEAT_MAX_TASKS
// count: raw system metadata is not trusted. An unknown-key record on a
// non-reserved id is force-disabled by reconciliation (kept visible, never
// executed), so it still consumes the cap like any ordinary record.
function isCanonicalSystemRecord(t: Task, registry: readonly SystemTaskDefinition<string>[]): boolean {
  return registry.some((d) => t.id === canonicalSystemId(d.key) && t.system?.key === d.key);
}

async function cmdAdd(argv: string[], registry: readonly SystemTaskDefinition<string>[] = SYSTEM_TASKS): Promise<void> {
  const { task, desc, cron, at, tz, deliver } = parseAdd(argv);
  assertSmsGroupDeliverable(deliver); // before any mutation: a refusal never touches schedule.json
  if (cron) {
    const gap = cronMinGapMinutes(cron, tz, FALLBACK_TZ);
    if (gap < MIN_INTERVAL) throw new Error(`--cron fires too often (min gap ${gap}min < ${MIN_INTERVAL}min limit)`);
  }
  const now = Date.now();
  const next_run_at = resolveNextRun({ cron, at, tz }, now, FALLBACK_TZ);
  const id = await mutate((tasks) => {
    if (tasks.filter((t) => !isCanonicalSystemRecord(t, registry)).length >= MAX_TASKS) {
      throw new Error(`schedule is full (${MAX_TASKS} tasks)`);
    }
    const t: Task = { id: mintTaskId(), task, desc, cron, at, tz, deliver, next_run_at, invisible_until: null, attempts: 0, created_at: new Date(now).toISOString() };
    return { tasks: [...tasks, t], value: t.id };
  });
  console.log(id);
}

export async function cmdCancel(id: string, registry: readonly SystemTaskDefinition<string>[] = SYSTEM_TASKS): Promise<void> {
  const removed = await mutate((tasks) => {
    const matches = tasks.filter((t) => t.id === id);
    // (i) The queue helpers mutate EVERY record sharing an id, so an ambiguous id
    // refuses with no write rather than multi-mutating.
    if (matches.length > 1) {
      throw new Error(`ambiguous id: ${matches.length} records share ${id} -- repair the duplicate set first`);
    }
    // (ii) A genuine system record (registered canonical id AND matching key) is
    // operator-controlled, never cancelled.
    const rec = matches[0];
    if (rec != null && isCanonicalSystemRecord(rec, registry)) {
      throw new Error(`system tasks cannot be cancelled; use schedule-cli system disable ${rec.system!.key}`);
    }
    // (iii) Repair path: validate as-if this ONE record were already removed, so
    // cancelling the single unambiguous ordinary record sitting under a reserved
    // id stays reachable (full validation would necessarily throw on that very
    // record); any OTHER remaining collision still aborts with no write.
    refuseOnCollision(tasks, registry, { excludeId: id });
    const kept = tasks.filter((t) => t.id !== id);
    return { tasks: kept, value: kept.length !== tasks.length };
  });
  if (!removed) { console.error(`no task with id ${id}`); process.exit(1); }
  console.log(`cancelled ${id}`);
}

// Read-only group discovery (spec §CLI discovery): the transcript-backed groups a
// --sms-group schedule may target, as JSON. Prints [] when there are no valid group
// transcripts. Only identity + display metadata -- no message bodies or media URLs.
// Every surface that can create schedules already holds the `schedule-cli *` grant,
// so email/Discord/chat runs can discover candidates without gaining sms-cli send
// authority.
function cmdGroups(): void {
  console.log(JSON.stringify(smsGroupSummaries(), null, 2));
}

// --- System task controls (2026-08-20 system scheduled tasks, T5) --------------------------
// `schedule-cli system list`, `schedule-cli system enable <key>`, and
// `schedule-cli system disable <key>` are the operator controls for runtime-owned
// system tasks. Each command runs reconcileSystemTasks INSIDE the
// same mutate() transaction as its own read/toggle (one atomic unit under the
// store lock -- never two separately locked steps), with tz from the ONE shared
// household resolver, so a canonical record is created/repaired and toggled in a
// single write. Registry and clock are injectable parameters (production defaults:
// the compile-time registry and the ambient clock); every toggle writes LITERAL
// booleans only. A ReservedIdCollisionError propagates from inside the
// transaction, so a colliding store is refused loudly with nothing written.

export interface SystemTaskSummary {
  key: string;
  desc: string;
  enabled: boolean; // the normalized literal boolean, never a raw malformed persisted value
  next_run_at: string | null;
}

function sysLog(msg: string): void {
  console.error(msg); // reconcile repairs are diagnostics; command data goes to stdout
}

function summaryOf(def: SystemTaskDefinition<string>, rec?: Task): SystemTaskSummary {
  return { key: def.key, desc: def.desc, enabled: rec ? systemTaskEnabled(rec) : false, next_run_at: rec?.next_run_at ?? null };
}

// Refusal for an argument that is not a registered system key: distinguish an
// ordinary task id (a likely `system enable <task-id>` mistake) from a plain
// unknown key. Read-only -- the refusal path never enters a transaction.
async function refuseNonKeyArg(key: string): Promise<never> {
  const hit = (await readTasks()).find((t) => t.id === key);
  if (hit != null && hit.system == null) {
    throw new Error(`not a system task: '${key}' is an ordinary task id (system keys only, e.g. 'daily-calendar-digest')`);
  }
  throw new Error(`unknown system task key: '${key}'`);
}

export async function cmdSystemList(
  registry: readonly SystemTaskDefinition<string>[] = SYSTEM_TASKS,
  now: Date = new Date(),
): Promise<SystemTaskSummary[]> {
  const tz = householdTz(process.env);
  return mutate((tasks) => {
    const r = reconcileSystemTasks(tasks, registry, now, tz, sysLog);
    const value = registry.map((def) => {
      const rec = r.tasks.find((t) => t.id === canonicalSystemId(def.key));
      return summaryOf(def, rec);
    });
    return { tasks: r.tasks, value };
  });
}

async function cmdSystemSetEnabled(
  key: string,
  enabled: boolean,
  registry: readonly SystemTaskDefinition<string>[],
  now: Date,
): Promise<SystemTaskSummary> {
  const def = findSystemDef(registry, key);
  if (def == null) return refuseNonKeyArg(key);
  const tz = householdTz(process.env);
  return mutate((tasks) => {
    const r = reconcileSystemTasks(tasks, registry, now, tz, sysLog);
    const rec = r.tasks.find((t) => t.id === canonicalSystemId(key));
    if (rec == null) throw new Error(`system task '${key}' missing after reconciliation`);
    // Both toggles write a literal boolean and clear claim/retry state. Only
    // enabling recomputes the next occurrence strictly after now; disabling keeps
    // reconciliation's queue progress (including the catch-up anchor on creation).
    const updated: Task = {
      ...rec,
      system: { key, enabled },
      invisible_until: null,
      attempts: 0,
      ...(enabled ? { next_run_at: resolveNextRun({ cron: def.cron, tz }, now.getTime(), tz) } : {}),
    };
    return { tasks: r.tasks.map((t) => (t.id === updated.id ? updated : t)), value: summaryOf(def, updated) };
  });
}

export async function cmdSystemEnable(
  key: string,
  registry: readonly SystemTaskDefinition<string>[] = SYSTEM_TASKS,
  now: Date = new Date(),
): Promise<SystemTaskSummary> {
  return cmdSystemSetEnabled(key, true, registry, now);
}

export async function cmdSystemDisable(
  key: string,
  registry: readonly SystemTaskDefinition<string>[] = SYSTEM_TASKS,
  now: Date = new Date(),
): Promise<SystemTaskSummary> {
  return cmdSystemSetEnabled(key, false, registry, now);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    try {
      if (cmd === "add") await cmdAdd(rest);
      else if (cmd === "cancel") await cmdCancel(rest[0]);
      else if (cmd === "list") console.log(JSON.stringify(await readTasks(), null, 2));
      else if (cmd === "groups") cmdGroups();
      else if (cmd === "system") {
        const [sub, key] = rest;
        if (sub === "list") console.log(JSON.stringify(await cmdSystemList(), null, 2));
        else if (sub === "enable" || sub === "disable") {
          if (!key) { console.error(`usage: schedule-cli system ${sub} <key>`); process.exit(1); }
          if (sub === "enable") {
            const r = await cmdSystemEnable(key);
            console.log(`enabled system task '${r.key}' (next run ${r.next_run_at})`);
          } else {
            const r = await cmdSystemDisable(key);
            console.log(`disabled system task '${r.key}'`);
          }
        } else { console.error("usage: schedule-cli system <list|enable|disable> [key]"); process.exit(1); }
      }
      else { console.error("usage: schedule-cli <add|cancel|list|groups|system list|enable|disable> …"); process.exit(1); }
    } catch (err) { console.error(`schedule-cli: ${(err as Error).message}`); process.exit(1); }
  })();
}
