# Consolidated Morning Check-In

**Date:** 2026-08-22
**Status:** Approved in chat; pending written-spec review

## Goal

Replace the separate daily calendar digest, Friday weekend check-in, and Monday weekly check-in with one runtime-owned `morning-check-in` system task. Each household receives at most one morning system message: a calendar update when today has qualifying events, otherwise the appropriate Friday or Monday check-in, otherwise nothing.

Make the task feel less mechanical by selecting and persisting one random household-local run minute between 08:00 and 08:59 for each occurrence. A missed occurrence may catch up before noon, but never later in the day.

## Non-goals

- Preserve separate enable/disable controls or enabled state from the three retired tasks.
- Preserve the retired task keys as aliases.
- Add user-configurable scheduling windows.
- Randomize ordinary user-created schedules or one-shot system triggers.
- Choose a separate time per recipient; one occurrence serves the whole household.
- Send an empty-day message on Tuesday, Wednesday, Thursday, Saturday, or Sunday.
- Restate the weekend itinerary in Friday copy.
- Add durable per-recipient completion state or change the accepted in-process-only duplicate-prevention boundary.
- Change recipient resolution, provider admission, delivery order, message privacy, or daily agent-run quota policy except where this design explicitly consolidates their caller.

## Registered task and startup replacement

The compile-time `SystemTaskKey` union and `SYSTEM_TASKS` registry contain one morning definition:

```text
morning-check-in
```

Its canonical record is `system:morning-check-in`. The CLI and shared schedule skill expose only this user-facing system key. `schedule-cli system list|enable|disable morning-check-in` controls the recurring record; `schedule-cli system trigger morning-check-in` continues to enqueue an independent due-now one-shot.

Startup and every reconciliation run an idempotent retired-task cleanup before validating the active registry:

- retire `system:daily-calendar-digest` carrying `system.key = daily-calendar-digest`;
- retire `system:friday-weekend-check-in` carrying `system.key = friday-weekend-check-in`; and
- retire `system:monday-weekly-check-in` carrying `system.key = monday-weekly-check-in`.

Every record in a retired key's duplicate set is removable only when its canonical id and `system.key` are the matching known pair. Matching retired canonical records are deleted, regardless of their old enabled, claim, retry, cron, timezone, or `next_run_at` state. The new canonical task is then created enabled by default and receives a newly selected first occurrence; no old enabled state or run time is migrated.

An ordinary record under a retired reserved id, a retired `system.key` on a noncanonical id, a wrong-key pairing, or any other uncertain retired-key collision remains fail-closed and receives the existing operator-repair diagnostic. Reconciliation never silently deletes such a record. Ordinary-id `system_trigger` records naming retired keys are no longer registered executable identities and are removed through the existing invalid-trigger cleanup before selection.

The replacement is idempotent: once old canonical records are gone and `system:morning-check-in` exists, later startups preserve the new record and its selected occurrence.

## Morning decision flow

The consolidated handler uses the shared household timezone and performs one calendar refresh/read before choosing a message mode.

1. Refresh configured family feeds and consume the refresh attempt's retained or updated family snapshot under the existing cache rules.
2. Read Baxter's own stored calendar.
3. Select and sanitize today's remaining, ongoing, and all-day events with the existing daily-digest eligibility and ordering rules.
4. Choose exactly one mode from the household-local weekday and selected events:

| Condition | Mode |
|---|---|
| Today has one or more qualifying events | `calendar` |
| No qualifying event today and local weekday is Friday | `friday` |
| No qualifying event today and local weekday is Monday | `monday` |
| Otherwise | `none` |

Mode precedence is unconditional: `calendar` suppresses Friday and Monday copy whenever today has a qualifying event. The handler never sends both messages in one occurrence.

`none` completes successfully with `agentRun:false`, no recipient snapshot, no durable-knowledge load, no reservation, no model call, and no provider call.

Calendar refresh failures continue to degrade through the retained family cache where possible. Calendar read or selection failure is not equivalent to an empty calendar: if the handler cannot reliably distinguish `calendar` from a fallback check-in, it fails before generation or delivery and uses normal retry behavior. It must never send Friday or Monday copy merely because calendar data was unavailable or malformed.

