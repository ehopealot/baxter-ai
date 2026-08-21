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
- Do not create a shared generated message and substitute names afterward.
- Do not add durable per-recipient completion or delivery state.
- Do not change the three system-task keys, schedules, or enablement controls.

## Recipient resolution and bounded context

Each live handler invocation loads the allowlist and calls the existing `resolveRecipients` boundary before any model invocation. The resulting deterministic contact order is the generation and delivery order for that invocation. A newly added contact after this snapshot waits for the next invocation. Provider sends still re-enter the existing fresh admission guards: a snapshotted recipient removed before `sendSms` performs its entry admission check is refused by SMS, and a recipient removed before `sendNew` resolves that recipient is refused by email. This design does not promise atomic revocation after either admission check while cap, moderation, or network work is in flight.

For every resolved contact, define exactly one canonical prompt-safe display name with this pipeline:

```text
wellFormedName = contact.name.toWellFormed()
controlSafeName = replace each C0/C1 control and U+2028/U+2029 in wellFormedName with U+0020 SPACE
cleanedName = trim(cleanForPromptLine(controlSafeName))
cappedName = cap(cleanedName, 80 Unicode code points)
promptName = cappedName is empty ? null : cappedName
```

`toWellFormed()` is the first canonical-name operation and replaces every unpaired UTF-16 surrogate with U+FFFD. Here C0/C1 means U+0000–U+001F and U+007F–U+009F. Unicode repair, control replacement, and cleaning happen before the 80-code-point cap. The resulting non-null `promptName` is well-formed UTF-16 and contains none of those disallowed controls. This single final value—not the source name or an intermediate value—is the name used in prompts, ambiguity checks, household-name validation, and runtime greetings.

Uniqueness compares non-null final `promptName` values using NFKC-normalized, case-insensitive equality over the full resolved snapshot. Therefore different source names that collide after truncation, case variants, and canonically equivalent Unicode spellings are ambiguous and receive generic rather than person-specific durable-knowledge claims. A null `promptName` is never unique. The comparison form is only an equality key; prompts and greetings retain the final cleaned-and-capped `promptName` spelling.

Build this bounded, untrusted recipient-context data block for the current contact:

```text
current recipient display name: current promptName
other named household members: at most the first 20 non-null promptNames for other contacts, in resolved contact order
omitted other named recipient count: named contacts beyond that 20-entry cap
household recipient count: resolved contact count
unnamed recipient count: contacts whose promptName is null
current name unique: current promptName is non-null and its NFKC-normalized, case-insensitive equality key occurs exactly once in the full resolved snapshot
```

The other-name list retains duplicate entries because duplicate names belong to distinct delivery contacts. The omitted count is the only information exposed about names beyond the cap; omitted names themselves do not enter the prompt. Uniqueness and unnamed counts are nevertheless computed over the full snapshot, not the capped list. Addresses never enter this structure. Runtime uses the same current `promptName` for the bounded greeting, preventing prompt and delivery identity from drifting.

If there are no resolved contacts, the invocation makes no reservations, model calls, or delivery-provider calls and completes with body-free aggregate configuration diagnostics. Friday or daily calendar refresh/fetch and local calendar reads may already have happened under their existing sequencing; those calendar fetches are not delivery-provider calls and this design does not move or suppress them solely because the recipient set is empty.

## Attribution contract

Every per-recipient prompt begins with fixed instructions and a delimited recipient-context data block. The instructions establish:

- “you” and second-person phrasing always refer to the current recipient;
- facts, preferences, history, and statements must remain attributed to the person identified by the source data;
- other household members may be mentioned naturally with their attribution preserved;
- a fact about Erik may be presented to Laura as a fact about Erik, but never rewritten as a fact about Laura;
- information whose owner is ambiguous must be omitted rather than reassigned;
- unnamed recipients and recipients whose display name is duplicated, including by truncation, may receive household-wide facts, calendar facts, and generic help, but not person-specific durable-knowledge claims;
- source text using unresolved first-person or second-person references without an identifiable person is ambiguous and must not be assigned to the recipient; and
- the model must not add a salutation because runtime adds the recipient greeting.

