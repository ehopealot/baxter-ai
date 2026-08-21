# Per-Recipient System Check-Ins

**Date:** 2026-08-21
**Status:** Approved in chat; pending reviewer-loop validation
**Repository:** `baxter-ai`
**Builds on:** PR #9 (`feat/model-owned-system-check-ins`)

## Goal

Generate the daily calendar message, Friday weekend check-in, and Monday week-start check-in separately for every resolved household recipient. Each model run must know who will receive its output so it can preserve attribution: a preference or statement belonging to Erik must not become a fact about Laura merely because Laura receives the message.

The model may mention other household members when useful. The requirement is not to isolate people from family context; it is to keep facts attached to the correct person.

## Non-goals

- Do not send `ResolvedContact` phone or email arrays to the model.
- Do not infer relationships, identities, or fact ownership from contact phone/email fields.
- Do not add free-text address detection or redaction; display names, calendar fields, and durable knowledge retain their existing sanitization and bounds and are not scanned for address-like substrings in this work.
- Do not pre-filter durable knowledge with brittle name matching.
- Do not create a shared generated message and substitute names afterward.
- Do not add durable per-recipient completion or delivery state.
- Do not change the three system-task keys, schedules, or enablement controls.

## Shared string-safety boundaries

Node 22 provides native `String.prototype.toWellFormed()` and `String.prototype.isWellFormed()` behavior, but the configured `app/tsconfig.json` library is ES2023 and does not declare those methods. Implementation therefore defines a narrow local compatibility declaration and typed wrappers equivalent to:

```ts
type NativeWellFormedString = string & {
  toWellFormed(): string;
  isWellFormed(): boolean;
};

const repairWellFormed = (value: string): string =>
  (value as NativeWellFormedString).toWellFormed();

const isWellFormedString = (value: string): boolean =>
  (value as NativeWellFormedString).isWellFormed();
```

These wrappers invoke Node 22's native semantics; they are not a replacement algorithm, polyfill, global declaration merge, or reason to broaden the configured TypeScript library. Canonical-name repair and calendar title/location repair call `repairWellFormed`, while generated subject/body validation calls `isWellFormedString`. Repair remains the first cleaning operation for untrusted prompt-bound identity and calendar fields. Generated output remains rejected for malformed UTF-16 before normalization or length checks.

These Unicode boundaries do not inspect free-form text for address-like substrings. Display names, calendar title/location fields, and durable knowledge continue through their existing field-specific sanitization and bounds only.

## Recipient resolution and bounded context

Each live handler invocation loads the allowlist and calls the existing `resolveRecipients` boundary before any model invocation. Its contact resolution, deduplication, and safe phone/email routing behavior remain unchanged; this design neither merges contacts nor redesigns recipient identity. The resulting deterministic contact order is the generation and delivery order for that invocation. A newly added contact after this snapshot waits for the next invocation. Provider sends still re-enter the existing fresh admission guards: a snapshotted recipient removed before `sendSms` performs its entry admission check is refused by SMS, and a recipient removed before `sendNew` resolves that recipient is refused by email. This design does not promise atomic revocation after either admission check while cap, moderation, or network work is in flight.

For every resolved contact, define exactly one canonical prompt-safe display name with this pipeline:

```text
rawName = String(contact.name ?? "")
wellFormedName = repairWellFormed(rawName)
controlSafeName = replace each C0/C1 control and U+2028/U+2029 in wellFormedName with U+0020 SPACE
cleanedName = trim(cleanForPromptLine(controlSafeName))
cappedName = cap(cleanedName, 80 Unicode code points)
promptName = cappedName is empty ? null : cappedName
```

