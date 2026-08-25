import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "./schedule-store.ts";
import type { FireResult, ExecutionContext } from "./heartbeat.ts";
import { runAgent, type RunAgentResult } from "./runtime.ts";
import { sanitizeGeneratedFollowUp } from "./followup-normalization.ts";
import { validateFollowUpTask, type FollowUpAuthority } from "./followup-types.ts";
import { FOLLOW_UP_PROVIDER_TIMEOUT_MS, markFollowUpSendStarted, withFollowUpDeliveryLock } from "./followup-delivery-lock.ts";
import { sendSms, sendGroupSms } from "./sms-cli.ts";
import { buildChat, sendNew, sendReply } from "./mail-cli.ts";

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

interface ProviderOptions { signal?: AbortSignal; }

export async function sendMailThread(threadId: string, body: string, options: ProviderOptions = {}): Promise<void> {
  const { adapter, chat } = buildChat();
  await sendReply(threadId, body, { adapter, chat, signal: options.signal });
}

export async function sendHomeChatEmail(email: string, subject: string, body: string, options: ProviderOptions = {}): Promise<void> {
  await sendNew(email, subject, body, { signal: options.signal });
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

async function boundedProvider<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("follow-up provider timeout is invalid");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`follow-up provider timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    // Do not Promise.race: await the abort-aware provider itself so its request
    // has actually settled before the delivery lock can be released.
    return await operation(controller.signal);
  } finally { clearTimeout(timer); }
}

export function makeFollowUpExecutor(deps: {
  runAgent: typeof runAgent;
  authority: () => FollowUpAuthority;
  sendSms: typeof sendSms;
  sendGroupSms: typeof sendGroupSms;
  sendReply: (threadId: string, body: string, options?: ProviderOptions) => Promise<void>;
  sendHomeChatEmail: (email: string, subject: string, body: string, options?: ProviderOptions) => Promise<void>;
  resolveChatLink: (chatId: string) => string;
  providerTimeoutMs?: number;
}): (task: Task, ctx: ExecutionContext, queue: FollowUpQueueCommitter) => Promise<FollowUpExecutionResult> {
  return async (task, ctx, queue) => {
    let initial;
    try { initial = validateFollowUpTask(task, deps.authority()); }
    catch { return { ok: false, agentRun: false }; }

    const slot = await ctx.reserveAgentRun();
    if (slot === null) return { ok: false, deferredByCap: true, agentRun: false };
    let generation: RunAgentResult;
    const generationCwd = mkdtempSync(join(tmpdir(), "baxter-followup-generation-"));
    try {
      generation = await deps.runAgent({
        prompt: `${GENERATION_INSTRUCTION}\n\n${JSON.stringify({ subject: initial.followUp.subject, plan_date: initial.followUp.plan_date })}`,
        logId: `followup-${task.id}-${Date.now()}`,
        surface: "heartbeat",
        cwd: generationCwd,
        allowedTools: "",
        // Content-suppressed generation persists no raw run log, so keep runAgent's
        // required directory inside the already-private cwd. This avoids a source-tree
        // write and lets the finally below remove the entire generation footprint.
        runsDir: generationCwd,
        // Trusted daemon env reaches runAgent so its once-per-process data-key
        // sync sees first-run/rotated source keys. runAgent centrally strips
        // those keys (and all surface secrets) only from the spawned child.
        env: process.env,
        suppressContent: true,
      });
    } catch { return { ok: false, agentRun: true }; }
    finally { rmSync(generationCwd, { recursive: true, force: true }); }
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
        const timeoutMs = deps.providerTimeoutMs ?? FOLLOW_UP_PROVIDER_TIMEOUT_MS;
        if (origin.surface === "home-chat") {
          const link = validLink(deps.resolveChatLink(origin.id));
          markFollowUpSendStarted(task.id);
          await boundedProvider(timeoutMs, (signal) => deps.sendHomeChatEmail(origin.email, `Checking back about ${valid.followUp.subject}`, `${body}\n\n${link}`, { signal }));
        } else if (origin.surface === "mail-thread") {
          markFollowUpSendStarted(task.id);
          await boundedProvider(timeoutMs, (signal) => deps.sendReply(origin.id, body, { signal }));
        } else if (origin.surface === "sms-group") {
          markFollowUpSendStarted(task.id);
          await boundedProvider(timeoutMs, (signal) => deps.sendGroupSms(origin.id, body, { signal }));
        } else {
          markFollowUpSendStarted(task.id);
          await boundedProvider(timeoutMs, (signal) => deps.sendSms(origin.id, body, { signal }));
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
