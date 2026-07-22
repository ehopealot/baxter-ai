# Migrating the mail surface from Gmail to AgentMail

Status: **proposed** (spec + TDD under review; implementation gated on operator go-ahead)
Date: 2026-07-22

## Context

Baxter's mail surface (`scripts/poll.mjs` + `scripts/gmail.mjs`) polls a dedicated
**Gmail** inbox over the Gmail REST API and spawns one scoped `claude -p` run per new
thread. Two problems motivate replacing the provider:

1. **Google does not support bot-owned inboxes.** Consumer Gmail signup is gated on
   phone verification and flags automated account creation; Workspace needs a real
   organization. The account we use is a personal-shaped account driven by a bot,
   which is against the grain of Google's terms.
2. **The OAuth story is high-maintenance.** `gmail.modify`/`gmail.send` are
   restricted scopes, so the consent screen is stuck in **Testing** mode (leaving it
   needs a paid third-party CASA audit). Testing-mode refresh tokens **expire every 7
   days**, so an operator must run `make auth` weekly or mail silently stops. This is
   the single biggest reason the Gmail surface is opt-in/experimental
   (`app/CLAUDE.md`, root `CLAUDE.md`).

**AgentMail** (`agentmail.to`) is an email API purpose-built for AI agents to own
inboxes. It answers both problems directly: an agent is *supposed* to own the inbox,
and auth is a single long-lived **API key** — no OAuth consent screen, no 7-day token,
no `make auth` treadmill.

### Constraint: no webhooks

The operator requires a **poll-based** design (no publicly reachable inbound endpoint
to host). This rules out the transactional-email crowd (Postmark/Mailgun/Resend/SES
inbound all push to a URL). AgentMail supports **polling** via a plain REST list call
(`GET /inboxes/{id}/messages`), so the existing poll loop shape is preserved.

### Intended outcome

`poll.mjs`'s loop, the send cap, the allowlist-as-boundary, the per-cycle cap, and —
critically — the **entire transcript-forgery sanitization pipeline** stay behavior-
identical. Only the provider plumbing (the Gmail REST calls, the OAuth token, the
MIME construction) is swapped for the AgentMail SDK, and the credential handling is
brought up to the stronger standard the Discord surface already uses.

## Goals

- Replace the Gmail REST/OAuth plumbing with the AgentMail JS SDK behind the **same
  CLI verb surface** (`list-new` / `get-thread` / `reply` / `send` / `label`) so
  `poll.mjs`, `prompt.md`, and `grants.mjs` change minimally.
- **Preserve the sanitization pipeline byte-for-byte** in behavior; make it
  transport-agnostic so it is finally unit-testable independent of a provider message
  shape (the `app/CLAUDE.md` "Tests" section flags this as the thin spot).