`repairWellFormed` is the first canonical-name operation and uses native `toWellFormed()` semantics to replace every unpaired UTF-16 surrogate with U+FFFD. Here C0/C1 means U+0000–U+001F and U+007F–U+009F. Unicode repair, control replacement, and name-specific single-line cleaning all happen before the 80-code-point cap. The resulting non-null `promptName` is well-formed UTF-16 and contains none of those disallowed controls. It is not scanned for address-like substrings. This single final value—not the source name or an intermediate value—is the name used in prompts, household-name content validation, deterministic fallbacks, and runtime greetings. Generation does not compare names for uniqueness, build name-equivalence keys, classify a contact from whether its name is null or shared by another contact, or emit ambiguity alerts.

Build this bounded, untrusted recipient-context data block for the current contact:

```text
current recipient display name: current promptName, or null when unavailable
other named household members: at most the first 20 non-null promptNames for other contacts, in resolved contact order
omitted other named recipient count: named contacts beyond that 20-entry cap
```

The other-name list retains duplicate entries because duplicate names belong to distinct delivery contacts. The omitted count is the only information exposed about names beyond the cap; omitted names themselves do not enter the prompt. The `ResolvedContact` phone and email arrays never enter this structure or model metadata. Runtime uses the same current `promptName` for the bounded greeting, preventing prompt and delivery identity from drifting.

If there are no resolved contacts, the invocation makes no reservations, model calls, or delivery-provider calls and completes with body-free aggregate configuration diagnostics. Friday or daily calendar refresh/fetch and local calendar reads may already have happened under their existing sequencing; those calendar fetches are not delivery-provider calls and this design does not move or suppress them solely because the recipient set is empty.

## Attribution contract

Every per-recipient prompt begins with fixed instructions and a delimited recipient-context data block. The instructions establish:

- “you” and second-person phrasing always refer to the current delivery recipient, whose display name may be null;
- the model decides which supplied durable facts are relevant to this recipient and check-in;
- every named fact, preference, history item, and statement must remain attributed to its named owner;
- other household members may be mentioned naturally with their attribution preserved;
- a fact about Erik may be presented to Laura as a fact about Erik, but never rewritten as a fact about Laura;
- a fact with no identifiable owner must not be assigned to the recipient merely because this prompt is for that recipient;
- contacts with a null or shared display name receive the same durable-knowledge snapshot and relevance instructions as every other contact, without a generic-only classification; and
- the model must not add a salutation because runtime adds the recipient greeting.

This prompt-level rule addresses semantic attribution without pretending free-form durable knowledge can be reliably partitioned in code.

## Per-surface generation

### Friday

For each contact, reserve one model-run slot and invoke one tool-less generation with:

- that contact's recipient context, with the `ResolvedContact` phone/email arrays structurally omitted;
- the bounded memory-first durable-knowledge snapshot already approved for PR #9, including memory and visible Collection text under its existing sanitization and byte ceilings;
- the sanitized upcoming-weekend calendar projection; and
- the existing warm, optional, non-presumptive Friday guidance.

The model returns validated JSON `{subject, body}` for that contact. It may mention other household members, but it must preserve attribution. Calendar-backed plans may be stated as plans; anything not calendar-backed or explicitly confirmed must be framed as a new optional suggestion.

### Monday

For each contact, invoke the same per-recipient JSON generation without calendar data. Its bounded memory and visible Collection text retain the existing sanitization, framing, source order, and byte ceilings before entering the prompt; this work does not scan them for address-like substrings. Clearly current priorities may be mentioned. Older priorities are framed as optional questions, and person-specific knowledge remains attached to the named person.

### Daily calendar message

Retain the existing no-event success path. After calendar refresh, local reads, selection, and projection, if there are zero qualifying events, return `{ ok: true, agentRun: false, detail: "no qualifying events" }` without recipient generation work: no reservation, model call, fallback, or delivery occurs.

When events qualify, invoke one tool-less body generation per resolved recipient with that contact's recipient-context block and the sanitized calendar projection. Daily generation receives no durable knowledge, but per-recipient context still gives the model the correct meaning of “you” and allows natural recipient-aware phrasing.