This prompt-level rule addresses semantic attribution without pretending free-form durable knowledge can be reliably partitioned in code.

## Per-surface generation

### Friday

For each contact, reserve one model-run slot and invoke one tool-less generation with:

- that contact's address-free recipient context;
- the bounded memory-first durable-knowledge snapshot already approved for PR #9, including memory and visible Collection text serialized through the address-redaction boundary described under Privacy and logging;
- the sanitized upcoming-weekend calendar projection; and
- the existing warm, optional, non-presumptive Friday guidance.

The model returns validated JSON `{subject, body}` for that contact. It may mention other household members, but it must preserve attribution. Calendar-backed plans may be stated as plans; anything not calendar-backed or explicitly confirmed must be framed as a new optional suggestion.

### Monday

For each contact, invoke the same per-recipient JSON generation without calendar data. Its bounded memory and visible Collection text pass through the same address-redaction serialization boundary before entering the prompt. Clearly current priorities may be mentioned. Older priorities are framed as optional questions, and person-specific knowledge remains attached to the named person.

### Daily calendar message

Retain the existing no-event success path. After calendar refresh, local reads, selection, and projection, if there are zero qualifying events, return `{ ok: true, agentRun: false, detail: "no qualifying events" }` without recipient generation work: no reservation, model call, fallback, or delivery occurs.

When events qualify, invoke one tool-less body generation per resolved recipient with that contact's recipient-context block and the sanitized calendar projection. Daily generation receives no durable knowledge, but per-recipient context still gives the model the correct meaning of “you” and allows natural recipient-aware phrasing.

The existing sanitized calendar projection caps titles at 200 UTF-16 code units and locations at 160 UTF-16 code units. Each cap must be surrogate-safe: if its boundary would fall between a high surrogate and its following low surrogate, the projection backs off by one code unit. The projected title and location therefore never contain a lone surrogate created by boundary truncation, independently of whether the assembled final body later needs its own truncation.

The approved email subject remains runtime-owned and exact:

```text
What’s on the calendar today — <local date>
```

The visible task description remains:

```text
Here’s what’s on the calendar
```

## Output validation and runtime personalization

Runtime adds `Hi <promptName> —` or `Hi there —` to all three message types. Generated bodies must not include their own salutation.

Friday and Monday require an exact-shape JSON object with exactly the `subject` and `body` keys and string values. After parsing and type checks, reject either string unless it is well-formed UTF-16; this rejection occurs before any normalization or length check. The weekly subject must then be nonempty, single-line plain text of at most 100 Unicode code points. The weekly body is trimmed after CRLF/CR normalization, must be nonempty plain text, and remains bounded to 1,200 UTF-16 code units before personalization. The existing final weekly body bound of 1,400 UTF-16 code units remains in force after the greeting is added.

Daily requires one nonempty plain-text body. Runtime rejects a generated daily body unless it is well-formed UTF-16 before performing any normalization or length check, then validates and normalizes it and constructs the complete per-contact body including the greeting. Only after personalization does runtime enforce the existing 2,000 UTF-16-code-unit daily delivery bound. The greeting is always preserved in full; if truncation is needed, truncate only the generated or fallback body at a text boundary, append one ellipsis, and never split a surrogate pair. Consequently both generated and deterministic-fallback daily deliveries, including their greeting, are at most 2,000 UTF-16 code units. Well-formedness rejection handles malformed strings that already contain lone surrogates; surrogate-safe truncation separately prevents runtime from creating a split from an otherwise well-formed string.

For all generated subjects and bodies:

- reject disallowed C0/C1 controls and U+2028/U+2029; bodies may retain normalized LF paragraph breaks, while subjects may not contain line breaks;
- reject fenced code, Markdown headings, HTML tags, and HTML/comment markup; ordinary plain-text paragraphs and list lines remain allowed;
- reject a weekly subject containing any household recipient `promptName` phrase, using case-insensitive NFKC comparison-word phrase boundaries over the full normalized household-name set, including names omitted from the prompt's 20-name list;
- retain the existing checks that weekly subjects do not expose calendar or durable-knowledge details; and
- reject a leading recipient salutation. At minimum, the deterministic validator rejects a body beginning with `Hi`, `Hello`, `Hey`, or `Dear` as a greeting; a body beginning with a household `promptName` followed by salutation punctuation; and a named time-of-day salutation such as `Good morning, <promptName>`, `Good afternoon, <promptName>`, or `Good evening, <promptName>`, all case-insensitively after normalization. A non-addressing day-aware opening such as `Good morning — here’s your Tuesday calendar` remains valid.

