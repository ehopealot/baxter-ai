#!/usr/bin/env node
// The heartbeat driver: one node loop that fires due scheduled tasks. Structural
// twin of poll.ts. Fires happen OUTSIDE the lock; claims/completions are locked.
// Every tick FIRST runs the reconciliation gate (runReconcileGate) and scans only
// its canonical snapshot; every id-based mutation revalidates in-lock against
// reserved-namespace collisions and duplicated ids; system records dispatch
// through compile-time registry handlers, never through the ordinary runFn.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, harnessLabel, skillsPreamble } from "./runtime.ts";
import {
  mutate, selectDue, applyClaim, applyOnSuccess, applyOnFailure, appendLog, capSkipLoggedToday, envInt, resolveNextRun,
} from "./schedule-store.ts";
import type { Task } from "./schedule-store.ts";
import { reserveAgentRunSlot, releaseAgentRunSlot } from "./fire-quota.ts";
import {
  ReservedIdCollisionError, AmbiguousIdError, reconcileSystemTasks, refuseOnCollision, systemTriggerKey, selectWindowOccurrence, occurrenceExpired,
} from "./system-reconcile.ts";
import { SYSTEM_TASKS, findSystemDef, systemTaskEnabled } from "./system-tasks.ts";
import type { SystemTaskContext, SystemTaskDefinition, SystemTaskResult } from "./system-tasks.ts";
import { householdTz } from "./household-tz.ts";
import { tzDateToken, zonedToUtcMs } from "./tz.ts";
import { MEMORY_DIR, LEARNED_SKILLS_DIR, DISCORD_TOKEN_PATH, MAIL_KEYS_PATH } from "./paths.ts";
import { HEARTBEAT_TOOLS, HEARTBEAT_SKILL_SRCS, HEARTBEAT_SKILL_NAMES, MAIL_CLI as MAIL_CLI_PATH, loadedSkillsList } from "./grants.ts";
import { collectionsPreamble } from "./collections-cli.ts";
import { householdPreamble } from "./household.ts";
import { currentFollowUpAuthority, isFeatureShapedTask } from "./followup-types.ts";
import {
  makeFollowUpExecutor, sendHomeChatEmail, sendMailThread,
  type FollowUpExecutionResult, type FollowUpQueueCommitter,
} from "./followup-execution.ts";
import { sendGroupSms, sendSms } from "./sms-cli.ts";
import { resolveChatLink } from "./link-cli.ts";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPT_PATH = join(APP_DIR, "heartbeat-prompt.md");
const RUNS_DIR = join(APP_DIR, ".claude", "heartbeat-runs");
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");
const MODEL = process.env.BAXTER_MODEL || "sonnet";
const INTERVAL_MS = envInt("HEARTBEAT_INTERVAL_SECONDS", 60) * 1000;
// envInt permits 0, but a 0 interval hot-spins the driver loop (setTimeout fires
// immediately), so reject it loudly -- same guard as poll.ts's interval.
if (INTERVAL_MS === 0) throw new Error("HEARTBEAT_INTERVAL_SECONDS must be >= 1");
const VISIBILITY_MS = envInt("HEARTBEAT_VISIBILITY_MINUTES", 15) * 60000;
const MAX_ATTEMPTS = envInt("HEARTBEAT_MAX_ATTEMPTS", 3);
const FIRE_CAP = envInt("HEARTBEAT_MAX_FIRES_PER_DAY", 200);
const FALLBACK_TZ = process.env.HEARTBEAT_TZ || "America/Los_Angeles";
// Fired run's grants + staged skills live in grants.ts (see the module header):
// HEARTBEAT_TOOLS is Baxter's usual grants MINUS schedule-cli (a scheduled task
// can't touch the schedule) PLUS mail + discord so a fire can deliver to either.
const RUN_ENV = { ...process.env };
delete RUN_ENV.DISCORD_BOT_TOKEN;

const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter";
// Surfaced to the prompt so a fire can address the operator explicitly on `send`
// (which now takes a recipient arg) and use them as the delivery fallback.
const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || "";