Friday and daily calendar fields use only sanitized projections; neither their prompts nor deterministic fallbacks may read a raw event title or location. Every title and optional location follows this order before the applicable existing projection cap:

```text
rawField = String(raw calendar field ?? "")
wellFormedField = repairWellFormed(rawField)
controlSafeField = replace each C0/C1 control and U+2028/U+2029 in wellFormedField with U+0020 SPACE
cleanedField = for that title or location, collapse every JavaScript `\s+` run to U+0020 SPACE and trim
projectedField = apply that projection's existing title or location cap
```

An optional location that is empty after cleaning remains omitted. Repair, control replacement, and field-specific whitespace cleaning precede every cap; no address-like substring scan is added. The existing daily sanitized calendar projection caps titles at 200 UTF-16 code units and locations at 160 UTF-16 code units. Each daily cap must be surrogate-safe: if its boundary would fall between a high surrogate and its following low surrogate, the projection backs off by one code unit. The projected title and location therefore contain neither a pre-existing unpaired surrogate nor one created by boundary truncation. Friday retains its already-approved calendar caps and ordering, with the same pre-cap sanitization pipeline.

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

Friday and Monday require an exact-shape JSON object with exactly the `subject` and `body` keys and string values. After parsing and type checks, call the typed `isWellFormedString` compatibility boundary for each string and reject either unless it is well-formed UTF-16; this rejection occurs before any normalization or length check. The weekly subject must then be nonempty, single-line plain text of at most 100 Unicode code points. The weekly body is trimmed after CRLF/CR normalization, must be nonempty plain text, and remains bounded to 1,200 UTF-16 code units before personalization. The existing final weekly body bound of 1,400 UTF-16 code units remains in force after the greeting is added.

Daily requires one nonempty plain-text body. Runtime calls the same `isWellFormedString` boundary and rejects a generated daily body unless it is well-formed UTF-16 before performing any normalization or length check, then validates and normalizes it and constructs the complete per-contact body including the greeting. Only after personalization does runtime enforce the existing 2,000 UTF-16-code-unit daily delivery bound. The greeting is always preserved in full; if truncation is needed, truncate only the generated or fallback body at a text boundary, append one ellipsis, and never split a surrogate pair. Consequently both generated and deterministic-fallback daily deliveries, including their greeting, are at most 2,000 UTF-16 code units. Well-formedness rejection handles malformed strings that already contain lone surrogates; surrogate-safe truncation separately prevents runtime from creating a split from an otherwise well-formed string.

For all generated subjects and bodies:

- reject disallowed C0/C1 controls and U+2028/U+2029; bodies may retain normalized LF paragraph breaks, while subjects may not contain line breaks;
- reject fenced code, Markdown headings, HTML tags, and HTML/comment markup; ordinary plain-text paragraphs and list lines remain allowed;
- reject a weekly subject containing any household recipient `promptName` phrase, using case-insensitive NFKC comparison-word phrase boundaries over the full normalized household-name set, including names omitted from the prompt's 20-name list;
- retain the existing checks that weekly subjects do not expose calendar or durable-knowledge details; and
- reject a leading recipient salutation. At minimum, the deterministic validator rejects a body beginning with `Hi`, `Hello`, `Hey`, or `Dear` as a greeting; a body beginning with a household `promptName` followed by salutation punctuation; and a named time-of-day salutation such as `Good morning, <promptName>`, `Good afternoon, <promptName>`, or `Good evening, <promptName>`, all case-insensitively after normalization. A non-addressing day-aware opening such as `Good morning — here’s your Tuesday calendar` remains valid.

