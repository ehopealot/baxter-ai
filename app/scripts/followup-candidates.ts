import parser from "cron-parser";
import type { Task } from "./schedule-store.ts";
import { isCanonicalSystemRecord, resolveNextRun } from "./schedule-store.ts";
import { SYSTEM_TASKS } from "./system-tasks.ts";
import type { CivilDate } from "./followup-normalization.ts";
import { sanitizeGeneratedFollowUp } from "./followup-normalization.ts";
import { isFeatureShapedTask, validateStoredFollowUp } from "./followup-types.ts";
import { tzMidnightOfToken } from "./tz.ts";
import { validTz } from "./household-tz.ts";

export interface FollowUpCandidate {
  id: string;
  desc: string;
  follow_up_subject?: string;
  occurrence: string;
  recurring: boolean;
}

const DAY_MS = 86_400_000;

function civilToken(date: CivilDate): number {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(date.year, date.month - 1, date.day);
  return value.getTime();
}

export function candidateInterval(planDate: CivilDate, tz: string): { startMs: number; endMs: number } {
  if (validTz(tz) !== tz) throw new Error("candidate timezone is invalid");
  const token = civilToken(planDate);
  return {
    startMs: tzMidnightOfToken(token - DAY_MS, tz),
    endMs: tzMidnightOfToken(token + DAY_MS, tz),
  };
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return new Date(value).toISOString() === value ? value : null; }
  catch { return null; }
}

function boundedDescription(task: Task): string {
  const raw = String(task.desc ?? task.task ?? "Scheduled task");
  // Bound work before the shared sanitizer; candidate text is advisory and the
  // source record remains identified by id. Structural sanitization precedes
  // the final 200-code-point projection.
  const boundedInput = Array.from(raw).slice(0, 1000).join("");
  let clean: string;
  try { clean = sanitizeGeneratedFollowUp(boundedInput); }
  catch { clean = "Scheduled task"; }
  return Array.from(clean).slice(0, 200).join("");
}

function taskId(task: Task): string {
  if (typeof task.id !== "string" || task.id.length < 1 || task.id.length > 200) throw new Error("candidate task id is invalid");
  return task.id;
}

export function findFollowUpCandidates(
  tasks: Task[],
  planDate: CivilDate,
  tz: string,
  maxTasks: number,
): FollowUpCandidate[] {
  if (!Number.isInteger(maxTasks) || maxTasks < 0) throw new Error("candidate task limit is invalid");
  if (!Array.isArray(tasks)) throw new Error("schedule store must contain an array");
  const ordinary = tasks.filter((task) => !isCanonicalSystemRecord(task, SYSTEM_TASKS));
  if (ordinary.length > maxTasks) throw new Error(`schedule store exceeds the ordinary task limit ${maxTasks}`);
  const { startMs, endMs } = candidateInterval(planDate, tz);
  const output: FollowUpCandidate[] = [];

  for (const task of ordinary) {
    const id = taskId(task);
    let followUpSubject: string | undefined;
    if (isFeatureShapedTask(task)) followUpSubject = validateStoredFollowUp(task).followUp.subject;

    let occurrenceMs: number;
    let recurring: boolean;
    if (typeof task.cron === "string" && task.cron.length > 0) {
      if (task.at != null) throw new Error(`candidate recurring task ${id} is invalid`);
      const taskTz = task.tz ?? tz;
      if (typeof taskTz !== "string" || validTz(taskTz) !== taskTz) throw new Error(`candidate recurring task ${id} has invalid timezone`);
      let next: Date;
      try {
        const iterator = parser.parseExpression(task.cron, { currentDate: new Date(startMs - 1), tz: taskTz });
        next = iterator.next().toDate(); // exactly one recurrence-engine query per task
      } catch (err) { throw new Error(`candidate recurring task ${id} is invalid`, { cause: err }); }
      occurrenceMs = next.getTime();
      recurring = true;
    } else if (task.cron === null) {
      const at = typeof task.at === "string" && task.at.length > 0 && task.at.length <= 100 ? task.at : null;
      const nextRunAt = canonicalIso(task.next_run_at);
      if (!at || !nextRunAt) throw new Error(`candidate task ${id} has invalid one-shot occurrence`);
      let resolved: string;
      try { resolved = resolveNextRun({ cron: null, at: task.at, tz: task.tz }, 0, tz); }
      catch (err) { throw new Error(`candidate task ${id} has invalid one-shot occurrence`, { cause: err }); }
      if (resolved !== nextRunAt) throw new Error(`candidate task ${id} has invalid one-shot occurrence`);
      occurrenceMs = Date.parse(nextRunAt);
      recurring = false;
    } else {
      throw new Error(`candidate task ${id} has invalid recurrence shape`);
    }

    if (occurrenceMs < startMs || occurrenceMs >= endMs) continue;
    output.push({
      id,
      desc: boundedDescription(task),
      ...(followUpSubject ? { follow_up_subject: followUpSubject } : {}),
      occurrence: new Date(occurrenceMs).toISOString(),
      recurring,
    });
  }
  if (output.length > maxTasks) throw new Error(`candidate output exceeds the ordinary task limit ${maxTasks}`);
  return output;
}
