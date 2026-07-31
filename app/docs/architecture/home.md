# Family-home web surface

The **`home`** surface publishes Baxter's checklists as a web page one family can open
(an index of their lists + tap-to-check), and drains the taps back into the store. It is
the CORE side of a two-part feature; the web page, sessions, login codes, and rate limiting
all live in a control-plane Cloudflare Worker + Durable Object (the private `baxter-control`
repo). The full contract is `docs/family-home-core-spec.md`.

## The model — a third mirror

The checklist store (`STATE_DIR/checklists/checklists.json`) stays the **source of truth**.
The web page is a **third reflective mirror** of it, exactly like the Discord channel mirror
(`checklist-mirror.ts`) — "the store is the source of truth; the surface is reflective." The
Durable Object holds a published copy of the view plus a queue of pending taps. Core
**publishes the view** and **drains the taps**, applying each through the **same
`proper-lockfile` `mutate()`** the CLI and the Discord gateway use. That shared gate is why
three writers are safe.

## Files

- **`scripts/home-bot.ts`** — the driver. A standalone long-running process (NOT tied to
  Discord, NOT in-process with the agent), started by the `home` compose profile when `home`
  is in `BAXTER_SURFACES`. Owns only the tick loop; all logic is in `home-mirror.ts`. Idles
  cleanly (logs once, no crash) if `home-keys.json` is absent.
- **`scripts/home-mirror.ts`** — the logic, mirroring `checklist-mirror.ts`'s shape: pure
  builders (`buildView`, `viewVersion`, `resolvePollAfterMs`, `recipientsFromEnv`),
  `applyIntent` (through the checklist lock), and the `runSyncTick` orchestration behind an
  injectable `HomeOps` seam (one signed POST) so the whole tick is unit-testable against a
  fake + a temp store, no network. The real signed op (`signedHomeOps`) is at the bottom and
  is verified live. Also `loadHomeKeys`.
- **`scripts/home-state.ts`** — the durable sync cursor (`HOME_STATE_PATH`, next to the
  checklist store). Single writer (this surface), so a plain atomic write, no lock. Holds
  `appliedThrough` (persisted **per applied intent**, so a crash duplicates at most one
  idempotent tap), the last-published `viewVersion`, and the 413 latches.

## Invariants worth keeping

- **A tap NEVER wakes an LLM run.** Draining + applying is plain code start to finish — there
  are no model calls in these files. The Discord mirror establishes the same pattern.
- **`viewVersion` is a digest of the *view*** (lists + projects + recipients), NOT of
  `checklists.json`. `recipients` come from env (`OPERATOR_EMAIL` ∪ `ALLOWED_RECIPIENTS`,
  the login allow-list) and project HTML from files, so a store-only digest would never
  republish an allow-list change — the DO would 403 a newly-allowed parent's login forever.
- **`viewVersion` is always the digest of the view core last *successfully* published** (a
  200), never a body that was merely sent. A 413/429/dropped body is not "accepted"; recording
  its version would make the next tick omit the view and leave the DO stale.
- **Signing:** AWS SigV4 via `aws4fetch`, `service: "home"` (NOT `s3`, so a calendar
  signature can't be replayed and — being non-s3 — the body is covered by the signature).
  Signed headers are `host;x-amz-date`; `Content-Type` is safe to set (aws4fetch treats it as
  unsignable). Never add `x-amz-content-sha256`.
- **Failure paths fail loudly, not silently:** a null echoed `viewVersion` (DO storage lost)
  resets `appliedThrough` to 0 and republishes; `409` resets the counter; `413` strips
  projects (latched, hourly re-probe) or, if the lists themselves overflow, drains-only;
  `403` stops the loop (fatal config); `401`/`429`/network back off 30s→5min and alert after
  ~10 consecutive `401`s.

## v1 scope

Lists-only: `buildProjects` returns `[]`. The 413-latch logic is fully implemented and tested
regardless (a lists-caused 413 must not silently latch projects forever). **Project
rendering is deferred** — it needs a markdown→HTML sanitizer allow-list (no `<script>`, no
`on*`, no `javascript:`), the sharpest security edge in the feature, since project files are
agent-maintained and this agent ingests email. Do not enable it without that allow-list.

## Running it

`home` is an opt-in compose profile (like `mail`/`voice`). Add `home` to `BAXTER_SURFACES`
(the control plane sets this per tenant), or `make home` to add just this surface to a
running fleet. It needs `home-keys.json` (provisioned by `baxctl home <id>`); without it the
surface idles. `make stop` / `make logs` include the `home` profile.