Validation receives the full set of final non-null household `promptName` values rather than only calendar or knowledge text, and household-name matching uses NFKC-normalized, case-insensitive comparison. This comparison is only an output content-validation boundary; it is not a generation-side name-equivalence or uniqueness key. `Dear Laura`, `Good morning, Laura`, a direct `Laura, ...` opening, markup/control output, and a weekly subject containing `Laura` are invalid even when that name is absent from calendar and durable-knowledge input. Any parse, shape, type, normalization, plain-text, length, subject-privacy, or salutation failure is “invalid output” and triggers deterministic fallback for only that contact.

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

- Friday retains the deterministic calendar-aware fallback from PR #9 and consumes only the repaired, control-safe, whitespace-cleaned, bounded calendar projection described above.
- Monday retains its friendly generic fallback.
- Daily gains a deterministic bounded summary built only from that same sanitized projection shape.

The daily fallback is assembled in this fixed order: day-aware opening, representative event lines, omitted-event line when needed, and low-pressure closing. Representative events are considered strictly in existing projected order (all-day first, then effective start, then title tie-break), never re-sorted per recipient. Each line uses only projected time, title, and optional location. Include the longest leading sequence of whole event lines that fits the post-greeting 2,000-unit bound while preserving the opening, omitted line, and closing. The omitted count equals the projection's existing omitted count plus projected events left out of the fallback. This makes selection and overflow deterministic and keeps at least the first representative event whenever qualifying events exist.

Fallbacks are personalized by the runtime greeting and never use person-specific durable knowledge.

## Privacy and logging

- Prompt recipient data contains only bounded, repaired, control-safe display names and aggregate counts. The `ResolvedContact` phone and email arrays are structurally omitted from recipient context and model metadata.
- Memory and visible Collection text retain the existing sanitization, framing, source order, and per-source and aggregate byte ceilings before inclusion in a Friday or Monday prompt.
- Canonical names and calendar title/location fields retain the ordered sanitization pipelines described above. Friday and daily prompts, runtime greetings, and deterministic calendar fallbacks consume only the resulting sanitized projections, never raw names or calendar fields.
- This work does not scan display names, calendar title/location fields, durable knowledge, or provider codes for address-like substrings. Daily receives no durable knowledge.
- Recipient data, durable knowledge, and calendar projections remain delimited untrusted data, never instructions.
- All three per-recipient model calls are tool-less and set content suppression so prompt/output bodies do not enter run logs.
- Model log IDs use occurrence time plus deterministic contact index and structurally exclude contact names and the `ResolvedContact` phone/email arrays.
- `deliverToHousehold` receives/uses the deterministic contact index. A necessary per-attempt diagnostic may contain only task label, `contact=<index>`, channel, and a sanitized fixed error category plus a structured safe code when available. Provider codes retain the existing structured safe-code allowlist only; this work adds no free-text address scan. If the structural check fails, omit the code entirely. The diagnostic must never receive or contain a contact name, a `ResolvedContact` phone/email field value, outbound subject/body, or free-form thrown/provider message.
- Unresolved-phone and recipient-configuration diagnostics report only aggregate counts/flags. In particular, daily no longer logs unresolved phone values.
- Calendar refresh/read/selection diagnostics use fixed categories and aggregate counts and never interpolate arbitrary exception messages or calendar fields.
- Success logs and task result details are aggregate-only: model runs, generated copies, fallbacks, contact count, SMS/email successes, and failure counts.
- Subjects, generated bodies, prompts, calendar fields, and durable-knowledge text never enter operational logs or task details.

## Documentation updates

Implementation updates `app/docs/architecture/heartbeat.md` so it no longer describes daily as one model run or weekly as one household-level shared run/body. The architecture doc must describe per-resolved-contact generation and reservation, the retained daily no-event short circuit, aggregate diagnostics that structurally omit contact phone/email fields, and the in-process-only duplicate-prevention/restart caveat. Existing system-task keys, schedules, subject text, and CI guidance remain unchanged.

## Testing

