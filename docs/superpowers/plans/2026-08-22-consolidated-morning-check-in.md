# Consolidated Morning Check-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For this operator-approved fast track, one worker may execute all tasks in order before the single whole-branch gate.

**Goal:** Replace the three recurring calendar/weekly system tasks with one persisted, household-local, random-minute `morning-check-in` task which sends at most one appropriate message per occurrence.

**Architecture:** Keep executable identity in `SYSTEM_TASKS`; make the existing scheduler/reconciliation path understand an optional runtime-owned recurring window rather than persisting a handler or random state. Retire only proved-safe legacy canonical records before normal namespace validation. Consolidate the old digest and weekly implementations into a new handler that refreshes and selects today before choosing `calendar`, `friday`, `monday`, or `none`; reuse the existing recipient/quota/admission/delivery primitives unchanged.

**Tech Stack:** Node.js 24, TypeScript with type stripping and `tsc --noEmit`, `node:test`, `cron-parser`, existing locked JSON schedule store and timezone helpers.

**Spec:** `docs/superpowers/specs/2026-08-22-consolidated-morning-check-in-design.md`

## Global Constraints

- `morning-check-in` is the only production `SystemTaskKey` and the only recurring registry definition. Its canonical id is `system:morning-check-in`, cron remains `0 8 * * *`, its window is 60 whole-minute slots from local 08:00 through 08:59, and its local civil-date cutoff is 12:00.
- Persist only the selected absolute ISO instant in `Task.next_run_at`; never persist a random function, handler, command, prompt, or user-configurable window. Select inside the existing `mutate()` transaction. Inject the minute selector into scheduling/reconciliation test seams; production chooses one uniform integer in `[0, 59]`.
- Preserve an already-valid selected occurrence byte-for-byte through no-change reconciliation, normal ticks, claims, nonfinal retry, cap deferral, and out-of-tokens invisibility. Select once only on creation, successful/final-give-up advancement, cutoff/stale expiry, enable, or a definition/timezone/invalid-selected-time repair.
- Before noon on the occurrence date, a past selected minute is due and catch-up may dispatch. At local 12:00 or later, expire an uncompleted recurring occurrence without executing it: clear claim/retry state, emit only a fixed body-free diagnostic (key/reason/timestamps/outcome), and choose the next eligible occurrence. A handler started before noon may finish after noon. A later-date stale occurrence is skipped. One-shot `system trigger` remains due now, ignores the window/cutoff, does not mutate the canonical task, and decides mode using actual execution time.
- Startup and every reconciliation first remove every member of a retired duplicate set only if both id and metadata prove the exact legacy canonical pairing: `system:daily-calendar-digest`/`daily-calendar-digest`, `system:friday-weekend-check-in`/`friday-weekend-check-in`, or `system:monday-weekly-check-in`/`monday-weekly-check-in`. Remove valid retired trigger records through invalid-trigger cleanup. Any ordinary reserved id, noncanonical retired metadata, wrong pair, unknown collision, or uncertain duplicate stays fail-closed with the existing operator-repair diagnostic and no write.
- Preserve queue collision/cap/claim semantics, shared household timezone and DST helpers, recipient resolution, content suppression, tool-less model runs, quota reservations, SMS-first/same-contact-email delivery, aggregate-only diagnostics, and the accepted in-process-only per-recipient duplicate boundary. Never log calendar/provider/model/contact/message content.
- The handler must refresh/read/select once before choosing mode: qualifying current-day events win over Friday/Monday; empty Friday selects Friday; empty Monday selects Monday; any other empty day returns successful `{ ok:true, agentRun:false }` without recipient/knowledge/reservation/model/provider work. Calendar unavailable, malformed, read, or selection failure must return a normal retryable failure before fallback mode or delivery.
- Friday may use one deterministic sanitized Saturday/Sunday title only after today was safely selected empty. No weekend time, date, location, URL, omitted count, agenda projection, or itinerary reaches its prompt/fallback. Its validation receives private sanitized weekend data and rejects another known title, known time/location, or more than one occurrence of the selected title. Monday gets no calendar context. Calendar mode retains the existing date subject, projection, validation, fallback, and delivery behavior.

