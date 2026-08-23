# Natural Morning Handoff

**Date:** 2026-08-23

**Status:** Approved in chat and self-reviewed; independent spec review pending

## Goal

Make the recurring `morning-check-in` feel like part of an existing conversation rather than a nearby unsolicited message.

From 06:00 until noon household-local time, an accepted inbound email, SMS, or Home Chat message may consume some or all of that day's canonical recurring morning occurrence before the normal 08:00–08:59 delivery. A winning inbound reply answers the person's actual message and, when reliable context exists and the situation is appropriate, naturally folds in the morning calendar/Friday/Monday update. Heartbeat later skips consumed recipients and delivers only to anyone still pending.

The primary invariant is suppression, not guaranteed inclusion: once an eligible inbound wins, that recipient remains consumed even if calendar context is unavailable, the combined model run fails, or the model appropriately omits the addition. Occasional duplicates or skipped deliveries are accepted at cross-file/process crash boundaries; every ordering choice should prefer a skipped morning update over a duplicate or closely adjacent automatic outbound.

## Locked product decisions

1. Eligible surfaces are direct email, 1:1 SMS, SMS groups, and Home Chat. Discord, voice, and TUI do not participate.
2. Eligibility opens at exactly 06:00 and closes at exactly 12:00 in the household timezone. It is not limited to the selected 08:00–08:59 instant: a still-current occurrence may be consumed before or after its selected time.
3. Direct email and 1:1 SMS consume only the resolved household contact. A person's known email and phone aliases share one consumption boundary.
4. Home Chat is household-shared. A winning Home Chat message consumes the whole occurrence.
5. Any SMS group message from an admitted household sender consumes the whole occurrence.
6. A shared-channel reply includes morning context only when nobody was consumed earlier and the channel is safe for household context:
   - Home Chat is household-safe by construction.
   - An SMS group is household-safe only when the received participant snapshot is present and valid, every non-Baxter participant is an admitted household phone, and the group ID is valid for a group reply.
7. An SMS group with an outsider, incomplete/malformed metadata, or a prior individual/automatic consumption closes silently. It answers normally but receives no morning context.
8. Consumption is persisted before context preparation or the inbound model run. It is never rolled back for context failure, model failure, token exhaustion, fallback delivery, dispatcher loss, or model omission.
9. When context exists, Baxter includes it by default but may omit it when urgency, safety, grief, or sensitivity makes an aside inappropriate.
10. The feature uses a separate sidecar ledger rather than extending `schedule.json`. It is intentionally best-effort across the schedule and sidecar files and fails toward skipped delivery.
11. Inbound consumption does not immediately advance `schedule.json`. Heartbeat processes and advances the selected occurrence at its normal time. The Home schedule view may continue showing a closed occurrence until then.
12. Manual `schedule-cli system trigger morning-check-in` one-shots remain independent and never read or write handoff state.

## Non-goals

- Perfect atomicity between `schedule.json`, the handoff sidecar, transcripts, model output, and provider delivery.
- Exactly-once delivery after process crashes or transient storage failures.
- Transcript scanning to infer the first message of the day.
- Immediate schedule-view advancement after an early inbound closes the occurrence.
- New schedule controls, user-configurable windows, or UI for sidecar state.
- Handoffs in Discord, voice, or TUI.
- Morning context in an SMS group that might contain an outsider.
- A second model run that separately writes morning copy for an inbound reply.
- Applying standalone morning output validators to a combined conversational reply.
- Changing the independent behavior of manual system triggers.
- Changing dependencies or `app/package-lock.json`.

## Terms

- **Canonical occurrence:** the enabled `system:morning-check-in` record whose `system.key` is `morning-check-in`; its persisted `next_run_at` identifies one recurring occurrence.
- **Occurrence key:** the exact absolute ISO string in that canonical record's `next_run_at`.
- **Direct consumption:** suppression of one resolved contact across their known admitted email and phone aliases.
- **Shared close:** suppression of every recipient for one occurrence.
- **Morning claim:** an in-memory, one-run indication that a particular inbound sidecar transaction won and may prepare a prompt addition. It is never persisted with a transcript or in the sidecar.
- **Automatic consume:** heartbeat's final sidecar transaction immediately before one contact's SMS-first provider chain.

## Architecture

The feature has three bounded units:

