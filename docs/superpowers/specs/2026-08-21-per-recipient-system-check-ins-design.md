# Per-Recipient System Check-Ins

**Date:** 2026-08-21
**Status:** Approved in chat; pending reviewer-loop validation
**Repository:** `baxter-ai`
**Builds on:** PR #9 (`feat/model-owned-system-check-ins`)

## Goal

Generate the daily calendar message, Friday weekend check-in, and Monday week-start check-in separately for every resolved household recipient. Each model run must know who will receive its output so it can preserve attribution: a preference or statement belonging to Erik must not become a fact about Laura merely because Laura receives the message.

The model may mention other household members when useful. The requirement is not to isolate people from family context; it is to keep facts attached to the correct person.

## Non-goals

- Do not send email addresses or phone numbers to the model.
- Do not infer relationships, identities, or fact ownership from contact addresses.
- Do not pre-filter durable knowledge with brittle name matching.
- Do not create a shared message and substitute names afterward.
- Do not add persistent per-recipient delivery state or retry already attempted recipients.
- Do not change the three system-task keys, schedules, or enablement controls.

## Recipient resolution

Each occurrence loads the allowlist and calls the existing `resolveRecipients` boundary before any model invocation. The resulting deterministic contact order is the generation and delivery order for that occurrence.

Build a bounded prompt-safe recipient context from the resolved snapshot:

```text
current recipient display name: cleaned name or null
other named household members: cleaned names
household recipient count: resolved contact count
unnamed recipient count: contacts without a cleaned name
current name unique: whether exactly one resolved contact has that cleaned name
```

Names are flattened with the existing prompt-line sanitizer, bounded to the existing display-name limit, and framed as untrusted data. Addresses never enter this structure. Duplicate display names remain distinct delivery contacts but are explicitly marked ambiguous for generation. A newly added contact after this snapshot waits for the next occurrence; provider sends still re-enter the existing fresh admission guards, so a removed contact cannot be sent to merely because it existed in the generation snapshot.

If there are no resolved contacts, the occurrence performs no model runs or provider calls and completes with body-free configuration diagnostics.

## Attribution contract

Every per-recipient prompt begins with fixed instructions and a delimited recipient-context data block. The instructions establish:

- “you” and second-person phrasing always refer to the current recipient;
- facts, preferences, history, and statements must remain attributed to the person identified by the source data;
- other household members may be mentioned naturally with their attribution preserved;
- a fact about Erik may be presented to Laura as a fact about Erik, but never rewritten as a fact about Laura;
- information whose owner is ambiguous must be omitted rather than reassigned;
- unnamed recipients and recipients whose display name is duplicated may receive household-wide facts, calendar facts, and generic help, but not person-specific durable-knowledge claims;
- source text using unresolved first-person or second-person references without an identifiable person is ambiguous and must not be assigned to the recipient; and
- the model must not add a salutation because runtime adds the recipient greeting.

This prompt-level rule addresses semantic attribution without pretending free-form durable knowledge can be reliably partitioned in code.

## Per-surface generation

### Friday

For each contact, reserve one model-run slot and invoke one tool-less generation with:

- that contact's recipient context;
- the bounded memory-first durable-knowledge snapshot already approved for PR #9;
- the sanitized upcoming-weekend calendar projection; and
- the existing warm, optional, non-presumptive Friday guidance.

The model returns validated JSON `{subject, body}` for that contact. It may mention other household members, but it must preserve attribution. Calendar-backed plans may be stated as plans; anything not calendar-backed or explicitly confirmed must be framed as a new optional suggestion.

### Monday

For each contact, invoke the same per-recipient JSON generation without calendar data. Clearly current priorities may be mentioned. Older priorities are framed as optional questions, and person-specific knowledge remains attached to the named person.

### Daily calendar message

After selecting the day's events, invoke one tool-less body generation per recipient with the same recipient-context block and the sanitized calendar projection. Daily generation receives no durable knowledge, but per-recipient context still gives the model the correct meaning of “you” and allows natural recipient-aware phrasing.

The approved email subject remains runtime-owned and exact:

```text
What’s on the calendar today — <local date>
```

The visible task description remains:

```text
Here’s what’s on the calendar
```

## Runtime personalization and delivery

Runtime adds the bounded `Hi <name> —` or `Hi there —` greeting to all three message types. Generated bodies must not include a salutation.