const DEFAULT_FOLLOW_UP_EXECUTOR = makeFollowUpExecutor({
  runAgent,
  authority: () => currentFollowUpAuthority(process.env),
  sendSms,
  sendGroupSms,
  sendReply: sendMailThread,
  sendHomeChatEmail,
  resolveChatLink: (chatId) => resolveChatLink(chatId, process.env),
});

// Preserve heartbeat's exported result name as a compatibility alias while
// ordinary fires and system handlers share the single documented contract.
export type FireResult = SystemTaskResult;

// The per-fire reservation context tick hands each executor. Built PER FIRE --
// once per claimed task -- as { reserveAgentRun: () => opts.reserveAgentRunFor(task.id), ... }
// so the reservation persisted to fire-quota.json is bound to the id of the
// task that actually fired; a context built once per tick would persist an
// undefined/wrong task field. The zero-arg reserveAgentRun() shape is the
// spec's contract for both this and SystemTaskContext.
export interface ExecutionContext {
  reserveAgentRun(): Promise<{ token: string } | null>;
  releaseAgentRun(token: string): Promise<void>;
}

// The full prompt for one fired task, extracted from the ordinary fire path
// (makeFireTask below) so the template fill -- and its slot map -- is
// unit-testable without an agent run. The slot map is the old inline one
// moved verbatim, plus HOUSEHOLD.
export function buildTaskPrompt(task: Task): string {
  const deliver = task.deliver
    ? `${task.deliver.surface} -> ${task.deliver.target}`
    : "(no delivery — just do the task; it is logged)";
  // fillTemplate is the shared single-pass, prototype-safe {{KEY}} substitution.
  return fillTemplate(readFileSync(PROMPT_PATH, "utf8"), {
    PERSONA_NAME, TASK: task.task as string, DELIVER: deliver,
    OPERATOR_EMAIL,
    MEMORY_PATH: join(MEMORY_DIR, "memory.md"), MAIL_CLI_PATH,
    // Injection-safe (slug + date only) -- see collectionsPreamble.
    COLLECTIONS_LIST: collectionsPreamble(),
    // Static list of the surface's baked skills (from grants.ts), so a `make add-skill`
    // skill is surfaced to the model without editing the prompt.
    LOADED_SKILLS: loadedSkillsList(HEARTBEAT_SKILL_NAMES),
    // Injection-safe (learned-skill NAMES only, sanitized) -- see skillsPreamble.
    LEARNED_SKILLS_LIST: skillsPreamble(),
    // Injection-safe (admitted addresses only, sanitized names) -- see householdPreamble.
    HOUSEHOLD: householdPreamble(),
  });
}

// The ordinary fire path, exported as a MINIMAL seam so the REAL path's
// reserve-before-run ordering is unit-testable with an injected runAgent (the
// old private fireTask was untestable: this module imports the real runAgent
// statically). deps.runAgent defaults to that real import, so production
// behavior is byte-identical; main() wires runFn: makeFireTask(). The seam
// injects ONLY runAgent -- prompt building, grants/env, runsDir, and the
// result mapping all stay inside.
export function makeFireTask(deps: { runAgent: typeof runAgent } = { runAgent }): (task: Task, ctx: ExecutionContext) => Promise<FireResult> {
  return async (task, ctx) => {
    const prompt = buildTaskPrompt(task);
    // Reserve the agent-run slot IMMEDIATELY BEFORE the model run: a denied
    // reservation (null) defers the occurrence instead of running it, so the
    // durable UTC cap is enforced before -- not after -- any model call.
    const slot = await ctx.reserveAgentRun();
    if (slot === null) return { ok: false, deferredByCap: true, agentRun: false };
    // A fire succeeds only if the run neither hit a hard error (`failed`:
    // non-zero exit / spawn failure / missing binary) nor ran out of tokens.
    // Out-of-tokens is surfaced separately so tick can pause rather than count
    // it a failure.
    const { outOfTokens, failed } = await deps.runAgent({
      prompt, logId: `${task.id}-${Date.now()}`, surface: "heartbeat", cwd: MEMORY_DIR, model: MODEL,
      allowedTools: HEARTBEAT_TOOLS, runsDir: RUNS_DIR, env: RUN_ENV,
      beforeRun: () => { ensurePlaywrightConfig(MEMORY_DIR); ensureSkills(HEARTBEAT_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR); },
    });
    if (outOfTokens) {
      // A global token outage is not this fire's fault and must not burn cap:
      // refund exactly this fire's slot (release is atomic + idempotent) and
      // surface out-of-tokens so tick keeps the claim for a free retry.
      await ctx.releaseAgentRun(slot.token);
      return { ok: false, outOfTokens: true, agentRun: true };
    }
    // Success and hard failure both keep the reservation consumed (fail-closed
    // cap: a fire that ran a model always counts against it).
    return { ok: !failed, agentRun: true };
  };
}