Validation receives the full set of final non-null household `promptName` values rather than only calendar or knowledge text, and household-name matching uses NFKC-normalized, case-insensitive comparison. `Dear Laura`, `Good morning, Laura`, a direct `Laura, ...` opening, markup/control output, and a weekly subject containing `Laura` are invalid even when that name is absent from calendar and durable-knowledge input. Any parse, shape, type, normalization, plain-text, length, subject-privacy, or salutation failure is “invalid output” and triggers deterministic fallback for only that contact.

## Delivery seam

Friday and Monday have a per-contact generated subject and body. Daily has a shared runtime-owned subject and per-contact generated body. Extend the household delivery seam to select subject and body per deterministic contact index while preserving:

- one computed final body per contact;
- SMS first;
- email fallback only for the same contact;
- byte-identical subject/body as applicable across that contact's provider attempts;
- one successful channel at most per contact in one live handler invocation;
- fresh provider admission checks at `sendSms` entry and `sendNew` recipient resolution, without claiming atomic revocation after admission while cap, moderation, or network work is in flight; and
- body-free, subject-free operational logs.

No generated copy may be reused for another contact.

The handler makes one bounded delivery chain per resolved contact and does not revisit a contact index after that chain finishes. This duplicate-prevention guarantee is deliberately in-process only. There is no durable per-recipient completion state: if the process crashes or restarts after partial delivery, existing heartbeat claim/failure semantics may retry the occurrence after its invisibility window and the new invocation may start again from contact index zero. Cross-restart duplicate prevention is explicitly out of scope.

## Quota and failure behavior

Every actual model invocation consumes its own durable agent-run reservation. Reservations remain bound to the firing system-task ID.

Process contacts sequentially:

1. Reserve immediately before that contact's model call.
2. On valid output, retain the generated copy.
3. On invalid output, rejection, or hard failure, keep the consumed reservation and use fallback copy only for that contact.
4. On quota denial, use fallback copy for that contact and all remaining contacts without making more reservation attempts in the invocation.
5. On out-of-tokens, release that contact's reservation and use fallback copy for that contact and all remaining contacts without making more reservation attempts in the invocation.
6. Continue through one delivery chain per resolved contact and complete the invocation; handled per-contact generation or delivery failures do not cause the live handler to restart from contact zero.

`agentRun` is true when at least one model invocation occurred. Result details report only aggregate counts such as model runs, generated copies, fallbacks, SMS deliveries, email deliveries, and failures.

### Fallback copy

- Friday retains the deterministic calendar-aware fallback from PR #9.
- Monday retains its friendly generic fallback.
- Daily gains a deterministic bounded summary built only from the already sanitized projection.

The daily fallback is assembled in this fixed order: day-aware opening, representative event lines, omitted-event line when needed, and low-pressure closing. Representative events are considered strictly in existing projected order (all-day first, then effective start, then title tie-break), never re-sorted per recipient. Each line uses only projected time, title, and optional location. Include the longest leading sequence of whole event lines that fits the post-greeting 2,000-unit bound while preserving the opening, omitted line, and closing. The omitted count equals the projection's existing omitted count plus projected events left out of the fallback. This makes selection and overflow deterministic and keeps at least the first representative event whenever qualifying events exist.

Fallbacks are personalized by the runtime greeting and never use person-specific durable knowledge.

## Privacy and logging

