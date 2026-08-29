# Corrected Morning Handoff and Home Chat Reminder Design

**Date:** 2026-08-23 (corrected 2026-08-29)

**Status:** Implemented

## Goal

Calendar morning handoffs are at-most-once **per resolved person**, across that
person's admitted SMS/email delivery aliases. Ordinary reminders keep their
explicit delivery target. Home Chat is an ordinary conversational surface, not
a morning-handoff surface; reminders created there need an external route.

The authoritative operational summary is
[`app/docs/architecture/heartbeat.md`](../../../app/docs/architecture/heartbeat.md).

## Morning handoff policy

1. The canonical recurring `morning-check-in` occurrence is eligible only from
   06:00 until noon in the household timezone. Manual `system trigger`
   occurrences never participate.
2. Direct mail and 1:1 SMS resolve against the fresh recipient roster. A winning
   direct handoff persists tokens for every phone, recipient email, and
   unambiguously associated sender-only email alias of that one resolved
   contact. Sender-only aliases are identity-only: they are never automatic
   email targets.
3. If an admitted direct address cannot be resolved to one contact, its own
   token can still win without inventing an identity relationship. Ambiguous
   matches do not mutate handoff state.
4. A safe inbound SMS group consumes only the contacts represented by its
   current participant snapshot. Every non-Baxter participant must be admitted
   and map to exactly one resolved contact; the group atomically consumes those
   contacts' complete alias sets. Its prompt audience contains only those
   covered contacts. It does not globally close an email-only or absent contact.
   A pending group claim also carries a normalized participant/contact fingerprint;
   a later unsafe or changed snapshot invalidates the pending claim before model
   dispatch instead of attaching it to a different audience. At dispatch, the
   captured snapshot is also re-evaluated against a freshly loaded allowlist and
   resolved roster; a mismatch suppresses only the handoff block while the
   ordinary group reply continues.
5. An unsafe, malformed, incomplete, corrupt, ambiguous, or outsider group is
   a no-op for morning-handoff state and context. It still follows its normal
   SMS conversation path.
6. The durable sidecar records only hashed tokens. It is written before prompt
   preparation/provider work and is never rolled back. Unavailable or corrupt
   state fails toward skipped automatic delivery rather than a duplicate.
7. Home Chat never imports, reads, writes, claims, closes, or renders
   `morning-handoff.json` state.

## Automatic group delivery

A canonical automatic morning update may use one SMS group only when all of the
following hold:

1. The latest valid inbound group snapshot is less than 24 hours old.
2. The latest appended inbound snapshot is household-safe; unsafe, malformed,
   incomplete, or corrupt trailing state never revives an older row. Timestamp
   ties fail closed.
3. Its non-Baxter participants map one-to-one to resolved contacts and cover
   every pending resolved contact. A missing, ambiguous, or email-only contact
   requires individual SMS-first/same-contact-email-fallback delivery instead.
4. At least one resolved contact lacks a received direct SMS. If every contact
   has received direct SMS, use individual delivery.
5. The snapshot fingerprint—group id, timestamp, sender, canonical participant
   set, and resolved roster—matches again after generation and after the
   asynchronous shared-close gate. Any change suppresses the prepared group
   send instead of rerouting it.

The shared-close gate is used only for this fully covered automatic group path.
Individual automatic delivery consumes one resolved contact immediately before
that contact's provider chain.

## Home Chat reminders

A Home Chat scheduled task cannot return to the web chat thread. The latest
`send-message` intent carries an authenticated `member:<address>` author id;
the route is resolved fresh from that identity, never from a display name. When
several messages coalesce, each current durable message id is marked in history
and has its own authenticated route-table entry; every untagged row instead has
a runtime-owned `[history]` prefix, so a display name cannot forge a trusted
current-message marker or borrow the newest author's route.

- With a direct SMS and recipient email, Home Chat instructs creation of
  `--sms <author-phone> --fallback-email <author-email>`.
- With an email but no SMS route, it uses `--email <author-email>`.
- A phone-authenticated author retains that exact phone alias rather than an
  arbitrary sibling alias on the same contact.
- With no safe route, the assistant explains the contact-setting limitation and
  does not schedule a delivery task or borrow another household member's target.
- An SMS group is used only when the requester explicitly identifies it and
  `schedule-cli groups` produces one unambiguous exact id. It is never selected
  because it is recent or because a display name appears to match.

`TaskDeliver.fallback_email` is optional and valid only alongside an `sms` or
`sms-group` primary target. It persists separately from the target. At fire
time the heartbeat prompt directs the agent to try the primary SMS/group first,
then the exact fallback email on a refusal/failure, and only then notify the
operator. Existing SMS, email, and group tasks without this field retain their
original explicit targets and behavior.

## Regression coverage

The implementation pins:

- sender-only email alias identity without making it a delivery target;
- person-scoped direct and partial-group handoff consumption;
- automatic-group full-audience admission and both fingerprint revalidation
  gates, plus fresh-roster revalidation of a debounced inbound group claim;
- Home Chat's absence from all morning-handoff paths;
- authenticated-author route resolution, exact phone retention, coalesced
  per-message provenance with unforgeable `[history]` prefixes, and refusal to
  borrow another contact;
- persisted `--fallback-email` parsing and heartbeat primary-then-fallback
  instructions.