export interface TickOptions {
  runFn: (task: Task, ctx: ExecutionContext) => Promise<FireResult>;
  // Reservation seams tick builds each per-fire ExecutionContext from. The cap
  // moved from tick's pre-executor log count to this durable pre-runAgent
  // reservation: only the executor knows whether its fire needs a model run,
  // so only it can decide to consume a slot (and defer when the window is full).
  reserveAgentRunFor(taskId: string): Promise<{ token: string } | null>;
  releaseAgentRun(token: string): Promise<void>;
  visibilityMs: number;
  maxAttempts: number;
  fallbackTz: string;
  // T12: the gate + system dispatch wiring, all optional with real defaults.
  // registry defaults to the compile-time SYSTEM_TASKS; log defaults to a
  // console-compatible sink; handler identity resolves ONLY by validated key
  // from the registry (tests inject fakes under test-local keys).
  registry?: readonly SystemTaskDefinition<string>[];
  systemHandlerResolver?: SystemHandlerResolver;
  log?: (msg: string) => void;
  /** Fresh clock sampled while claiming; production defaults to wall clock. */
  claimNow?: (snapshotNowMs: number) => Date;
  /** Dedicated strict executor for every feature-shaped record. */
  followUpExecutor?: ReturnType<typeof makeFollowUpExecutor>;
}

// A system handler as resolved from the registry by its key: exactly a
// definition's execute (handler identity never comes from disk).
export type SystemHandlerFn = (task: Task, ctx: SystemTaskContext) => Promise<SystemTaskResult>;
export type SystemHandlerResolver = (key: string) => SystemHandlerFn | undefined;

function defaultSystemHandlerResolver(key: string): SystemHandlerFn | undefined {
  return findSystemDef(SYSTEM_TASKS, key)?.execute;
}

function appendFireOutcome(
  nowMs: number,
  claimed: Task,
  result: FireResult,
  outcome: "completed" | "failed" | "gave-up",
): void {
  appendLog({
    ts: new Date(nowMs).toISOString(),
    id: claimed.id,
    task: claimed.task,
    outcome,
    deliver: claimed.deliver,
    agent_run: result.agentRun ?? (claimed.system != null || claimed.system_trigger != null ? false : true),
    system_key: claimed.system?.key ?? claimed.system_trigger?.key,
    detail: result.detail,
  });
}

// The reconciliation gate as an exported FINITE helper (main() is an infinite
// loop -- the gate body must be independently callable and testable). Runs the
// whole reconcile inside ONE schedule-store mutate() transaction (a no-change
// reconcile skips the rewrite via the store's JSON-equality check), catches
// ReservedIdCollisionError itself -- logging the operator repair instruction
// it carries -- and returns ok:false instead of throwing past the helper so
// the daemon loop stays alive; every tick keeps refusing until the operator
// repairs, after which the next reconcile creates/restores the system task
// under its canonical id. Called once in main() before the loop and FIRST in
// every tick; tick scans ONLY the returned canonical snapshot (never re-reads
// the store), so a collision hand-edited in after startup is caught here.
export async function runReconcileGate(
  now: Date,
  opts: { registry?: readonly SystemTaskDefinition<string>[]; log?: (msg: string) => void } = {},
): Promise<{ ok: true; tasks: Task[] } | { ok: false; error: string }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  try {
    const outcome = await mutate((tasks) => {
      const r = reconcileSystemTasks(tasks, opts.registry ?? SYSTEM_TASKS, now, householdTz(process.env), log);
      return { tasks: r.tasks, value: r };
    });
    return { ok: true, tasks: outcome.tasks };
  } catch (err) {
    if (err instanceof ReservedIdCollisionError) {
      log(err.message);
      return { ok: false, error: err.message };
    }
    throw err; // anything else (e.g. a malformed registry cron) fails loud at the gate
  }
}

