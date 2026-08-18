#!/usr/bin/env node
// Baxter's only interface to the schedule. Locked/atomic via schedule-store;
// enforces the rate limits (min recurrence, max tasks) at add time. Never lets
// the run raw-edit schedule.json.
import { pathToFileURL } from "node:url";
import type { Task, TaskDeliver } from "./schedule-store.ts";
import {
  mutate, readTasks, newId, resolveNextRun, cronMinGapMinutes, envInt,
} from "./schedule-store.ts";
import { hasTranscript, isStrictGroupId, smsGroupSummaries } from "./sms-transcript.ts";

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

async function cmdAdd(argv: string[]): Promise<void> {
  const { task, desc, cron, at, tz, deliver } = parseAdd(argv);
  assertSmsGroupDeliverable(deliver); // before any mutation: a refusal never touches schedule.json
  if (cron) {
    const gap = cronMinGapMinutes(cron, tz, FALLBACK_TZ);
    if (gap < MIN_INTERVAL) throw new Error(`--cron fires too often (min gap ${gap}min < ${MIN_INTERVAL}min limit)`);
  }
  const now = Date.now();
  const next_run_at = resolveNextRun({ cron, at, tz }, now, FALLBACK_TZ);
  const id = await mutate((tasks) => {
    if (tasks.length >= MAX_TASKS) throw new Error(`schedule is full (${MAX_TASKS} tasks)`);
    const t: Task = { id: newId(), task, desc, cron, at, tz, deliver, next_run_at, invisible_until: null, attempts: 0, created_at: new Date(now).toISOString() };
    return { tasks: [...tasks, t], value: t.id };
  });
  console.log(id);
}

async function cmdCancel(id: string): Promise<void> {
  const removed = await mutate((tasks) => {
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    try {
      if (cmd === "add") await cmdAdd(rest);
      else if (cmd === "cancel") await cmdCancel(rest[0]);
      else if (cmd === "list") console.log(JSON.stringify(await readTasks(), null, 2));
      else if (cmd === "groups") cmdGroups();
      else { console.error("usage: schedule-cli <add|cancel|list|groups> …"); process.exit(1); }
    } catch (err) { console.error(`schedule-cli: ${(err as Error).message}`); process.exit(1); }
  })();
}