- Prompt recipient data contains only bounded cleaned display names and aggregate counts.
- Before any memory or visible Collection text can be truncated, framed, or included in a Friday or Monday prompt, it crosses one address-redaction serialization boundary. That boundary replaces every email-shaped token with the fixed marker `[email address removed]` and every phone-like sequence containing 7–15 digits with the fixed marker `[phone number removed]`. Redaction does not reorder sources, and the existing per-source and aggregate durable-knowledge byte ceilings are applied to the redacted serialization.
- Phone numbers and email addresses are excluded from every model prompt: neither recipient context nor durable knowledge may contain them. Daily receives no durable knowledge.
- Recipient data, redacted durable knowledge, and calendar projections remain delimited untrusted data, never instructions.
- All three per-recipient model calls are tool-less and set content suppression so prompt/output bodies do not enter run logs.
- Model log IDs use occurrence time plus deterministic contact index, never a name or address.
- `deliverToHousehold` receives/uses the deterministic contact index. A necessary per-attempt diagnostic may contain only task label, `contact=<index>`, channel, and a sanitized error category plus a structured safe code when available. It must never contain a contact name, phone number, email address, outbound subject/body, or free-form thrown/provider message.
- Unresolved-phone and recipient-configuration diagnostics report only aggregate counts/flags. In particular, daily no longer logs unresolved phone values.
- Calendar refresh/read/selection diagnostics use fixed categories and aggregate counts and never interpolate arbitrary exception messages or calendar fields.
- Success logs and task result details are aggregate-only: model runs, generated copies, fallbacks, contact count, SMS/email successes, and failure counts.
- Subjects, generated bodies, prompts, calendar fields, and durable-knowledge text never enter operational logs or task details.

## Documentation updates

Implementation updates `app/docs/architecture/heartbeat.md` so it no longer describes daily as one model run or weekly as one household-level shared run/body. The architecture doc must describe per-resolved-contact generation and reservation, the retained daily no-event short circuit, aggregate/address-free diagnostics, and the in-process-only duplicate-prevention/restart caveat. Existing system-task keys, schedules, subject text, and CI guidance remain unchanged.

## Testing

Update focused unit and integration coverage, including the existing one-run/shared-copy assertions in `app/scripts/daily-calendar-digest.test.ts`, `app/scripts/daily-calendar-digest.integration.test.ts`, `app/scripts/weekly-household-check-in.test.ts`, and `app/scripts/weekly-household-check-in.integration.test.ts`, to cover:

1. Friday, Monday, and qualifying-event daily invoking once per resolved contact in deterministic order.
2. The daily zero-event success path causing zero recipient reservations, model calls, fallbacks, and sends with `agentRun:false`.
3. Distinct recipient prompts and outputs reaching only their intended contacts.
4. Recipient context containing cleaned names/counts while excluding all email addresses and phone numbers.
5. The single canonical `promptName` pipeline calling `contact.name.toWellFormed()` first, then replacing disallowed controls before cleaning, trimming, and capping at 80 Unicode code points before mapping empty output to null. Fixtures include NUL, ESC, a C1 control, a lone high surrogate, and a lone low surrogate and assert that none reaches a prompt or delivered greeting unrepaired. Null names are non-unique; distinct source names colliding after truncation, case variants, and canonically equivalent Unicode spellings are ambiguous under NFKC-normalized, case-insensitive equality.
6. At most 20 other prompt names in resolved order, overflow names absent, and only the correct omitted-name count exposed.
7. “You” being defined as the current recipient and the prompt explicitly preserving attribution across other household members.
8. An Erik-specific fact remaining attributed to Erik in Laura's prompt/output fixture rather than becoming Laura's preference.
9. Other household members remaining valid content when attribution is preserved, while unnamed and duplicate-name contacts receive generic/household-wide treatment.
10. One quota reservation per attempted model call, with quota exhaustion, invalid output, hard failure, and out-of-tokens producing per-contact fallback without skipping later delivery.
11. Exact weekly JSON shape plus subject/body type, control, markup, and length rejection; daily plain-text/control/markup rejection. Lone-high- and lone-low-surrogate generated-output fixtures are rejected before normalization or length checks for daily bodies and for weekly subjects and bodies, including `\ud800` and `\udc00` escaped inside otherwise valid weekly JSON.
12. Salutation fixtures including `Dear <name>`, `Good morning, <name>`, direct-name openings, and leading `Hi there`, `Hello everyone`, and `Hey folks`, plus a weekly name-bearing subject, all producing only that contact's fallback. A separate weekly subject contains an NFKC/case variant of a household `promptName` omitted by the 20-name prompt cap, proving subject validation uses the full resolved household-name set. A non-addressing day-aware daily opening remains valid.
13. Daily generated and fallback final bodies staying within 2,000 UTF-16 code units after the preserved greeting, including whitespace truncation and surrogate-pair boundary cases.
14. Daily fallback ordering, whole-line fitting, location rendering, and omitted count, including events dropped only to satisfy the post-greeting bound. Supplementary-character fixtures cross both the 200-unit title boundary and the 160-unit location boundary and assert that projected fields and the assembled fallback contain no boundary-created lone surrogate; at least one such fallback remains below 2,000 units and receives no final-body truncation.
15. Per-contact subjects and bodies remaining isolated through SMS-first/same-contact-email fallback, with byte-identical same-contact provider payloads and fresh admission checks.
16. Snapshot-versus-admission races: a recipient admitted only after generation begins receives neither a model call nor a send in that invocation. A recipient in the initial snapshot may have been generated for but is refused when removed immediately before `sendSms` performs its entry admission check, and is refused when removed immediately before `sendNew` resolves that recipient. The race fixtures exercise those concrete admission seams without asserting atomic revocation after either check.
17. One bounded attempt chain per contact index in a live invocation, no in-process revisit after handled failures, and an explicit heartbeat-level fixture/documented assertion that a crash/retry may begin a new invocation at contact zero because no durable completion state exists.
18. Content-suppressed model runs; occurrence-plus-index log IDs; delivery diagnostics containing only index/channel/safe category/code; unresolved-phone diagnostics containing counts, not values; arbitrary provider/calendar exception messages absent; and aggregate-only task details.
19. Zero resolved contacts causing zero reservations, model calls, and delivery-provider sends while allowing existing calendar refresh/fetch sequencing.
20. Memory and visible Collection fixtures containing email addresses and 7–15-digit phone-like sequences are redacted before existing truncation/framing and byte ceilings; neither Friday nor Monday model payloads contain those addresses, while source ordering remains intact.
21. Existing calendar selection, durable-knowledge bounds, system registry, schedule mirror, runtime dispatch, and provider admission behavior remaining intact.

