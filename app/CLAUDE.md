# The mail agent ("Baxter Burgundy")

A daemon (`scripts/poll.mjs`) polls a dedicated Gmail inbox every `POLL_INTERVAL_SECONDS`. For each new, allowlisted, non-automated thread, it spawns one scoped `claude -p` run (the persona "Baxter Burgundy") with a rendered prompt containing the full thread transcript. That run can reply in-thread, browse the web via the Playwright CLI skill (persistent browser profile → logins/cookies carry over between emails), and read/write a small cross-thread memory file. Configured via `app/.env` (copy from `app/.env.example` — every var is commented there).

Run it via the root `Makefile`: `make run` (foreground), `make auth` (one-time OAuth), `make app-shell` (debug shell). See root `CLAUDE.md` for those.

## File map

- **`scripts/poll.mjs`** — the daemon loop. Groups new messages by thread, dispatches at most one `claude -p` run per thread per cycle, enforces `MAX_EMAILS_PER_CYCLE`/`MAX_SENDS_PER_DAY`, sends a reauth reminder to `OPERATOR_EMAIL` once the OAuth token nears its 7-day expiry (see Auth below).
- **`scripts/gmail.mjs`** — the only file that touches the OAuth token. CLI wrapper around the Gmail REST API (`list-new`, `get-thread`, `reply`, `send`, `label`), invoked as a subprocess by both `poll.mjs` and the spawned `claude -p` run's `Bash` tool. Also exports `normalizeLineTerminators`/`neutralizeStructuralMarkers` as a plain module for `poll.mjs` to reuse — the bottom CLI-dispatch block is guarded with an `import.meta.url`/`pathToFileURL` check so importing those doesn't also trigger the CLI dispatch against the importer's own `argv`.
- **`scripts/paths.mjs`** — all persistent state paths (`~/.mail-agent/...`, i.e. the config Docker volume), centralized so they can't drift. Includes `MEMORY_PATH`, deliberately isolated in its own `memory-workspace/` subdirectory — see Sandbox below.
- **`scripts/send-state.mjs`** — the daily send-cap counter (`MAX_SENDS_PER_DAY`), incremented by `gmail.mjs` at the actual Gmail send call (not by `poll.mjs` at dispatch time — a run can send more than one email).
- **`scripts/authorize.mjs`** — one-time interactive OAuth bootstrap (`make auth`).
- **`prompt.md`** — the template rendered per thread. Uses `{{FROM}}`/`{{SUBJECT}}`/`{{BODY}}`/`{{MESSAGE_ID}}`/`{{MEMORY_PATH}}`/`{{GMAIL_CLI_PATH}}`/`{{PERSONA_NAME}}`/`{{GMAIL_USER_EMAIL}}` placeholders.

## Auth

OAuth2 via `google-auth-library`, scopes `gmail.modify` + `gmail.send`. Google classifies these as restricted/sensitive, so getting the consent screen out of **Testing** mode requires a paid third-party CASA audit — not worth it for a personal tool. The practical consequence: **the refresh token expires after 7 days**, unconditionally, while in Testing mode. `poll.mjs` emails `OPERATOR_EMAIL` a reminder at day 6; re-run `make auth` when you get it. Both the dedicated account and your own operator address must be added as **test users** on the OAuth consent screen, or the flow will reject them.

## Sandbox constraint (important if you touch `poll.mjs`'s claude spawn)

The spawned `claude -p` run's own filesystem sandbox restricts `Write`/`Edit` to its **working directory**, regardless of what `--allowedTools` grants — confirmed by testing, not documented. `/app` isn't persistent storage anyway (only `/home/node`, the config volume, survives container restarts), so the run's `cwd` is set to `MEMORY_PATH`'s own directory (`~/.mail-agent/memory-workspace/`, containing nothing but `memory.md`) rather than `APP_DIR`. Consequences:
- `gmail.mjs` is invoked by **absolute path** in the run's `Bash` tool (`GMAIL_CLI_PATH`), since the relative form only resolves from `APP_DIR`.
- Also confirmed by testing: path-scoped `Write(<path>)`/`Edit(<path>)` `--allowedTools` rules do **not** get approved headlessly in this Claude Code CLI version — only bare, unscoped `Write`/`Edit` do. The isolated `cwd` (containing only `memory.md`) is what actually bounds the blast radius, not the permission rule.

## The transcript-forgery sanitization pipeline (`gmail.mjs`)

This is the most-reviewed, most-hardened part of the codebase — a long chain of consecutive automated-review rounds (13 fix commits) found and fixed real bugs here (commits from `aad325e` through `b059964`; `git log --oneline aad325e..b059964` for the full story if you need the reasoning behind a specific piece). Read this before changing any of `TRIGGER_MARKER`, `MESSAGE_SEPARATOR`, `neutralizeStructuralMarkers`, `neutralizeDanglingSeparatorTail`, `normalizeLineTerminators`, or `formatThreadMessage`.