---

## Files and interfaces

| File | Change |
|---|---|
| `app/scripts/system-tasks.ts` | Replace the closed keys/registry with `morning-check-in`; extend `SystemTaskDefinition` with an optional compile-time ranged recurring policy (minute-slot count/window/cutoff) while fixed cron definitions remain valid. |
| `app/scripts/system-reconcile.ts` | Add pure/injectable range selection, legacy cleanup before validation, occurrence repair/expiry, and canonical normalization that preserves valid selected values. |
| `app/scripts/schedule-store.ts` | Make `applyOnSuccess` and final `applyOnFailure` accept the registry-aware occurrence-advance resolver without changing ordinary cron/one-shot behavior. |
| `app/scripts/heartbeat.ts` | Reconcile/expire before selection and advance recurring system records through the registry window policy after success/final give-up; leave trigger behavior independent. |
| `app/scripts/schedule-cli.ts` | Enable via the ranged policy (new future occurrence), retain disable/trigger semantics, and inject selector/time policy through the same command/reconcile seams. |
| `app/scripts/morning-check-in.ts` | New consolidated runtime handler/dependency seam, prompts, title-only Friday projection/fallback, and per-recipient loop. |
| `app/scripts/daily-calendar-digest.ts`, `app/scripts/weekly-household-check-in.ts` | Remove obsolete production handler definitions once behavior is covered by the consolidated module; do not retain retired executable aliases. |
| `app/scripts/{system-tasks,system-reconcile,schedule-store,schedule-cli,heartbeat,morning-check-in}.test.ts` | Update registry/queue/CLI/heartbeat coverage and add deterministic ranged, retirement, and handler contract tests. |
| `app/scripts/weekly-system-guidance.test.ts` | Assert all production guidance contains only `morning-check-in`, its toggle/trigger commands, and the consolidated behavior. |
| `app/{chat-prompt.md,discord-prompt.md,discord-reaction-prompt.md,sms-prompt.md,tui-prompt.md,scripts/mail-bot.ts,skills/schedule/SKILL.md}` | Replace retired user-facing keys/examples with the one key; explain random 08:00–08:59 scheduling, catch-up, and independent immediate trigger without exposing retired aliases. |
| `app/docs/architecture/heartbeat.md` | Document replacement cleanup, decision precedence, title-only Friday rule, ranged persistence/catch-up/expiry, and preserved delivery/privacy boundaries. |

### Task 1: Write the scheduler/replacement RED tests

**Files:** `app/scripts/system-tasks.test.ts`, `app/scripts/system-reconcile.test.ts`, `app/scripts/schedule-store.test.ts`, `app/scripts/schedule-cli.test.ts`, `app/scripts/heartbeat.test.ts`.

- [ ] **Step 1:** Replace old production-registry expectations with exactly one `morning-check-in` definition (`desc` chosen for the consolidated task; cron `0 8 * * *`) and add compile-time tests that a fixed definition may omit window policy while the production definition declares its 60-slot/12:00 policy.
- [ ] **Step 2:** Add deterministic selector fixtures (endpoints 0 and 59) proving selection is a whole local minute in `[08:00,08:59]`, stored as UTC ISO, and selector invocation is exactly once per newly selected occurrence. Cover before 08:00, in-window future and past slot, 09:00-to-before-noon catch-up, exactly noon expiry, after-noon creation, stale earlier civil date, and spring-forward/fall-back local window/cutoff behavior.
- [ ] **Step 3:** Add no-reselection tests for no-change reconciliation (same references/no rewrite), restart before selected minute, restart after selected minute before noon, claim, nonfinal hard failure, cap deferral, and out-of-token invisibility. Add exactly-one reselection tests for success, final give-up, expiry, enable, invalid selected timestamp, changed window/cron, and timezone repair; each repair clears claim/retry state where required.
- [ ] **Step 4:** Add retirement fixtures: empty store produces only the enabled canonical new record; each recognized legacy canonical record and safe duplicate member is removed despite enabled/claim/retry/cron/tz/time; a retired ordinary-id trigger is removed before due selection; later reconciliation is byte/idempotent. Add failure fixtures for legacy reserved ordinary records, wrong key/id pairings, and retired metadata outside its canonical id, asserting existing collision diagnostics and byte-identical store.
- [ ] **Step 5:** Add CLI/heartbeat fixtures proving disable prevents dispatch, enable chooses a new future ranged occurrence, trigger remains ordinary-id due-now and leaves the canonical object byte-identical, and trigger ignores noon/window while canonical recurring selection/expiry does not. Verify recurring success and final give-up use a fresh selection, but ordinary cron and one-shot queue semantics remain unchanged.

