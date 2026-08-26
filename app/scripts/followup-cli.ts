#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import type { Task, TaskDeliver } from "./schedule-store.ts";
import { isCanonicalSystemRecord, mintTaskId, mutate, ordinaryTaskLimit } from "./schedule-store.ts";
import { SYSTEM_TASKS } from "./system-tasks.ts";
import { householdTz } from "./household-tz.ts";
import { normalizePhone } from "./normalize-phone.ts";
import { isStrictGroupId } from "./sms-transcript.ts";
import { normalizeFollowUpSubject, parseGregorianDate, selectFollowUpInstant, type MinuteSelector } from "./followup-normalization.ts";

function routeFromEnv(env: NodeJS.ProcessEnv): TaskDeliver {
  const surface = env.BAXTER_FOLLOWUP_SURFACE;
  const target = env.BAXTER_FOLLOWUP_TARGET;
  if (!surface || !target) throw new Error("follow-up environment is missing");
  if (surface === "sms") {
    const phone = normalizePhone(target);
    if (!phone) throw new Error("follow-up environment has an invalid SMS phone target");
    return { surface: "sms", target: phone };
  }
  if (surface === "sms-group") {
    if (!isStrictGroupId(target)) throw new Error("follow-up environment has an invalid SMS group target");
    return { surface: "sms-group", target };
  }
  if (surface === "mail" || surface === "home-chat") return { surface: "mail", target };
  throw new Error("follow-up environment has an unsupported surface");
}

function parseAddArgs(argv: string[]): { subject: string; planDate: string } {
  if (argv.length !== 3 || !argv[0] || argv[0].startsWith("--") || argv[1] !== "--plan-date" || !argv[2]) {
    throw new Error('usage: followup-cli add "<subject>" --plan-date YYYY-MM-DD');
  }
  return { subject: argv[0], planDate: argv[2] };
}

export async function cmdFollowUpAdd(argv: string[], deps: { now?: Date; selector?: MinuteSelector; env?: NodeJS.ProcessEnv } = {}): Promise<{ id: string; subject: string; plan_date: string; next_run_at: string }> {
  const env = deps.env ?? process.env;
  const deliver = routeFromEnv(env);
  const { subject: rawSubject, planDate: rawDate } = parseAddArgs(argv);
  const normalized = normalizeFollowUpSubject(rawSubject);
  const planDate = parseGregorianDate(rawDate);
  const now = deps.now ?? new Date();
  const tz = householdTz(env);
  const nextRunAt = selectFollowUpInstant(planDate, now, tz, deps.selector);
  const record = await mutate((tasks) => {
    if (tasks.filter((task) => !isCanonicalSystemRecord(task, SYSTEM_TASKS)).length >= ordinaryTaskLimit()) throw new Error(`schedule is full (${ordinaryTaskLimit()} tasks)`);
    const id = mintTaskId();
    const task: Task = {
      id, task: `Check back about ${normalized.subject}`, desc: `Check back about ${normalized.subject}`,
      cron: null, at: nextRunAt, tz, next_run_at: nextRunAt, invisible_until: null, attempts: 0,
      created_at: now.toISOString(), deliver,
    };
    return { tasks: [...tasks, task], value: task };
  });
  return { id: record.id, subject: normalized.subject, plan_date: planDate.token, next_run_at: nextRunAt };
}

async function main(): Promise<void> {
  const [, , command, ...argv] = process.argv;
  if (command !== "add") throw new Error('usage: followup-cli add "<subject>" --plan-date YYYY-MM-DD');
  console.log(JSON.stringify(await cmdFollowUpAdd(argv)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => { console.error(`followup-cli: ${(err as Error).message}`); process.exit(1); });
}
