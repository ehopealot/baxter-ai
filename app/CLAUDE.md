# The mail agent ("Baxter")

Baxter is a standing agent (persona "Baxter") that lives across several surfaces sharing one image, one config volume, and one `MEMORY_DIR`: the Resend mail surface, Discord gateway, heartbeat scheduler, interactive terminal (TUI), opt-in voice bot, and offline code-execution sandbox. Each surface spawns scoped runs through `runtime.ts`'s `runAgent`. Configured via `app/.env` (copy from `app/.env.example` — every var is commented there). **Run commands live in the root `CLAUDE.md`'s `make`/`Makefile` table — not duplicated here.**

This file is a **map**. Each subsystem's full essay is co-located with its code under `docs/architecture/` (and the harness layer under `scripts/harnesses/CLAUDE.md`); read the relevant topic file before touching that subsystem.

## Architecture map

- **Resend mail surface** (`scripts/mail-bot.ts` + `scripts/mail-cli.ts`) — Resend webhook → Worker `/mail/inbound` (Svix verification) → Durable Object queue → a SigV4-authenticated container link. `mail-bot.ts` re-verifies and dispatches scoped runs; `mail-cli.ts` is the credential boundary for reply/send/calendar/attachment operations. See [mail](docs/architecture/mail.md).
- **Discord gateway** (`scripts/discord-bot.ts`) — response gate, reaction wake, per-channel dispatchers, and run budgets. See [discord](docs/architecture/discord.md).
- **Harness layer** (`scripts/harnesses/`) — the harness-agnostic `runAgent` driver and model adapters. See [harnesses](scripts/harnesses/CLAUDE.md).
- **Heartbeat scheduler** (`scripts/heartbeat.ts`) — fires due tasks on a schedule; `schedule-cli` + shared grants/skill model. See [heartbeat](docs/architecture/heartbeat.md).
- **Production drain** (`scripts/drain.ts` + `scripts/drain-control.ts`) — durable admission leases and SIGUSR1 intake closure. See [drain](docs/architecture/drain.md).
- **Interactive terminal / TUI** (`scripts/tui.ts`) — the operator's console (`baxter shell`). See [tui](docs/architecture/tui.md).
- **Voice bot** (`scripts/voice-bot.ts`) — opt-in Discord voice surface.
- **Family-home web surface** (`scripts/home-bot.ts`) — default-on light surface (absent `BAXTER_SURFACES` runs it; only `voice` remains opt-in) and checklist mirror. See [home](docs/architecture/home.md).
- **Code execution** (`scripts/code-cli.ts`) — offline Python/Node sandbox. See [codapi](docs/architecture/codapi.md).
- **Tool CLIs** (`files-cli`/`collections-cli`/`data-cli`/`skills-cli`) — workspace/data/discovery gateways. See [tool-clis](docs/architecture/tool-clis.md).
- **Transcript sanitizer** (`scripts/transcript.ts`) — shared mail/Discord transcript-forgery sanitization. See [transcript](docs/architecture/transcript.md).
- **Security model** — auth, credential boundaries, sandbox constraints, and guardrails. See [security](docs/architecture/security.md).

## File map

- **`scripts/mail-bot.ts`** — the Resend mail daemon. It holds the SigV4 `/mail-link` socket, receives queued webhook payloads, calls the Resend Chat SDK adapter's `handleWebhook`, and dispatches scoped runs.
- **`scripts/mail-cli.ts`** — the credential boundary and CLI for `reply`, `send`, `send-calendar`, and `get-attachment`; it enforces recipient/from/send-cap guards and uses Resend + the Chat SDK.
- **`scripts/mail-transcript.ts`** — durable transcript and thread Message-ID index used by the mail surface.
- **`scripts/paths.ts`** — persistent state paths, centralized so they cannot drift. Mail identity provisioning is done by `baxctl add`/`baxctl home`, which derives `BAXTER_EMAIL=<id>@<domain>`; there is no inbox-provisioning command.
- **`prompt.md`** — the mail eval template; production mail runs build their prompt in `mail-bot.ts`.

## Tests

This is TypeScript, run directly by Node 22 — no build step. Use global `tsc --noEmit -p tsconfig.json` where the platform-specific local TypeScript package is unavailable, then `node --test` from `app/`. The eval harness has additional offline tests under `evals/` and live model scenarios.

## Docs

Per-subsystem essays are co-located near their code, especially [mail](docs/architecture/mail.md), [Discord](docs/architecture/discord.md), [harnesses](scripts/harnesses/CLAUDE.md), [transcript](docs/architecture/transcript.md), and [security](docs/architecture/security.md).
