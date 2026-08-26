# Proactive date follow-ups

(part of Baxter — see [architecture map](../../CLAUDE.md))

Baxter may quietly schedule one check-in when an admitted **Mail, direct/group SMS, or Home Chat** inbound mentions exactly one plausible plan on a concrete future civil date without explicitly requesting a reminder. Those surfaces receive the shared prompt guidance plus an origin-bound `followup-cli` capability. Discord, voice, TUI, heartbeat, and every other run type receive neither. Proactive judgment is prompt-only: there is no proactive skill to stage and no full-run skill-profile lease.

## Model judgment and code authority

A concise prompt block on admitted Mail, SMS, and Home Chat runs owns only judgment and wording: resolve a day/date, reject ambiguous/today/past/explicit-reminder/multiple-plan turns, compare candidate meanings, and disclose only after successful creation. The tool grant and protected context, not this guidance, are the authority.

`followup-cli` is the enforcement boundary:

```text
followup-cli add "<subject>" --plan-date YYYY-MM-DD
followup-cli list
followup-cli candidates --plan-date YYYY-MM-DD
```

It accepts no recipient, route, author, provider, or timezone flags. Each supported daemon creates a random per-turn, mode-0600 context under `STATE_DIR/followup-context`, places only its path in `BAXTER_FOLLOWUP_CONTEXT_PATH`, and removes it in `finally`. The file carries a bounded Linux lease (creator PID, `/proc` process-start identity, and creation time), so daemon-crash leftovers, PID reuse, and expired runs fail closed. The CLI opens with `O_NOFOLLOW`, verifies type/owner/mode/size on the opened fd, and performs one bounded fd read; it rejects missing, stale, swapped/symlinked, oversized, malformed, or unsupported contexts before schedule access. Mail binds the admitted local thread; SMS binds the normalized direct number or strict transcript-backed group id; Home Chat binds the exact current `send-message` chat and author. Home creation additionally requires that exact author to be an admitted canonical `member:<email>`.

## Ordinary scheduler record

A proactive check-in is one ordinary cap-counted, visible, cancellable one-shot in `schedule.json`. It carries the static task marker `proactive-follow-up:v1`, `desc: "Check back about <subject>"`, one selected `at`/`next_run_at`, `deliver: null`, and additive `follow_up` provenance (version, normalized subject, real plan date, opaque turn token, origin, and an optional delivery-start marker). Validation derives the one code-owned route from that origin; no duplicate route is persisted. Existing schedule readers ignore the additive field, and Home's Scheduled Tasks projection continues to use ordinary description/time/recurrence/enabled fields without decoding destinations.

Subject normalization is NFKC → Unicode whitespace collapse → Cc/Cf removal → trim/collapse → fixed-point structural-marker neutralization → trim/collapse, bounded to 160 Unicode code points. Dates are strict round-tripped Gregorian `YYYY-MM-DD` in `householdTz()`. Tomorrow selects one of 180 whole minutes from 09:00–11:59 on the plan date; plans two or more civil days away select one of 180 minutes from 13:00–15:59 on the prior date. Today/past dates fail.

Creation revalidates origin inside the locked scheduler mutation, applies the ordinary task cap, rejects an exact subject/date/origin duplicate, and permits at most one record per code-owned turn token. Output exposes only id, subject, plan date, and selected instant.

`candidates` strictly reads the schedule and projects ordinary one-shots or the recurrence engine's first occurrence inside the household-local half-open interval `[prior-day 00:00, day-after-plan 00:00)`. Recurring persisted `next_run_at` is not trusted for this query. Output and descriptions are bounded; corrupt or oversized state fails instead of looking empty. Semantic similarity remains the model's decision.

## Strict execution and delivery

Any own `follow_up` property, `mail-thread`/`home-chat-email` route, or unknown delivery variant enters `validateFollowUpTask`; it never falls through to the generic scheduled-task prompt. System reconciliation inspects an entire canonical duplicate set before collapse: one feature-shaped member is retained for this strict accounting regardless of ordering, while multiple feature-shaped members refuse for operator repair. The validator checks the complete metadata, normalized subject/date, static marker/description, one-shot timing/window/timezone, origin shape, `deliver: null`, queue shape, and current route authority.

A valid claimed record reserves one ordinary heartbeat model slot and performs one content-suppressed generation with `allowedTools: ""` in a newly created empty temporary cwd. That cwd contains no staged skills, memory, credential files, or surface secrets and is removed in `finally`. The prompt contains only fixed tone guidance plus subject and plan date. Any tool attempt, failed/malformed/empty result, or sanitized output over 1,000 Unicode code points causes no provider call.

After generation, code reloads the record in a short scheduler transaction, compares immutable fields, and validates again with strict fresh durable authority. A second scheduler transaction writes `follow_up.delivery_started_at` immediately before code invokes the one route derived from the origin. One parent-linked 30-second bound covers the complete route—not just the final request—including Mail/Home moderation and send-counter acquisition plus Sendblue counter/STOP locks, 429 backoff, and provider work. Each abort-aware operation settles before the provider outcome reaches the ordinary queue transaction:

- direct or group Sendblue delivery to the exact persisted conversation;
- Resend reply in the exact indexed thread; or
- Resend email to the exact admitted Home Chat author, with the exact chat URL resolved and appended by code.

There is no provider or operator fallback. Revocation, STOP, missing transcript/thread/chat/link, provider refusal, timeout, or failure returns through ordinary heartbeat retry/give-up accounting. Provider success/failure is committed in a short scheduler transaction after provider work settles; if cancellation already removed the record, that queue mutation is a no-op. There is no delivery-lock sidecar and no lock-held provider commit.

## Cancellation ordering

`schedule-cli cancel <id>` remains the only deletion interface. The heartbeat transaction writes `delivery_started_at` immediately before its one code-owned provider call. Cancellation observes and removes that same record in one scheduler transaction: it reports `send_already_started`—meaning delivery possibly started—only when it sees the marker; otherwise it reports `cancelled`, and cancel-first yields no provider call. A task already removed after a successful one-shot is ordinarily not found.

## Rollout and rollback

Enforcement (strict schema/classifier, context loader, marker/router, heartbeat branch) must exist before prompt guidance and grants. Rollback reverses only enablement first: remove the supported prompt guidance and `followup-cli` grants so no new records are created, while ordinary list/cancel and strict execution remain to drain or cancel existing records. Do not remove strict classification until no feature-shaped records remain. No migration or outer Home Worker change is required.