**The problem:** the model needs the full thread transcript (not just the triggering message) for context, but it also needs to know unambiguously which message to actually respond to — and message content is otherwise attacker-influenced (anyone who threads themselves into an allowed conversation). Positional framing ("respond to the last message") turned out to be unreliable — the trigger is chosen from `list-new`'s candidates by `internalDate`, not by transcript position, so a chronologically-later message (e.g. the agent's own prior reply) can legitimately follow the real trigger in the transcript.

**The design that emerged:**
- Every message in the transcript is explicitly formatted; the actual trigger gets a literal `[^ RESPOND TO THIS MESSAGE]` marker appended (not positional inference).
- Content from senders not on `ALLOWED_SENDERS` (checked per-message, not per-thread) is fully redacted — From/Date/Subject/body all replaced with `[redacted]`/`[content omitted]`, not just the body.
- The agent's own past replies are exempted from redaction via Gmail's `SENT` label (Gmail-assigned metadata an inbound message can't forge) — **not** via the `From` header (spoofable) or `Authentication-Results` (absent on the account's own sent mail, so that approach silently never fired — a real regression caught mid-session).
- Both the marker and the separator strings are neutralized wherever they appear in real message content (a fixed-point loop, since naive single-pass replacement can reconstruct an intact separator from overlapping occurrences).
- The neutralization runs on **fully composed** message blocks, not individual fields — a body that merely starts with `---\n\n` or ends with `\n\n---` contains no complete separator on its own but combines with the template's own literal `\n\n` (or the *next* block's real separator, inserted afterward by the join) to forge one. Composition-seam bugs like this were the largest single source of review findings.
- The trigger marker itself is protected by a **random UUID placeholder** during sanitization (not a fixed string — fixed placeholders are embeddable by attacker/forwarded content) and substituted for the real marker only after sanitization completes.
- Line-terminator normalization (`normalizeLineTerminators`) folds `\r\n`/`\r`/Unicode line-break-alike characters (`LINE_SEPARATOR`/`PARAGRAPH_SEPARATOR`/`NEXT_LINE`, i.e. U+2028/U+2029/U+0085) to `\n` before any of the above runs — every sanitizer matches literal `\n` only, and the model reading the transcript isn't a byte-exact splitter, so any character that visually reads as a line break is an equally valid forgery vector.
- **Two sinks, not one**: `thread.body` (fully sanitized inside `gmail.mjs`) and the top-level `thread.from`/`thread.subject` JSON fields (deliberately left raw in `gmail.mjs`, since `poll.mjs` needs the real `from` for its own allowlist re-check) both eventually reach the prompt. `poll.mjs`'s `renderPrompt` sanitizes `{{FROM}}`/`{{SUBJECT}}` itself, at the point of interpolation — this was the last bug found in the chain, and it's an easy one to reintroduce if a new prompt placeholder gets added without checking whether it needs the same treatment.

**If you add a new field to the prompt template or the transcript**, ask: is this attacker-influenced text? If yes, does it need `normalizeLineTerminators` + `neutralizeStructuralMarkers` before interpolation, and could it combine with adjacent template text or a subsequent join to form a partial/seam forgery?

## No test suite (yet)

There is no formal test file — every fix above was verified with an ad-hoc `node -e '...'` script run inside the built container, re-implementing the relevant function(s) inline and checking specific attack strings. The automated code-reviewer has twice flagged this as a real gap given how many regressions have hit this one area. If you're touching the sanitization pipeline, either write a real test file (`node:test`, no extra dependency needed — would require adding `export` to more of `gmail.mjs`'s internals) or at minimum replicate the verification pattern: build the image, exec a script that imports the real functions from the built `gmail.mjs`/`poll.mjs` (not a hand-copied reimplementation — that's how a bug in the reimplementation itself slipped through once), test against both crafted attack strings and real production thread data, then run `poll.mjs` live for a few cycles before calling it done.

## A sharp edge: typing Unicode escape sequences

Twice in this project's history, typing an exotic Unicode character (or its `\uXXXX` escape sequence) directly into a source-file edit got silently corrupted somewhere in the tool-call transport — once collapsing NUL bytes to invisible spaces (both `Read` and the automated reviewer's own tooling rendered them as blank, masking a real bug for several review rounds), once expanding a typed ` ` escape sequence into the actual raw character, which then broke the JS parser (U+2028/U+2029 are themselves lexical line terminators, so a literal one inside a regex literal terminates it early). **If you need an exotic/control Unicode codepoint in source, use `String.fromCodePoint(0x...)` — plain ASCII digits, no risk.** Verify with `node -e 'for (const ch of require("fs").readFileSync(path,"utf8")) if (ch.codePointAt(0) > 127) console.log(ch.codePointAt(0).toString(16))'` after any edit that should be pure ASCII.

## Guardrail philosophy

Deliberately minimal by design, not an oversight: the container's only credential is the dedicated Gmail account (no payment info, no other linked accounts), so the persona is free to browse/register accounts/reply without a permission blocklist. The real safety nets are operational and enforced in plain code (not prompt instructions a run could talk itself out of): the sender allowlist (fails closed), the daily send cap, loop-prevention (never processes its own sent mail), and the per-cycle email cap. The extensive sanitization work above exists because thread *content* (not the ability to act) turned out to be the actual attack surface once cross-message context was added.
