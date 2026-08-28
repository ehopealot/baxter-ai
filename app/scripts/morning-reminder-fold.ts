// Atomically take direct one-shot reminders for the Monday/Friday morning update.
// This deliberately uses only `desc`, never the scheduler instruction in `task`.
import { mutate, type Task } from "./schedule-store.ts";
import type { ResolvedContact } from "./recipients.ts";
import { tzDateToken, zonedToUtcMs } from "./tz.ts";

const ID = /^[a-f0-9]{8}$/;
export interface FoldedMorningReminder { id: string; description: string; }

function isMondayOrFriday(now: Date, tz: string): boolean {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
  return day === "Monday" || day === "Friday";
}

function localNoon(now: Date, tz: string): number {
  const localDay = new Date(tzDateToken(now, tz));
  return zonedToUtcMs(localDay.getUTCFullYear(), localDay.getUTCMonth() + 1, localDay.getUTCDate(), 12, 0, 0, tz);
}

function isDirectForContact(task: Task, contact: ResolvedContact): boolean {
  const route = task.deliver;
  return (route?.surface === "mail" && contact.emails.includes(route.target))
    || (route?.surface === "sms" && contact.phones.includes(route.target));
}

function eligible(task: Task, contact: ResolvedContact, now: Date, tz: string): FoldedMorningReminder | null {
  if (!ID.test(task.id) || task.cron || !task.at || task.invisible_until != null || !task.desc || !isDirectForContact(task, contact)) return null;
  const due = new Date(task.next_run_at);
  if (Number.isNaN(due.getTime()) || due.getTime() <= now.getTime() || due.getTime() >= localNoon(now, tz)) return null;
  return { id: task.id, description: task.desc };
}

/** Re-select and remove only still-pending eligible reminders under one lock,
 * immediately before the check-in is delivered. Claimed or already-due tasks
 * remain for normal heartbeat processing. */
export async function takeMorningRemindersForContact(contact: ResolvedContact, now: Date, tz: string): Promise<FoldedMorningReminder[]> {
  if (!isMondayOrFriday(now, tz)) return [];
  return mutate((tasks) => {
    const selected = tasks.flatMap((task) => {
      const reminder = eligible(task, contact, now, tz);
      return reminder ? [reminder] : [];
    });
    const ids = new Set(selected.map(({ id }) => id));
    return { tasks: ids.size ? tasks.filter((task) => !ids.has(task.id)) : tasks, value: selected };
  });
}