1. **`morning-handoff-store.ts`** owns the versioned sidecar, address tokens, locking, atomic writes, schema bounds, pruning, and direct/shared/automatic consume operations. It has no calendar, model, transcript, prompt, or provider access.
2. **`morning-handoff.ts`** resolves canonical-occurrence eligibility, household identities, group classification, in-memory claims, and sanitized morning context packets. It composes existing allowlist/recipient/calendar/check-in helpers but does not send messages.
3. **Surface and heartbeat integration** calls those units at explicit boundaries: inbound after durable receipt/admission but before dispatch, prompt preparation at the eventual run, and heartbeat immediately before automatic delivery.

The sidecar is the durable suppression authority. `schedule.json` remains the recurrence authority. Neither file embeds data from the other. The exact occurrence key joins them best-effort: stale sidecar entries cannot suppress a newly selected occurrence because the key differs.

## Canonical occurrence eligibility

An inbound attempt samples an injected/current daemon clock; it does not trust provider-authored `at` timestamps for the 06:00/noon decision. The attempt is eligible only when all of the following hold in one schedule snapshot:

1. Local time is at least 06:00:00 and strictly before 12:00:00 under `householdTz`.
2. Exactly one unambiguous canonical recurring record exists for `morning-check-in`. Duplicate/colliding, malformed, unknown, or trigger records never become handoff authority.
3. `system.enabled === true` literally.
4. `next_run_at` is a parseable absolute instant whose household-local civil date equals the sampled clock's local civil date.
5. The selected occurrence has not already advanced to a later local date.

The selected time may be in the future or past. `invisible_until` does not make an occurrence ineligible: an inbound and an in-progress heartbeat handler still race at the per-recipient sidecar boundary.

Inbound helpers read schedule state but do not reconcile or mutate it. Startup/tick/CLI reconciliation remains the sole canonical-record repair path. Missing, corrupt, ambiguous, disabled, or not-today schedule state yields no consumption and no prompt addition; the ordinary inbound reply continues.

After a winning sidecar consume and before building a prompt addition, the run re-reads the canonical record. It prepares context only if the same occurrence key is still current and enabled. A schedule advance during debounce therefore leaves a harmless stale suppression entry and no duplicate morning addition.

A claim captured at 11:59 may continue through a run that finishes after noon, just as a heartbeat handler begun before cutoff may finish after cutoff. The claim's captured consumption instant governs calendar selection, subject to the same-occurrence recheck.

## Sidecar path and schema

Production state lives beside the schedule at:

```text
~/.mail-agent/schedule/morning-handoff.json
```

`paths.ts` exports `MORNING_HANDOFF_PATH`. Under `SCHEDULE_DIR_OVERRIDE`, the sidecar resolves to `<override>/morning-handoff.json`, keeping schedule/handoff tests isolated without a second override variable.

Version 1 has this conceptual shape:

```json
{
  "version": 1,
  "occurrences": {
    "2026-08-23T15:42:00.000Z": {
      "closed": false,
      "consumed": ["64 lowercase hex characters"],
      "updated_at": "2026-08-23T13:05:00.000Z"
    }
  }
}
```

Requirements:

- occurrence keys and `updated_at` values are parseable canonical ISO strings;
- `closed` is a literal boolean;
- `consumed` is a deduplicated, sorted array of exact lowercase SHA-256 strings;
- the complete file is capped at 64 KiB;
- at most eight occurrences are retained;
- at most 256 consumed tokens are retained per occurrence;
- unknown fields, wrong versions, invalid values, or exceeded bounds make the file unavailable rather than partially trusted;
- valid mutations retain the newest eight occurrence keys by absolute time and atomically prune older ones.

The initial file is created atomically with mode `0600`. Every replacement temp is `0600`, written in the same directory, and renamed atomically. `proper-lockfile` uses the established retry/stale profile shared by the schedule and transcript stores. Failed writes clean up their temp best-effort. Read-only snapshots never rewrite a valid no-change file.

### Recipient tokens

A canonical address becomes:

```text
sha256("baxter-morning-handoff:v1\0" + canonicalAddress)
```

where canonical email is admitted lowercase email and canonical phone is admitted E.164. Only the lowercase digest is persisted. Tokens are stable across processes and channels but never logged or inserted into model prompts.

