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
  builders (`buildView`, `buildCollectionsView`, `viewVersion`, `recipientsFromEnv`),
  `applyIntent` (through the checklist lock), and `wireLink`, which connects a
  `HomeLink`-shaped port to those builders and the checklist store — on-demand view build on
  `pull`, tap-apply/persist/ack on `intent`, change-notify on `checkForChanges`.
  `buildCollectionsView` identity-fences each JSON source, then deterministically converts
  only its visible Markdown fields into safe HTML. Also `loadHomeKeys`.
- **`scripts/home-bot.ts`** also watches the whole Collection directory directly and asks
  `wireLink` to rebuild on every directory event: the bounded source-discovery rule counts
  stray entries too, so a non-Collection deletion can make a Collection publishable. There is
  no model renderer or derived Collection cache.
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
- **`viewVersion` is a digest of the *view*** (lists + collections + recipients), NOT of
  `checklists.json`. `recipients` come from the shared `allowlist.json` (`OPERATOR_EMAIL`
  ∪ its recipients, read fresh via `recipientsFromEnv` — `ALLOWED_RECIPIENTS` is only the
  first-run/fallback seed; see "The tenant allow-list" below) and structured Collection items
  from fenced source files, so a store-only digest would never republish an allow-list change —
  the DO would 403 a newly-allowed parent's login forever.
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

## The tenant allow-list (`allowlist.json`)

The `home` surface can now also administer *who is allowed to reach Baxter*: a
session-gated Settings page on `home.<domain>` (`GET /settings`, `POST
/settings/add`, `POST /settings/remove` — implemented in the private
`baxter-control` repo's `workers/home/src/object.ts`) lets any authenticated
tenant member view the family roster and add/remove an email or phone contact.
Phone entries are accepted and stored but currently **inert** — there is no SMS
channel yet, so a phone-only member can be listed but can't trigger or receive
anything.

- **Source of truth moved to the Durable Object.** The DO holds tenant
  membership as `Member` objects (`address`, `kind: "email"|"phone"`,
  optional `name`, `sender`/`recipient` booleans, an optional `protected`
  flag reserved for the operator). It is the authority; everything
  downstream — the container, `allowlist.json`, `mail.ts`'s send/receive
  gates — only ever sees the *derived* address arrays (senders/recipients),
  never the member objects themselves.
- **`~/.mail-agent/home/allowlist.json`** (`ALLOWLIST_PATH`, `scripts/paths.ts`
  — one subdirectory deeper than the original spec wording, alongside the
  home surface's other state) is the shared runtime file every surface reads
  **fresh** on each call (`loadAllowlist`, `scripts/allowlist.ts`): `mail.ts`'s
  send/receive gates and `home-mirror.ts`'s `recipientsFromEnv` read it live,
  no caching, no restart required after a change. **`home-bot.ts` is its sole
  writer** — every other reader only ever reads.
- **Live propagation over the WS link.** The DO pushes the derived snapshot
  down the link as a `command` message carrying `reason: "sync"` or
  `reason: "mutation"`. `reason: "sync"` fires on every (re)connect and is
  applied **unconditionally** — it must win even if the file's on-disk
  version is higher (the DO-storage-wipe/reseed case). `reason: "mutation"`
  fires on a live `/settings` edit and is applied only if its version is
  strictly greater than what's already on disk (idempotent under redelivery
  within a connection). On either apply, `home-bot.ts` (`applyMembersCommand`)
  writes `allowlist.json` and republishes the checklist view so
  `View.recipients` (the login allow-list) goes back up the link immediately
  — no container restart needed for an allow-list change to take effect.
- **Fail-closed, three-tier fallback.** Readers fall back **file → app.env
  seed → empty** — never "allow all." A missing file (not yet provisioned) is
  the silent, expected case; an unreadable-but-present or corrupt file logs
  loudly (because the env seed it falls back to could be *broader* than the
  file it's replacing, e.g. a since-revoked sender still sitting in a stale
  `ALLOWED_SENDERS`) before falling back to the seed. An empty seed means
  nobody, in both directions.
- **`app.env`'s `ALLOWED_SENDERS`/`ALLOWED_RECIPIENTS` are a one-time seed,
  not the running configuration.** They're read only when `allowlist.json` is
  absent (first run / not yet provisioned) via `seedMembers`, which is
  seed-if-empty, authoritative-ignore: once the DO has stored members it never
  re-reads the env-derived report. Editing `app.env` after first run has no
  effect on a live tenant — use the Settings page.
- **The DO also owns live, read-guarded directory-KV maintenance.** The
  fleet-wide email→tenant directory (`HOME_DIRECTORY_KV`, used for login
  routing before a session exists) is kept in sync with membership add/remove
  from `/settings`: an add reads the KV first to refuse a cross-tenant email
  collision before persisting anything, then writes the mapping; a remove
  compare-then-deletes. This is **best-effort** — KV is eventually consistent
  with no compare-and-swap, so the guard narrows rather than closes a
  collision window, and a transient KV write failure after the list change is
  already persisted keeps the list change and surfaces a warning. **The fix
  for a failed KV write is to retry from `/settings`** (the mutation re-runs
  the KV op unconditionally, even on an otherwise-no-op duplicate add or
  absent remove, specifically so a retry repairs a prior partial write).
  `baxctl home <id>` is explicitly **NOT** a repair path for this: its own
  `syncDirectory` step is put-only and sourced from `app.env`'s seed, so
  running it against a tenant whose live roster has since diverged can
  **reintroduce stale mappings** rather than fix them.
- **`/settings` is the only new writer of the allow-list trust boundary**, and
  it is session-gated (never `ADMIN_SECRET` — that stays baxctl's, family-facing
  auth is a session). It's routed at **both** layers: the front Worker
  (`workers/home/src/index.ts`) treats `GET /settings` as a browser page route
  and cookie-routes the `POST /settings/add`/`POST /settings/remove` writes to
  the right tenant's DO (same shape as the `/auth/*` forwards — no decodable
  session cookie means no tenant to forward to, so it's refused directly
  without spending a DO instantiation); the DO itself (`object.ts`) re-checks
  session and Origin on every one of those routes rather than trusting the
  Worker's forward.