Update focused unit and integration coverage, including the existing one-run/shared-copy assertions in `app/scripts/daily-calendar-digest.test.ts`, `app/scripts/daily-calendar-digest.integration.test.ts`, `app/scripts/weekly-household-check-in.test.ts`, and `app/scripts/weekly-household-check-in.integration.test.ts`, to cover:

1. Friday, Monday, and qualifying-event daily invoking once per resolved contact in deterministic order.
2. The daily zero-event success path causing zero recipient reservations, model calls, fallbacks, and sends with `agentRun:false`.
3. Distinct recipient prompts and outputs reaching only their intended contacts, with each model call receiving that contact's `promptName` (or null), other-name list, and omitted-name count.
4. Recipient context and model metadata structurally omitting the `ResolvedContact` phone/email arrays while containing the cleaned display names and aggregate counts.
5. The single canonical `promptName` pipeline calling the typed native well-formedness repair boundary first, then replacing disallowed controls, applying name-specific single-line cleaning and trimming, and capping at 80 Unicode code points before mapping empty output to null. Fixtures include NUL, ESC, a C1 control, a lone high surrogate, and a lone low surrogate. Assert that no malformed surrogate or disallowed control reaches a prompt, deterministic fallback, or delivered greeting.
6. At most 20 other prompt names in resolved order, overflow names absent, and only the correct omitted-name count exposed.
7. “You” being defined as the current recipient and the prompt explicitly preserving attribution across other household members while assigning relevance selection to the model.
8. An Erik-specific fact remaining attributed to Erik in Laura's prompt/output fixture rather than becoming Laura's preference.
9. Null and duplicate display-name contacts receiving the same bounded durable-knowledge input and model-owned relevance instructions as other contacts, with no uniqueness/equivalence field, ambiguity alert, or generic-only instruction in any recipient prompt.
10. One quota reservation per attempted model call, with quota exhaustion, invalid output, hard failure, and out-of-tokens producing per-contact fallback without skipping later delivery.
11. Exact weekly JSON shape plus subject/body type, control, markup, and length rejection; daily plain-text/control/markup rejection. Lone-high- and lone-low-surrogate generated-output fixtures are rejected through the typed native well-formedness compatibility boundary before normalization or length checks for daily bodies and for weekly subjects and bodies, including `\ud800` and `\udc00` escaped inside otherwise valid weekly JSON.
12. Salutation fixtures including `Dear <name>`, `Good morning, <name>`, direct-name openings, and leading `Hi there`, `Hello everyone`, and `Hey folks`, plus a weekly name-bearing subject, all producing only that contact's fallback. A separate weekly subject contains an NFKC/case variant of a household `promptName` omitted by the 20-name prompt cap, proving subject validation uses the full resolved household-name set. A non-addressing day-aware daily opening remains valid.
13. Daily generated and fallback final bodies staying within 2,000 UTF-16 code units after the preserved greeting, including whitespace truncation and surrogate-pair boundary cases.
14. Friday and daily calendar sanitization plus daily fallback ordering, whole-line fitting, location rendering, and omitted count, including events dropped only to satisfy the post-greeting bound. Title and location fixtures separately contain pre-existing lone high and lone low surrogates and C1 controls; assert that no malformed surrogate or disallowed control reaches Friday/daily prompts or deterministic calendar fallbacks. Supplementary-character fixtures cross both daily's 200-unit title boundary and 160-unit location boundary and assert that projected fields and the assembled fallback contain no pre-existing or boundary-created lone surrogate; at least one such fallback remains below 2,000 units and receives no final-body truncation. Existing calendar caps, projection order, and fallback order remain unchanged.
15. Per-contact subjects and bodies remaining isolated through SMS-first/same-contact-email fallback, with byte-identical same-contact provider payloads and fresh admission checks.
16. Snapshot-versus-admission races: a recipient admitted only after generation begins receives neither a model call nor a send in that invocation. A recipient in the initial snapshot may have been generated for but is refused when removed immediately before `sendSms` performs its entry admission check, and is refused when removed immediately before `sendNew` resolves that recipient. The race fixtures exercise those concrete admission seams without asserting atomic revocation after either check.
17. One bounded attempt chain per contact index in a live invocation, no in-process revisit after handled failures, and an explicit heartbeat-level fixture/documented assertion that a crash/retry may begin a new invocation at contact zero because no durable completion state exists.
18. Content-suppressed model runs; occurrence-plus-index log IDs; recipient context, model metadata, and diagnostics structurally omitting contact phone/email fields; delivery diagnostics containing only index/channel/fixed safe category/code; unresolved-phone diagnostics containing counts, not values; arbitrary provider/calendar exception messages absent; and aggregate-only task details. Provider-code fixtures retain ordinary values accepted by the existing structured safe-code allowlist and omit codes that fail that structural check.
19. Zero resolved contacts causing zero reservations, model calls, and delivery-provider sends while allowing existing calendar refresh/fetch sequencing.
20. Memory and visible Collection fixtures retain existing sanitization, source ordering, framing, and byte ceilings.
21. Existing calendar selection, durable-knowledge bounds, system registry, schedule mirror, runtime dispatch, and provider admission behavior remaining intact.

