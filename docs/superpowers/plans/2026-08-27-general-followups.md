# General Follow-ups Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Expand proactive date follow-ups into capped, prioritized date and unresolved-topic follow-ups that are visible to every agent run for cancellation after resolution.

**Architecture:** Persist minimal trusted follow-up metadata on the existing ordinary scheduler tasks so the CLI can identify and prioritize the records without parsing model-visible task text. A shared, injection-safe follow-up preamble reads pending records and is appended to every agent prompt; the three admitted inbound surfaces retain the sole creation capability while every surface with schedule cancellation can resolve a listed follow-up.

**Tech Stack:** TypeScript, Node test runner, existing locked `schedule-store`, household timezone helpers, prompt templates and `fillTemplate`.

---

### Task 1: Represent and schedule capped follow-up kinds

**Files:**
- Modify: `app/scripts/schedule-store.ts`
- Modify: `app/scripts/followup-normalization.ts`
- Modify: `app/scripts/followup-normalization.test.ts`
- Modify: `app/scripts/followup-cli.ts`
- Modify: `app/scripts/followup-cli.test.ts`

**Step 1: Write failing tests**

Add tests for a `FollowUpState` record with a bounded normalized subject and `kind: "date" | "topic"`; test topic creation syntax `followup-cli add "subject" --topic`, both kinds' household-local 13:00–15:59 timing (topics exactly two civil days later), three-pending cap rejection, one-follow-up-per-local-day forward movement, and date-record priority moving a topic record from a conflicting day to the next available day.

**Step 2: Run the focused tests to verify they fail**

Run: `cd app && node --import tsx --test scripts/followup-normalization.test.ts scripts/followup-cli.test.ts`

Expected: FAIL because topic syntax, metadata, and conflict resolution are absent.

**Step 3: Write minimal implementation**

Add optional `follow_up` metadata only to ordinary one-shot task records. Extend `followup-cli` to accept exactly one of `--plan-date YYYY-MM-DD` or `--topic`; retain date-to-follow-up-day selection but schedule both kinds only from 13:00–15:59 household-local; select topics two civil days after creation. Inside the existing single `mutate` transaction, count pending follow-up records, reject the fourth, calculate occupied local civil days, and relocate conflicts. On a date collision with a topic task, move the existing topic task forward to the next free day before adding the date task. Date tasks never move for topic tasks. Persist `follow_up.kind` and normalized subject, and continue using the normal delivery route and scheduler record.

**Step 4: Run the focused tests to verify they pass**

Run: `cd app && node --import tsx --test scripts/followup-normalization.test.ts scripts/followup-cli.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add app/scripts/{schedule-store.ts,followup-normalization.ts,followup-normalization.test.ts,followup-cli.ts,followup-cli.test.ts}
git commit -m "feat: add capped topic follow-ups"
```

### Task 2: Inject safe pending-follow-up context and update guidance

**Files:**
- Create: `app/scripts/followup-preamble.ts`
- Create: `app/scripts/followup-preamble.test.ts`
- Modify: `app/scripts/proactive-followup-guidance.ts`
- Modify: `app/scripts/mail-bot.ts`
- Modify: `app/scripts/sms-bot.ts`
- Modify: `app/scripts/chat-bot.ts`
- Modify: `app/scripts/discord-bot.ts`
- Modify: `app/scripts/heartbeat.ts`
- Modify: `app/scripts/tui.ts`
- Modify: `app/scripts/voice-bot.ts`
- Modify: `app/evals/harness.ts`

**Step 1: Write failing tests**

Test a preamble that lists only validated follow-up id, kind, due time, and normalized subject; excludes delivery targets and arbitrary task text; safely falls back to an empty/no-record block on unreadable state. Add assertions that mail, SMS, Home Chat, Discord message/reaction, heartbeat, TUI normal (non-onboarding), voice dispatch, and eval prompt rendering include the same follow-up context. Test that the Monday/Friday morning check-in folds a same-recipient pending follow-up into that recipient's update, consumes it after successful delivery, and leaves SMS-group follow-ups for their normal 13:00–15:59 execution. Update behavioral eval scenarios for topic creation and cancellation after a later turn resolves the topic.

**Step 2: Run the focused tests to verify they fail**

Run: `cd app && node --import tsx --test scripts/followup-preamble.test.ts scripts/{mail-bot,sms-bot,chat-bot,discord-bot,heartbeat,tui,voice-bot}.test.ts evals/harness.test.ts`

Expected: FAIL because the shared preamble and all-surface injection are absent.

**Step 3: Write minimal implementation**

Create an async/synchronous shared reader appropriate to the existing prompt builders that loads scheduler tasks and renders a constant-structured, prompt-safe block from typed `follow_up` metadata. Append it to all normal agent prompts, including unsupported surfaces; do not add `followup-cli` creation authority beyond mail/SMS/Home Chat. In the Monday/Friday system handler, select due-later-today direct mail/SMS follow-ups for each matching recipient, include them in that recipient's daily update, and consume only those delivered records; SMS-group routes are never candidates. Update guidance so only supported inbound surfaces can proactively create, a topic must be a specific, concrete unresolved matter that merits a check-in—not a default action after every interaction—and every normal discussion run compares the injected ids to the current discussion and cancels a follow-up whenever the topic may already be resolved. State the deliberately broad cancellation rule explicitly: err toward cancelling rather than sending an unnecessary check-in; certainty is not required. Keep explicit user reminders on `schedule-cli`, and preserve truthful cancellation behavior.

**Step 4: Run the focused tests to verify they pass**

Run: `cd app && node --import tsx --test scripts/followup-preamble.test.ts scripts/{mail-bot,sms-bot,chat-bot,discord-bot,heartbeat,tui,voice-bot}.test.ts evals/harness.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add app/scripts app/evals
git commit -m "feat: expose pending follow-ups to every run"
```

### Task 3: Document and verify the revised behavior

**Files:**
- Modify: `app/docs/architecture/proactive-followups.md`
- Modify: `README.md` (only if its follow-up description needs terminology alignment)
- Modify: `docs/superpowers/plans/2026-08-27-general-followups.md`

**Step 1: Update architecture documentation**

Document the two kinds, uniform 13:00–15:59 timing, topic timing, three-pending and one-per-day limits, date-over-topic conflict resolution, Monday/Friday same-recipient daily-update consumption (and SMS-group exclusion), metadata purpose, all-surface safe prompt preamble, and retained creation grants/delivery boundaries.

**Step 2: Run complete verification**

Run: `cd app && npm run typecheck && make check`

Expected: exit 0.

**Step 3: Inspect the final diff**

Run: `git diff --check origin/feat/proactive-date-followups...HEAD && git status --short`

Expected: no whitespace errors and only intentional files.

**Step 4: Commit**

```bash
git add app/docs/architecture/proactive-followups.md README.md docs/superpowers/plans/2026-08-27-general-followups.md
git commit -m "docs: describe general follow-up scheduling"
```
