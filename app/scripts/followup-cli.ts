#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import type { Task, TaskDeliver } from "./schedule-store.ts";
import {
  isCanonicalSystemRecord,
  mintTaskId,
  mutate,
  ordinaryTaskLimit,
  readTasksStrict,
} from "./schedule-store.ts";
import { SYSTEM_TASKS } from "./system-tasks.ts";
import { householdTz } from "./household-tz.ts";
import { admitEmail } from "./allowlist.ts";
import {
  normalizeFollowUpSubject,
  parseGregorianDate,
  selectFollowUpInstant,
  type MinuteSelector,
} from "./followup-normalization.ts";
import {
  FOLLOW_UP_TASK_MARKER,
  currentFollowUpAuthority,
  isFeatureShapedTask,
  validateStoredFollowUp,
  type FollowUpAuthority,
  type FollowUpOrigin,
} from "./followup-types.ts";
import { loadFollowUpRunContext, type FollowUpRunContext } from "./followup-context.ts";
import { findFollowUpCandidates, type FollowUpCandidate } from "./followup-candidates.ts";

export interface FollowUpSummary {
  id: string;
  subject: string;
  plan_date: string;
  next_run_at: string;
  origin: { surface: FollowUpOrigin["surface"] };
  desc: string;
}

interface DerivedRoute { origin: FollowUpOrigin; deliver: TaskDeliver; }

function deriveRoute(context: FollowUpRunContext): DerivedRoute {
  if (context.surface === "sms") return {
    origin: { surface: "sms", id: context.phone },
    deliver: { surface: "sms", target: context.phone },
  };
  if (context.surface === "sms-group") return {
    origin: { surface: "sms-group", id: context.group_id },
    deliver: { surface: "sms-group", target: context.group_id },
  };
  if (context.surface === "mail") return {
    origin: { surface: "mail-thread", id: context.thread_id },
    deliver: { surface: "mail-thread", target: context.thread_id },
  };
  const email = context.author_id.slice("member:".length);
  if (admitEmail(email) !== email) throw new Error("Home Chat follow-up requires the exact current member email author");
  return {
    origin: { surface: "home-chat", id: context.chat_id, email },
    deliver: { surface: "home-chat-email", target: email, chat_id: context.chat_id },
  };
}

function routeAuthorized(route: DerivedRoute, authority: FollowUpAuthority): boolean {
  const origin = route.origin;
  return origin.surface === "sms" ? authority.directSms(origin.id)
    : origin.surface === "sms-group" ? authority.groupSms(origin.id)
    : origin.surface === "mail-thread" ? authority.mailThread(origin.id)
    : authority.homeChat(origin.id, origin.email);
}

function loadCapability(
  env: NodeJS.ProcessEnv,
  authority?: FollowUpAuthority,
): { context: FollowUpRunContext; route: DerivedRoute; authority: FollowUpAuthority } {
  const context = loadFollowUpRunContext(env);
  const route = deriveRoute(context);
  const current = authority ?? currentFollowUpAuthority(env);
  if (!routeAuthorized(route, current)) throw new Error("follow-up origin is not currently authorized");
  return { context, route, authority: current };
}

function parseAddArgs(argv: string[]): { subject: string; planDate: string } {
  if (argv.length !== 3 || !argv[0] || argv[0].startsWith("--") || argv[1] !== "--plan-date" || !argv[2]) {
    throw new Error('usage: followup-cli add "<subject>" --plan-date YYYY-MM-DD');
  }
  return { subject: argv[0], planDate: argv[2] };
}

function parseCandidateArgs(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== "--plan-date" || !argv[1]) {
    throw new Error("usage: followup-cli candidates --plan-date YYYY-MM-DD");
  }
  return argv[1];
}

