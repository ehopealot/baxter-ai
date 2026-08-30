# Security: Auth, Sandbox, and Guardrail philosophy

(part of Baxter — see [architecture map](../../CLAUDE.md))

## Auth

The mail surface authenticates to **Resend** with a single **API key** (`RESEND_API_KEY`) — no OAuth, no consent screen, no token expiry, nothing to renew (the old Gmail path needed a Google Cloud OAuth client and a 7-day refresh token; all of that is gone). Run **`baxctl add/home`** once at setup: it derives the tenant address from the configured verified `RESEND_DOMAIN` and writes `BAXTER_EMAIL` to the tenant env.

The key is a full-authority credential, so it's kept out of the spawned run's environment. `mail-bot.ts`/`heartbeat.ts` write it to a 0600 file (`MAIL_KEYS_PATH`, `~/.mail-agent/mail-keys.json`) at startup, and `runtime.ts`'s `runAgent` — the single spawn path all daemons go through — strips `RESEND_API_KEY` (and `DISCORD_BOT_TOKEN`) from every run's env (`stripRunSecrets`). `mail-cli.ts` reads the key **env-first-then-file**, so a daemon's own call uses the env and a spawned run uses the file.

**Whether a spawned run can READ that 0600 file is harness-dependent, and the load-bearing control is cwd-confinement — NOT the env-strip.** The env-strip only prevents *accidental* leakage through command construction (echo/shell-interpolation); it does nothing against a deliberate two-step — `Read` the key file, then `mail reply`/`discord-cli send` the contents out. What actually stops that is whether the run has a read primitive that can reach the file at all:
- **openrouter/local (structured-tool) harnesses — NOT reachable (the deployed posture; verified).** `read_file`/`edit_file` and `files-cli` resolve every path under the run's cwd (`~/.mail-agent/memory-workspace/`) and refuse escapes; `code-cli` runs in the codapi sandbox with no host FS; `playwright-cli`/`invisible-cli` block the `file:` scheme (tested — `Access to "file:" protocol is blocked`). The key files live one level UP (`~/.mail-agent/`), so no read primitive reaches them — the run genuinely cannot read the key. Baxter runs here.
- **Claude harness — REACHABLE (a genuine residual, not just a shell-interp footnote).** Claude Code's native `Read`/`Grep` are NOT cwd-bounded (its sandbox confines `Write`/`Edit` — see "Sandbox constraint" below — but not reads), so a sufficiently-injected run CAN open the 0600 file by exact path and then exfil it via `mail reply` (in-thread to the **sender** — the attacker, on the email surface) or `discord-cli send` (to a channel). `mail send` can now reach any address in `ALLOWED_RECIPIENTS` (∪ `OPERATOR_EMAIL`), so it is a channel too — but a **bounded** one: those recipients are operator-configured from the environment and can't be added by a run, so the blast radius is the operator-trusted addresses, not an arbitrary attacker inbox. Practical consequence: on the claude harness, treat every address you put in `ALLOWED_RECIPIENTS` as a possible exfiltration destination for a fully-injected run, and keep the list to addresses you'd trust with the container's secrets. This residual is now **opt-in only**: `BAXTER_HARNESS` defaults to `openrouter` (the cwd-confined structured-tool posture — see `runtime.ts` `getHarness`), so the safe posture is what you get by omission, and this exposure exists ONLY if an operator explicitly sets `BAXTER_HARNESS=claude` while feeding it untrusted input. Deeper hardening if you ever want claude to be safe under untrusted input: drop the native `Read` grant on this harness (would require a cwd-confined full-read verb on `files-cli`, which today only does list/grep/search), or privilege-separate the key (own it as a different UID so same-UID access can't read it).

Full design: the AgentMail→Resend migration design — in the OUTER repo (baxter-control), not this one, at `docs/superpowers/specs/2026-08-06-agentmail-to-resend-design.md`; the earlier Gmail→AgentMail design (`docs/superpowers/specs/2026-07-22-agentmail-migration-design.md`) is superseded, kept only as history (its harness-reachability analysis predates Resend).

## Public calendar add-link capabilities

`calendar-cli get-add-to-calendar-link <uid>` creates two public URLs for an own event
used in an email or direct-SMS reply: one provider-bound Google redirect code and one
provider-bound device-ICS code. A URL is exactly `/a/<10-case-sensitive-base62-code>`, with
no tenant, provider, redirect, or query parameter. It is intentionally an unauthenticated
bearer capability: anyone who receives or forwards a code can use only its bound response
until its fixed 24-hour expiry. `FamilyHome` stores the immutable snapshot and private
provider binding; the global directory stores only code-to-tenant/expiry routing metadata.

The directory durably admits at most ten structurally-valid lookups in every rolling
1,000-ms interval **before** mapping lookup; an eleventh returns generic 429 with
`Retry-After: 1` rather than probing or forwarding. It returns generic 404 for malformed, unknown, expired, and
tenant-local-orphaned codes; it never falls back to a login page, uses no caller-supplied
destination or tenant identity, constructs a fresh header-stripped forwarded request, and
sends no-store/no-referrer headers. Issuance is protected by the tenant's existing SigV4
Home credential. The tenant DO serializes cross-DO issue/reuse and the directory atomically
reserves both codes; directory and tenant alarms clean their own expiry data. The previous
long-token URL contract is deliberately hard-cut over rather than migrated: old URLs 404 and
legacy records are deleted in bounded batches.

Application code must not log codes or event snapshots. Cloudflare invocation logs and
email/SMS forwarding can expose an active URL to operators/recipients; a 10-character base62
code has roughly 60 bits of bearer entropy, not the former 144 bits. The shared global
rate limit is also an accepted availability/DoS tradeoff: a scanner can consume capacity for
all tenants. The directory is a central routing dependency, and manually transcribed codes
are case-sensitive. These bounded 24-hour residuals are accepted for direct no-sign-in links
and must remain visible in review/deployment decisions. The authenticated Home calendar menu
is deliberately separate and continues to use its session-gated device download and direct
Google URL.

## Sandbox constraint (important if you touch `mail-bot.ts`'s claude spawn)

The spawned `claude -p` run's own filesystem sandbox restricts `Write`/`Edit` to its **working directory**, regardless of what `--allowedTools` grants — confirmed by testing, not documented. `/app` isn't persistent storage anyway (only `/home/node`, the config volume, survives container restarts), so the run's `cwd` is set to `MEMORY_PATH`'s own directory (`~/.mail-agent/memory-workspace/`) rather than `APP_DIR`. Consequences:
- `mail-cli.ts` is invoked by **absolute path** in the run's `Bash` tool (`MAIL_CLI_PATH`), since the relative form only resolves from `APP_DIR`.
- Also confirmed by testing: path-scoped `Write(<path>)`/`Edit(<path>)` `--allowedTools` rules do **not** get approved headlessly in this Claude Code CLI version — only bare, unscoped `Write`/`Edit` do. The isolated `cwd` is what actually bounds the blast radius, not the permission rule. It contains `memory.md` plus a `.playwright/` folder (`mail-bot.ts`'s `ensurePlaywrightConfig()` writes a `cli.config.json` there before each spawned run so bare `playwright-cli open` defaults to Chromium — see the [Playwright-browser note](browsers.md)). A run's unscoped `Write` can rewrite that config, including `browser.launchOptions.executablePath`/`args`, so treat it as a default the code sets, not a control the code enforces — consistent with this project's deliberately minimal, operational guardrails (see Guardrail philosophy below), but worth knowing before assuming the sandbox is a hard boundary on what `playwright-cli` can launch.

## Guardrail philosophy

Deliberately minimal by design, not an oversight: the container's only credentials are the Resend API key and the Discord bot token (no payment info, no other linked accounts), so the persona is free to browse/register accounts/reply without a permission blocklist. The real safety nets are operational and enforced in plain code (not prompt instructions a run could talk itself out of): the sender allowlist and the send-recipient allowlist (both fail closed, both env-sourced), the daily send cap, loop-prevention (never processes its own sent mail — identified by the unforgeable `baxter-sent` label, never the spoofable `From`), and the per-cycle email cap. The extensive sanitization work above exists because thread *content* (not the ability to act) turned out to be the actual attack surface once cross-message context was added.