**RED command (run before implementation):**
```bash
cd app && node --test scripts/system-tasks.test.ts scripts/system-reconcile.test.ts scripts/schedule-store.test.ts scripts/schedule-cli.test.ts scripts/heartbeat.test.ts
```
**Expected RED result:** failures for missing `morning-check-in` type/registry/window-selector APIs, legacy cleanup, window cutoff/advance behavior, and changed CLI/heartbeat expectations. Existing old-key expectations may fail once deliberately updated; no production code is changed in this step.

### Task 2: Implement generic persisted ranged scheduling and safe retirement (GREEN)

**Files:** `app/scripts/system-tasks.ts`, `app/scripts/system-reconcile.ts`, `app/scripts/schedule-store.ts`, `app/scripts/schedule-cli.ts`, `app/scripts/heartbeat.ts`, and the Step 1 scheduler tests.

- [ ] **Step 1:** Define an optional, immutable `SystemTaskDefinition` recurring-window contract sufficient to derive a local occurrence from its cron day anchor, a uniform whole-minute selector, and cutoff; ensure fixed definitions remain representable. Register only `morning-check-in` with the 08:00 cron/60 minute/noon policy.
- [ ] **Step 2:** Add pure helper seams in reconciliation for local civil occurrence selection and validity/expiry. Derive local day/cutoff through `householdTz`/`tz.ts` helpers rather than ambient timezone or fixed milliseconds. A selector is called only after the transaction has determined replacement is needed.
- [ ] **Step 3:** Run narrowly proven retired-canonical cleanup before `validateReservedNamespace`; remove only exact known id+`system.key` pairs (including safe duplicates) and remove retired throwaway trigger records as invalid identities. Then validate the active namespace and create/normalize only `system:morning-check-in`. Do not migrate legacy enabled state or chosen time.
- [ ] **Step 4:** Normalize a valid ranged canonical record without rewriting it. On invalid definition/timezone/selected value, clear `invisible_until` and attempts and choose one replacement. On local cutoff/later-date stale occurrence, clear those fields, select the next eligible day, and write fixed content-free diagnostics. Ensure normal registry validation still fail-closes all uncertain collisions.
- [ ] **Step 5:** Route canonical recurring success and final give-up through the registry-aware next-occurrence helper; retain a nonfinal failure's selected `next_run_at`. At the top-of-tick reconciliation gate, expiry happens before `selectDue`; apply cutoff only to registered recurring records, not valid one-shot triggers. Make enable choose a new future occurrence using the policy; disable clears claim/retry but does not dispatch; trigger creates the unchanged due-now ordinary-id record.
- [ ] **Step 6:** Preserve lock boundaries: all selection/replacement happens within `mutate`, while handlers remain outside the lock. Keep `applyOnSuccess`/`applyOnFailure` ordinary behavior for normal cron and `at` tasks.

**GREEN command:**
```bash
cd app && node --test scripts/system-tasks.test.ts scripts/system-reconcile.test.ts scripts/schedule-store.test.ts scripts/schedule-cli.test.ts scripts/heartbeat.test.ts
```
**Expected GREEN result:** all focused scheduler/registry/CLI/heartbeat tests pass, including DST, retirement, no-reselection, success/final-give-up, expiry, enable, and immediate independent trigger cases.