function sameOrigin(a: FollowUpOrigin, b: FollowUpOrigin): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function cmdFollowUpAdd(
  argv: string[],
  deps: { now?: Date; selector?: MinuteSelector; env?: NodeJS.ProcessEnv; authority?: FollowUpAuthority } = {},
): Promise<{ id: string; subject: string; plan_date: string; next_run_at: string }> {
  const env = deps.env ?? process.env;
  const { context, route, authority } = loadCapability(env, deps.authority); // before schedule access
  const parsed = parseAddArgs(argv);
  const normalized = normalizeFollowUpSubject(parsed.subject);
  const planDate = parseGregorianDate(parsed.planDate);
  const now = deps.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("follow-up creation time is invalid");
  const tz = householdTz(env);
  const nextRunAt = selectFollowUpInstant(planDate, now, tz, deps.selector);
  const createdAt = now.toISOString();
  const cap = ordinaryTaskLimit();

  const record = await mutate((tasks) => {
    // Re-read durable authority under the scheduler mutation lock. This keeps a
    // revocation racing creation fail-closed; provider stores remain separate
    // lock domains, so execution validates again before send.
    if (!routeAuthorized(route, authority)) throw new Error("follow-up origin is not currently authorized");
    const ordinary = tasks.filter((task) => !isCanonicalSystemRecord(task, SYSTEM_TASKS));
    if (ordinary.length >= cap) throw new Error(`schedule is full (${cap} tasks)`);
    for (const task of tasks) {
      if (!isFeatureShapedTask(task)) continue;
      const existing = validateStoredFollowUp(task).followUp;
      if (existing.turn_token === context.turn_token) throw new Error("a proactive follow-up already exists for the same turn");
      if (existing.subject_key === normalized.subjectKey && existing.plan_date === planDate.token && sameOrigin(existing.origin, route.origin)) {
        throw new Error("an exact proactive follow-up duplicate already exists");
      }
    }
    const id = mintTaskId();
    if (tasks.some((task) => task.id === id)) throw new Error("follow-up task id collision");
    const task: Task = {
      id,
      task: FOLLOW_UP_TASK_MARKER,
      desc: `Check back about ${normalized.subject}`,
      cron: null,
      at: nextRunAt,
      tz,
      next_run_at: nextRunAt,
      invisible_until: null,
      attempts: 0,
      created_at: createdAt,
      deliver: route.deliver,
      follow_up: {
        version: 1,
        subject: normalized.subject,
        subject_key: normalized.subjectKey,
        plan_date: planDate.token,
        turn_token: context.turn_token,
        origin: route.origin,
      },
    };
    return { tasks: [...tasks, task], value: task };
  });
  return { id: record.id, subject: normalized.subject, plan_date: planDate.token, next_run_at: nextRunAt };
}

export async function cmdFollowUpList(
  deps: { env?: NodeJS.ProcessEnv } = {},
): Promise<FollowUpSummary[]> {
  loadFollowUpRunContext(deps.env ?? process.env); // capability before schedule access
  const tasks = await readTasksStrict();
  const cap = ordinaryTaskLimit();
  if (tasks.filter((task) => !isCanonicalSystemRecord(task, SYSTEM_TASKS)).length > cap) throw new Error(`schedule store exceeds the ordinary task limit ${cap}`);
  const output: FollowUpSummary[] = [];
  for (const task of tasks) {
    if (!isFeatureShapedTask(task)) continue;
    const valid = validateStoredFollowUp(task);
    output.push({
      id: task.id,
      subject: valid.followUp.subject,
      plan_date: valid.followUp.plan_date,
      next_run_at: task.next_run_at,
      origin: { surface: valid.followUp.origin.surface },
      desc: task.desc!,
    });
  }
  if (output.length > cap) throw new Error(`follow-up list exceeds the ordinary task limit ${cap}`);
  return output;
}

export async function cmdFollowUpCandidates(
  argv: string[],
  deps: { env?: NodeJS.ProcessEnv; authority?: FollowUpAuthority } = {},
): Promise<FollowUpCandidate[]> {
  const env = deps.env ?? process.env;
  loadCapability(env, deps.authority); // capability + current admission before schedule access
  const planDate = parseGregorianDate(parseCandidateArgs(argv));
  const tasks = await readTasksStrict();
  return findFollowUpCandidates(tasks, planDate, householdTz(env), ordinaryTaskLimit());
}

async function main(): Promise<void> {
  const [, , command, ...argv] = process.argv;
  if (command === "add") console.log(JSON.stringify(await cmdFollowUpAdd(argv)));
  else if (command === "list") {
    if (argv.length) throw new Error("usage: followup-cli list");
    console.log(JSON.stringify(await cmdFollowUpList(), null, 2));
  } else if (command === "candidates") console.log(JSON.stringify(await cmdFollowUpCandidates(argv), null, 2));
  else throw new Error("usage: followup-cli <add|list|candidates> …");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(`followup-cli: ${(err as Error).message}`);
    process.exit(1);
  });
}