- **Strengthen the credential boundary**: keep the API key out of the spawned run's
  env, mirroring the Discord-token pattern (today `poll.mjs` passes the run the
  daemon's *full* env).
- Delete the now-dead OAuth machinery (`authorize.mjs`, `make auth`, the reauth
  reminder, `google-auth-library`).

## Non-goals

- Webhooks / AgentMail realtime (explicitly excluded by the operator).
- Custom sending domain (start on AgentMail's default `@agentmail.to`; custom domain
  is a paid follow-up needing DNS).
- IMAP path. AgentMail also exposes IMAP/SMTP; the REST SDK is the cleaner fit and
  keeps the credential-boundary CLI model. IMAP stays a documented escape hatch.
- Promoting the mail surface into the default `make run` fleet. Kept opt-in for now
  (smaller blast radius); the 7-day-token reason for opt-in is gone, so promotion is a
  reasonable later change.

## AgentMail capability summary (verified against docs.agentmail.to)

- **SDK**: `npm i agentmail`; `import { AgentMailClient } from "agentmail"`;
  `new AgentMailClient({ apiKey })`. Fields are **camelCase** in JS (`inboxId`,
  `threadId`, `messageId`, `inReplyTo`) even though the REST API is snake_case.
- **Inbox**: `client.inboxes.create({ clientId })` → `{ inboxId, ... }`; default
  address on `@agentmail.to`. `client.inboxes.list()`.
- **List** (`client.inboxes.messages.list(inboxId, opts)`): filters `labels`
  (inclusive), `before`/`after` (timestamps), `from`/`to`/`subject` (substring,
  repeatable), `ascending`, `limit`, `pageToken`; response `{ messages, count, limit,
  nextPageToken }`. List items carry `from,to,subject,timestamp,labels,inReplyTo,
  references,threadId,messageId,preview,headers` — **`preview`, not full body**.
  Default excludes spam/unauthenticated (`include_*` flags off).
- **Get** (`client.inboxes.messages.get(inboxId, messageId)`): full `text` + `html` +
  all list fields + `headers`.
- **Thread** (`client.inboxes.threads.get(inboxId, threadId)`): the thread's messages.
- **Send** (`client.inboxes.messages.send(inboxId, { to, subject, text, labels })`) →
  `{ messageId, threadId }`.
- **Reply** (`client.inboxes.messages.reply(inboxId, messageId, { text, labels,
  replyAll })`) → `{ messageId, threadId }`. AgentMail sets threading + recipient from
  the original message; we do **not** hand-build `In-Reply-To`/`References`.
- **Label**: `PATCH /inboxes/{id}/messages/{messageId}` (add/remove `labels`).
- **No system field marks sent-vs-received** — we apply our own label (see below).

## Design

### What stays identical

- `poll.mjs`'s loop: `list-new` → group by thread → per-thread `get-thread` →
  `isAllowedSender`/`isAutomated`/send-cap gates → `label` all → spawn run → optional
  out-of-tokens reply.
- The CLI's JSON contracts: `list-new` prints `[{id, threadId}]`; `get-thread` prints
  `{ id, threadId, from, subject, messageId, references, receivedAt, isAutomated,
  isAllowedSender, body }`; `reply`/`send` read the body from stdin.
- The **sanitization pipeline**: `normalizeTranscriptText`,
  `neutralizeStructuralMarkers`, `neutralizeDanglingSeparatorTail`,
  `formatThreadMessage`, `TRIGGER_MARKER`, `MESSAGE_SEPARATOR`, `makePlaceholder`,
  `extractEmailAddress` — logic unchanged. `poll.mjs`'s `renderPrompt` still sanitizes
  `{{FROM}}`/`{{SUBJECT}}` at the interpolation seam.
- `send-state.mjs` (`recordSend`/`loadSendState`/`MAX_SENDS_PER_DAY`) — provider-
  agnostic; the increment just moves to the AgentMail send call.
- The allowlist / send-cap / per-cycle-cap / loop-prevention guardrails.

### Provider mapping

| Concern | Gmail (today) | AgentMail (proposed) |
|---|---|---|
| Auth | OAuth2 client id/secret + 7-day refresh token file | one API key (`AgentMailClient`) |
| New mail | `GET /messages?q=-label:agent-processed -from:me {from:…}` | `messages.list(after=cursor)` + client-side exclude of `agent-processed`/own/off-allowlist |
| Full thread | `GET /threads/{id}?format=full` | `threads.get` + per-message `get` for full `text` |
| Own message | Gmail `SENT` label | our applied `baxter-sent` label |
| Automated | `Auto-Submitted`/`Precedence` headers | same headers, read from `message.headers` |
| Reply | build MIME `In-Reply-To`/`References`, `messages/send` w/ `threadId` | `messages.reply(inboxId, messageId, …)` |
| Send (operator) | build MIME to `OPERATOR_EMAIL` | `messages.send(inboxId, { to: OPERATOR_EMAIL, … })` |
| Mark handled | add `agent-processed` label via `modify` | add `agent-processed` label via message update |

### Credential model (security delta — the most important change)

Today `poll.mjs` passes the spawned run `env: { ...process.env, … }` — the run
inherits the daemon's whole environment. With Gmail this is tolerable because the env
alone can't act (the *refresh token* lives in `TOKEN_PATH`, and only `gmail.mjs` reads
it). With AgentMail **the API key alone is full authority**, so leaving it in any run's
env lets a prompt-injected run exfiltrate it — directly if the run is granted the mail
CLI (echo-via-command), or via shell interpolation of `$AGENTMAIL_API_KEY` into *any*
granted command's arguments otherwise.

**The key reaches every daemon, not just `poll.mjs`.** All four app-image services
(run/discord/heartbeat/voice) share `env_file: [app/.env]` (compose.yaml; codapi has
none — it holds no secrets), so `AGENTMAIL_API_KEY` is present in the discord,
heartbeat, and voice daemons too. Heartbeat is the sharp case: it grants the
mail CLI (`HEARTBEAT_TOOLS`, `grants.mjs:37` — a fired task may deliver to email), its
task text is indirectly attacker-influenced (`schedule-cli add`), and it runs in the
**default** fleet where `poll.mjs` is not up. So the strip must be universal, and the
key file must be written by every daemon that can spawn a mail-capable run.