A resolved contact is consumed when any token derived from their current admitted phones/emails appears in the occurrence. A winning direct attempt adds tokens for every address of the unambiguously resolved contact. If the triggering address cannot be paired but is itself admitted, it adds at least that address token. This permits heartbeat to suppress the matching current contact without inventing an identity relationship.

A consume mutation receives the current resolved roster. After adding tokens, it marks `closed:true` when every current resolved contact intersects the consumed set. That snapshot deliberately favors skipping a contact added later over reopening an already-finished morning. Closing because this direct mutation consumed the final pending contact does not revoke this mutation's own `direct-consumed` outcome or in-memory claim.

### Mutation outcomes

Store APIs return fixed decisions, never identities or free-form detail:

- `direct-consumed` — this contact won and may carry a direct morning claim;
- `shared-closed` — this shared attempt won; a separate boolean says whether household context is eligible;
- `already-consumed` — this contact, shared occurrence, or closed occurrence already lost;
- `automatic-consumed` — heartbeat won the contact immediately before provider work;
- `state-unavailable` — lock, read, schema, or write authority was unavailable.

Direct and shared inbound consumes are durable before their result is handed to a dispatcher. Automatic consume is durable before the first SMS/email provider call. No outcome is rolled back.

## Corruption, bounds, and fail-toward-skipped behavior

The store distinguishes a valid empty file from unavailable state. It never treats malformed state as an open occurrence.

Every heartbeat inspection and consume operation obtains the sidecar lock. When any locked operation finds corrupt, oversized, unsupported, or malformed content, it replaces the file atomically with canonical v1 state containing only the current occurrence marked `closed:true`. It returns `state-unavailable`, so an inbound receives no context and heartbeat sends nothing. This repairs future occurrences without trying to salvage attacker/hand-edited tokens. A valid inspection is read-only and does not rewrite the file.

When the store cannot obtain the lock, read, create, or write the file, it does not throw into the inbound receipt path. Inbound answers normally without a morning claim. Heartbeat treats unavailable state as closed for that occurrence: it performs no provider calls, reports successful no-op completion, and lets the normal scheduler advance. This prevents repeated hard retries from producing a later automatic message near a household interaction.

A transient inbound write failure that clears before heartbeat is an accepted duplicate window. Other accepted windows include schedule advancement racing a sidecar write and a provider send winning immediately before an inbound consume. No design can remove those windows without the cross-file transaction/lease architecture explicitly rejected for this feature.

## Inbound consumption boundary

Consumption occurs after the inbound has been durably applied and a household authority exists, but before the surface's debounced model run:

- **Mail:** build/append the transcript, require `allowedSender`, then attempt direct consumption before inbound moderation and `notify`. A household message later blocked by moderation still suppresses the morning outbound. Unauthorized mail never mutates handoff state.
- **1:1 SMS:** after transcript append succeeds, attempt direct consumption before read-receipt/dispatch. The helper independently requires an admitted household phone.
- **SMS group:** after transcript append succeeds, classify the admitted sender/group and attempt shared close before dispatch. A non-household group sender never mutates state.
- **Home Chat:** after a `send-message` intent is durably appended, attempt household-shared close before title/dispatch. Create/delete intents never participate.

A failed transcript append/dead-lettered message does not consume because the user turn was not applied to the conversation. A handoff-store failure never dead-letters, blocks, or replays an otherwise valid inbound.

### Debounce and in-memory claims

Consumption precedes the 1.2/4-second surface debounce, so a message near the automatic window can suppress before its model run begins. A winning decision creates a transient `MorningHandoffClaim` carrying only:

- occurrence key;
- captured consumption instant;
- audience (`direct` or `household`);
- cleaned recipient/household context needed for prompt preparation.

The surface's dispatcher envelope/coalescer preserves the earliest non-null winning claim for a key while retaining the latest inbound payload, so a quick second message cannot overwrite the first message's claim with `already-consumed`. The claim is consumed by at most one run. A process crash, budget-dropped trigger, moderation stop, or delivery failure after sidecar persistence may lose the in-memory claim; this is an intentional skipped-addition outcome, not grounds to reopen suppression.

## Direct identity resolution

Each attempt loads a fresh allowlist and runs the existing `resolveRecipients` rules. It never invents identity from display names beyond those rules.