## Collections publication

Each canonical Collection source is a JSON array of strict `{title, content, notes}` entries.
`buildCollectionsView` identity-fences the source, rejects non-JSON/invalid entries, and converts
only `title` and `content` Markdown to safe `titleHtml`/`contentHtml`. It never reads, renders, or
serializes `notes`; those remain internal agent context in the source file. The fence rejects a
source over the 1 MiB source cap before allocation and bounds a descriptor read through the same
cap, including a growth race. Discovery streams the directory with a 200-entry ceiling and stops
after 100 canonical source categories, so a native file writer cannot turn one Home rebuild into
unbounded directory metadata work, Collection source reads, or renders. `home-bot.ts` watches every
Collection-directory event and immediately runs the ordinary view-digest path—there is no model call, derived cache, debounce queue, or
migration job. An accepted `collections-cli delete` unlinks its source, emits that directory event, and the next pulled view omits the
Collection, replacing the Durable Object's rendered artifact; there is no separate local artifact to clean up. Legacy Markdown sources stay available to Baxter through `collections-cli open`, but
Home omits them until a normal JSON save replaces them. Publication is all-or-none for Collections:
the mirror supplies the projection only the bytes remaining below the 1.5 MiB Home payload cap and
stops on the first over-budget source; lists and recipients are still published while `collections`
falls back to an empty array.

## Running it

`home` runs by default inside the light container.
`BAXTER_SURFACES` narrows the set (the control plane sets this per tenant), and
`make home` brings just the light container up on an already-running fleet. It needs
`home-keys.json` (provisioned by `baxctl home <id>`); without it the surface idles.
`make stop` / `make logs` include the `home` profile.

## SMS surface

A second, separate compose profile — `sms` (`scripts/sms-bot.ts`) — rides the same
control-plane DO as this surface but has nothing to do with checklists. It lets a family
member text Baxter (via Sendblue, an iMessage/SMS/RCS provider) and get a reply from a
scoped agent run, with a local transcript kept for conversational context. Design:
`docs/superpowers/specs/2026-08-04-home-sms-surface-design.md`.

**Why SMS needs the cloud in the loop, unlike Discord/mail.** Discord and mail are each a
tenant's *own* provider account (its own bot token / its own inbox), so the container
connects out and pulls its own inbound directly — the cloud is never involved. SMS's free
Sendblue tier gives the whole fleet exactly **one shared number and one shared credential**;
one webhook receives every tenant's inbound, so *tenant resolution has to happen in the
cloud* before anything reaches a container. SMS therefore reuses the same push-down pattern
this doc already uses for checklist taps, not the Discord/mail pattern.

**Path:** a text arrives at Sendblue's shared number, which POSTs to
`workers/home`'s `POST /sms/inbound`, authenticated by the `sb-signing-secret` request
header Sendblue sends on every inbound POST (compared constant-time against the Worker
secret `SMS_WEBHOOK_SECRET`; a mismatch -- or a missing header -- is a plain 404,
indistinguishable from an unknown route). The Worker normalizes `from_number` to E.164 and
looks it up via `hashPhone`/`lookupTenantByPhone` — a phone-flavored mirror of the existing
`hashEmail`/directory-KV lookup (same `DIRECTORY_HASH_SECRET`, a distinct label, double-HMAC,
fail-closed on a missing/short secret). An unresolved sender is logged and dropped (2xx, not
an error — an unknown texter is an ordinary input). A resolved tenant gets the message
forwarded to its DO on a **dedicated `"sms"`-tagged link**, parallel to (and independent of)
the checklist link used above — SMS runs as its own container process, so it dials its own
`wss://.../svc/<id>/sms-link` (same SigV4 handshake shape). The DO checks a
`sms:seen:<dedupKey>` set before doing anything else (unpruned in v1 — a prune alarm is a
roadmap item; a duplicate is a 2xx no-op — this is
where idempotency lives, since the Worker can't consult a tenant's seen-set before it has
even resolved the tenant), then persists the pending inbound and allocates a down-id
*before* sending (mirroring this doc's persist-before-send / ack-cursor / reconnect-replay
machinery, on its own `sms:pending:<id>` / `nextSmsDownId` cursor space). On the container,
`sms-bot.ts` receives the down-message, appends it to a local JSONL transcript, and **wakes a
scoped `claude -p` run** — the one place this doc's "a tap must never wake an LLM run"
invariant does NOT apply, because an inbound text is content, not a tap. The run replies by
shelling out to `Bash(sms-cli send <phone>)`.

