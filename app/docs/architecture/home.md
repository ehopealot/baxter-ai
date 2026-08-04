# Family-home web surface

The **`home`** surface publishes Baxter's checklists as a web page one family can open
(an index of their lists + tap-to-check), and drains the taps back into the store. It is
the CORE side of a two-part feature; the web page, sessions, login codes, and rate limiting
all live in a control-plane Cloudflare Worker + Durable Object (the private `baxter-control`
repo). The full contract used to be `docs/family-home-core-spec.md`; that document is now
**superseded for the wire channel** by
`docs/superpowers/specs/2026-08-03-home-websocket-transport-design.md` (D1 retired the
`POST /api/sync` poll channel it described — see that document's status line).

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
  is in `BAXTER_SURFACES`. Owns the `HomeLink` lifecycle: the signed WS connect
  (`signedLinkConnect`, SigV4 over `wss://.../svc/<tenant>/link`), the checklist-dir
  `fs.watch` that triggers `wireLink`'s `checkForChanges`, and liveness. Idles cleanly (logs
  once, no crash) if `home-keys.json` is absent.
- **`scripts/home-link.ts`** — the transport: one persistent WebSocket link to the
  control-plane Durable Object (connect, `hello`, heartbeat, reconnect/backoff/liveness,
  message routing). Owns no application logic — `wireLink` (below) drives its
  `onPull`/`onIntent`/`onOpen` callbacks. This is the sole core↔DO channel; the HTTP poll
  path it replaced (`runSyncTick`/`HomeOps`) was removed in D1.
- **`scripts/home-mirror.ts`** — the logic, mirroring `checklist-mirror.ts`'s shape: pure
  builders (`buildView`, `viewVersion`, `recipientsFromEnv`), `applyIntent` (through the
  checklist lock), and `wireLink`, which connects a `HomeLink`-shaped port to those builders
  and the checklist store — on-demand view build on `pull`, tap-apply/persist/ack on
  `intent`, change-notify on `checkForChanges`. Also `loadHomeKeys`.
- **`scripts/home-state.ts`** — the durable sync cursor (`HOME_STATE_PATH`, next to the
  checklist store). Single writer (this surface), so a plain atomic write, no lock. Holds
  exactly one field, `appliedThrough`, persisted **per applied intent** so a crash
  duplicates at most one idempotent tap. (The poll-era `publishedVersion`/413-latch fields
  the old HTTP path used were dropped outright in the 2026-08-04 fix pass, per the
  clean-cutover policy — `loadState` still backfills a missing field from `freshState()`, so
  an on-disk file carrying the old shape loads fine, its extra keys simply unread.)

## Invariants worth keeping

- **A tap NEVER wakes an LLM run.** Draining + applying is plain code start to finish — there
  are no model calls in these files. The Discord mirror establishes the same pattern.
- **`viewVersion` is a digest of the *view*** (lists + projects + recipients), NOT of
  `checklists.json`. `recipients` come from env (`OPERATOR_EMAIL` ∪ `ALLOWED_RECIPIENTS`,
  the login allow-list) and project HTML from files, so a store-only digest would never
  republish an allow-list change — the DO would 403 a newly-allowed parent's login forever.
- **Signing:** AWS SigV4 via `aws4fetch`, `service: "home"` (NOT `s3`, so a calendar
  signature can't be replayed and — being non-s3 — the body is covered by the signature).
  Signed headers are `host;x-amz-date`; `Content-Type` is safe to set (aws4fetch treats it as
  unsignable). Never add `x-amz-content-sha256`.
- **Gap-safety on `appliedThrough`:** `wireLink`'s `onIntent` tracks a `failedFloor` — the
  lowest locally-failed, still-unresolved intent id on the current connection. The cursor
  advances unconditionally at-or-below that floor (handling both a DO-side gap and a locally
  failed-then-redelivered intent correctly) and withholds strictly above it; the floor clears
  on every reconnect. See `home-mirror.ts`'s `wireLink` header comment for the full argument.
  The pending-queue bound that used to backstop this on the DO side (`workers/home/src/do.ts`'s
  `prune()`) was removed in D1 along with the poll path that was its only caller — see the
  roadmap's A7 entry for when link-path pruning replaces it.

## v1 scope

Lists-only: `buildProjects` returns `[]`. **Project rendering is deferred** — it needs a
markdown→HTML sanitizer allow-list (no `<script>`, no `on*`, no `javascript:`), the sharpest
security edge in the feature, since project files are agent-maintained and this agent ingests
email. Do not enable it without that allow-list.

## Running it

`home` is an opt-in compose profile (like `mail`/`voice`). Add `home` to `BAXTER_SURFACES`
(the control plane sets this per tenant), or `make home` to add just this surface to a
running fleet. It needs `home-keys.json` (provisioned by `baxctl home <id>`); without it the
surface idles. `make stop` / `make logs` include the `home` profile.
