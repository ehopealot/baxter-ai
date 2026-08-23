// Compile-time registry of runtime-owned system tasks: the closed key union,
// definition/context/result contracts, canonical `system:` id helper, and
// strict-enabled predicate. The registry is the SOLE source of executable
// handler identity, description, and recurrence -- a persisted record only
// NAMES a key, and a key with no registered definition never executes code.
// Definitions are registered below at module load, while consumers still take
// the registry as an injectable parameter.
import type { Task } from "./schedule-store.ts";

export type SystemTaskKey = "morning-check-in";

/** Runtime-owned local recurrence range. The selected instant, not this policy,
 * is persisted on the task record. */
export interface RecurringWindowPolicy {
  startHour: number;
  minuteSlots: number;
  cutoffHour: number;
}

// The execution context heartbeat hands a system handler (T12 wires the real
// one): the fire's instant, the per-fire agent-run quota closures (the spec's
// zero-arg reserveAgentRun() shape -- tick binds them to the CLAIMED task's id
// so every persisted reservation names the task that fired), and a log sink.
// No store access: all persistence stays in the driver.
export interface SystemTaskContext {
  now: Date;
  reserveAgentRun(): Promise<{ token: string } | null>;
  releaseAgentRun(token: string): Promise<void>;
  log(msg: string): void;
}

// The shared result contract for ordinary fires and system handlers.
// system-tasks.ts never imports heartbeat.ts, avoiding a runtime cycle.
export interface SystemTaskResult {
  // Whether the fire completed successfully.
  ok: boolean;
  // A global token outage; the fire keeps its claim for a free retry.
  outOfTokens?: boolean;
  // The UTC agent-run cap window was full: no model was invoked, so tick defers
  // this and the remaining due occurrences without recording success/failure.
  deferredByCap?: boolean;
  // Whether this fire consumed a model run (audit log field). Ordinary/legacy
  // fires may leave it unset; system handlers set it explicitly.
  agentRun?: boolean;
  // Bounded operational summary for logs -- never a generated digest body.
  detail?: string;
}

// One registered system task. The GENERIC key parameter is deliberate: K
// defaults to the closed SystemTaskKey union so SYSTEM_TASKS (and T11's
// registration) only accept compile-time-known keys, while every
// registry-consuming parameter and helper (findSystemDef here; T4's
// validateReservedNamespace/refuseOnCollision/reconcileSystemTasks; T5's
// cmdSystem* functions; T12's runReconcileGate and systemHandlerResolver) is
// typed against the WIDER readonly SystemTaskDefinition<string>[] -- tests
// construct fully-typed fake definitions under test-local keys with no casts,
// while assigning such a fake to SYSTEM_TASKS stays a compile error.
export interface SystemTaskDefinition<K extends string = SystemTaskKey> {
  key: K;
  desc: string;
  cron: string;
  /** Optional so fixed-time test/extension definitions remain representable. */
  window?: Readonly<RecurringWindowPolicy>;
  execute(task: Task, ctx: SystemTaskContext): Promise<SystemTaskResult>;
}

// The reserved `system:` id under which reconciliation persists a definition's
// canonical record (isReservedId in schedule-store.ts guards the prefix).
export function canonicalSystemId(key: string): string {
  return `system:${key}`;
}

// Strict boolean: only the literal true enables. Persisted records are
// arbitrary JSON, so a truthy read ('true', 1) must never execute a handler;
// malformed values are repaired to literal false by reconciliation (T4).
export function systemTaskEnabled(t: Task): boolean {
  return t.system?.enabled === true;
}

// Runtime import direction is system-tasks -> concrete task handlers; handlers
// import only TYPES from this module, so there is no cycle.
import { morningCheckInDefinition } from "./morning-check-in.ts";

// Runtime-owned definitions are registered at module load with their real defaults;
// consumers still take an injectable registry so focused tests stay isolated.
export const SYSTEM_TASKS: readonly SystemTaskDefinition<SystemTaskKey>[] = [morningCheckInDefinition()];

export function findSystemDef(registry: readonly SystemTaskDefinition<string>[], key: string): SystemTaskDefinition<string> | undefined {
  return registry.find((d) => d.key === key);
}