**STOP suppression.** In a 1:1 conversation, a trimmed standalone `STOP` is matched
case-insensitively before transcript append or agent dispatch. The daemon atomically persists
the normalized number in `sms/opt-outs.json`, acknowledges the control message silently, and
starts no run. Every direct `sms-cli send` and `send-contact` reads that state before quota or
provider work, so an already-running agent, heartbeat, or scheduled delivery is blocked too.
Any later non-STOP direct inbound atomically removes the number before normal transcript and
dispatch processing. Group messages — including a standalone group `STOP` — never change 1:1
suppression. A corrupt suppression file fails closed for direct sends; missing state means no one
has opted out. The `sms-opt-out` skill handles prose requests such as “please stop messaging me”
by asking the person to send `STOP` by itself; in a group it explicitly directs them to send that
keyword in Baxter's direct 1:1 thread. Exact direct keyword variants never reach the model.

**Group chats.** A group message carries a Sendblue `group_id` (plus `participants` and
`group_display_name`); the Worker forwards these instead of dropping the message, mapping
Sendblue's `group_display_name` to the `group_name` field the container reads. The
**individual sender** is still authorized via `lookupTenantByPhone` (so a group with two
allowed members works from either), but the **conversation is keyed on `group_id`** end to
end (`convKey` → `group:<id>`): one transcript for the whole group, dispatched as one thread,
with each inbound recording its speaker (`from`) so the prompt attributes who said what. The
run replies **into the group** with `Bash(sms-cli send-group <group_id>)` (Sendblue's
`send-group-message`), and the prompt tells it to be selective (a group is ambient — chime in
only when addressed or clearly useful). Presence signals (read receipts / typing) stay 1:1
only. A 1:1 (`group_id` absent/empty) is unchanged: keyed on the sender, replied via `send`.

**Shared number, fleet-wide credential.** All tenants share one Sendblue account/number —
there is no way to tell tenants apart at the provider level, which is exactly why resolution
has to happen in the cloud. `SENDBLUE_API_KEY` / `SENDBLUE_API_SECRET` / `SENDBLUE_FROM_NUMBER`
are container-side env vars, set fleet-wide (the same values on every tenant's `sms` service),
not per-tenant secrets.

**Credential boundary.** `sms-bot.ts` (the daemon) holds the three `SENDBLUE_*` values, writes
them to a 0600 file (`sms-keys.json`) for `sms-cli` to read, and **strips them from the env
handed to the spawned run** — exactly like `DISCORD_BOT_TOKEN`. The agent never sees the
credential; it can only act through `sms-cli`, a token-scoped CLI (modeled on `discord-cli.ts`)
that POSTs to Sendblue's `send-message` endpoint, retries once on a 429 (respecting Sendblue's
1 msg/sec), and enforces a daily send cap (`SMS_MAX_SENDS_PER_DAY`, recorded before the POST —
over-count-on-failure is the safe direction, same as the mail/Discord counters).

**Transcript store.** Sendblue has no queryable scrollback (unlike Discord's REST API), so the
container keeps its own: one JSONL file per conversation — a normalized E.164 phone number for
a 1:1, or a `g-<id>` file for a group (keyed `group:<id>`) — lock-guarded
(`proper-lockfile`, same shape as the checklist store) because the daemon's inbound append and
`sms-cli`'s outbound append are two separate processes that can race on the same conversation.
Each entry is `{ direction: "in"|"out", at, content, media_url?, from? }` (`from` records the
group speaker); `sms-cli`, not the daemon,
owns the outbound half (it appends immediately after a successful send), which is what lets the
agent see its own prior replies on the next inbound. The run is fed the most recent entries as
conversational context.

**No reply loop.** Only Sendblue's `receive` webhook is ever registered
(`sendblue webhooks set-receive https://home.<domain>/sms/inbound`, with the webhook's
signing secret set to the same value as `SMS_WEBHOOK_SECRET`, one-time per deploy — see
the outer repo's `README.md`). Registering `outbound` too would feed
Baxter's own sent replies back in as if they were new inbound texts — deliberately never done.

`sms` is on by default too, in the same light container (`BAXTER_SURFACES` only narrows). It
needs the same `home-keys.json` as this surface (provisioned by `baxctl home <id>`) to dial
its link, plus the `SENDBLUE_*` env vars to actually send; missing either, it idles rather
than crash-looping.