We therefore mirror the **Discord-token pattern** but **centralize the strip** so no
daemon can forget it:

1. `paths.mjs`: add `AGENTMAIL_KEY_PATH = join(STATE_DIR, "agentmail-key.json")`
   (beside `DISCORD_TOKEN_PATH`/`DATA_KEYS_PATH`, i.e. `~/.mail-agent/`, one level
   **above** the run's cwd `MEMORY_DIR`).
2. **`runtime.mjs runAgent()` — the single chokepoint all four daemons spawn through —
   strips the surface credentials from the child env it builds**: delete
   `AGENTMAIL_API_KEY` and `DISCORD_BOT_TOKEN` (the two secrets a run reaches only via
   a file-fallback CLI). It must **not** strip the model-provider keys
   (`OPENROUTER_API_KEY`/`OPENAI_API_KEY`) — on those harnesses the runner *is* the
   run and needs them to call the model. This also closes a pre-existing hole: today
   the mail run keeps `DISCORD_BOT_TOKEN` (`poll.mjs:259` passes `...process.env`
   unstripped). The per-daemon `delete RUN_ENV.DISCORD_BOT_TOKEN` lines
   (`discord-bot.mjs:126`, `heartbeat.mjs:32`, `voice-bot.mjs:168`) become redundant
   but are kept as defense in depth.
3. **Key-file bootstrap** in the daemons that can spawn a **mail-capable** run —
   `poll.mjs` (mail) and `heartbeat.mjs` (mail delivery): at `main()` startup, if the
   env carries `AGENTMAIL_API_KEY`, write it to `AGENTMAIL_KEY_PATH` `{ mode: 0o600 }`
   (heartbeat mirrors its existing conditional `DISCORD_TOKEN_PATH` write,
   `heartbeat.mjs:93-94`). discord/voice runs aren't granted the mail CLI, so they need
   no file — the central strip is all they require.
4. `mail.mjs`: read the key **env-first-then-file** (verbatim shape of
   `discord-cli.mjs`'s `token()`), so a daemon's direct call uses the env and a spawned
   run uses the file without the key ever entering its environment.

Residual (unchanged, accepted): the run's unscoped native `Read` can still open the
`0600` file by exact path — identical to `gmail-token.json`/`discord-token.json`/
`data-keys.json`. The env-strip closes the *echo-via-command / shell-interpolation*
paths, not direct file access.

### New-mail detection (`list-new`)

AgentMail's `labels` list-filter is **inclusive only** (no "not this label"), and
processed mail accumulates in a long-lived bot inbox, so a naive list-all-then-exclude
grows unbounded over the inbox's lifetime. We bound it with a **conservative timestamp
cursor** whose invariant is the correctness crux:

> **The cursor never advances past a message that has not yet been handled.**

Design:

- Persist the cursor on the config volume (`~/.mail-agent/mail-poll-cursor.json`).
  Each `list-new`: `messages.list({ after: cursor, ascending: true, limit })`, page
  through in ascending time order, and classify each message:
  - **excluded** — carries `agent-processed` (already handled), OR is own (carries
    `baxter-sent`, or `from` == `BAXTER_EMAIL`), OR off-allowlist
    (`extractEmailAddress(from)` ∉ `ALLOWED_SENDERS`, exact/lowercased);
  - **survivor** — everything else. Fail **closed**: empty `ALLOWED_SENDERS` ⇒ every
    message is off-allowlist ⇒ print `[]`.
  Emit each survivor as `{ id: messageId, threadId }`.
- **Cursor advance rule:** compute the boundary — the **oldest survivor's**
  `timestamp` if any, else the max listed `timestamp` (everything seen is excluded —
  safe to skip) — and store `boundary − one safety margin` (see Risk #5). **An empty
  listing leaves the cursor unchanged** — nothing new was seen, so there is nothing to
  advance past (and `max` of an empty set is undefined; a naive `Math.max(...[])` would
  yield `−Infinity` and destroy the cursor on every idle poll). The margin is
  **unconditional** (both non-empty branches): the next `messages.list({ after })` then
  re-includes the boundary message itself regardless of whether `after` is inclusive or
  strictly-exclusive. Re-listing the already-seen messages within one margin of the
  boundary is free — the `agent-processed` label and the own/off-allowlist exclusion
  filters drop them again — whereas an exclusive `after` stored *at* the boundary would
  skip the very oldest unhandled survivor, a silent drop. This is what makes deferral
  safe: a survivor left unhandled this cycle — because `poll.mjs` hit
  `MAX_EMAILS_PER_CYCLE` (`poll.mjs:184`) or the daily send cap (`poll.mjs:220`), or a
  crash landed between `list-new` and `labelAll` — is still at or after the cursor next
  cycle, so it is re-listed and eventually handled. Once `poll.mjs` labels a handled
  **or skipped** thread `agent-processed`, those messages become *excluded*, so the
  oldest-survivor boundary moves forward and the cursor with it — off-allowlist/own
  mail therefore can't pin the cursor forever either (it's excluded, not a survivor,
  and any such message older than the oldest survivor falls behind the boundary).
- **The `agent-processed` label is the correctness/idempotency source of truth**
  (crash-safe, race-safe, exactly-once); the cursor is only an efficiency bound on how
  far back each listing reaches. Because it only ever *widens* what a listing re-scans
  (never narrows it past an unhandled survivor), the cursor only has to be
  *conservative* — which the unconditional `boundary − margin` above guarantees under
  either `after` semantics, at the cost of re-listing the already-seen messages within
  one margin of the boundary each cycle (typically one; the label and the own/
  off-allowlist exclusion filters drop them again).

`poll.mjs`'s independent `thread.isAllowedSender` re-check (post-parse, exact address)
stays as the real security boundary — `list-new`'s allowlist filter is a cheap
prefilter, exactly as the Gmail query was.

### Own-message detection (redaction exemption)

`formatThreadMessage` redacts any thread participant not on the allowlist, but
**exempts the agent's own past replies**. Gmail used its unforgeable `SENT` label
(inbound mail can't cause it to be applied). AgentMail exposes no such directional
field, so we create the equivalent: **every `reply`/`send` applies a `baxter-sent`
label**, and a message counts as "own" **only if it carries that label** — never by
`From` alone (spoofable). An inbound attacker cannot cause our label to be applied to
their message (labels are inbox-side metadata set via our API key, not message
content), so this reproduces the SENT-label trust property. `from == BAXTER_EMAIL`
is used only as an *additional* exclusion in `list-new`, never as the redaction-
exemption signal.

> Open question for the reviewer: if AgentMail applies an unforgeable system `sent`
> label (or authenticated-sender flag) we can rely on that instead of a self-applied
> label. Default to the self-applied `baxter-sent` label since it is provably under
> our control; confirm system-label semantics at implementation before choosing.

### Sanitization pipeline: transport-agnostic refactor

The pipeline is the most-reviewed code in the repo (13 fix commits) and must not
change behavior. Today `formatThreadMessage(msg, isTrigger)` takes a **Gmail** message
(`msg.payload.headers`, `extractPlainText(payload)`, `isAllowedThreadParticipant(msg)`
via `SENT`). We refactor it to take a **normalized** message:

```
{ from, date, subject, text, isOwn, isAllowed }   // all strings + two booleans
```

- The neutralization/redaction/marker/seam logic inside `formatThreadMessage` is
  **unchanged** — it already operates on composed strings.
- **`formatThreadMessage` normalizes all four text fields itself.** It already runs
  `normalizeTranscriptText` on `from`/`date`/`subject` (gmail.mjs:367-369); we extend
  that to `text`. This is load-bearing, not cosmetic: today the body is normalized
  *upstream* in `extractPlainText` (gmail.mjs:144-149), and that upstream step
  disappears with the Gmail payload parser. AgentMail's `text` routinely carries CRLF,
  and `neutralizeStructuralMarkers` matches literal `\n` only — so an un-normalized
  body `\r\n\r\n---\r\n\r\n` (or a U+2028 line-break-alike) would forge a boundary.
  Normalizing inside `formatThreadMessage` keeps sanitization self-contained
  regardless of adapter discipline (defense in depth).
- Provider-specific extraction (`from`/`date`/`subject`/`text`, `isOwn` via
  `baxter-sent`, `isAllowed` via allowlist) moves into the `mail.mjs` adapter, which
  builds the normalized object.
- The pure functions move to a provider-neutral module **`transcript.mjs`**
  (`normalizeTranscriptText`, `neutralizeStructuralMarkers`,
  `neutralizeDanglingSeparatorTail`, `formatThreadMessage`, `makePlaceholder`,
  `extractEmailAddress`, `TRIGGER_MARKER`, `MESSAGE_SEPARATOR`). The four current
  importers of the two sanitizers (`runtime.mjs`, `discord-bot.mjs`, `poll.mjs`,
  `gmail.test.mjs`) repoint to `transcript.mjs`. `mail.mjs` imports from it too.

This is a near-mechanical move plus a parameter-shape change (the one behavioral
addition — `formatThreadMessage` normalizing `text` itself — is called out above), and
it makes `formatThreadMessage` directly testable with crafted inputs, closing the
thin-spot the tests doc calls out.

### Sending & threading

- `reply <messageId>`: `assertUnderSendCap()` → read stdin body → `recordSend()` →
  `client.inboxes.messages.reply(inboxId, messageId, { text: body, labels:
  ["baxter-sent"] })`. Threading handled by AgentMail. Print `{ sent: true, threadId }`.
- `send <subject>`: recipient **hardcoded to `OPERATOR_EMAIL`** (unchanged security
  property — no `to` argument surface for a prompt-injected run) →
  `messages.send(inboxId, { to, subject, text: body, labels: ["baxter-sent"] })`.
- `recordSend()` is called **before** the network call (over-counting a flood guard is
  the safe direction — unchanged from today).

### Setup flow

- Remove `make auth` + `authorize.mjs`. Add **`make inbox`**: with `AGENTMAIL_API_KEY`
  set, create-or-show Baxter's inbox (`inboxes.create({ clientId: "baxter" })`,
  idempotent on the stable `clientId`) and print its address to put in `BAXTER_EMAIL`.
- Remove the reauth reminder entirely: `REAUTH_REMINDER_PATH`,
  `maybeSendReauthReminder`, `REAUTH_REMINDER_AFTER_MS`, `TOKEN_PATH`. No token
  expiry means nothing to remind about.
- Drop `google-auth-library` from `app/package.json`; add `agentmail`.

### Naming (proposed; the one reversible/cosmetic decision)

Rename to shed the misleading `gmail` identifiers, since the file no longer touches
Gmail: `gmail.mjs` → **`mail.mjs`**; `grants.mjs` `GMAIL_CLI` → `MAIL_CLI`; prompt
placeholders `{{GMAIL_CLI_PATH}}` → `{{MAIL_CLI_PATH}}`, `{{GMAIL_USER_EMAIL}}` →
`{{BAXTER_EMAIL}}`; env `GMAIL_USER_EMAIL` → `BAXTER_EMAIL`; compose `gmail` profile →
`mail`; Makefile `run-gmail`/`gmail` → `run-mail`/`mail`. Mostly mechanical but broad
(touches Makefile, compose.yaml, README, both CLAUDE.md, deploy/). **If the operator
prefers minimal churn, we keep the `gmail.*` names and only swap internals** — call
it in review.

One rename site is **not** cosmetic: `harnesses/runner-common.mjs`'s `isDeliveryCall`
matches the CLI *basename* (`"gmail"`, derived from the granted script via
`parseAllowedTools`), so renaming the file silently breaks reply-delivery detection on
the openrouter/local harnesses (risking a give-up poke against an already-sent reply →
double-send) unless that check and its `runner-common.test.mjs` cases move to `"mail"`
in lockstep. This coupling is *why* the basename matters even if we keep the `gmail.*`
file name.

## File-by-file changes (implementation phase)

New:
- `app/scripts/mail.mjs` — the AgentMail CLI (replaces `gmail.mjs`).
- `app/scripts/transcript.mjs` — the extracted provider-neutral sanitizers.
- `app/scripts/transcript.test.mjs` — sanitizer + `formatThreadMessage` tests.
- `app/scripts/mail.test.mjs` — adapter/mapping tests (injected fake client).
- `docs/superpowers/specs/2026-07-22-agentmail-migration-design.md` — this spec.

Modified:
- `paths.mjs` — add `AGENTMAIL_KEY_PATH` + `MAIL_POLL_CURSOR_PATH`; remove
  `TOKEN_PATH`/`REAUTH_REMINDER_PATH`.
- `runtime.mjs` — `runAgent()` strips `AGENTMAIL_API_KEY` + `DISCORD_BOT_TOKEN` from
  the child env (central chokepoint; preserves `OPENROUTER_API_KEY`/`OPENAI_API_KEY`);
  repoint sanitizer imports to `transcript.mjs`.
- `poll.mjs` — import from `mail.mjs`/`transcript.mjs`; write the 0600 key file at
  `main()`; drop the reauth reminder; rename prompt slots.
- `heartbeat.mjs` — write the 0600 `AGENTMAIL_KEY_PATH` at `main()` (mirrors its
  Discord-token bootstrap, `heartbeat.mjs:93-94`); `GMAIL_CLI as GMAIL_CLI_PATH` →
  `MAIL_CLI as MAIL_CLI_PATH`.
- `grants.mjs` — `GMAIL_CLI`→`MAIL_CLI`, allow-rule `Bash(node ${MAIL_CLI} *)`.
- `harnesses/runner-common.mjs` — `isDeliveryCall`'s `params.cli === "gmail"` →
  `"mail"` and the `node <…gmail>` preamble text (runner-common.mjs:327). The one
  **functionally-coupled** rename site (see Naming).
- `harnesses/openrouter-tools.mjs`, `discord-bot.mjs` — `gmail.mjs` path token → 
  `mail.mjs`; `discord-bot.mjs` also repoints its sanitizer imports to `transcript.mjs`.
- `prompt.md` / `heartbeat-prompt.md` — placeholder renames.
- `.env.example` — replace the OAuth block with `AGENTMAIL_API_KEY` + `BAXTER_EMAIL`;
  keep `OPERATOR_EMAIL`/`ALLOWED_SENDERS`/caps.
- `Makefile` — `auth`→`inbox`; `run-gmail`/`gmail`/`stop`/`logs` profile rename.
- `compose.yaml` — `gmail` profile → `mail`; env stays via `env_file`.
- Tests: `grants.test.mjs`, `harnesses/openrouter-tools.test.mjs`,
  `harnesses/runner-common.test.mjs` (the `d("gmail", …)` delivery cases) — flip
  `gmail`→`mail` in the implementation phase (kept green on `main`-shaped code until
  then).
- `README.md`, root + `app/CLAUDE.md`, `deploy/` — swap the Gmail/OAuth/`make auth`
  narrative for AgentMail/API-key/`make inbox`; drop the 7-day-token language.

Removed:
- `app/scripts/authorize.mjs`; `google-auth-library` dependency; `make auth`.

## TDD test plan (written and reviewed **before** implementation)

`transcript.test.mjs`:
- Carries over the 3 existing sanitizer tests (import from `transcript.mjs`).
- `formatThreadMessage`, normalized input:
  - non-allowed participant (`isAllowed:false`) ⇒ From/Date/Subject/body all redacted.
  - own message (`isOwn:true`) ⇒ **not** redacted even if `isAllowed` is false.
  - trigger (`isTrigger:true`) ⇒ real `TRIGGER_MARKER` present exactly once; a body
    literally containing the marker text is neutralized.
  - seam forgery: body ending `"\n\n---"` does not yield a live `MESSAGE_SEPARATOR`
    after the trigger placeholder/marker substitution (`neutralizeDanglingSeparatorTail`).
  - overlapping-separator fixed-point (`"\n\n---\n\n---\n\n"`).
  - **un-normalized input**: a body arriving with `\r\n\r\n---\r\n\r\n` or a U+2028
    separator (i.e. the adapter did *not* pre-normalize) is still neutralized, because
    `formatThreadMessage` normalizes `text` itself — the regression Finding 4 guards.

`mail.test.mjs` (pure logic via an injected fake `AgentMailClient`; no network):
- `listNew`: empty `ALLOWED_SENDERS` ⇒ `[]`; excludes `agent-processed`; excludes own
  by `baxter-sent` label **and** by `from`; excludes off-allowlist; emits `{id,
  threadId}` for survivors; **stores the cursor one safety margin below the oldest
  survivor** (or below max-listed when there are no survivors); an **empty listing
  leaves the cursor unchanged** (no `−Infinity` from `max([])`).
- **cursor deferral (F1, exclusive-`after` worst case):** pin the fake client to
  **strictly-exclusive** `after` and assert the oldest survivor left unhandled this
  cycle (simulate the cap) is **re-listed** the following cycle — the margin is what
  stops an exclusive `after` at the boundary from skipping it. Also assert an
  off-allowlist/own message more than a margin older than the oldest survivor falls
  behind the cursor (isn't re-listed forever).
- `getThread`: picks the newest **candidate** (by `timestamp`) among passed ids, never
  a non-candidate; sets `isAutomated` from `Auto-Submitted`/`Precedence`; sets
  `isAllowedSender` from the exact parsed address; a `baxter-sent` message is exempt
  from redaction while a spoofed `From: BAXTER_EMAIL` **without** the label is redacted.
- credential loader: env present ⇒ uses env; env absent ⇒ reads the 0600 file; neither
  ⇒ throws (mirrors `discord-cli` `token()`).
- `reply`/`send`: call `recordSend()` before the client call; `send` ignores any
  recipient input and targets `OPERATOR_EMAIL`; both attach the `baxter-sent` label.

`runtime.test.mjs` (credential strip — Finding 2): a new case asserts the env
`runAgent()` hands the spawn has `AGENTMAIL_API_KEY` and `DISCORD_BOT_TOKEN` **deleted**
while `OPENROUTER_API_KEY`/`OPENAI_API_KEY` **survive** (inject a fake harness and
capture the env it receives).

Existing suite: `grants.test.mjs`, `harnesses/openrouter-tools.test.mjs`, and
`harnesses/runner-common.test.mjs` expectations flip from `gmail`→`mail` **in the
implementation phase** (so `node --test` stays green on `main`-shaped code until then).
The two new test files are the TDD red state until `mail.mjs`/`transcript.mjs` exist.

## Verification (implementation phase)

- `node --test` from `app/` (auto-discovers `harnesses/`), all green.
- Manual pipeline check per `app/CLAUDE.md`: build the image, exec a script that
  imports the **real** `transcript.mjs`/`mail.mjs` from the built image (not a
  reimplementation), run crafted attack strings **and** real thread data through it.
- Live smoke: `make inbox` → set `BAXTER_EMAIL` → `make mail` (foreground poller) →
  send a test mail from an allowlisted address → confirm one run, one in-thread reply,
  the trigger correctly marked, off-allowlist CC redacted, and the send cap increments.
- Confirm **both** a `poll.mjs`-spawned run **and** a `heartbeat.mjs`-fired run have
  **no** `AGENTMAIL_API_KEY`/`DISCORD_BOT_TOKEN` in their env (grep the run env dump),
  yet `mail.mjs` still works inside each (reads the 0600 file). Then verify a bare
  `make run` (default fleet, no poller) still lets a heartbeat mail-delivery task send
  — i.e. `heartbeat.mjs` wrote the key file even though `poll.mjs` never ran.

## Risks / open questions

1. **Thread bodies**: whether `threads.get` returns full per-message `text` or only
   metadata/preview. If preview-only, `getThread` does one `messages.get` per message
   (N calls/thread; fine for short threads). Confirm at implementation.
2. **System sent/authenticated labels** (see the own-message open question) — pick the
   self-applied label unless a stronger unforgeable system signal is confirmed.
3. **SDK on arm64 image**: confirm `agentmail` installs/runs cleanly under the Colima
   arm64 build; fall back to raw `fetch` (host-locked to `api.agentmail.to`, Bearer
   key) if not — the CLI boundary is identical either way.
4. **Deliverability from `@agentmail.to`**: replies to real people should authenticate
   (AgentMail-managed SPF/DKIM); watch spam placement in the live smoke, and consider
   a custom domain later.
5. **Cursor `after` semantics + timestamp resolution**: `list({ after })` may be
   inclusive or strictly-exclusive (unverified), and `timestamp` has finite resolution
   (a later message can share a tick with the boundary). The cursor-advance rule
   defends against both by storing `boundary − one safety margin` (≥ the timestamp
   resolution — confirm the units, seconds vs. ms, at implementation), so the boundary
   message **and** same-tick arrivals are always re-listed and the `agent-processed`
   label dedupes the overlap. The one residual assumption is that receipt `timestamp`
   is monotonic in arrival order for messages landing *more than* a margin apart —
   which server-assigned receipt time should satisfy.

## Rollback

The change is isolated to the mail surface on a feature branch. Discord/heartbeat/
codapi are untouched except the sanitizer import repoint (pure move). Reverting the
branch restores the Gmail path; the config volume's Gmail token is left intact during
the transition.
