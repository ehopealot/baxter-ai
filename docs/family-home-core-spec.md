# Family home — the CORE side (implementer handoff)

**Superseded** (poll/sync path) by
`docs/superpowers/specs/2026-08-03-home-websocket-transport-design.md`; the
`POST /api/sync` channel described here was retired in D1. Membership/calendar
sections remain informational pending their own specs.

**For:** the core (`baxter-ai`) implementer. **Self-contained**: the control plane is a
private repo you do not need. Everything you must agree with is in §Contract.

**Depends on:** core at `cdf1129` (ships `checklist-cli`, `checklist-store`, the Discord
mirror). **Counterpart:** a Cloudflare Worker + Durable Object built in `baxter-control`,
which serves one web page per family — an index of their checklists, tap-to-check, and
(stubbed) project pages.

## The one-paragraph model

`STATE_DIR/checklists/checklists.json` stays **the source of truth**. The web page is a
*third mirror* of it, alongside the CLI and the Discord channel — the same relationship
`checklist-mirror.ts` already states in its header ("the store is the source of truth; the
channel is reflective"). The Durable Object holds a published copy plus a queue of pending
taps. Core publishes the view and drains the taps, applying them through the **same
`proper-lockfile` `mutate()`** the CLI uses. That gate is why three writers are safe; do
not write the store any other way.

## What core must build

### 1. `home-mirror.ts` — logic, behind a seam

Follow `checklist-mirror.ts` exactly in shape: pure functions for the diff/decision, and an
injectable ops interface so the whole thing is unit-testable against a fake and a temp
store, with no network.

```ts
export interface HomeOps {
  sync(body: SyncRequest): Promise<SyncResponse>;   // one signed POST, see §Contract
}
```

Pure parts worth isolating (they are where the bugs will be): building the view from the
store, computing `viewVersion`, and deciding which intents still need applying.

### 2. A driver process, gated on `BAXTER_SURFACES`

The Discord mirror is driven by `discord-bot.ts`; the web must not require Discord, so this
needs its own long-running process, enabled by adding `home` to `BAXTER_SURFACES` in the
tenant's `app.env`. The control plane already manages that value per tenant.

The tick is **set by the DO**, not fixed here — see `pollAfterSeconds` in §Contract. Start
at 30s before the first response arrives, then obey what you are told, clamped to
**[2s, 60s]** so a buggy or hostile value can neither stall the surface nor hammer it.

Note this process is *not* in-process with the agent, so it cannot observe a write as it
happens; it detects one:

1. Build the view; compute `viewVersion` — a sha256 over a canonical serialization of
   **`view` itself**: lists *and* projects *and* recipients. **Not** a digest of
   `checklists.json`: `recipients` comes from `app.env` and project HTML from the project
   files, so digesting only the store means adding a parent to `ALLOWED_RECIPIENTS` never
   republishes — the DO keeps the old allow-list and 403s that address's login forever,
   with nothing in the logs pointing at why. Not a timestamp either: an unchanged view must
   produce an unchanged version, or every tick republishes.
2. `POST /api/sync` with `appliedThrough` and, **only if `viewVersion` changed**, the view.
3. Apply each returned intent in `id` order (below).
4. Persist `appliedThrough` **after each intent**, not after the batch.

`BAXTER_SURFACES` gains a `home` token, which means core's `check-surfaces` allow-list and
the compose profiles need it in the same change — otherwise a tenant with `home` set fails
to start with nothing pointing at why.

### 3. Applying intents

- `check` / `uncheck` — through `mutate()`, same path as the CLI. Idempotent; if the item
  or list is gone, **no-op and still advance `appliedThrough`** (the operator deleted it;
  the tap is moot, exactly as a removed item's reminder self-cancels).

These are the **only** two kinds. Apply the batch strictly in `id` order, persisting
`appliedThrough` after each.

**Core sends no mail for this feature.** Login codes are mailed by the Durable Object
itself, from a dedicated send-only identity — so nothing on a human's critical path waits
for a tick, and the tick's only job is keeping the agent's view of the lists current.

**Persist `appliedThrough` in `STATE_DIR`, next to the store, not in memory.** It is what
makes a crash safe: intents are deleted by the DO only when acknowledged, so anything not
yet acked is redelivered — within the queue bound stated in §Contract. Writing it
per-intent rather than per-batch bounds the damage of
a crash to **at most one duplicate**, which for `check`/`uncheck` is invisible.

### 4. Project rendering (stub is fine for v1)

Core renders project markdown to HTML and publishes it; the Worker never parses markdown.

**Sanitize at render time, with a tag/attribute allow-list.** This is not optional and it
is the sharpest security edge in the whole feature: project files are agent-maintained and
this agent ingests email, so untrusted text can reach a project and become stored HTML on
the same origin as a year-long session cookie. No `<script>`, no `on*` attributes, no
`javascript:` URLs, no `<style>`, no `<iframe>`. If that is more than v1 warrants, publish
`projects: []` and ship lists only — the Worker treats projects as optional.

### 5. A tap must not wake an LLM run

**A hard invariant, confirmed by the operator (2026-07-31): the agent does not react to a
tap.** Draining and applying intents is plain code start to finish. If a check-off ever
costs a model call, that is a bug, not a feature to be gated.

The Discord mirror already establishes the pattern — it consumes its own reactions
specifically so a mirror message never wakes a run.

## Contract

Authoritative. Both sides implement exactly this.

### Credential

`baxctl` writes `STATE_DIR/.mail-agent/home-keys.json`, `0600`, owned `1000:1000` — same
placement class as `calendar-keys.json`:

```json
{ "endpoint": "https://hopefam.home.bax.bot",
  "tenant": "hopefam",
  "accessKeyId": "…24 hex…",
  "secretAccessKey": "…48 hex…" }
```

Absent file ⇒ the surface logs once and idles. Do not crash the container.

### Signing

**AWS SigV4 via `aws4fetch`** (already a core dependency, added for calendaring):

```ts
new AwsClient({ accessKeyId, secretAccessKey, region: "auto", service: "home" })
```

`service: "home"`, **not `"s3"`** — the service string is part of the credential scope and
therefore of the signing key, so a calendar signature can never be replayed here even if
the secrets were ever confused. The secrets are separate anyway; this is the second barrier.

Verified behaviour worth knowing: for a **non-`s3`** service, aws4fetch does *not* send
`x-amz-content-sha256`, but it *does* put `sha256(body)` into the canonical request. So the
**body is covered by the signature** — unlike the calendar path, where s3's
`UNSIGNED-PAYLOAD` substitution leaves it uncovered. The verifier computes the hash from the
body rather than trusting a header. Do not add an explicit `x-amz-content-sha256` header;
it would change the canonical request.

Signed headers will be `host;x-amz-date`. Requests older than **±15 minutes** are refused.

### `POST {endpoint}/api/sync`

Request:

```json
{ "viewVersion": "sha256-hex of the canonical serialization of `view`",
  "view": { … } ,
  "appliedThrough": 41 }
```

- `view` — **omit entirely** when `viewVersion` is unchanged since the last accepted sync.
- `appliedThrough` — highest intent `id` durably applied. `0` on first run.

`view`:

```json
{ "lists": [ { "slug": "groceries", "name": "Groceries", "open": 3, "total": 7,
               "items": [ { "id": "…", "text": "milk", "checked": false, "due": null } ] } ],
  "projects": [ { "slug": "kitchen", "name": "Kitchen reno", "html": "<h2>…</h2>" } ],
  "recipients": [ "parent@example.com" ] }
```

- `recipients` — `OPERATOR_EMAIL` ∪ `ALLOWED_RECIPIENTS` from the tenant's env. **This is
  the login allow-list.** Empty ⇒ nobody can log in (fails closed, matching core's send
  side). The DO will not mail a code to an address outside this list -- which is also what
  stops a compromised Worker being usable as an open relay.
- Items keep the store's own ids; the DO addresses taps by `listSlug` + `itemId`.

Response:

```json
{ "intents": [ { "id": 42, "kind": "check",     "listSlug": "groceries", "itemId": "…", "at": "…" },
               { "id": 43, "kind": "uncheck", "listSlug": "costco", "itemId": "…", "at": "…" } ],
  "viewVersion": "…echoed…",
  "pollAfterSeconds": 2 }
```

- `viewVersion` — the version the **DO currently holds**, or `null` if it holds none. If
  it does not match what core last published, **republish the full view on the next tick
  regardless of whether anything changed.** This is the only signal that DO state was lost
  (a recreated object, an `rm` then re-add, a binding change moving `idFromName(tenant)`).
  **A `null` echo means the DO holds no view at all — its storage was lost. Reset the
  persisted `appliedThrough` to `0` on that same tick, in addition to republishing.** This
  is the reliable storage-loss signal; `409` is only the counter-level check and has a
  boundary hole: if the reset DO issues enough new intents before core's next sync, core's
  stale `appliedThrough` is no longer greater than the DO's counter, the check passes, and
  those intents are silently acknowledged and deleted — a dropped tap with nothing to
  detect it, and counters permanently realigned. The `null` echo does not depend on how far
  the reset queue has already advanced.

  Without acting on the echo at all, a DO that loses its view serves an empty page with an
  empty `recipients` — nobody in the family can log in — while core happily 200s forever.
- `pollAfterSeconds` — how long to wait before the next sync. The DO knows two things core
  cannot: whether a phone has a socket open right now, and whether anything is queued. Obey
  it, clamped to [2s, 60s]. It is a rate control, not a guarantee — syncing *earlier*
  because the local view changed is always allowed. **If absent, or not a finite number,
  fall back to the idle rung (60s)** — 30s only before any response has arrived. The clamp
  alone does not cover this: `Math.min(60, Math.max(2, undefined))` is `NaN`, and
  `setTimeout(NaN)` fires immediately, so the idle rung becomes a hot loop — the one "buggy
  value" the clamp was added for and the one it misses.

  Fall back rather than *hold the previous interval*: the absent case is persistent (an old
  DO build, a rollback, a serialization bug), and the field goes missing most visibly on the
  fast rung — so holding would pin 2s indefinitely, ~43k requests/day for one tenant. The
  failure is asymmetric: falling back costs a slower login while the DO is broken, and
  self-heals the moment the field returns.
- `intents` — everything with `id > appliedThrough`, ascending. Apply **in order**.
- Sending `appliedThrough: N` also acknowledges: the DO deletes intents `id <= N`. There is
  no separate ack call.
- Intent ids are monotonically increasing integers per tenant.
- **The queue is bounded.** The DO caps `pending[]` (dropping oldest, with a logged
  counter) and expires intents older than ~1h. Two consequences core must accept: **ids may
  have gaps** — a gap is not an error, apply what arrives — and a tap made while core was
  down long enough to overflow is **lost, not redelivered**. That is the price of not
  growing DO storage without bound behind a container that is down for a day.

Status codes, and what core does with each:

- `200` — ok.
- `401` — bad or absent signature, or clock skew beyond ±15 minutes. Retry on the same
  backoff schedule as `429`, reset on the first `200`; after ~10 consecutive `401`s, **alert**
  — the credential likely needs re-registering (`baxctl home <id>` on the box) — but keep
  retrying, since re-registration fixes it without a container restart. Skew self-heals; a
  wrong or unregistered `accessKeyId` does not, and without the alert it is a few hundred
  identical log lines a day once the backoff reaches its 5-minute cap — quiet enough to sit
  there indefinitely — and a surface that never works.
- `403` — tenant mismatch. Fatal config error; log loudly and stop syncing.
- `409` — `appliedThrough` exceeds the highest intent id the DO has ever issued, i.e. **the
  queue was reset** while `STATE_DIR` kept counting. Core resets its persisted
  `appliedThrough` to `0` and retries next tick. Without this, a `rm` + re-add (or any loss
  of DO storage) leaves the two counters permanently out of step: every sync returns an
  empty `intents`, core logs a healthy 200 every tick, and no tap ever arrives
  again. The reset costs only redelivery, which is free: `check`/`uncheck` are the only
  kinds and both are idempotent.
- `413` — view over the size cap (**to be fixed by the control plane before handoff, not
  assumed at 256 KB**: the DO persists `view` as stored state, and legacy KV-backed Durable
  Object storage caps a single value at 128 KiB where SQLite-backed storage is far higher.
  Whoever configures the DO settles the number and it goes here). In practice a `413` means
  one large project's rendered HTML. Record `oversizedProjectsDigest` in `STATE_DIR` — the
  digest of **the entire `projects` array that was rejected**, since a `413` does not
  identify which project is at fault. Log once, alert, and republish immediately with
  `projects: []` (the Worker treats that as valid). **While a freshly built `projects` array
  digests to `oversizedProjectsDigest`, build the view with `projects: []` and do not retry
  the full body.** Any change to any project clears the latch, costing at most one failing
  request per project edit.

  **The latch also expires: retry the full body once an hour even while latched**, and on a
  `413` re-record the digest and restart the timer. Without that, a `413` actually caused by
  `lists` (every item's text for every list rides the same payload, and the cap may be as low
  as 128 KiB) latches an innocent, small `projects` array — and once the lists shrink again
  the projects digest is still unchanged, so project pages stay silently gone forever with
  no alert and no escape but an unrelated project edit. The re-probe caps the cost at 24
  failing requests a day (48 in the doubly-`413` state below, where the stripped
  republish fails too) and guarantees projects return once the view fits, whatever the
  original cause.

  **If the `projects: []` publish ALSO returns `413`, the view cannot be published at all.**
  Do *not* record the stripped array as `oversizedProjectsDigest`: that makes the latch
  oscillate between two values and restores the very thrash it exists to prevent. Alert as
  fatal for the publish path, keep `viewVersion` at the last accepted value, and **keep
  syncing with `view` omitted (drain-only) on the normal tick** — these syncs succeed, so
  they must not be throttled; the fatal alert, not a slower loop, carries the signal.
  (Riding the `429` backoff would be either dead weight — drain-only returns `200`, which
  resets it — or, read as a cadence to hold, five minutes between drains while the endpoint
  answers `200`: taps undrained for five minutes, invisibly.) Retry a full publish
  when the built view's digest changes, or on the hourly re-probe above, and in both cases
  the retry includes `projects`. This is the more important half:
  `/api/sync` carries publish *and* drain in one request, so a permanently-413ing sync
  returns no `intents` at all — taps never apply, taking
  the whole surface down rather than merely leaving the page stale.

  The latch is not optional bookkeeping — without it: tick N publishes the full view, gets
  `413`, republishes stripped, `200`. Tick N+1 rebuilds, the oversized project is unchanged,
  the digest differs from the last accepted (stripped) one, so "viewVersion changed" fires
  and the same oversized body goes out again. Forever, two requests a tick, one failing —
  a thrash with the same end state as the stall it replaced, and "log once" is meaningless
  under a loop that re-enters every tick.

  Consequently: **`viewVersion` is always the digest of the view core last successfully
  published (a `200`)** — never of the view it built, and never of a body that was rejected
  or never arrived. "Sent" is not "accepted": record the version of a `413`-ed, `429`-ed or
  dropped body and the next tick sees "unchanged", omits `view`, and the DO holds a stale
  view core believes it published. That self-heals only via the echoed-version mismatch,
  i.e. an extra tick of staleness resting on a different rule being right.

  Lists ride the same payload, so without all of this a size problem in one project file
  stops checklist updates *and* leaves `recipients` stale, taking down logins.
- `429` — exponential backoff from 30s to a 5-minute cap, reset on the first `200`.

### The fence — why `appliedThrough` is in both directions

The DO applies a tap to its own copy immediately, so the other parent's phone updates
without waiting for core. That copy is then overwritten by your next publish. Without a
fence, this happens: parent checks "milk" at t=0; the agent touches an unrelated list at
t=3 and publishes a snapshot read from disk **before** the drain ran; the DO overwrites the
view and both phones watch "milk" un-check itself.

So the DO, on receiving a publish, replaces the view and then **re-applies every pending
intent with `id > appliedThrough` on top** before broadcasting. Your side of the bargain is
simply to send an honest `appliedThrough` with every sync.

## Out of scope for core

- Serving HTML, sessions, cookies, rate limiting, the DO — all control-plane.
- Login codes entirely — the Durable Object **generates and mails** them, from its own
  send-only identity. Core never sees a code, plaintext or hashed.
- Deciding the login allow-list — core only publishes `recipients`.

## Testing expectations

Match the existing bar: `checklist-mirror.test.ts` runs against a fake `DiscordOps` and a
temp store with no live client. Do the same with a fake `HomeOps`.

The happy-path cases: view built from a store, **`viewVersion` stable across no-op
rebuilds**, intents applied in order, an intent for a
deleted item advancing `appliedThrough` without error, a crash between apply and persist
duplicating at most one intent, and an intent for a **list** that no longer exists being a
no-op rather than an error.

**And every failure path below, because each one fails permanently and silently if wrong —
which is the entire reason they are specified:**

- `viewVersion` changes when `recipients` changes and the store does not. (Note
  "`viewVersion` stable across no-op rebuilds" alone under-tests this: a store-only digest
  passes it too, and a store-only digest is the bug.)
- An echoed `viewVersion` that differs from what was last published — and `null` — each
  force a full republish on the next tick.
- `409` resets `appliedThrough` to 0 and re-applies idempotently.
- `413` publishes `projects: []` **and does not resend the oversized body on the following
  tick** — the latch, not just the first strip.
- An `intents` batch with a gap in ids applies without error.
- Repeated `401` backs off rather than retrying every tick.
- A `413` on the `projects: []` publish does **not** latch the stripped array, does not
  retry a full body, and keeps draining `intents` on the normal tick.
- The latch re-probes after an hour and clears once the full body fits.
- `appliedThrough` exactly equal to the DO's highest issued id returns `200`, not `409` —
  the boundary, tested in both directions.
- A `null` echoed `viewVersion` resets `appliedThrough` to `0` as well as republishing.
- `pollAfterSeconds` of `0`, a negative, `3600`, absent, or non-numeric each resolve to a
  value in [2s, 60s] — absent and non-numeric resolving to the 60s idle rung, never to a
  zero-delay retry and never holding a stale 2s.

## Rollout

Core lands first; the control plane bumps its `core/` submodule pin, rebuilds tenants, and
adds `home` to `BAXTER_SURFACES` per family. The Worker can be deployed before core is
ready — it simply has nothing publishing to it.
