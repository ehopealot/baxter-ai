import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "./schedule-store.ts";
import type { FireResult, ExecutionContext } from "./heartbeat.ts";
import { runAgent, type RunAgentResult } from "./runtime.ts";
import { MEMORY_DIR } from "./paths.ts";
import { sanitizeGeneratedFollowUp } from "./followup-normalization.ts";
import { validateFollowUpTask, type FollowUpAuthority } from "./followup-types.ts";
import { markFollowUpSendStarted, withFollowUpDeliveryLock } from "./followup-delivery-lock.ts";
import { sendSms, sendGroupSms } from "./sms-cli.ts";
import { buildChat, sendNew, sendReply } from "./mail-cli.ts";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNS_DIR = join(APP_DIR, ".claude", "followup-runs");
const GENERATION_INSTRUCTION = "Write one brief, warm, conversational check-in about the supplied future plan. Ask how it is going or whether it is still on; do not claim the plan happened, do not mention scheduling, and output plain text only.";

export interface FollowUpQueueCommitter {
  reload(taskId: string): Promise<Task | null>;
  success(taskId: string): Promise<void>;
  failure(taskId: string): Promise<{ gaveUp: boolean }>;
}

export interface FollowUpExecutionResult extends FireResult {
  queueCommitted?: "completed" | "failed" | "gave-up";
}

export interface FollowUpGenerationResult extends RunAgentResult { toolUseCount: number; }

export async function sendMailThread(threadId: string, body: string): Promise<void> {
  const { adapter, chat } = buildChat();
  await sendReply(threadId, body, { adapter, chat });
}

export async function sendHomeChatEmail(email: string, subject: string, body: string): Promise<void> {
  await sendNew(email, subject, body, {});
}

function immutableSnapshot(task: Task): string {
  return JSON.stringify({
    id: task.id, task: task.task, desc: task.desc, cron: task.cron, at: task.at, tz: task.tz,
    next_run_at: task.next_run_at, deliver: task.deliver, created_at: task.created_at,
    follow_up: task.follow_up, system: task.system, system_trigger: task.system_trigger,
  });
}

function validLink(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.host) throw new Error("Home Chat link is invalid");
  return url.toString();
}

export function makeFollowUpExecutor(deps: {
  runAgent: typeof runAgent;
  authority: () => FollowUpAuthority;
  sendSms: typeof sendSms;
  sendGroupSms: typeof sendGroupSms;
  sendReply: (threadId: string, body: string) => Promise<void>;
  sendHomeChatEmail: (email: string, subject: string, body: string) => Promise<void>;
  resolveChatLink: (chatId: string) => string;
}): (task: Task, ctx: ExecutionContext, queue: FollowUpQueueCommitter) => Promise<FollowUpExecutionResult> {
  return async (task, ctx, queue) => {
    let initial;
    try { initial = validateFollowUpTask(task, deps.authority()); }
    catch { return { ok: false, agentRun: false }; }

    const slot = await ctx.reserveAgentRun();
    if (slot === null) return { ok: false, deferredByCap: true, agentRun: false };
    let generation: RunAgentResult;
    try {
      generation = await deps.runAgent({
        prompt: `${GENERATION_INSTRUCTION}\n\n${JSON.stringify({ subject: initial.followUp.subject, plan_date: initial.followUp.plan_date })}`,
        logId: `followup-${task.id}-${Date.now()}`,
        surface: "heartbeat",
        cwd: MEMORY_DIR,
        allowedTools: "",
        runsDir: RUNS_DIR,
        env: process.env,
        suppressContent: true,
      });
    } catch { return { ok: false, agentRun: true }; }
    if (generation.outOfTokens) {
      await ctx.releaseAgentRun(slot.token);
      return { ok: false, outOfTokens: true, agentRun: true };
    }
    if (generation.failed || generation.succeeded !== true || generation.toolUseCount !== 0 || typeof generation.resultText !== "string") {
      return { ok: false, agentRun: true };
    }
    let body: string;
    try { body = sanitizeGeneratedFollowUp(generation.resultText); }
    catch { return { ok: false, agentRun: true }; }

    return withFollowUpDeliveryLock(task.id, async () => {
      const current = await queue.reload(task.id);
      if (current === null) {
        await queue.success(task.id);
        return { ok: true, agentRun: true, queueCommitted: "completed" };
      }
      let valid;
      try {
        if (immutableSnapshot(current) !== immutableSnapshot(task)) throw new Error("follow-up task changed after claim");
        valid = validateFollowUpTask(current, deps.authority());
      } catch {
        const failure = await queue.failure(task.id);
        return { ok: false, agentRun: true, queueCommitted: failure.gaveUp ? "gave-up" : "failed" };
      }

      try {
        const origin = valid.followUp.origin;
        if (origin.surface === "home-chat") {
          const link = validLink(deps.resolveChatLink(origin.id));
          markFollowUpSendStarted(task.id);
          await deps.sendHomeChatEmail(origin.email, `Checking back about ${valid.followUp.subject}`, `${body}\n\n${link}`);
        } else if (origin.surface === "mail-thread") {
          markFollowUpSendStarted(task.id);
          await deps.sendReply(origin.id, body);
        } else if (origin.surface === "sms-group") {
          markFollowUpSendStarted(task.id);
          await deps.sendGroupSms(origin.id, body);
        } else {
          markFollowUpSendStarted(task.id);
          await deps.sendSms(origin.id, body);
        }
        await queue.success(task.id);
        return { ok: true, agentRun: true, queueCommitted: "completed" };
      } catch {
        const failure = await queue.failure(task.id);
        return { ok: false, agentRun: true, queueCommitted: failure.gaveUp ? "gave-up" : "failed" };
      }
    });
  };
}