- Mail canonicalizes the triggering sender with the existing extraction/admission path, then locates the one resolved contact containing that email.
- 1:1 SMS normalizes/admit-checks the triggering phone, then locates the one resolved contact containing that phone.
- If one contact matches, all of that contact's admitted aliases are tokenized and the existing `buildRecipientContexts` entry becomes the direct prompt audience.
- If no contact matches but the triggering address is admitted, only its token is consumed and the direct audience uses a null current-recipient display name. No phone is paired to an email, or vice versa, by guesswork.
- More than one current contact matching one canonical address is invalid ambiguity and yields `state-unavailable`; it never consumes an arbitrary person.

No address survives into the claim's prompt-facing audience data.

## SMS group classification

`group_id` presence selects group semantics, matching the existing SMS transcript boundary. A group attempts a shared close only when the canonical inbound sender passes `admittedRosterPhone` against the fresh allowlist.

Shared close and context eligibility are separate decisions. An admitted group always closes, even when it cannot receive morning content.

A group is context-eligible only when all of these hold:

1. No token was consumed and the occurrence was not closed before this transaction.
2. `group_id` passes the shared strict group-ID predicate, so the normal run has a safe `sms-cli send-group` target.
3. `participants` is present as a nonempty array.
4. Every participant canonicalizes to E.164; duplicates collapse.
5. Baxter's configured sending number is ignored when present.
6. At least one non-Baxter participant remains, and the canonical inbound sender appears in that set.
7. Every remaining participant passes `admittedRosterPhone` against the same allowlist snapshot.

The received participant array is treated as the provider's current snapshot, not as user-authored proof beyond that boundary. It need not contain every resolved household phone; it must contain only household phones after excluding Baxter. Missing data, an invalid number, an outsider, an invalid group ID, an empty non-Baxter set, or failure to include the sender makes the close silent.

If any direct or automatic token already exists, a later household-only group closes silently to avoid showing a duplicate update to someone already served. Two shared channels race under the sidecar lock; only the first open occurrence can receive a household claim. Setting `closed:true` does not revoke that winning shared mutation's own household claim.

## Home Chat classification

Every successfully applied Home Chat `send-message` is an authenticated household-shared interaction. It closes the whole occurrence regardless of which member authored the message. It receives a household claim only when the occurrence was open with no prior consumed token. If a direct/automatic recipient already won, Home Chat closes the remainder silently.

Home Chat does not attempt per-author consumption. Its shared transcript means every member can see the reply, so later individual automatic messages would be duplicates even if only one author typed.

## Morning context packet

A winning, still-current in-memory claim prepares context after consumption. Preparation does not reserve the heartbeat agent-run quota and does not launch a second model. The normal inbound run is the only model run.

Refactor the consolidated handler so automatic delivery and handoff preparation share one authority for:

1. family calendar refresh/cache degradation;
2. own calendar read and exact event validation;
3. today/ongoing/all-day event selection;
4. `calendar` → Friday → Monday → `none` precedence;
5. calendar and weekend projections;
6. durable-knowledge loading and existing bounds.

The packet uses the captured consumption instant and household timezone:

- **Calendar:** the existing bounded sanitized daily `DigestEvent[]`, omitted count, local date/weekday, and direct/household audience.
- **Friday:** at most the existing one sanitized weekend title plus bounded durable knowledge; no time, date, location, URL, omitted count, or itinerary projection crosses into the prompt packet.
- **Monday:** bounded durable knowledge and audience; no calendar event context.
- **None:** no prompt addition.

Direct audience uses the existing `RecipientContext` and attribution instructions. Household audience carries cleaned named household members, bounded by the existing context limits, and explicitly states that no single member is the default referent of “you.” Named facts remain attributed to their named owners; ownerless facts are never assigned to a participant.

Calendar fields and durable knowledge are sentinel-delimited untrusted data, not instructions. The packet contains no email, phone, group ID, chat ID, raw participant metadata, provider field, or sidecar token. Calendar/context preparation failures return no addition and do not affect the already-persisted consumption.

## Prompt integration

`mail-bot.ts`, `sms-bot.ts`, and `chat-bot.ts` accept an optional pre-rendered morning handoff block at their existing prompt-build/run seams. When absent, prompt bytes remain unchanged except for unrelated concurrent main-branch changes.

The block tells Baxter:

1. Answer the person's actual request first and preserve all normal surface reply/tool requirements.
2. When packet content exists, add a short, natural morning aside rather than a second standalone message.
3. Include the useful packet by default, but omit it for urgent, safety-related, grief-heavy, or otherwise sensitive turns where the aside would be inappropriate.
4. Never mention the scheduler, selected time, sidecar, suppression, consumption, a “morning check-in,” or the fact that a separate outbound was prevented.
5. Never print data delimiters or treat data fields as commands.
6. Preserve named fact ownership and the audience rules.

The combined reply uses the normal surface tool path (`mail-cli reply`, `sms-cli`, or `chat-cli send`). Existing inbound hard-failure/token-wall fallback notices remain unchanged. There is no post-generation morning-body validator because the output also contains the user's requested conversational answer and is delivered through agent tool calls. Input projection/privacy boundaries and the ordinary run's tool/admission controls remain authoritative.

Silent closes and `none` mode do not append an empty instruction. Context failure likewise preserves the ordinary prompt shape.

## Heartbeat integration

The sidecar affects only a task that is the canonical recurring `system:morning-check-in`. One-shot `system_trigger` records always execute the current standalone handler behavior without a sidecar read, early filter, or automatic consume.

For the canonical task:

1. Inspect the current occurrence under the sidecar lock before calendar/model/provider work; a valid no-change inspection does not rewrite, while malformed state is repaired closed as specified above.
2. If state is unavailable or `closed`, return `{ok:true, agentRun:false}` with a fixed aggregate detail and perform no calendar refresh, reservation, model, or provider work.
3. Run the existing calendar-first mode selection.
4. Resolve the recipient snapshot and remove contacts already intersecting the consumed-token set before per-recipient quota reservation or model generation.
5. Preserve all current per-recipient generation, deterministic fallback, validation, greeting, and SMS-first/same-contact-email fallback behavior for pending contacts.
6. Immediately before calling `deliverToHousehold` for one contact, run `automaticConsume` under the sidecar lock using the same occurrence key and full resolved-roster snapshot.
7. If another inbound/shared/automatic attempt won, discard this contact's prepared copy and continue without a provider call.
8. If `automaticConsume` wins, call the provider chain. Never roll back its tokens on SMS/email failure or process interruption.
9. If sidecar becomes unavailable mid-handler, stop all remaining delivery, return successful completion with fixed aggregate detail, and let heartbeat advance. Already completed providers remain completed.

Early filtering saves quota for prior inbound winners. The final mutation is the race boundary: an inbound can still suppress while heartbeat is generating copy. Conversely, once heartbeat's final consume wins, a later inbound receives no packet even if the provider call has not completed.

A closed or fully consumed occurrence is a successful no-op, not a hard failure, cap deferral, or gave-up outcome. Normal success advancement selects the next random occurrence and leaves the old sidecar entry inert. Calendar failure before any automatic consume retains normal hard-retry behavior; prior inbound suppressions remain in the sidecar across retries.

Provider errors retain their existing isolated aggregate semantics, except that the contact was consumed before the attempt and therefore cannot be retried by handoff logic.

## Concurrency and accepted race outcomes

The sidecar lock guarantees ordering among direct, shared, and automatic consumes for one occurrence. It does not guarantee ordering with schedule advancement, transcript persistence, model output, or provider transport.

Required in-lock outcomes:

- same person through email and SMS: one direct claim;
- two different direct contacts: each may win once;
- direct then shared: direct may get context; shared closes silently;
- shared then direct: shared may get context; direct loses;
- household shared versus household shared: one gets context, the other loses;
- outsider/ambiguous group first: closes silently and every later attempt loses;
- inbound during automatic generation: inbound wins if it persists before final automatic consume;
- automatic consume first: inbound loses even if provider work is still pending.

Accepted best-effort windows:

- inbound sidecar write fails transiently, then automatic delivery proceeds;
- heartbeat sends immediately before inbound persistence;
- schedule advances after eligibility read but before sidecar write;
- a winning in-memory claim is lost before its model run;
- automatic consume persists, then the process/provider fails before delivery;
- roster membership changes after an occurrence is marked closed.

Every accepted crash/order window either already has a serialized winner or is biased toward no automatic message. No retry/rollback mechanism may be added without a new design decision.

## Privacy and security