**Commit:** `feat(schedule): add ranged morning occurrence and retire legacy system tasks`

### Task 3: Write the consolidated-handler RED tests

**Files:** create `app/scripts/morning-check-in.test.ts`; use the existing calendar/recipient fixtures and seams from `daily-calendar-digest.test.ts` and `weekly-household-check-in.test.ts` as source material.

- [ ] **Step 1:** Build a single injected harness with refresh, own read, cache fallback, feed eligibility, durable knowledge, recipients, reservation/release, `runAgent`, SMS/email, clock, paths, and log seams. It must execute the `morning-check-in` definition, never import heartbeat runtime behavior.
- [ ] **Step 2:** Add mode table tests: qualifying today event on Friday/Monday selects calendar only; empty Friday selects one Friday check-in; empty Monday selects Monday; every other empty day performs no recipient/knowledge/reservation/model/provider work and succeeds `agentRun:false`. Include remaining/ongoing/all-day and DST eligibility parity with `selectDigestEvents`.
- [ ] **Step 3:** Add failures proving refresh/cache/own-read/selection malformed/unavailable states return `ok:false` before recipient work and never fall through to Friday/Monday. Prove normal refresh consumes its returned snapshot, while refresh-throw uses retained cache under existing eligibility rules.
- [ ] **Step 4:** Pin calendar behavior parity: date-bearing subject, bounded sanitized projection, no unsafe calendar fields in prompt/fallback, tool-less content-suppressed run, cleaned greeting, deterministic fallback, recipient isolation, quota/out-of-token behavior, SMS-first same-contact email fallback, zero-recipient behavior, aggregate-only result/logs.
- [ ] **Step 5:** Pin Friday boundaries: after an empty today selection, project weekend data privately; prompt/fallback receive at most a selected sanitized title and no time/date/location/URL/omitted count/agenda list. Test generic no-title fallback; selected-title fallback; title optionally absent in good generation; one selected-title conversational reference allowed; repeat selected title, another known title, known time, or known location invalidates only that recipient and uses fallback. Pin Monday has durable knowledge but no calendar fields/snapshot/prompt region.
- [ ] **Step 6:** Pin shared loop semantics for all sending modes: snapshot contacts once; reserve immediately before each model call; invalid/hard failure only falls back for that contact; quota denial/out-of-token stops later model calls but sends fallbacks to remaining contacts; out-of-token releases only its token; provider failures are isolated and no contact is revisited.

**RED command (run before handler implementation):**
```bash
cd app && node --test scripts/morning-check-in.test.ts
```
**Expected RED result:** module-not-found/import failure for `morning-check-in.ts`; after the test shell exists, failures identify missing decision flow, title-only projection/validation, and merged delivery behavior.

### Task 4: Implement the consolidated handler (GREEN)

**Files:** create `app/scripts/morning-check-in.ts`; update `app/scripts/system-tasks.ts`; remove `app/scripts/daily-calendar-digest.ts` and `app/scripts/weekly-household-check-in.ts` only after imports/tests have moved; keep `digest-agenda.ts`, `check-in-context.ts`, recipient, delivery, calendar-refresh, and durable-knowledge modules as shared dependencies.

