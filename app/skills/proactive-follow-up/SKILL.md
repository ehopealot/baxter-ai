---
name: proactive-follow-up
description: Quietly arrange one origin-bound check-in for a concrete future day/date plan, and safely cancel one later when plans are off.
---

# Proactive date follow-ups

Use this workflow only on an admitted inbound Mail, SMS, or Home Chat turn where this skill is staged. The separate `followup-cli` grant and daemon-owned turn context are the authority; this skill grants nothing.

## Creation workflow

1. Complete the person's primary request first.
2. Resolve day/date language using the household timezone already configured for Baxter (`householdTz()` in the capability). Never ask for or pass a timezone flag.
3. Consider only a plausible intended activity tied confidently to one concrete future civil date.
4. Do **not** create a proactive follow-up when:
   - the person explicitly requested a reminder about it (create only that requested reminder through the schedule workflow);
   - the date is today, past, ambiguous, impossible, vague, or not confidently resolvable;
   - it is not a plausible plan;
   - two or more distinct plans in this inbound turn would each independently qualify. In that case create none rather than choosing;
   - origin/identity/candidate/schedule authority is unavailable; or
   - creation fails.
5. For exactly one qualifying plan, run exactly:

   `followup-cli candidates --plan-date YYYY-MM-DD`

   Compare meaning, not literal words. Suppress only when a returned nearby occurrence is about the same or a similar subject. For example, “grocery run,” “go to the store,” and “pick up groceries” can be similar; an unrelated recurring task is not. A distant task is not in this bounded output and does not suppress.
6. If not suppressed, run exactly once:

   `followup-cli add "<short subject>" --plan-date YYYY-MM-DD`

   Pass only subject and date. Never add recipient, route, phone, group, email, thread, chat, author, provider, delivery, or timezone flags.
7. Only after `add` succeeds, include one short disclosure in the normal reply: **“I’ll check back in about <subject>.”** Never claim a check-in after a refusal, failure, skip, or uncertain result.

Example: “I’m thinking of going to the store on Friday. Please set up a grocery list.” Make the grocery list first; inspect candidates; if eligible add one subject such as `the store trip`; then reply that the list is ready and “I’ll check back in about the store trip.”

## Cancellation workflow

A clear later statement that the plan is off may arrive on any supported conversation surface.

1. Run `followup-cli list`.
2. Match proactive metadata by subject and plan date/context. Never cancel an explicit reminder merely because it sounds similar.
3. If exactly one match is clear, run `schedule-cli cancel <id>` once.
4. If the output is ordinary `cancelled <id>`, say **“Got it—I won’t check back about <subject>.”**
5. If it ends with `send_already_started`, say truthfully: **“I canceled any further attempt, but a check-in may already be on the way.”** Never promise prevention in this case.
6. If multiple candidates are plausible, ask which one rather than bulk-cancelling. If list/cancel fails, do not claim success.
