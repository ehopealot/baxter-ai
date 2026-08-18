---
name: schedule
description: Schedule tasks to run later or on a repeat with schedule-cli -- one-shot reminders (--at) or recurring jobs (--cron), delivered to a Discord channel or emailed to the operator or an allowlisted recipient (mail `send` reaches OPERATOR_EMAIL plus ALLOWED_RECIPIENTS). A dedicated driver fires them; you only add/cancel/list.
allowed-tools: Bash(schedule-cli:*)
---

# Scheduling tasks with schedule-cli

`schedule-cli` is how you make something happen **later** without anyone
re-prompting you — a reminder, a recurring summary, a periodic check. You only
edit the schedule; a separate heartbeat driver fires each task when it's due,
running a fresh you with the task in context, and delivers the result where you
said.

## Commands

| Command | What it does |
|---|---|
| `schedule-cli add "<task>" --desc "<label>" (--cron "<expr>" \| --at "<ISO>") [--tz <zone>] [--discord <channelId> \| --email <address> \| --sms <phone>]` | Add a task. Prints its id. |
| `schedule-cli cancel <id>` | Remove a task. |
| `schedule-cli list` | Show all tasks (JSON): id, description, schedule, next run, delivery. |

- The `<task>` is a plain-English description of what a future you should do
  ("post the weekly standup reminder", "check the deploy queue and email me if
  it's stuck"). Write it so a fresh you with no memory of this conversation can
  carry it out.
- **`--cron "<expr>"`** for recurring (standard 5-field cron, e.g. `0 9 * * 1-5`
  = weekdays 9am). **`--at "<ISO>"`** for a one-shot (`2026-07-20T14:00:00Z`, or a
  naive `2026-07-20T14:00:00` read in `--tz`). Exactly one of the two.
- **`--desc "<label>"`** (required) is the short, user-facing description shown to
  the family on the home Scheduled-tasks page. Keep it plain and specific
  (`Weekly grocery reminder`), not the internal instruction.
- **`--discord <channelId>`** posts the result to that channel; **`--email <address>`**
  emails it to that address, which must be reachable by mail `send` -- the **operator**
  or an address your operator allowlisted in `ALLOWED_RECIPIENTS`. If the target isn't
  allowlisted, the fired run falls back to emailing the operator with the intended
  recipient named in the body to forward, so warn the requester it may go via the
  operator. **`--sms <phone>`** texts that number via `sms-cli` -- any phone number
  listed for the household (the phone numbers in your household roster); a number
  that isn't listed is refused. If the send fails
  (e.g. SMS not configured on that box), the fired run falls back to emailing the
  operator instead. Omit all three only for a purely internal task (nothing to deliver).

## Timezone — use the requester's

Times mean the **requester's** wall clock: their `9am` is their 9am. Set
`--tz <IANA zone>` (e.g. `America/New_York`) from what they say ("9am Eastern")
or what you already know about them. **If a clock-time schedule needs a timezone
and you don't know theirs, just ask** — don't guess. With no `--tz` it falls back
to the operator's default zone, which is usually not what a specific person meant.

## Limits & rules

- **Recurring tasks fire at most once an hour** — a `--cron` that would fire more
  often than hourly is rejected. (One-shot `--at` has no minimum — schedule it
  for any time.) If you need "every few minutes", that's not what this is for.
- A **scheduled run cannot schedule or cancel tasks** — so you can't set up a task
  that reschedules itself. Manage the schedule here, in your normal
  conversations; to stop a recurring task, `cancel <id>` (find it with `list`).
- Prefer one-shots for reminders and cron for genuinely repeating work. Before
  adding a duplicate, `list` to see what's already scheduled.