- [ ] **Step 1:** Export `morningCheckInDefinition(deps?)` and an explicit mode/result-safe dependency seam. Use `householdTz(ctx/deps env)`, one refresh attempt, own calendar read, `selectDigestEvents`, and `projectDigestEvents` to decide mode before recipient/knowledge work. Fail unreadable/malformed calendar data instead of treating it as empty.
- [ ] **Step 2:** Implement calendar mode by preserving daily digest's projection/prompt/subject/validation/fallback logic. Move or reuse helpers only if the external privacy and character bounds remain identical; do not duplicate an alternate event eligibility rule.
- [ ] **Step 3:** Implement Friday's post-empty-today projection using loaded snapshots and existing civil-time event selection primitives. Deterministically choose no more than one cleaned title. Construct prompt/fallback text with title-only input and low-pressure help; pass a private sanitized weekend projection to validation so nonselected title/time/location/repetition is rejected. Do not admit an itinerary representation into model-facing data.
- [ ] **Step 4:** Implement Monday using the existing weekly durable-knowledge and generic subject/body contract but no calendar context. Retain name ownership, body/subject validation, runtime greeting, and deterministic fallback.
- [ ] **Step 5:** Share one contact snapshot/context loop among calendar/friday/monday. Keep per-contact reserve-before-run, literal `allowedTools: ""`, `suppressContent:true`, token release, per-contact fallback and delivery ordering. Produce only aggregate counts/index diagnostics and `agentRun` based on actual model attempts.
- [ ] **Step 6:** Remove imports/definitions for the retired handlers and update registry imports so no retired executable identity remains. Delete their dedicated tests only after equivalent cases are moved into the new handler test; retain or relocate integration coverage as appropriate.

**GREEN commands:**
```bash
cd app && node --test scripts/morning-check-in.test.ts
cd app && node --test scripts/morning-check-in.test.ts scripts/morning-check-in.integration.test.ts
```
**Expected GREEN result:** the new unit suite and consolidated integration suite pass; no test import retains a retired handler or active retired key.

**Commit:** `feat(heartbeat): consolidate calendar and weekly morning check-ins`

### Task 5: Write/implement guidance and documentation updates

**Files:** `app/scripts/weekly-system-guidance.test.ts`, `app/skills/schedule/SKILL.md`, `app/docs/architecture/heartbeat.md`, `app/chat-prompt.md`, `app/discord-prompt.md`, `app/discord-reaction-prompt.md`, `app/sms-prompt.md`, `app/tui-prompt.md`, `app/scripts/mail-bot.ts`.

- [ ] **Step 1:** First update `weekly-system-guidance.test.ts` to require exactly `morning-check-in` in every production scheduling surface and reject all three retired keys. Assert only the consolidated enable/disable/trigger examples, at-most-one decision precedence, random 08:00–08:59 persisted occurrence/catch-up language where appropriate, and a trigger's independent due-now behavior.
- [ ] **Step 2:** Run the RED command below. Then replace guidance in all listed runtime prompt strings and skill text. Do not alter eval-only `app/prompt.md` unless it currently presents a production key (it is intentionally distinct).
- [ ] **Step 3:** Rewrite heartbeat architecture documentation to state startup retirement/fail-closed uncertainty, mode precedence, Friday title-only constraint, no-send empty non-Friday/Monday behavior, random persisted range, before-noon catch-up/expiry, retry preservation/new-occurrence reselection, enable and trigger semantics, and unchanged privacy/delivery/quota boundaries. Update scheduler comments/type docs alongside behavior in Steps 2/4.

**RED command:**
```bash
cd app && node --test scripts/weekly-system-guidance.test.ts
```
**Expected RED result:** current guidance exposes all three retired keys and old Friday itinerary wording.

**GREEN command:**
```bash
cd app && node --test scripts/weekly-system-guidance.test.ts
```
**Expected GREEN result:** every production scheduling surface documents only `morning-check-in`; eval-only template behavior remains intentionally separate.

**Commit:** `docs(schedule): document consolidated morning check-in`

### Task 6: Cross-file migration audit and focused GREEN gate

**Files:** all files changed above plus `app/scripts/schedule-mirror.test.ts` and Home schedule view dependencies only if a literal retired key is found. The registry-backed view should need no behavior change; do not add a TUI/control surface.

- [ ] **Step 1:** Search the full repository for each retired key and ensure remaining occurrences exist only in deliberate retirement constants/tests and historical approved spec documents. Confirm user-facing guidance, registry, CLI expectation, task-cap, cancellation, trigger audit, schedule mirror/Home descriptions, and integration tests name `morning-check-in` where they concern active behavior.
- [ ] **Step 2:** Ensure `SystemTaskKey` is closed to the single active key, `SYSTEM_TASKS` is a singleton, and old record cleanup occurs before active validation without weakening collisions. Ensure no test permits a trigger to use ranged policy/cutoff or a canonical disabled state to gate trigger execution.
- [ ] **Step 3:** Run TypeScript and all directly affected suites.