- Sidecar state contains only timestamps, booleans, and domain-separated address hashes.
- Hashes, canonical addresses, group IDs, participant lists, and contact indices do not enter logs.
- Prompt audience data contains cleaned bounded display names only; phone and email addresses never enter the morning packet.
- SMS group participant metadata is an admission/classification input only and is never copied into morning context.
- Outside/ambiguous groups receive no calendar or durable-knowledge packet.
- Existing event sanitization and Friday title-only boundary remain unchanged.
- Existing allowlist/provider admission is re-evaluated fresh; the sidecar never authorizes an inbound or outbound.
- The model cannot read or edit the sidecar through its cwd-confined file tools.
- Store diagnostics are fixed categories and bounded aggregate counts. They contain no provider/model/calendar/free-form error text.
- `runAgent` content suppression remains enabled for standalone heartbeat generation. Combined inbound runs retain their existing surface logging behavior; this feature adds no duplicate body logging.

## Diagnostics

Allowed fixed categories include:

```text
direct-consumed
shared-closed-context
shared-closed-silent
already-consumed
not-eligible
state-unavailable
automatic-consumed
automatic-suppressed
```

Logs may include surface, system key, occurrence/cutoff timestamps, fixed category, and aggregate counts. They may not include names, addresses, group IDs, participant values, subjects, bodies, calendar fields, durable facts, generated text, raw store errors, or sidecar hashes.

Heartbeat completion detail remains bounded and aggregate, for example contacts resolved, prior-consumed, auto-consumed, SMS/email delivered, failed, and a fixed sidecar status. No detail reports which contact occupied an index across separate runs.

## File and component changes

Expected implementation seams are:

- `app/scripts/paths.ts` — sidecar path.
- New `app/scripts/morning-handoff-store.ts` and focused tests — bounded file format, hashing, lock/atomic mutation, pruning, unavailable/repair semantics, consume races.
- New `app/scripts/morning-handoff.ts` and focused tests — eligibility, contact mapping, group classification, claims, shared context packet.
- `app/scripts/morning-check-in.ts` — extract shared calendar/mode/context authority; canonical sidecar early/final checks; preserve trigger independence and current standalone generation/delivery.
- `app/scripts/mail-bot.ts`, `sms-bot.ts`, and `chat-bot.ts` plus their tests — post-apply consumption, debounce-preserved claim, optional prompt block, unchanged no-block rendering.
- `app/scripts/household-delivery.ts` only if a minimal pre-delivery hook is cleaner than the handler's existing one-contact calls; no provider-policy change.
- `app/docs/architecture/heartbeat.md` — natural handoff window, per-recipient/shared suppression, delayed advancement, trigger independence, and best-effort failure posture.

Do not edit Discord, voice, TUI, Home worker/UI code, outer-repository code, dependencies, or `app/package-lock.json` unless a reviewed implementation finding proves a required existing call site; any scope expansion requires operator approval.

## Testing

Implementation follows strict TDD. Tests use temporary schedule/sidecar/allowlist/transcript directories and injected clocks/selectors/providers/agents. No test touches live household state.

### Store and eligibility

1. Exact 06:00 is eligible; 05:59:59 and exact noon are not.
2. Eligibility follows household timezone and civil date across spring-forward/fall-back dates.
3. A selected future or past time on today's date is eligible; tomorrow, yesterday, disabled, malformed, missing, duplicate/colliding, trigger, and unknown records are not.
4. The daemon clock, not provider `at`, controls eligibility.
5. Same-occurrence re-read permits context; advancement/disable suppresses context without rollback.
6. Address token vectors pin domain separation, canonicalization, lowercase output, and email/SMS alias intersection.
7. Valid no-change reads do not rewrite; concurrent direct mutations lose no tokens.
8. Same-contact cross-surface races produce one winner; different contacts may both win.
9. Direct/shared and shared/shared races implement the required winner table.
10. Final current-roster consumption marks closed.
11. Version, 64-KiB, eight-occurrence, 256-token, ISO, boolean, hash, unknown-field, and dedup/sort bounds are pinned.
12. Corrupt/oversized mutation repairs current occurrence closed; lock/read/write failures return unavailable without throwing into inbound.
13. Temp files are owner-only and atomic-write cleanup is tested where the filesystem seams permit.

### Channel identity and dispatch

