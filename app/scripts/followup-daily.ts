import { normalizeFollowUpSubject } from "./followup-normalization.ts";
import { tzDateToken } from "./tz.ts";
import type { ResolvedContact } from "./recipients.ts";
import { mutate, type Task } from "./schedule-store.ts";

const ID = /^[a-f0-9]{8}$/;

function isMondayOrFriday(now: Date, tz: string): boolean {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
  return day === "Monday" || day === "Friday";
}

/** Direct mail/SMS follow-ups due later in today's Monday/Friday update. Group
 * routes intentionally remain ordinary scheduled tasks: a household update has
 * no equivalent group recipient or delivery acknowledgement. */
export async function consumeFoldedFollowUps(ids: readonly string[]): Promise<void> {
  const wanted = new Set(ids);
  if (!wanted.size) return;
  await mutate((tasks) => ({ tasks: tasks.filter((task) => !wanted.has(task.id) || task.follow_up == null), value: undefined }));
}

export function dueFollowUpsForContact(tasks: readonly Task[], contact: ResolvedContact, now: Date, tz: string): { id: string; subject: string }[] {
  if (!isMondayOrFriday(now, tz)) return [];
  const today = tzDateToken(now, tz);
  return tasks.flatMap((task) => {
    if (!ID.test(task.id) || !task.follow_up || (task.follow_up.kind !== "date" && task.follow_up.kind !== "topic")) return [];
    const due = new Date(task.next_run_at);
    if (Number.isNaN(due.getTime()) || due.getTime() <= now.getTime() || tzDateToken(due, tz) !== today) return [];
    const route = task.deliver;
    const matchingMail = route?.surface === "mail" && contact.emails.includes(route.target);
    const matchingSms = route?.surface === "sms" && contact.phones.includes(route.target);
    if (!matchingMail && !matchingSms) return [];
    try { return [{ id: task.id, subject: normalizeFollowUpSubject(task.follow_up.subject).subject }]; }
    catch { return []; }
  });
}