## Calendar mode

Calendar mode preserves the current daily calendar behavior:

- the date-bearing email subject;
- the bounded sanitized event projection;
- per-recipient, content-suppressed, tool-less model generation;
- runtime-owned cleaned-name greeting;
- deterministic bounded calendar fallback;
- SMS-first and same-contact email fallback; and
- aggregate/index-only diagnostics.

The consolidation changes only its registry key, orchestration point, and ranged occurrence time. Event qualification, projection, validation, recipient snapshot, quota behavior, and delivery boundaries remain intact.

## Friday mode

Friday mode is a friendly weekend check-in, not an early weekend itinerary. Because Saturday and Sunday calendar events will receive their own same-day calendar updates, Friday copy may allude lightly to at most one upcoming weekend event but must not restate event details.

After today's selection proves empty, the handler may project Saturday/Sunday events from the already loaded own and family snapshots. It deterministically chooses at most one representative sanitized event title. No event time, date, location, URL, omitted-event count, agenda line, or full weekend projection enters the Friday model prompt or fallback.

The prompt instructs Baxter that the optional title is a conversational hint only. Acceptable use includes: “Looks like you have a great weekend coming up—the concert should be fun.” Baxter may omit the hint when it is not natural or useful. It must not enumerate plans, present an itinerary, or imply unprovided details.

The deterministic Friday fallback follows the same rule:

- with a representative title, include at most one brief title-only reference;
- without one, use a generic warm weekend note; and
- in both cases, retain the friendly low-pressure offer to help.

The existing subject/body output validation, generic subject requirement, runtime greeting, durable-knowledge bounds, named fact ownership, and per-recipient delivery isolation remain in force. Validation receives the private sanitized weekend projection even though the prompt does not: it rejects output that echoes any known weekend title other than the selected title, any known weekend time/location, or the selected title more than once. The prompt also forbids invented event details; as with other free-text generation, runtime can enforce known-field non-disclosure but cannot prove the semantic truth of arbitrary new prose.

## Monday mode

Monday mode preserves the current Monday weekly organization check-in. It receives no calendar event context after today's selection proves empty. It retains the existing durable-knowledge context, model-owned generic subject/body, validation, deterministic fallback, runtime greeting, and low-pressure offer to help.

## Shared per-recipient execution

Only `calendar`, `friday`, and `monday` modes proceed to recipient work. The handler snapshots resolved contacts once, builds the existing bounded recipient contexts, and executes one deterministic contact loop.

For each contact:

- reserve one durable agent-run slot immediately before that contact's model call;
- perform one content-suppressed, tool-less model generation for the selected mode;
- validate output under that mode's existing plain-text/privacy rules;
- use only that contact's generated or deterministic fallback copy;
- add the runtime-owned cleaned-name greeting; and
- attempt the existing SMS-first, same-contact-email delivery chain.

A model or validation failure falls back only for the affected contact and later contacts continue. Quota denial or out-of-tokens stops later model attempts but still completes exactly one fallback delivery chain per remaining contact; out-of-tokens releases only its own reserved slot. Provider failures remain isolated per contact.

The handler does not revisit an attempted contact in one invocation. Existing heartbeat retry behavior remains accepted: an unhandled process interruption may later retry the occurrence from contact zero because there is no durable per-recipient completion state.

## Ranged system scheduling

### Definition contract

`SystemTaskDefinition` retains a cron expression as the recurrence/day anchor and gains an optional compile-time window policy for runtime-owned recurring tasks. Fixed-time definitions remain representable without a window.

The morning task anchors at 08:00 daily and declares:

- random window: 60 whole-minute slots, 08:00 through 08:59 household-local time; and
- catch-up cutoff: 12:00 household-local time on the occurrence's civil date.

The production random source selects a uniform integer minute slot. Scheduling helpers accept an injectable selector for deterministic tests. The selected absolute instant is persisted in the canonical record's `next_run_at`; no per-tick or per-restart random selection occurs.

### Creation and preservation

