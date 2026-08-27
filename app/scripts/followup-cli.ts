#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import type { FollowUpState, Task, TaskDeliver } from "./schedule-store.ts";
import { isCanonicalSystemRecord, mintTaskId, mutate, ordinaryTaskLimit } from "./schedule-store.ts";
import { SYSTEM_TASKS } from "./system-tasks.ts";
import { householdTz } from "./household-tz.ts";
import { normalizePhone } from "./normalize-phone.ts";
import { isStrictGroupId } from "./sms-transcript.ts";
import { moveFollowUpToNextDay, normalizeFollowUpSubject, parseGregorianDate, selectFollowUpInstant, selectTopicFollowUpInstant, type MinuteSelector } from "./followup-normalization.ts";
import { tzDateToken } from "./tz.ts";

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

function parseAddArgs(argv: string[]): { subject: string; kind: FollowUpState["kind"]; planDate?: string } {
  if (!argv[0] || argv[0].startsWith("--")) throw new Error('usage: followup-cli add "<subject>" <--plan-date YYYY-MM-DD|--topic>');
  if (argv.length === 2 && argv[1] === "--topic") return { subject: argv[0], kind: "topic" };
  if (argv.length === 3 && argv[1] === "--plan-date" && argv[2]) return { subject: argv[0], kind: "date", planDate: argv[2] };
  throw new Error('usage: followup-cli add "<subject>" <--plan-date YYYY-MM-DD|--topic>');
}

const isFollowUp = (task: Task): task is Task & { follow_up: FollowUpState } => task.follow_up?.kind === "date" || task.follow_up?.kind === "topic";

function nextFreeInstant(instant: string, tz: string, occupiedDays: Set<number>): string {
  let candidate = instant;
  while (occupiedDays.has(tzDateToken(new Date(candidate), tz))) candidate = moveFollowUpToNextDay(candidate, tz);
  return candidate;
}

export async function cmdFollowUpAdd(argv: string[], deps: { now?: Date; selector?: MinuteSelector; env?: NodeJS.ProcessEnv } = {}): Promise<{ id: string; subject: string; kind: FollowUpState["kind"]; plan_date?: string; next_run_at: string }> {
  const env = deps.env ?? process.env;
  const deliver = routeFromEnv(env);
  const { subject: rawSubject, kind, planDate: rawDate } = parseAddArgs(argv);
  const normalized = normalizeFollowUpSubject(rawSubject);
  const planDate = rawDate == null ? undefined : parseGregorianDate(rawDate);
  const now = deps.now ?? new Date();
  const tz = householdTz(env);
  const preferredRunAt = kind === "date"
    ? selectFollowUpInstant(planDate!, now, tz, deps.selector)
    : selectTopicFollowUpInstant(now, tz, deps.selector);
  const record = await mutate((tasks) => {
    if (tasks.filter((task) => !isCanonicalSystemRecord(task, SYSTEM_TASKS)).length >= ordinaryTaskLimit()) throw new Error(`schedule is full (${ordinaryTaskLimit()} tasks)`);
    const followUps = tasks.filter(isFollowUp);
    if (followUps.length >= 3) throw new Error("follow-up limit (3 pending)");
    const preferredDay = tzDateToken(new Date(preferredRunAt), tz);
    let adjustedTasks = tasks;
    if (kind === "date") {
      const displaced = followUps.find((task) => task.follow_up.kind === "topic" && tzDateToken(new Date(task.next_run_at), tz) === preferredDay);
      if (displaced) {
        const otherDays = new Set(followUps.filter((task) => task.id !== displaced.id).map((task) => tzDateToken(new Date(task.next_run_at), tz)));
        otherDays.add(preferredDay);
        const movedAt = nextFreeInstant(displaced.next_run_at, tz, otherDays);
        adjustedTasks = tasks.map((task) => task.id === displaced.id ? { ...task, at: movedAt, next_run_at: movedAt } : task);
      }
    }
    const occupiedDays = new Set(adjustedTasks.filter(isFollowUp).map((task) => tzDateToken(new Date(task.next_run_at), tz)));
    const nextRunAt = nextFreeInstant(preferredRunAt, tz, occupiedDays);
    const id = mintTaskId();
    const task: Task = {
      id, task: `Check back about ${normalized.subject}`, desc: `Check back about ${normalized.subject}`,
      cron: null, at: nextRunAt, tz, next_run_at: nextRunAt, invisible_until: null, attempts: 0,
      created_at: now.toISOString(), deliver, follow_up: { kind, subject: normalized.subject },
    };
    return { tasks: [...adjustedTasks, task], value: task };
  });
  return { id: record.id, subject: normalized.subject, kind, ...(planDate ? { plan_date: planDate.token } : {}), next_run_at: record.next_run_at };
}

async function main(): Promise<void> {
  const [, , command, ...argv] = process.argv;
  if (command !== "add") throw new Error('usage: followup-cli add "<subject>" <--plan-date YYYY-MM-DD|--topic>');
  console.log(JSON.stringify(await cmdFollowUpAdd(argv)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => { console.error(`followup-cli: ${(err as Error).message}`); process.exit(1); });
}