// The UTC instant the agent-run cap window resets at: the start of the next
// UTC day after nowMs. Computed from the tick's injected instant, never the
// ambient wall clock (quota reset, skip-line logging, and this deferral target
// all read one instant).
function nextUtcResetMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// Every id-based heartbeat write uses this transaction wrapper. The collision
// guard is deliberately the first in-lock operation, before the callback can
// inspect or update task records.
function mutateTaskGuarded<V>(
  id: string,
  registry: readonly SystemTaskDefinition<string>[],
  mutation: (tasks: Task[]) => { tasks: Task[]; value: V },
): Promise<V> {
  return mutate((tasks) => {
    refuseOnCollision(tasks, registry, { mutatedId: id });
    return mutation(tasks);
  });
}

// Defer one due record to the next UTC quota reset: invisible_until only --
// next_run_at stays due (the occurrence is deferred, not cancelled) and
// attempts are untouched. Its own per-record mutate() transaction of the same
// id-based shape the claim/success/failure writes use, so it takes the same
// in-lock refuseOnCollision({ mutatedId }) guard; a guard refusal (a duplicate id
// or reserved-namespace collision appearing between the due snapshot and this
// write) is caught PER RECORD -- the id is logged, the record is left due with
// nothing written -- and the deferral pass continues with the remaining
// occurrences. Anything else (a lock/FS/JSON failure out of mutate) is an
// infrastructure error, NOT a refusal: it is rethrown so it reaches main's
// per-tick handler instead of being mislabeled a guard refusal and swallowed.
async function deferRecordToReset(
  id: string,
  resetMs: number,
  registry: readonly SystemTaskDefinition<string>[],
  log: (m: string) => void,
): Promise<boolean> {
  const resetIso = new Date(resetMs).toISOString();
  try {
    await mutateTaskGuarded(id, registry, (tasks) => {
      let hit = false;
      const next = tasks.map((t) => { if (t.id !== id) return t; hit = true; return { ...t, invisible_until: resetIso }; });
      return { tasks: hit ? next : tasks, value: null };
    });
    return true;
  } catch (err) {
    // Only guard refusals are per-record recoverable (duplicated id /
    // reserved-namespace violation); everything else is infrastructure and
    // must escape the tick rather than masquerade as a refusal.
    if (!(err instanceof ReservedIdCollisionError) && !(err instanceof AmbiguousIdError)) throw err;
    log(`[heartbeat] deferral refused for '${id}' -- duplicated id left due, nothing written: ${(err as Error).message}`);
    return false;
  }
}

// A deferredByCap result is neither a success nor a failure: no attempt
// increment, no cron advance, no completed/failed log entry. Defer the deferred
// record AND every remaining due occurrence of THIS tick's snapshot to the next
// UTC reset, write at most one skipped line per UTC day (checked at the tick's
// injected instant), then END the tick. The termination is load-bearing:
// applyClaim matches by id and UNCONDITIONALLY overwrites invisible_until, so a
// loop continuing over this stale `due` snapshot would re-claim and re-execute
// the just-deferred records (for the digest, re-running its feed-refresh
// preflight) and undo the deferral; the next tick re-selects from a fresh
// snapshot in which they are invisible until the reset.
async function deferCapExhausted(
  due: Task[],
  deferredIndex: number,
  claimed: Task,
  nowMs: number,
  registry: readonly SystemTaskDefinition<string>[],
  log: (m: string) => void,
): Promise<void> {
  const resetMs = nextUtcResetMs(nowMs);
  const deferred = await deferRecordToReset(claimed.id, resetMs, registry, log);
  if (deferred && !capSkipLoggedToday(new Date(nowMs))) {
    appendLog({ ts: new Date(nowMs).toISOString(), id: claimed.id, task: claimed.task, outcome: "skipped", detail: "agent-run cap reached - deferred to next UTC reset" });
  }
  for (let j = deferredIndex + 1; j < due.length; j++) await deferRecordToReset(due[j].id, resetMs, registry, log);
}