When the canonical record is created before 08:00, select one time in today's window. During the window, still select from the complete 60-minute window: a selected future minute waits normally, while a selected past minute is immediately due. Between 09:00 and noon, today's selected time is necessarily past and the occurrence is immediately due as catch-up. At or after noon, today's occurrence is expired and creation selects the next eligible day's window.

A valid persisted selected time remains unchanged across startup reconciliation, ordinary ticks, claims, hard retries, quota deferral, and out-of-token invisibility. Reconciliation reselects only when:

- creating the canonical record;
- advancing a completed or final-give-up occurrence;
- expiring an occurrence at the noon cutoff;
- enabling a disabled task for its next future occurrence; or
- repairing a changed/invalid definition, timezone, or selected run value.

Each newly selected occurrence gets one fresh random minute.

### Catch-up and expiry

A due selected occurrence may dispatch while the household-local clock is strictly before noon. At 12:00 or later, reconciliation expires an uncompleted canonical occurrence before due selection, clears claim/retry state, emits a fixed body-free diagnostic, and selects the next eligible day's random window. Expiry is neither task success nor hard failure and does not invoke the handler.

If Baxter restarts on a later date, stale missed occurrences are skipped and the next applicable window is selected. If it restarts before noon on the original occurrence date, the persisted occurrence remains eligible for catch-up.

A handler that begins before noon may finish after noon; the cutoff gates dispatch, not in-flight completion.

### Completion, retries, and disabling

Successful completion and final give-up advance the canonical task to a newly randomized next occurrence. A nonfinal hard failure preserves the current occurrence and selected time while incrementing attempts under the existing visibility-window retry contract.

A disabled canonical task never dispatches. Re-enabling selects a new future occurrence under the current window definition rather than retroactively delivering a disabled occurrence. Operators use `system trigger` when they intentionally want an immediate test.

### Manual trigger

`schedule-cli system trigger morning-check-in` remains a separate ordinary-id, due-now one-shot. It does not use the random window or noon cutoff, does not alter the canonical recurring record, and chooses message mode from the trigger's actual household-local execution time. Existing one-shot success, hard-failure, quota, cancellation, and give-up semantics remain intact.

## Store and reconciliation invariants

Registry definitions remain the sole executable source of system handler identity and schedule policy. Persisted records name a key and carry queue state; they never persist a handler, command, prompt, random function, or user-defined window.

The ranged scheduler must preserve existing boundaries:

- random selection occurs inside the same locked transaction that creates, repairs, enables, expires, or advances the canonical record;
- a no-change reconciliation returns the original objects and performs no rewrite;
- duplicate IDs and reserved-namespace collisions still refuse id-based mutations;
- trigger validation remains independent from canonical enabled state and window policy;
- the ordinary task cap still exempts only the one canonical registered record, not throwaway triggers; and
- timezone conversion uses the shared household resolver and civil-time helpers, including across DST transitions.

The Home schedule view and `schedule-cli system list` display the single canonical task and its persisted selected `next_run_at`. No separate random-time field or UI configuration is added.

## Privacy and diagnostics

The consolidated task preserves the current per-recipient privacy contract:

- no address enters model context;
- prompts and greetings use repaired, control-safe, bounded display names;
- calendar fields pass through the shared Unicode repair, address-redaction, whitespace, and code-point caps before prompt or fallback use;
- only the selected Friday title may cross the weekend-calendar boundary;
- model content remains suppressed from raw run logs;
- operational logs and task details remain aggregate/index based; and
- free-form calendar, provider, model, subject, body, name, phone, and email content does not enter diagnostics.

Ranged-schedule diagnostics may contain only the system key, fixed reason category, selected/cutoff timestamps, and queue outcome. They never include household content.

## Documentation and user-facing updates

Update:

- `app/docs/architecture/heartbeat.md` to describe the single task, decision precedence, Friday title-only hint, ranged scheduling, catch-up, expiry, and startup replacement;
- `app/skills/schedule/SKILL.md` to list only `morning-check-in` and show enable/disable/trigger examples;
- system-task guidance tests and any Home/system schedule descriptions that name the retired keys; and
- comments and type contracts in the scheduler, reconciliation, and handler modules.