Friday and Monday have a per-contact generated subject and body. Daily has a shared runtime-owned subject and per-contact generated body. Extend the household delivery seam to select subject and body per contact while preserving:

- one computed final body per contact;
- SMS first;
- email fallback only for the same contact;
- byte-identical body across that contact's SMS and email attempts;
- one successful channel at most per contact;
- fresh provider admission checks; and
- body-free, subject-free operational logs.

No generated copy may be reused for another contact.

## Quota and failure behavior

Every actual model invocation consumes its own durable agent-run reservation. Reservations remain bound to the firing system-task ID.

Process contacts sequentially:

1. Reserve immediately before that contact's model call.
2. On valid output, retain the generated copy.
3. On invalid output, rejection, or hard failure, keep the consumed reservation and use fallback copy only for that contact.
4. On quota denial, use fallback copy for that contact and all remaining contacts without making more reservation attempts in the occurrence.
5. On out-of-tokens, release that contact's reservation and use fallback copy for that contact and all remaining contacts.
6. Continue to one delivery attempt per resolved contact and complete the occurrence; do not defer or retry the whole occurrence after partial per-recipient work.

`agentRun` is true when at least one model invocation occurred. Result details report only aggregate counts such as model runs, generated copies, fallbacks, SMS deliveries, email deliveries, and failures.

### Fallback copy

- Friday retains the deterministic calendar-aware fallback from PR #9.
- Monday retains its friendly generic fallback.
- Daily gains a deterministic bounded summary built from the already sanitized projection: a day-aware opening, representative event time/title/location lines, the omitted-event count when applicable, and a low-pressure closing.

Fallbacks are personalized by runtime greeting and never use person-specific durable knowledge.

## Privacy and validation

- Prompt recipient data contains cleaned display names and aggregate counts only.
- Phone numbers and email addresses are excluded from every model prompt.
- Recipient data, durable knowledge, and calendar projections remain delimited untrusted data, never instructions.
- All three per-recipient model calls are tool-less and set content suppression so prompt/output bodies do not enter run logs.
- Log IDs use occurrence time plus deterministic contact index, never a name or address.
- Weekly output remains exact-shape JSON with bounded plain-text subject/body validation.
- Weekly subjects remain generic and may not contain recipient names, calendar details, or durable-knowledge details.
- Daily output remains bounded plain text.
- Generated bodies may name household members in ordinary prose but may not begin with their own salutation.
- Operational logs and task details never contain recipient names, prompts, subjects, generated bodies, calendar fields, or durable-knowledge text.

## Testing

Add focused unit and integration coverage for:

1. Friday, Monday, and daily invoking once per resolved contact in deterministic order.
2. Distinct recipient prompts and outputs reaching only their intended contacts.
3. Recipient context containing cleaned names/counts while excluding all email addresses and phone numbers.
4. “You” being defined as the current recipient and the prompt explicitly preserving attribution across other household members.
5. An Erik-specific fact remaining attributed to Erik in Laura's prompt/output fixture rather than becoming Laura's preference.
6. Other household members remaining valid content when attribution is preserved.
7. Unnamed and duplicate-name contacts receiving generic/household-wide treatment.
8. One quota reservation per attempted model call.
9. Quota exhaustion, invalid output, hard failure, and out-of-tokens producing per-contact fallback without skipping later delivery.
10. Daily deterministic fallback retaining calendar facts and bounds.
11. Per-contact subjects and bodies remaining isolated through SMS-first/email-fallback delivery.
12. Byte-identical same-contact SMS/email bodies and fresh provider admission checks.
13. Content-suppressed model runs, index-only log IDs, and aggregate-only task/log output.
14. Zero resolved contacts causing zero reservations, model calls, and sends.
15. Existing calendar selection, durable-knowledge bounds, system registry, schedule mirror, and runtime dispatch behavior remaining intact.

## Acceptance criteria

- Every resolved recipient receives at most one successful delivery per occurrence.
- Every non-fallback delivered message was generated specifically for that recipient.
- The model knows the current recipient and other named household members without receiving contact addresses.
- The prompt permits relevant mentions of other members while explicitly prohibiting cross-person fact reassignment.
- Each model call is individually quota-reserved and tool-less.
- Partial quota/provider/model failures degrade to per-contact fallback without duplicate retries.
- Friday, Monday, and daily preserve their approved tone, calendar, subject, length, privacy, and delivery contracts.
- Focused typechecking and affected suites pass locally; the pull-request CI workflow is the authoritative full-project check before merge.
