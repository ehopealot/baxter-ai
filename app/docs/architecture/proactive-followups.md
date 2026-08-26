# Proactive date follow-ups

(part of Baxter — see [architecture map](../../CLAUDE.md))

Mail, direct/group SMS, and Home Chat prompts may suggest one ordinary future check-in when an inbound turn contains one plausible plan on a concrete future day/date without an explicit reminder request. Discord, voice, TUI, heartbeat, and other runs receive neither this guidance nor `followup-cli`.

## Creation

`followup-cli` accepts only:

```text
followup-cli add "<subject>" --plan-date YYYY-MM-DD
```

The supported daemon supplies its admitted delivery surface and target in the run environment. The SMS daemon exposes that capability only after canonicalizing a direct target with `normalizePhone` or validating a group target with `isStrictGroupId`; malformed routes keep ordinary SMS behavior but receive no follow-up route. The CLI revalidates those SMS boundaries before persistence. It also validates the bounded subject, strict Gregorian future date, household-local timing window, and ordinary task cap, then writes a normal one-shot scheduler record. Its `task` and `desc` are both `Check back about <subject>` and its `deliver` is an existing scheduler delivery route: SMS, SMS group, or mail. There is no follow-up metadata, separate context file, special scheduler store, or alternate delivery type.

The model may use ordinary `schedule-cli list` before creation to avoid a similar existing reminder. `followup-cli` does not expose separate list or candidate commands.

## Execution and cancellation

Follow-ups use the normal heartbeat claim, model prompt, delivery, retry, and give-up path. They have the same delivery semantics as any ordinary scheduled task; the model is guided to send a brief check-in using the persisted route.

`schedule-cli cancel <id>` is the only cancellation path. On a clear cancellation, Baxter removes the ordinary task and says, “I won’t remind you again” only after that command succeeds. A missing, failed, or ambiguous cancellation must not claim success. A provider send can theoretically race a cancellation, just as it can for any ordinary scheduled task; this version intentionally has no special marker or ordering protocol.

## Boundaries

The `followup-cli` grant is staged only for the three supported inbound surfaces. The CLI accepts no model-supplied provider, recipient, route, or timezone flags; the trusted daemon environment supplies delivery. Subject/date parsing and scheduler limits remain code-enforced. No Home Worker change or data migration is required.