14. Mail consumes after append/admission and before moderation/notify; unauthorized and append-failed mail do not.
15. 1:1 SMS consumes after append and only for an admitted household phone.
16. Group SMS from a non-household sender never mutates.
17. Admitted group SMS always closes, including outsider/missing/malformed metadata.
18. Context-eligible group fixtures require strict ID, present normalized participants, nonempty non-Baxter set, sender inclusion, and all-household admission.
19. Baxter's own number is ignored whether present or absent.
20. A group need not contain every household phone; additional outsiders force silent close.
21. Prior direct/automatic consumption makes a later household-only group close silently.
22. Home Chat send-message closes household-wide; create/delete and failed append do not.
23. A rapid second item cannot overwrite the first item's winning claim during debounce; only one run consumes it.
24. A dropped/crashed run leaves suppression durable and context claim non-recoverable.
25. Unpaired admitted direct addresses consume only their own token and expose no address to the prompt.

### Context and prompts

26. Calendar wins on Friday/Monday; Friday, Monday, and none follow existing precedence.
27. Calendar packets use the exact sanitized daily projection and captured consume time.
28. Friday packets contain at most one sanitized title and no time/date/location/URL/omitted/itinerary data.
29. Monday contains no event context.
30. Direct and household audience instructions preserve named ownership; packet/prompt fixtures contain no known phone/email/group/chat IDs.
31. Context unavailable and none mode return no block while consumption remains.
32. Mail/SMS/Home Chat prompts render the block when supplied and remain byte-identical to the old no-block shape otherwise.
33. Prompt instructions require answer-first/natural inclusion, urgency/sensitivity omission, and no scheduler/sidecar vocabulary.
34. One inbound run occurs; no heartbeat quota reservation or second model call is introduced.
35. Model failure, token exhaustion, fallback notice, and omission do not reopen consumption.

### Heartbeat

36. Manual triggers ignore the sidecar and retain existing immediate behavior.
37. Canonical closed/unavailable state succeeds before calendar/quota/model/provider work.
38. Early consumed filtering avoids quota/model work for those contacts.
39. Inbound winning during generation makes heartbeat discard prepared copy before provider work.
40. Automatic final consume winning causes the later inbound to lose.
41. Shared close during an active handler suppresses every remaining provider call.
42. Mid-handler sidecar unavailability stops remaining sends and completes successfully.
43. Provider failure after automatic consume does not remove tokens or cause handoff retry.
44. Partial consumption sends only remaining contacts with current per-recipient generation, fallback, greeting, SMS-first, admission, and aggregate behavior.
45. Hard calendar failure retains the occurrence and existing suppressions for retry.
46. Closed/all-consumed no-op advances once to one newly randomized occurrence; stale sidecar state does not affect it.
47. Existing catch-up, noon expiry, disable/enable, retry, quota, out-of-token, retired-key cleanup, collision, and random-window suites remain green.

### Verification

48. Focused tests pass under Node's test runner.
49. `./node_modules/.bin/tsc --noEmit` passes.
50. The full `make check` suite passes.
51. `git diff --check` passes.
52. `app/package-lock.json` is byte-identical to `origin/main`.
53. Whole-branch correctness/decay review converges with no unresolved release blocker before PR creation.

## Acceptance criteria

- A direct household email or 1:1 SMS accepted from 06:00 through before noon consumes that contact across known email/SMS aliases.
- Home Chat and admitted SMS groups consume the whole recurring occurrence.
- Only household-safe shared channels with no prior consumption receive morning context; external/ambiguous/prior-consumed groups close silently.
- Consumption precedes context/model work and never rolls back.
- The combined inbound run answers first and naturally includes reliable morning context by default, with an urgency/sensitivity omission escape.
- Heartbeat sends only to still-pending contacts and atomically consumes each immediately before its provider chain.
- Sidecar failure and crashes prefer skipped automatic delivery over duplication.
- The sidecar remains separate from `schedule.json`; schedule advancement stays on the normal heartbeat path.
- Manual triggers remain independent.
- Existing per-recipient fact ownership, calendar/Friday privacy, quota, fallback, SMS-first delivery, provider admission, randomized scheduling, catch-up, and noon expiry remain intact.
- No raw address or participant identity enters morning prompts, logs, or sidecar state.
- No dependency or package-lock change is made.