No separate outer-repository or TUI control implementation is required: existing registry-backed list/toggle/trigger and schedule-view paths consume the one new key automatically.

## Testing

Implementation follows strict test-driven development.

### Message selection and content

1. Calendar mode wins on Friday and Monday when today has a qualifying event; the corresponding fallback check-in does not generate or deliver.
2. Friday with no event today sends exactly one weekend check-in.
3. Monday with no event today sends exactly one weekly check-in.
4. Every other empty day performs no recipient, knowledge, reservation, model, or provider work.
5. Remaining, ongoing, and all-day event eligibility matches the current daily digest across timezone and DST boundaries.
6. Calendar unavailable/malformed fails before mode selection and never becomes an empty-day fallback.
7. Friday prompt and fallback receive at most one sanitized event title and no time, date, location, URL, omitted count, or itinerary projection.
8. Friday generated and fallback copy may mention the one title conversationally; fixtures that repeat it, mention another known event, or echo a known time/location fall back only for the affected recipient.
9. Monday receives no event context.
10. Per-recipient prompts, reservations, model results, fallbacks, greetings, delivery chains, and provider admission remain isolated.
11. Quota denial, out-of-tokens, invalid output, hard generation failure, zero recipients, and provider failures preserve current aggregate results and side-effect bounds.

### Ranged scheduling

12. The selector chooses only whole-minute instants from 08:00 through 08:59 in the household timezone, including endpoint fixtures.
13. One occurrence invokes the random selector exactly once and persists the result.
14. No-change startup/tick reconciliation, restart before the selected time, restart after it but before noon, claim, retry, quota deferral, and out-of-token handling do not reselect.
15. Completion and final give-up each select exactly one next occurrence.
16. Before-08:00 creation, in-window future/past selection, 09:00-to-noon catch-up, exact-noon expiry, and after-noon creation behave as specified.
17. A stale occurrence from an earlier civil date is skipped; the next applicable window is selected.
18. A handler beginning before noon may complete after noon.
19. Disabling prevents dispatch; enabling selects a future ranged occurrence; manual trigger stays immediately due and leaves the canonical record byte-identical.
20. Spring-forward and fall-back fixtures prove selected wall-clock times remain in the declared local window and cutoff comparison uses the occurrence's civil date.
21. Invalid persisted times, cron/window definition changes, and timezone changes clear stale claim/retry state and select one valid replacement.

### Replacement and invariants

22. Empty store creates only `system:morning-check-in`, enabled with one selected occurrence.
23. Valid old canonical records—including safe duplicate canonical members and any prior enabled/claim/retry/time state—are removed and the new task starts enabled with a new selection.
24. Retired reserved-id ordinary records, wrong-key pairings, and noncanonical retired system metadata fail closed with no write.
25. Retired throwaway trigger records are removed before dispatch.
26. Repeated reconciliation is idempotent and does not rewrite or reselect.
27. Registry, CLI, shared schedule skill, architecture docs, schedule view, trigger audit fields, task cap, cancellation, and reserved-namespace tests name only the consolidated key where appropriate.
28. Focused scheduler/handler tests, TypeScript, `git diff --check`, and the full project test gate pass.

## Acceptance criteria

- The registry exposes one recurring `morning-check-in` task and one toggle.
- A household receives at most one automatic system message per morning occurrence.
- Today's qualifying calendar events always choose calendar copy over Friday or Monday copy.
- Empty Friday and Monday mornings choose their respective check-ins; other empty mornings send nothing.
- Friday context/fallback contains at most one sanitized weekend event title and no itinerary details.
- Every recurring occurrence has one persisted random minute from 08:00 through 08:59 household-local time.
- Restarts and retries preserve that selected minute; new occurrences select a new minute.
- Catch-up dispatch is allowed only before noon; stale occurrences expire without delivery.
- Startup safely removes recognized retired canonical records, creates the new task enabled by default, and retains fail-closed handling for uncertain collisions.
- Manual triggers remain immediate and independent.
- Existing per-recipient attribution, privacy, quota, fallback, admission, and delivery guarantees remain intact.
