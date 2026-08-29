# Group-Chat Morning Updates and Reminders Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Prefer a valid active family SMS group for a canonical automatic morning update only when it safely covers every pending resolved household contact and at least one lacks a received direct SMS; otherwise send individually. Ordinary reminders retain explicit SMS/email/group targets. Home Chat reminders default to the authenticated author's direct SMS with that same person's persisted email fallback, or email alone when SMS is unavailable; a group is used only when explicitly and unambiguously named.

**Architecture:** A valid active group is a recent (within 24 hours), inbound, strict-ID, household-safe transcript snapshot whose last appended inbound row is authoritative; unsafe, incomplete, malformed, corrupt, or tied candidates fail closed. Inbound group handoffs consume only the resolved contacts represented by their safe participant snapshot, while direct aliases consume one resolved person across SMS/email aliases. A pending group claim carries that participant/contact fingerprint and is invalidated by an unsafe or changed successor before dispatch; the captured group snapshot is also re-evaluated against a fresh allowlist/roster when its debounced run starts. Home Chat never participates in handoff state. Automatic group delivery additionally requires full coverage of every pending resolved contact; an email-only or omitted contact forces individual SMS-first/same-contact-email fallback. The handler fingerprints group id, timestamp, sender, participants, and the resolved roster, then rechecks it after generation and after the shared-close gate. Scheduler tasks persist a primary SMS/group target plus an optional recipient-only email fallback; Home Chat obtains a route table keyed by each coalesced message's authenticated author, with a runtime-owned `[history]` prefix on untagged rows so a display name cannot impersonate a current-message marker.

**Tech Stack:** TypeScript, Node test runner, JSONL SMS transcripts, existing Sendblue group sender, `make check`.

---

### Task 1: Select a valid group independently of direct-message recency

**Files:**
- Modify: `app/scripts/sms-transcript.ts`
- Test: `app/scripts/sms-transcript.test.ts`

**Step 1: Write failing tests**

Add a fixture with a valid group inbound followed by a newer direct inbound. Assert group discovery still returns the valid group. Add safe snapshots followed by newer unsafe, malformed, and corrupt trailing rows for the same group; all must reject that group rather than backtrack. Preserve coverage for ignoring Baxter outbound rows and failing closed on ambiguous timestamps between candidate groups.

**Step 2: Run the focused test to verify it fails**

Run:

```bash
cd app && node --test --experimental-strip-types scripts/sms-transcript.test.ts
```

Expected: the new test fails because the current global-inbound comparison lets the direct transcript suppress the group.

**Step 3: Write minimal implementation**

Make `latestInboundSmsGroup()` scan only strict group transcripts and choose the newest eligible inbound group. It must retain the existing `groupEligible` validation seam and must not let outbound rows participate. Direct transcript coverage belongs in the morning-routing layer, not group discovery.

**Step 4: Run the focused test to verify it passes**

Run:

```bash
cd app && node --test --experimental-strip-types scripts/sms-transcript.test.ts
```

Expected: PASS.

### Task 2: Route automatic updates by direct-transcript coverage

**Files:**
- Modify: `app/scripts/morning-check-in.ts`
- Test: `app/scripts/morning-check-in.test.ts`

**Step 1: Write failing tests**

For the canonical task, inject a valid recent group and received-message lookup. Cover:

1. One household contact lacks a received direct message: exactly one group SMS is sent, with no individual SMS/email.
2. A direct transcript containing only Baxter's outbound rows still uses the active group.
3. Every resolved contact has a received direct message: no group SMS is sent; each contact follows existing individual SMS-first, same-contact-email-fallback delivery.
4. A group omitting any resolved contact (including an email-only contact) uses individual delivery regardless of direct coverage.
5. A stale/unsafe/missing group still uses individual delivery regardless of coverage.
6. A direct handoff winning during group-copy generation makes the final shared close context-ineligible and suppresses the group provider call.
7. A same-ID change to sender, participant set, timestamp, or resolved roster during generation is revalidated before provider work and suppresses the group call.
8. The same complete fingerprint is revalidated after shared-close returns and suppresses the group call on any change.

