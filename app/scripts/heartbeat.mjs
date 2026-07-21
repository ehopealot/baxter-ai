#!/usr/bin/env node
// The heartbeat driver: one node loop that fires due scheduled tasks. Structural
// twin of poll.mjs. Fires happen OUTSIDE the lock; claims/completions are locked.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, harnessLabel, skillsPreamble } from "./runtime.mjs";
import {
  mutate, readTasks, selectDue, applyClaim, applyOnSuccess, applyOnFailure, appendLog, fireCountToday, capSkipLoggedToday, envInt,
} from "./schedule-store.mjs";
import { MEMORY_DIR, LEARNED_SKILLS_DIR, DISCORD_TOKEN_PATH } from "./paths.mjs";
import { HEARTBEAT_TOOLS, HEARTBEAT_SKILL_SRCS, GMAIL_CLI as GMAIL_CLI_PATH } from "./grants.mjs";
import { projectsPreamble } from "./projects-cli.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPT_PATH = join(APP_DIR, "heartbeat-prompt.md");
const RUNS_DIR = join(APP_DIR, ".claude", "heartbeat-runs");
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");
const MODEL = process.env.BAXTER_MODEL || "sonnet";
const INTERVAL_MS = envInt("HEARTBEAT_INTERVAL_SECONDS", 60) * 1000;
// envInt permits 0, but a 0 interval hot-spins the driver loop (setTimeout fires
// immediately), so reject it loudly -- same guard as poll.mjs's interval.
if (INTERVAL_MS === 0) throw new Error("HEARTBEAT_INTERVAL_SECONDS must be >= 1");
const VISIBILITY_MS = envInt("HEARTBEAT_VISIBILITY_MINUTES", 15) * 60000;
const MAX_ATTEMPTS = envInt("HEARTBEAT_MAX_ATTEMPTS", 3);
const FIRE_CAP = envInt("HEARTBEAT_MAX_FIRES_PER_DAY", 200);
const FALLBACK_TZ = process.env.HEARTBEAT_TZ || "America/Los_Angeles";
// Fired run's grants + staged skills live in grants.mjs (see the module header):
// HEARTBEAT_TOOLS is Baxter's usual grants MINUS schedule-cli (a scheduled task
// can't touch the schedule) PLUS gmail + discord so a fire can deliver to either.
const RUN_ENV = { ...process.env };
delete RUN_ENV.DISCORD_BOT_TOKEN;

const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter Burgundy";

async function fireTask(task) {
  const deliver = task.deliver
    ? `${task.deliver.surface} -> ${task.deliver.target}`
    : "(no delivery — just do the task; it is logged)";
  // fillTemplate is the project's single-pass, prototype-safe {{KEY}} substitution.
  const prompt = fillTemplate(readFileSync(PROMPT_PATH, "utf8"), {
    PERSONA_NAME, TASK: task.task, DELIVER: deliver,
    MEMORY_PATH: join(MEMORY_DIR, "memory.md"), GMAIL_CLI_PATH,
    // Injection-safe (slug + date only) -- see projectsPreamble.
    PROJECTS_LIST: projectsPreamble(),
    // Injection-safe (learned-skill NAMES only, sanitized) -- see skillsPreamble.
    LEARNED_SKILLS_LIST: skillsPreamble(),
  });
  // A fire succeeds only if the run neither hit a hard error (`failed`: non-zero
  // exit / spawn failure / missing binary) nor ran out of tokens. Out-of-tokens
  // is surfaced separately so tick can pause rather than count it a failure.
  const { outOfTokens, failed } = await runAgent({
    prompt, logId: `${task.id}-${Date.now()}`, cwd: MEMORY_DIR, model: MODEL,
    allowedTools: HEARTBEAT_TOOLS, runsDir: RUNS_DIR, env: RUN_ENV,
    beforeRun: () => { ensurePlaywrightConfig(MEMORY_DIR); ensureSkills(HEARTBEAT_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR); },
  });
  return { ok: !outOfTokens && !failed, outOfTokens };
}

export async function tick(nowMs, { runFn, fireCap, visibilityMs, maxAttempts, fallbackTz }) {
  const due = selectDue(await readTasks(), nowMs);
  let fires = fireCountToday(); // read the durable count once; track locally after (don't re-scan the growing log per task)
  for (const dueTask of due) {
    if (fires >= fireCap) {
      // At most one skipped line per day (UTC), not per tick.
      if (!capSkipLoggedToday()) appendLog({ ts: new Date(nowMs).toISOString(), id: dueTask.id, task: dueTask.task, outcome: "skipped", detail: "daily fire cap reached" });
      break; // stop firing for this tick
    }
    // Claim under the lock; a concurrent cancel makes claim return null -> skip.
    const claimed = await mutate((tasks) => { const r = applyClaim(tasks, dueTask.id, nowMs, visibilityMs); return { tasks: r.tasks, value: r.claimed }; });
    if (!claimed) continue;
    let result;
    try { result = await runFn(claimed); } catch { result = { ok: false }; }
    if (result.ok) {
      await mutate((tasks) => ({ tasks: applyOnSuccess(tasks, claimed.id, nowMs, fallbackTz), value: null }));
      appendLog({ ts: new Date(nowMs).toISOString(), id: claimed.id, task: claimed.task, outcome: "completed", deliver: claimed.deliver });
      fires++;
    } else if (result.outOfTokens) {
      // A token outage is global and hours-long -- not this task's fault. Leave
      // the claim in place (it retries for free when invisible_until expires,
      // without burning an attempt) and stop the tick so the rest of the due
      // list doesn't burn attempts against the same outage.
      break;
    } else {
      const { gaveUp } = await mutate((tasks) => { const r = applyOnFailure(tasks, claimed.id, nowMs, maxAttempts, fallbackTz); return { tasks: r.tasks, value: r }; });
      appendLog({ ts: new Date(nowMs).toISOString(), id: claimed.id, task: claimed.task, outcome: gaveUp ? "gave-up" : "failed", deliver: claimed.deliver });
      fires++;
    }
  }
}

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (token) { mkdirSync(dirname(DISCORD_TOKEN_PATH), { recursive: true }); writeFileSync(DISCORD_TOKEN_PATH, JSON.stringify({ token }), { mode: 0o600 }); }
  console.log(`[heartbeat] up; harness ${harnessLabel(MODEL)}; interval ${INTERVAL_MS}ms, fire cap ${FIRE_CAP}/day, tz ${FALLBACK_TZ}`);
  for (;;) {
    try { await tick(Date.now(), { runFn: fireTask, fireCap: FIRE_CAP, visibilityMs: VISIBILITY_MS, maxAttempts: MAX_ATTEMPTS, fallbackTz: FALLBACK_TZ }); }
    catch (err) { console.error(`[heartbeat] tick error: ${err.message}`); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