**Commands:**
```bash
cd app && node --test scripts/system-tasks.test.ts scripts/system-reconcile.test.ts scripts/schedule-store.test.ts scripts/schedule-cli.test.ts scripts/heartbeat.test.ts scripts/morning-check-in.test.ts scripts/weekly-system-guidance.test.ts scripts/schedule-mirror.test.ts
cd app && npx tsc --noEmit -p tsconfig.json
git grep -n -E 'daily-calendar-digest|friday-weekend-check-in|monday-weekly-check-in' -- app ':!app/docs/architecture/heartbeat.md' ':!app/skills/schedule/SKILL.md'
git diff --check
```
**Expected GREEN result:** tests/typecheck/diff check pass; grep returns only explicit retired-cleanup constants/tests (and no active registry, guidance, prompt, CLI, Home, or handler references). Review each result rather than accepting an empty/nonempty status blindly.

**Commit:** `test(schedule): cover consolidated morning check-in migration`

### Task 7: Prepare whole-branch gate evidence

- [ ] **Step 1:** Confirm the Step 6 focused suite, typecheck, migration search, and documentation test are green after the final logical commit. Do not run a separate correctness review or whole-project test gate here; this step only prepares the bounded final diff and records the intended high-risk assertions for Step 8.
- [ ] **Step 2:** Ensure `git status --short` is clean after the logical commits, or contains only intentional plan-scoped unstaged source, test, and documentation changes if the fast-track executor leaves commits to the parent; remove no user work.

**Commands:**
```bash
git diff --check
git diff --cached --name-only
git status --short
```
**Expected GREEN result:** diff check is silent, `git diff --cached --name-only` is empty, and status shows only intentional unstaged plan-scope changes.

### Task 8: Whole-branch correctness/decay gate (single gate after implementation)

- [ ] **Step 1:** Inspect `git diff --check`, `git status --short`, and the final diff for scope: only scheduler/handler/tests/guidance/docs necessary for this approved spec. Confirm no production configuration, dependency, unrelated prompt, recipient, provider, or Home-control changes slipped in.
- [ ] **Step 2:** Run the full repository gate from the root. If it fails, fix only root-cause defects within this plan, add a regression test first where behavior was missing, rerun focused tests then rerun the full gate. Do not commit generated files or temp schedule state.
- [ ] **Step 3:** Manually audit the high-risk invariants against the final code: exact-pair legacy deletion before validation; no selection churn; strict `< noon` dispatch and handler-start allowance; post-success/final-give-up fresh selection; trigger byte identity; calendar failure never fallback; Friday title-only prompt/fallback plus private validation; no-event no-side-effects; aggregate diagnostics.

**Commands:**
```bash
make check
git diff --check
git status --short
git diff --stat origin/main...HEAD
git diff -- app/scripts/system-tasks.ts app/scripts/system-reconcile.ts app/scripts/schedule-store.ts app/scripts/schedule-cli.ts app/scripts/heartbeat.ts app/scripts/morning-check-in.ts app/docs/architecture/heartbeat.md app/skills/schedule/SKILL.md
```
**Expected GREEN result:** `make check` passes; diff check is silent; status contains only intended tracked implementation/doc/test changes and no staged/unrelated/generated files; final audit confirms the global constraints.

## Task graph

```text
Step 1 (scheduler RED)
  -> Step 2 (generic ranged scheduling + retirement GREEN)
  -> Step 3 (handler RED)
  -> Step 4 (consolidated handler GREEN)
  -> Step 5 (guidance/docs RED->GREEN)
  -> Step 6 (migration audit + focused gate)
  -> Step 7 (prepare final evidence)
  -> Step 8 (single whole-branch correctness/decay gate)
```