No production acceptance depends on a live model or delivery provider. Focused TypeScript and affected unit/integration suites run locally. The pull-request CI workflow remains the authoritative full-project check before merge.

## Acceptance criteria

- Every resolved recipient enters at most one successful delivery chain per live handler invocation.
- Every non-fallback delivered message was generated specifically for that recipient.
- The model knows the current recipient and at most 20 other named household contacts without receiving contact addresses; memory and visible Collection text are also address-redacted before truncation/framing, and overflow exposes only a count.
- The prompt permits relevant mentions of other members while explicitly prohibiting cross-person fact reassignment.
- One well-formed, control-safe final `promptName` is used everywhere; `contact.name.toWellFormed()` repairs lone surrogates before cleaning and truncation, and ambiguity is then decided with NFKC-normalized, case-insensitive equality, so truncation collisions, case variants, and canonically equivalent spellings cannot be treated as unique.
- Each model call is individually quota-reserved and tool-less.
- Daily with no qualifying events remains a successful zero-reservation, zero-model, zero-delivery short circuit.
- Partial quota/provider/model failures degrade to per-contact fallback without revisiting completed contact indices during the same live invocation.
- A snapshotted recipient removed before the `sendSms` entry admission check or before `sendNew` resolves that recipient is refused at that seam; no atomic revocation after either check is claimed.
- A crash or restart may retry from contact zero under existing heartbeat semantics; no durable per-recipient completion guarantee is claimed.
- Weekly parsed subject/body strings and daily generated bodies containing pre-existing lone surrogates are rejected before normalization or length checks; separately, calendar projection and final-body caps do not create surrogate splits, runtime greetings cannot create an over-limit daily body, and deterministic fallback obeys the same final bound.
- Logs and task details contain no names, addresses, content, calendar fields, durable knowledge, or free-form exception messages; only aggregate summaries and index/channel/safe-code diagnostics are allowed.
- Friday, Monday, and daily preserve their approved tone, calendar, subject, length, privacy, and delivery contracts.
- Focused typechecking and affected suites pass locally; the pull-request CI workflow is the authoritative full-project check before merge.
