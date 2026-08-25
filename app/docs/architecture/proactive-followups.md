# Proactive date follow-ups

(part of Baxter — see [architecture map](../../CLAUDE.md))

Baxter may quietly schedule one check-in when an admitted **Mail, direct/group SMS, or Home Chat** inbound mentions exactly one plausible plan on a concrete future civil date without explicitly requesting a reminder. Discord, voice, TUI, heartbeat, and every other run type are unsupported. They receive neither the skill nor the separate creation capability. Because surfaces overlap, `runAgent` holds each shared-cwd skill profile immutable for the whole run under an owner-only cross-process lease: compatible Mail/SMS/Chat runs in the consolidated process may overlap, while another process or a different profile waits until active runs exit before restaging. Unsupported runs therefore cannot gain the proactive skill mid-run, and supported runs cannot lose it before a lazy load.

## Model judgment and code authority

The baked `proactive-follow-up` skill owns only judgment and wording: resolve a day/date, reject ambiguous/today/past/explicit-reminder/multiple-plan turns, compare candidate meanings, and disclose only after successful creation. It has no `allowed-tools` frontmatter.

`followup-cli` is the enforcement boundary:

```text
followup-cli add "<subject>" --plan-date YYYY-MM-DD
followup-cli list
followup-cli candidates --plan-date YYYY-MM-DD
```

It accepts no recipient, route, author, provider, or timezone flags. Each supported daemon creates a random per-turn, mode-0600 context under `STATE_DIR/followup-context`, places only its path in `BAXTER_FOLLOWUP_CONTEXT_PATH`, and removes it in `finally`. The file carries a bounded Linux lease (creator PID, `/proc` process-start identity, and creation time), so daemon-crash leftovers, PID reuse, and expired runs fail closed. The CLI opens with `O_NOFOLLOW`, verifies type/owner/mode/size on the opened fd, and performs one bounded fd read; it rejects missing, stale, swapped/symlinked, oversized, malformed, or unsupported contexts before schedule access. Mail binds the admitted local thread; SMS binds the normalized direct number or strict transcript-backed group id; Home Chat binds the exact current `send-message` chat and author. Home creation additionally requires that exact author to be an admitted canonical `member:<email>`.

## Ordinary scheduler record

A proactive check-in is one ordinary cap-counted, visible, cancellable one-shot in `schedule.json`. It carries the static task marker `proactive-follow-up:v1`, `desc: "Check back about <subject>"`, one selected `at`/`next_run_at`, code-owned delivery, and additive `follow_up` provenance (version, normalized subject/key, real plan date, opaque turn token, and origin). Existing schedule readers ignore the additive field; the Home Scheduled Tasks projection continues to use ordinary description/time/recurrence/enabled fields and does not decode destinations.

Subject normalization is NFKC → Unicode whitespace collapse → Cc/Cf removal → trim/collapse → fixed-point structural-marker neutralization → trim/collapse, bounded to 160 Unicode code points. Dates are strict round-tripped Gregorian `YYYY-MM-DD` in `householdTz()`. Tomorrow selects one of 180 whole minutes from 09:00–11:59 on the plan date; plans two or more civil days away select one of 180 minutes from 13:00–15:59 on the prior date. Today/past dates fail.

Creation revalidates origin inside the locked scheduler mutation, applies the ordinary task cap, rejects an exact subject/date/origin duplicate, and permits at most one record per code-owned turn token. Output exposes only id, subject, plan date, and selected instant.

`candidates` strictly reads the schedule and projects ordinary one-shots or the recurrence engine's first occurrence inside the household-local half-open interval `[prior-day 00:00, day-after-plan 00:00)`. Recurring persisted `next_run_at` is not trusted for this query. Output and descriptions are bounded; corrupt or oversized state fails instead of looking empty. Semantic similarity remains the model's decision.

## Strict execution and delivery

Any own `follow_up` property, `mail-thread`/`home-chat-email` route, or unknown delivery variant enters `validateFollowUpTask`; it never falls through to the generic scheduled-task prompt. System reconciliation inspects an entire canonical duplicate set before collapse: one feature-shaped member is retained for this strict accounting regardless of ordering, while multiple feature-shaped members refuse for operator repair. The validator checks the complete metadata, normalized subject/key/date, static marker/description, one-shot timing/window/timezone, exact origin-route agreement, queue shape, and current route authority.

A valid claimed record reserves one ordinary heartbeat model slot and performs one content-suppressed generation with `allowedTools: ""` in a newly created empty temporary cwd. That cwd contains no staged skills, memory, credential files, or surface secrets and is removed in `finally`. The prompt contains only fixed tone guidance plus subject and plan date. Any tool attempt, failed/malformed/empty result, or sanitized output over 1,000 Unicode code points causes no provider call.

After generation, code takes the per-task delivery lock, quarantines malformed/crash coordination artifacts, reloads the record, compares immutable fields, validates again with strict fresh durable authority, and invokes exactly one persisted route. One parent-linked 30-second bound covers the complete route—not just the final request—including Mail/Home moderation and send-counter acquisition plus Sendblue counter/STOP locks, 429 backoff, and provider work. Each abort-aware operation settles before the delivery lock is released; cancellation's 40-second lock wait is derived above that route bound:

- direct or group Sendblue delivery to the exact persisted conversation;
- Resend reply in the exact indexed thread; or
- Resend email to the exact admitted Home Chat author, with the exact chat URL resolved and appended by code.

There is no provider or operator fallback. Revocation, STOP, missing transcript/thread/chat/link, provider refusal, timeout, or failure returns through ordinary heartbeat retry/give-up accounting. Provider success/failure scheduler mutation is committed while the delivery lock is held; heartbeat logs it once and does not mutate twice. A later marker/unlink/lock-release failure is logged as coordination cleanup, retains the send marker when cancellation status is uncertain, and cannot erase the committed result; nested release cleanup still attempts both locks.

## Cancellation ordering

`schedule-cli cancel <id>` remains the only deletion interface. Feature-shaped tasks use a per-task delivery lock plus a short waiter-registration lock. Cancellation that linearizes first removes the record and guarantees no provider call. A send that linearizes first records `send_already_started`, holds the lock through provider outcome and scheduler mutation, then lets cancellation remove any retained retry. CLI output becomes:

```text
cancelled <id> -- send_already_started
```

The skill then says a check-in **may already be on the way**, rather than promising prevention. Ordinary cancellation output remains `cancelled <id>`.

## Rollout and rollback

Enforcement (strict schema/classifier, context loader, delivery lock/router, heartbeat branch) must exist before grants and skill staging. Rollback reverses only the enablement first: remove the skill and supported `followup-cli` grants so no new records are created, while ordinary list/cancel and strict execution remain to drain or cancel existing records. Do not remove strict classification until no feature-shaped records remain. No migration or outer Home Worker change is required.
