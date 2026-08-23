---
name: schedule
description: Schedule tasks to run later or on a repeat with schedule-cli -- one-shot reminders (--at) or recurring jobs (--cron), delivered to a Discord channel, emailed to the operator or an allowlisted recipient (mail `send` reaches OPERATOR_EMAIL plus ALLOWED_RECIPIENTS), texted to a household-listed phone, or sent into a previously received SMS group. A dedicated driver fires them; ordinary tasks support add/cancel/list and group discovery, while runtime-owned tasks support system list/enable/disable/trigger.
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
| `schedule-cli add "<task>" --desc "<label>" (--cron "<expr>" \| --at "<ISO>") [--tz <zone>] [--discord <channelId> \| --email <address> \| --sms <phone> \| --sms-group <groupId>]` | Add a task. Prints its id. |
| `schedule-cli cancel <id>` | Remove a task. |
| `schedule-cli list` | Show all tasks (JSON): id, description, schedule, next run, delivery. |
| `schedule-cli groups` | List discoverable SMS groups (JSON): `id`, `name`, `participants`, `speakers`, `lastActivity` — the groups Baxter has received texts from and can schedule into. |
| `schedule-cli system list` | List runtime-owned system tasks (JSON): key, description, enabled, next run. |
| `schedule-cli system enable <key>` | Turn a system task back on (e.g. the daily calendar digest); it resumes at its next scheduled occurrence. |
| `schedule-cli system disable <key>` | Turn a system task off. It stays listed but never fires while disabled. |
| `schedule-cli system trigger <key>` | Queue a separate due-now one-shot for a system task. Prints the ordinary task id. |

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
  operator instead. **`--sms-group <groupId>`** sends the result into an SMS group
  conversation via `sms-cli send-group` -- only a group Baxter has already received
  (see discovery below); the CLI refuses an unknown or never-received group id.
  These delivery flags are mutually exclusive -- at most one per task. Omit them all
  only for a purely internal task (nothing to deliver).

## SMS groups — discover, then schedule by exact id

`--sms-group` takes an **exact provider group id**, never a group name. When someone
asks for a scheduled result to go to "the family group", "the carpool text", or
otherwise identifies a group by name or membership:

1. Run **`schedule-cli groups`** — it lists every group Baxter has received, with its
   exact `id`, `name`, current `participants`, known `speakers`, and `lastActivity`.
2. Pick a candidate only when the evidence is clear (the name matches, or the
   participants/speakers/recency line up with who asked). Group names are not unique
   and the CLI does no fuzzy matching.
3. If more than one group is plausible, **ask the requester which one** (name its
   members/last activity) instead of guessing.
4. Create the schedule with the selected exact `id`: `--sms-group <groupId>`.

A group stays schedulable only while its local transcript exists; renaming the group
never breaks a schedule (the stored target is the id, not the name). Baxter cannot
create a group or cold-text a group it has never received.

## Timezone — use the requester's

Times mean the **requester's** wall clock: their `9am` is their 9am. Set
`--tz <IANA zone>` (e.g. `America/New_York`) from what they say ("9am Eastern")
or what you already know about them. **If a clock-time schedule needs a timezone
and you don't know theirs, just ask** — don't guess. With no `--tz` it falls back
to the operator's default zone, which is usually not what a specific person meant.

## System tasks — list, toggle, or trigger; never add or cancel the recurring record

Some tasks are **runtime-owned system tasks** the heartbeat driver runs by itself.
You don't `add` them, and you **cannot `cancel` them**. There is one toggle:

- `morning-check-in` — a household-local random persisted minute from 08:00–08:59.

It chooses calendar copy first when today has qualifying events; otherwise it sends a
Friday title-only weekend hint, a Monday weekly check-in, or nothing. Missed runs may
catch up before noon and expire after that. Startup replaces the retired daily/Friday/
Monday task records with this one task.

- "turn off the morning check-in" → `schedule-cli system disable morning-check-in`
- "start the morning check-in again" → `schedule-cli system enable morning-check-in`
- "run the morning check-in now" → `schedule-cli system trigger morning-check-in`
- Not sure of the key? `schedule-cli system list` prints it.

`schedule-cli system trigger <key>` queues a **separate due-now one-shot** and prints
its ordinary task id. The recurring system record remains unchanged: triggering does
not enable or reschedule it, claim it, or otherwise mutate the canonical recurring
record. It also does not execute the task inline; the heartbeat dispatches it later.
The recurring system record remains non-cancellable, while the separate queued
one-shot may be cancelled with `schedule-cli cancel <printed-id>` before heartbeat
claims it.

Enabling resumes at the task's next scheduled occurrence. System tasks can only be
toggled from your normal conversations — a heartbeat-fired run still has no
`schedule-cli`, same as every other schedule edit.

## Limits & rules

- **Recurring tasks fire at most once an hour** — a `--cron` that would fire more
  often than hourly is rejected. (One-shot `--at` has no minimum — schedule it
  for any time.) If you need "every few minutes", that's not what this is for.
- A **scheduled run cannot schedule or cancel tasks** — so you can't set up a task
  that reschedules itself. Manage the schedule here, in your normal
  conversations; to stop a recurring task, `cancel <id>` (find it with `list`).
- Prefer one-shots for reminders and cron for genuinely repeating work. Before
  adding a duplicate, `list` to see what's already scheduled.
