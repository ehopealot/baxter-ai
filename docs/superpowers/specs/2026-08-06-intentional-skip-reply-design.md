# Intentional "skip" — an affirmative no-response for poked reply turns

**Date:** 2026-08-06
**Status:** Approved direction (owner co-designed + made the key calls); pending implementation plan.

## Goal

Give Baxter an explicit way to **affirmatively decline to respond** on a reply
surface, so that when the reply-harness pokes him and there is genuinely
nothing to send, he can signal "no response, on purpose" instead of sending a
noise message like "no action needed" into the chat/SMS/email thread.

## The problem

The reply-harness (`core/app/scripts/harnesses/runner-common.ts`) can't tell
two very different situations apart:

- the model **forgot** to send its reply (wrote one, never called the send
  tool), vs
- the model has **nothing to send** (the incoming message needs no reply).

On an `EXPECT_REPLY` surface, a turn that ends with no delivery call
(`isDeliveryCall` → false) triggers a **poke** (`unsentReplyNudge`) telling the
model to run its send tool. The model, poked, resolves the poke the only way it
knows how — by actually **sending** "no action needed." So the observed noise
is the harness's own nudge leaking out as a real message. There is currently no
way for the model to say "this poke is spurious; I'm intentionally staying
silent."

## Design

A per-surface **`skip`** verb, recognized by the harness as a resolved turn,
that sends nothing and is only ever surfaced to the model inside the poke.

### 1. `skip` verb on each reply CLI

Add a `skip` subcommand to each `EXPECT_REPLY` reply CLI — `sms-cli`,
`chat-cli`, `discord-cli`, and `mail-cli` (once it lands from the Resend
migration). Behavior:

- Takes an **optional one-line reason** (arg or stdin), e.g. `sms-cli skip` or
  `sms-cli skip "nothing actionable"`.
- **Sends nothing** to any provider. Makes no outbound API call.
- **Does not** append an outbound entry to the surface transcript (it is a
  non-response, not a message).
- **Logs** the intentional non-response for observability — surface, timestamp,
  and the optional reason — via the daemon's existing log path (not the
  transcript). Prints a small JSON confirmation (`{"skipped":true}`) and exits
  0.

No new grant is needed: each surface already grants `Bash(node <cli> *)` (and
the on-PATH shim), so `<cli> skip` is already inside the existing glob.

### 2. Harness recognizes `skip` as a resolved turn (`runner-common.ts`)

- Add `isIntentionalSkip(toolName, params)` — true for `run_cli` with
  `params.cli` in the reply set and sub-command `skip`. Keep it **separate**
  from `isDeliveryCall` so a skip is distinguishable from a real send in logs
  and metrics.
- `nudgeDecision(...)` treats a turn in which a skip occurred as **resolved**
  (returns `null` — no poke), exactly like a delivery, and never as `"empty"`.
- A real delivery still takes precedence; a skip only matters when no delivery
  happened.

### 3. Poke-only exposure (the safety rail)

`skip` is advertised **only** in the poke, never in the base prompt:

- `unsentReplyNudge(cliMap)` gains the skip option, framed to discourage misuse:
  e.g. *"…either send your reply (`<replyHint>`), or — only if this nudge is
  spurious and no reply is genuinely warranted — run `run_cli <cli> skip` to
  intentionally stay silent."*
- `skip` is **not** mentioned in `systemPreamble`, the run_cli instruction line,
  or any tool description. The model therefore only learns the verb exists at
  the moment it is poked, so by construction it's a response to a poke, not a
  first-class "ignore the user" tool.

### 4. Observability + a light anomaly flag

- Each intentional skip is logged (surface, at, reason) so silence is visible
  operationally without reaching the thread.
- Belt-and-suspenders: if a `skip` is ever observed on a turn that was **not**
  poked (or on a non-`EXPECT_REPLY` surface), log it as anomalous — the
  placement in §3 should prevent it, but a flag catches drift.

## Scope

- **In:** the `skip` verb on the reply CLIs (`sms-cli`, `chat-cli`,
  `discord-cli`, `mail-cli`), the `runner-common.ts` recognition + nudge-text
  change, and the intentional-skip logging.
- **Out:** any change to how real replies are sent; any use of `skip` outside
  the poke path; proactive/heartbeat runs (they are not poke-driven reply
  turns); UI surfacing of skip counts (logging only for now).

## Testing

- `runner-common.test.ts`:
  - `isIntentionalSkip("run_cli", { cli: "sms-cli", args: ["skip"] })` → true;
    `{ cli: "sms-cli", args: ["send"] }` → false; a non-`run_cli` tool → false.
    Cover each reply CLI key.
  - `nudgeDecision(...)` returns resolved (no poke) for a turn whose only tool
    call was a `skip`; still returns `"unsent"`/`"empty"` when neither a
    delivery nor a skip occurred.
  - `unsentReplyNudge(cliMap)` text includes the `skip` option for the granted
    surface; `systemPreamble` output does **not** mention `skip` (poke-only).
- Per-CLI (`sms-cli.test.ts`, `chat-cli.test.ts`, `discord-cli.test.ts`, and
  `mail-cli.test.ts` when present): `skip` makes **no** provider call (assert
  the injected fetch/send fake is never called), appends **no** transcript
  entry, logs the intentional pass (with the reason when given), and exits 0.

## Global constraints

- `skip` sends nothing to any provider and never appends an outbound transcript
  entry.
- `skip` is surfaced **only** via `unsentReplyNudge` — never in `systemPreamble`,
  the run_cli instruction line, or any tool description (poke-only by
  construction).
- The harness counts a `skip` as a **resolved** turn (no further poke), tracked
  **separately** from real deliveries.
- Per-surface verb reusing the existing `Bash(node <cli> *)` grant — no new
  grant.
- Intentional skips are logged (surface, at, reason) for observability.
- Applies to the `EXPECT_REPLY` reply surfaces only (`sms`, `chat`, `discord`,
  `mail`).

## Sequencing note

This feature edits `runner-common.ts` (also touched by the Resend migration's
Task 10) and each reply CLI (including `mail-cli`, built in the migration's
Task 5). It can ship for `sms`/`chat`/`discord` independently; `mail-cli`'s
`skip` verb slots in whenever the mail migration's `mail-cli` closes. Build it
as its own plan; its core commits need the Fable auto-review.

## Deferred / follow-ups

- Surfacing skip counts/reasons in an operator view (home or a report).
- Whether repeated skips to the same correspondent should escalate a notice.
