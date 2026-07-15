#!/usr/bin/env node
// Baxter's only interface to the schedule. Locked/atomic via schedule-store;
// enforces the rate limits (min recurrence, max tasks) at add time. Never lets
// the run raw-edit schedule.json.
import { pathToFileURL } from "node:url";
import {
  mutate, readTasks, newId, resolveNextRun, cronMinGapMinutes,
} from "./schedule-store.mjs";

const MIN_INTERVAL = Number(process.env.HEARTBEAT_MIN_INTERVAL_MINUTES || 60);
const MAX_TASKS = Number(process.env.HEARTBEAT_MAX_TASKS || 100);
const FALLBACK_TZ = process.env.HEARTBEAT_TZ || "America/Los_Angeles";

export function parseAdd(argv) {
  const [task, ...rest] = argv;
  if (!task || task.startsWith("--")) throw new Error("task description required as the first argument");
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--cron" || k === "--at" || k === "--tz" || k === "--discord" || k === "--email") {
      if (i + 1 >= rest.length) throw new Error(`missing value for ${k}`);
      flags[k] = rest[++i];
    } else throw new Error(`unknown argument: ${k}`);
  }
  if (!!flags["--cron"] === !!flags["--at"]) throw new Error("exactly one of --cron or --at is required");
  if (flags["--discord"] && flags["--email"]) throw new Error("at most one delivery target (--discord or --email)");
  const deliver = flags["--discord"] ? { surface: "discord", target: flags["--discord"] }
    : flags["--email"] ? { surface: "gmail", target: flags["--email"] } : null;
  return { task, cron: flags["--cron"] || null, at: flags["--at"] || null, tz: flags["--tz"] || null, deliver };
}

async function cmdAdd(argv) {
  const { task, cron, at, tz, deliver } = parseAdd(argv);
  if (cron) {
    const gap = cronMinGapMinutes(cron, tz, FALLBACK_TZ);
    if (gap < MIN_INTERVAL) throw new Error(`--cron fires too often (min gap ${gap}min < ${MIN_INTERVAL}min limit)`);
  }
  const now = Date.now();
  const next_run_at = resolveNextRun({ cron, at, tz }, now, FALLBACK_TZ);
  const id = await mutate((tasks) => {
    if (tasks.length >= MAX_TASKS) throw new Error(`schedule is full (${MAX_TASKS} tasks)`);
    const t = { id: newId(), task, cron, at, tz, deliver, next_run_at, invisible_until: null, attempts: 0, created_at: new Date(now).toISOString() };
    return { tasks: [...tasks, t], value: t.id };
  });
  console.log(id);
}

async function cmdCancel(id) {
  const removed = await mutate((tasks) => {
    const kept = tasks.filter((t) => t.id !== id);
    return { tasks: kept, value: kept.length !== tasks.length };
  });
  if (!removed) { console.error(`no task with id ${id}`); process.exit(1); }
  console.log(`cancelled ${id}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    try {
      if (cmd === "add") await cmdAdd(rest);
      else if (cmd === "cancel") await cmdCancel(rest[0]);
      else if (cmd === "list") console.log(JSON.stringify(await readTasks(), null, 2));
      else { console.error("usage: schedule-cli <add|cancel|list> …"); process.exit(1); }
    } catch (err) { console.error(`schedule-cli: ${err.message}`); process.exit(1); }
  })();
}