**Step 2: Run the focused test to verify it fails**

Run:

```bash
cd app && node --test --experimental-strip-types scripts/morning-check-in.test.ts
```

Expected: the complete-coverage case fails because current code routes to the group solely from its presence and age.

**Step 3: Write minimal implementation**

Inject `hasReceivedTranscript` through `MorningCheckInDeps`. A contact has direct coverage when at least one resolved phone has a direct transcript with a received (`direction: "in"`) row; an outbound-only or email-only contact has no direct SMS coverage. Use the active group only when it is valid/recent, covers every pending resolved contact, and direct coverage is incomplete. Keep `hasTranscript` unchanged for its existing transcript-presence authorization callers, fingerprint/revalidate the group at both gates, and preserve the group `sharedClose` path plus individual `automaticConsume` + `deliverToHousehold` path otherwise.

**Step 4: Run the focused test to verify it passes**

Run:

```bash
cd app && node --test --experimental-strip-types scripts/morning-check-in.test.ts
```

Expected: PASS.

### Task 3: Persist Home Chat reminder routing and SMS email fallback

**Files:**
- Modify/Test: `app/scripts/home-chat-reminders.ts`, `app/scripts/home-chat-reminders.test.ts`
- Modify/Test: `app/scripts/chat-bot.ts`, `app/scripts/chat-bot.test.ts`, `app/chat-prompt.md`
- Modify/Test: `app/scripts/schedule-store.ts`, `app/scripts/schedule-cli.ts`, `app/scripts/schedule-cli.test.ts`
- Modify/Test: `app/scripts/heartbeat.ts`, `app/scripts/heartbeat.test.ts`, `app/heartbeat-prompt.md`

**Step 1: Write failing tests**

Pin sender-only-email identity resolution to the authenticated author's direct SMS plus recipient-only email fallback. Pin `--fallback-email` as a persisted adjunct to `--sms`/`--sms-group`, never as a replacement target. Pin the fire prompt's exact primary-then-fallback behavior, and assert Home Chat never selects a recent group or another household member by display name.

**Step 2: Write minimal implementation and run focused tests**

Resolve `member:<address>` through the fresh allowlist/recipient resolver. Render only that resolved route into the current Home Chat run; use a group only after explicit `schedule-cli groups` discovery yields one unambiguous exact id. Persist `fallback_email` on SMS/group tasks and direct the heartbeat fire to send it after a primary failure before notifying the operator.

```bash
cd app && node --test --experimental-strip-types scripts/home-chat-reminders.test.ts scripts/chat-bot.test.ts scripts/schedule-cli.test.ts scripts/heartbeat.test.ts
```

### Task 4: Update architecture documentation and verify

**Files:**
- Modify: `app/docs/architecture/heartbeat.md`

**Step 1: Update architecture documentation**

Document the strict full-audience automatic-group requirement, person-scoped inbound group consumption, alias identity, both fingerprint revalidation gates, Home Chat's complete exclusion from morning handoffs, and authenticated-author reminder routing with persisted email fallback.

**Step 2: Run focused suites and full gate**

Run:

```bash
cd app
node --test --experimental-strip-types scripts/sms-transcript.test.ts
node --test --experimental-strip-types scripts/morning-check-in.test.ts
node --test --experimental-strip-types scripts/sms-bot.test.ts
node --test --experimental-strip-types scripts/schedule-cli.test.ts
cd .. && make check
git diff --check
git status --short
```

Expected: all tests and whitespace check pass, with only intended changes.

### Task 5: Expert code review and PR update

1. Obtain a fresh-context expert code review with an extended timeout.
2. Address verified findings with tests first.
3. Re-run the relevant validation.
4. Commit and push the PR branch, then report the PR URL and review result.