export async function tick(
  nowMs: number,
  {
    runFn, reserveAgentRunFor, releaseAgentRun, visibilityMs, maxAttempts, fallbackTz,
    registry = SYSTEM_TASKS,
    systemHandlerResolver = defaultSystemHandlerResolver,
    log = (m: string) => console.log(m),
    claimNow = () => new Date(),
    followUpExecutor = DEFAULT_FOLLOW_UP_EXECUTOR,
  }: TickOptions,
): Promise<void> {
  // The gate runs FIRST: reconcile inside one transaction, then scan ONLY its
  // returned canonical snapshot (never re-read the store). On a reserved-id
  // collision nothing is selected, claimed, or dispatched -- the gate already
  // logged the repair instruction -- and the tick returns without throwing.
  const gate = await runReconcileGate(new Date(nowMs), { registry, log });
  if (!gate.ok) return;
  // Strict literal-true due filter: disabled and not-yet-repaired malformed
  // system records are never selected, even with a stale due next_run_at.
  const due = selectDue(gate.tasks, nowMs).filter((t) => isFeatureShapedTask(t) || !t.system || systemTaskEnabled(t));
  for (let i = 0; i < due.length; i++) {
    const dueTask = due[i];
    // Claim under the lock; a concurrent cancel makes claim return null -> skip.
    // The in-lock guard refuses reserved-namespace collisions and duplicated
    // ids (the queue helpers mutate EVERY record sharing an id) with no write,
    // and a system task disabled between the tick's snapshot and this claim is
    // NOT dispatched: the strict-enabled recheck runs against the CURRENT
    // locked record, not the snapshot (a 'schedule-cli system disable'
    // completing mid-tick must not fire).
    const claim = await mutateTaskGuarded(dueTask.id, registry, (tasks) => {
      const current = tasks.find((t) => t.id === dueTask.id);
      if (current?.system != null && !isFeatureShapedTask(current) && !systemTaskEnabled(current)) {
        return { tasks, value: { claimed: null as Task | null, refusedEnabled: true, claimTime: null as Date | null, expiry: null as { key: string; selected: string; cutoff: string; outcome: string } | null } };
      }
      // Sample inside the guarded transaction: a tick snapshot taken before noon
      // must not claim a ranged occurrence after its occurrence-date cutoff.
      const claimTime = claimNow(nowMs);
      const def = current?.system ? findSystemDef(registry, current.system.key) : undefined;
      if (current && def?.window && occurrenceExpired(current, def, claimTime, householdTz(process.env))) {
        const tz = householdTz(process.env), selected = current.next_run_at;
        const date = new Date(tzDateToken(new Date(selected), tz));
        const cutoff = new Date(zonedToUtcMs(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), def.window.cutoffHour, 0, 0, tz)).toISOString();
        const replacement = { ...current, invisible_until: null, attempts: 0,
          next_run_at: selectWindowOccurrence(def, claimTime, tz, undefined, true) };
        return { tasks: tasks.map((task) => task === current ? replacement : task), value: { claimed: null as Task | null, refusedEnabled: false, claimTime: null as Date | null, expiry: { key: def.key, selected, cutoff, outcome: "replaced" } } };
      }
      const r = applyClaim(tasks, dueTask.id, claimTime.getTime(), visibilityMs);
      return { tasks: r.tasks, value: { claimed: r.claimed as Task | null, refusedEnabled: false, claimTime, expiry: null as { key: string; selected: string; cutoff: string; outcome: string } | null } };
    });
    if (claim.refusedEnabled) {
      log(`[heartbeat] ${dueTask.id} is disabled -- not dispatched`);
      continue;
    }
    if (claim.expiry != null) {
      const { key, selected, cutoff, outcome } = claim.expiry;
      log(`[heartbeat] claim-time expiry reason=cutoff system_key=${key} selected=${selected} cutoff=${cutoff} queue_outcome=${outcome}`);
      continue;
    }
    if (claim.claimed == null) continue; // cancellation (or removal) won the race
    const claimed = claim.claimed;
    // Per-fire context: the reservation binds to the id of the task firing NOW.
    const reserveForThisFire = (): Promise<{ token: string } | null> => reserveAgentRunFor(claimed.id);
    let result: FireResult & { queueCommitted?: FollowUpExecutionResult["queueCommitted"] };
    if (isFeatureShapedTask(claimed)) {
      // Feature classification outranks every executable dispatch identity,
      // including registry-owned systems and one-shot triggers.
      const nextOccurrence = (record: Task): string => {
        const def = record.system ? findSystemDef(registry, record.system.key) : undefined;
        return def?.window ? selectWindowOccurrence(def, new Date(nowMs), householdTz(process.env), undefined, true) : resolveNextRun(record, nowMs, fallbackTz);
      };
      const queue: FollowUpQueueCommitter = {
        reload: (taskId) => mutateTaskGuarded(taskId, registry, (tasks) => ({
          tasks,
          value: tasks.find((record) => record.id === taskId) ?? null,
        })),
        success: (taskId) => mutateTaskGuarded(taskId, registry, (tasks) => ({
          tasks: applyOnSuccess(tasks, taskId, nowMs, fallbackTz, nextOccurrence),
          value: undefined,
        })),
        failure: (taskId) => mutateTaskGuarded(taskId, registry, (tasks) => {
          const applied = applyOnFailure(tasks, taskId, nowMs, maxAttempts, fallbackTz, nextOccurrence);
          return { tasks: applied.tasks, value: { gaveUp: applied.gaveUp } };
        }),
        markDeliveryStarted: (taskId) => mutateTaskGuarded(taskId, registry, (tasks) => {
          const current = tasks.find((record) => record.id === taskId);
          if (current == null) return { tasks, value: null };
          const started = {
            ...current,
            follow_up: { ...current.follow_up!, delivery_started_at: new Date().toISOString() },
          };
          return { tasks: tasks.map((record) => record.id === taskId ? started : record), value: started };
        }),
      };
      try { result = await followUpExecutor(claimed, { reserveAgentRun: reserveForThisFire, releaseAgentRun }, queue); }
      catch { result = { ok: false }; }
    } else {
      const triggerKey = systemTriggerKey(claimed, registry);
      const expectedTrigger = Object.prototype.hasOwnProperty.call(dueTask, "system_trigger");
      if (claimed.system != null || triggerKey != null) {
        // System dispatch: handler identity comes ONLY from the registry, by the
        // validated key -- never from the persisted record. A trigger uses the
        // same handler while remaining independent of its recurring record's
        // enabled/claim/retry state.
        const key = claimed.system?.key ?? triggerKey!;
        const handler = systemHandlerResolver(key);
        if (handler == null) {
          log(`[heartbeat] no registered handler for system key '${key}' -- refusing to dispatch ${claimed.id}`);
          continue;
        }
        const sysCtx: SystemTaskContext = { now: claim.claimTime!, reserveAgentRun: reserveForThisFire, releaseAgentRun, log };
        try { result = await handler(claimed, sysCtx); } catch { result = { ok: false }; }
      } else if (expectedTrigger || Object.prototype.hasOwnProperty.call(claimed, "system_trigger")) {
        // Defense in depth for a trigger edited between reconciliation and claim:
        // never let an invalid trigger fall through to the ordinary prompt path.
        log(`[heartbeat] invalid system trigger ${claimed.id} -- refusing to dispatch`);
        continue;
      } else {
        try { result = await runFn(claimed, { reserveAgentRun: reserveForThisFire, releaseAgentRun }); } catch { result = { ok: false }; }
      }
    }
    if (result.queueCommitted) {
      appendFireOutcome(nowMs, claimed, result, result.queueCommitted);
      continue;
    }
    if (result.deferredByCap) {
      await deferCapExhausted(due, i, claimed, nowMs, registry, log);
      return; // the deferral pass ENDS the tick
    }
    if (result.ok) {
      await mutateTaskGuarded(claimed.id, registry, (tasks) => ({
        tasks: applyOnSuccess(tasks, claimed.id, nowMs, fallbackTz, (record) => {
          const def = record.system ? findSystemDef(registry, record.system.key) : undefined;
          return def?.window ? selectWindowOccurrence(def, new Date(nowMs), householdTz(process.env), undefined, true) : resolveNextRun(record, nowMs, fallbackTz);
        }),
        value: null,
      }));
      // Ordinary/legacy fires default agent_run true; a system fire defaults
      // false (an unset agentRun on a system result means no model ran). detail
      // carries the handler's bounded aggregate (counts/states only, never a
      // digest body); an ordinary fire's undefined detail serializes away.
      appendFireOutcome(nowMs, claimed, result, "completed");
    } else if (result.outOfTokens) {
      // A token outage is global and hours-long -- not this task's fault. Leave
      // the claim in place (it retries for free when invisible_until expires,
      // without burning an attempt) and stop the tick so the rest of the due
      // list doesn't burn attempts against the same outage.
      break;
    } else {
      const { gaveUp } = await mutateTaskGuarded(claimed.id, registry, (tasks) => {
        const r = applyOnFailure(tasks, claimed.id, nowMs, maxAttempts, fallbackTz, (record) => {
          const def = record.system ? findSystemDef(registry, record.system.key) : undefined;
          return def?.window ? selectWindowOccurrence(def, new Date(nowMs), householdTz(process.env), undefined, true) : resolveNextRun(record, nowMs, fallbackTz);
        });
        return { tasks: r.tasks, value: r };
      });
      appendFireOutcome(nowMs, claimed, result, gaveUp ? "gave-up" : "failed");
    }
  }
}