No production acceptance depends on a live model or delivery provider. Focused TypeScript checking must pass with `app/tsconfig.json` still targeting and loading ES2023; the implementation must not broaden its configured library to obtain `toWellFormed`/`isWellFormed` declarations. Affected unit/integration suites run locally. The pull-request CI workflow remains the authoritative full-project check before merge.

## Acceptance criteria

- Every resolved recipient enters at most one successful delivery chain per live handler invocation.
- Every non-fallback delivered message was generated specifically for that recipient.
- Each model call receives its current contact's cleaned display name or null and at most 20 other named household contacts; recipient context and model metadata structurally omit the `ResolvedContact` phone/email arrays, durable knowledge retains its existing sanitization and bounds, and name overflow exposes only a count.
- The prompt permits relevant mentions of other members while explicitly prohibiting cross-person fact reassignment; the model owns fact relevance without generation-side uniqueness/equivalence matching, ambiguity classification, or ambiguity alerts.
- One well-formed, control-safe final `promptName` (or null) is used everywhere; the typed compatibility boundary invokes native `toWellFormed()` semantics before control replacement, name-specific cleaning, and truncation.
- Each model call is individually quota-reserved and tool-less.
- Daily with no qualifying events remains a successful zero-reservation, zero-model, zero-delivery short circuit.
- Partial quota/provider/model failures degrade to per-contact fallback without revisiting completed contact indices during the same live invocation.
- A snapshotted recipient removed before the `sendSms` entry admission check or before `sendNew` resolves that recipient is refused at that seam; no atomic revocation after either check is claimed.
- A crash or restart may retry from contact zero under existing heartbeat semantics; no durable per-recipient completion guarantee is claimed.
- Weekly parsed subject/body strings and daily generated bodies containing pre-existing lone surrogates are rejected through the typed native well-formedness boundary before normalization or length checks; separately, calendar projection and final-body caps do not create surrogate splits, runtime greetings cannot create an over-limit daily body, and deterministic fallback obeys the same final bound.
- Friday and daily prompts and deterministic calendar fallbacks use only calendar titles/locations repaired, control-cleaned, whitespace-cleaned, and then capped under their existing projection contracts.
- Logs, diagnostics, task details, and model metadata structurally exclude the `ResolvedContact` phone/email arrays; logs and task details also contain no names, content, calendar fields, durable knowledge, or free-form exception messages, only aggregate summaries and index/channel/fixed-category diagnostics plus structurally accepted provider codes.
- Friday, Monday, and daily preserve their approved tone, calendar, subject, length, privacy, and delivery contracts.
- Focused typechecking and affected suites pass locally; the pull-request CI workflow is the authoritative full-project check before merge.