export interface HeartbeatDeps {
  log?: (msg: string) => void;
  logErr?: (msg: string) => void;
}

export async function main(deps: HeartbeatDeps = {}): Promise<void> {
  // Defaults keep standalone output exactly as it was: heartbeat daemon lines
  // go to stdout/stderr only. A consolidated supervisor injects a real logger.
  const log = deps.log ?? ((m: string) => console.log(m));
  const logErr = deps.logErr ?? ((m: string) => console.error(m));
  const token = process.env.DISCORD_BOT_TOKEN;
  if (token) { mkdirSync(dirname(DISCORD_TOKEN_PATH), { recursive: true }); writeFileSync(DISCORD_TOKEN_PATH, JSON.stringify({ token }), { mode: 0o600 }); }
  // Same 0600 key-file bootstrap as mail-bot.ts: a heartbeat-fired run is granted
  // mail-cli but its Resend creds are stripped by runAgent, so write the key file here
  // or heartbeat mail delivery would break outright.
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) { mkdirSync(dirname(MAIL_KEYS_PATH), { recursive: true }); writeFileSync(MAIL_KEYS_PATH, JSON.stringify({ apiKey: resendKey }), { mode: 0o600 }); }
  log(`[heartbeat] up; harness ${harnessLabel(MODEL)}; interval ${INTERVAL_MS}ms, fire cap ${FIRE_CAP}/day, tz ${FALLBACK_TZ}`);
  // Startup gate: reconcile system tasks ONCE before the daemon loop. A
  // reserved-id collision logs loudly (both sinks) but keeps the loop alive --
  // every tick's gate keeps refusing until the operator repairs; after repair
  // the next reconcile creates/restores the system task under its canonical id.
  const startupGate = await runReconcileGate(new Date(), { log });
  if (!startupGate.ok) logErr(`[heartbeat] ${startupGate.error}`);
  for (;;) {
    try {
      await tick(Date.now(), {
        runFn: makeFireTask(),
        // Every persisted reservation names the task that actually fired:
        // tick binds each per-fire context's zero-arg reserveAgentRun() to the
        // claimed task's id, and this is the reserve it forwards to.
        reserveAgentRunFor: (taskId) => reserveAgentRunSlot(new Date(), FIRE_CAP, taskId),
        releaseAgentRun: releaseAgentRunSlot,
        visibilityMs: VISIBILITY_MS, maxAttempts: MAX_ATTEMPTS, fallbackTz: FALLBACK_TZ,
        log,
      });
    }
    catch (err) { logErr(`[heartbeat] tick error: ${(err as Error).message}`); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
