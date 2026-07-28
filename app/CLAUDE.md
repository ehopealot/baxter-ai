# The mail agent ("Baxter")

Baxter is a standing agent (persona "Baxter") that lives across several surfaces sharing one image, one config volume, and one `MEMORY_DIR`: a mail poller, a Discord gateway, a heartbeat scheduler, an interactive terminal (TUI), an opt-in voice bot, and an offline code-execution sandbox. Each spawns a scoped run through `runtime.ts`'s `runAgent`, which can reply, research the web, browse via two Playwright CLIs, run code, and read/write memory/project notes. Configured via `app/.env` (copy from `app/.env.example` — every var is commented there). **Run commands live in the root `CLAUDE.md`'s `make`/`Makefile` table — not duplicated here** (the fleet is docker-compose-managed; Discord is the default surface, the mail poller is opt-in via `make run-mail`).

This file is a **map**. Each subsystem's full essay is co-located with its code under `docs/architecture/` (and the harness layer under `scripts/harnesses/CLAUDE.md`); the security model is split across `security.md`, `transcript.md`, and the per-surface docs — read the relevant topic file before touching that subsystem.

## Architecture map

- **Mail poller** (`scripts/poll.ts`) — polls the AgentMail inbox, spawns one scoped run per new allowlisted thread. See [mail](docs/architecture/mail.md).
- **Discord gateway** (`scripts/discord-bot.ts`) — the second surface: response gate, reaction wake, per-channel dispatchers, run budgets. See [discord](docs/architecture/discord.md).
- **Harness layer** (`scripts/harnesses/`) — the harness-agnostic `runAgent` driver, the `claude` adapter vs the structured-tool harnesses (openrouter/openai/custom), context-blowout guards, model escalation, multimodal routing. See [harnesses](scripts/harnesses/CLAUDE.md).
- **Heartbeat scheduler** (`scripts/heartbeat.ts`) — fires due tasks on a schedule; `schedule-cli` + the shared `grants.ts` tool/skill model. See [heartbeat](docs/architecture/heartbeat.md).
- **Interactive terminal / TUI** (`scripts/tui.ts`) — the operator's console (`baxter shell`); chat vs `/slash` trust tiers. See [tui](docs/architecture/tui.md).
- **Voice bot** (`scripts/voice-bot.ts`) — the opt-in Discord voice surface (voice-dispatch reuses `DISCORD_TOOLS`). Design: `docs/superpowers/specs/2026-07-18-discord-voice-fast-baxter-design.md`, `docs/superpowers/specs/2026-07-19-voice-muzak-design.md`.
- **Code execution (codapi)** (`scripts/code-cli.ts`) — offline Python/Node sandbox. See [codapi](docs/architecture/codapi.md).
- **Two browsers** (`playwright-cli` + `scripts/invisible_cli.py`) — the default Chromium browser + the anti-detect Firefox, plus skill staging / learned skills. See [browsers](docs/architecture/browsers.md).
- **Tool CLIs** (`files-cli`/`projects-cli`/`data-cli`/`skills-cli`) — the run's workspace/data/discovery gateways. See [tool-clis](docs/architecture/tool-clis.md).
- **Transcript sanitizer** (`scripts/transcript.ts`) — the transcript-forgery sanitization pipeline shared by the mail and Discord surfaces. See [transcript](docs/architecture/transcript.md).
- **Security model** — Auth (credential boundary + harness-dependent read residual), the `claude`-spawn sandbox constraint, and the guardrail philosophy. See [security](docs/architecture/security.md).

## File map

The subsystem essays for the big files live in the topic docs above. Short, cross-cutting files:

- **`scripts/poll.ts`, `scripts/mail.ts`, `scripts/send-state.ts`, `scripts/make-inbox.ts`, `prompt.md`, `tui-prompt.md`** — the mail surface's daemon loop, AgentMail credential boundary, send-cap counter, inbox provisioning, and prompt templates; see [mail](docs/architecture/mail.md).
- **`scripts/transcript.ts`** — the shared transcript-forgery sanitization pipeline; see [transcript](docs/architecture/transcript.md).
- **`scripts/paths.ts`** — all persistent state paths (`~/.mail-agent/...`, i.e. the config Docker volume), centralized so they can't drift. Includes `AGENTMAIL_KEY_PATH` (the 0600 API key file) and `MAIL_POLL_CURSOR_PATH` (the poll cursor); `MEMORY_PATH` is deliberately isolated in its own `memory-workspace/` subdirectory — see [Sandbox](docs/architecture/security.md).
- **`scripts/invisible_cli.py`** — the stealth browser wrapper (installed on PATH as `invisible-cli`). See [Two browsers](docs/architecture/browsers.md).
- **`skills/invisible-playwright/`** — the skill documenting `invisible-cli`, dropped into the run's cwd by `poll.ts` so it's discoverable. See [Two browsers](docs/architecture/browsers.md).

## Tests

This is TypeScript, run directly by Node 22 — no build step. `make check` (from the repo root) runs `tsc --noEmit` (strict) then the test suite below; from `app/` the equivalent is `./node_modules/.bin/tsc --noEmit` + `node --test`.

There's a `node:test` suite (`scripts/*.test.ts` + `scripts/harnesses/*.test.ts`) — run it with **`node --test`** from `app/` (bare, so it auto-discovers the `harnesses/` subdir; a flat `scripts/*.test.ts` glob would miss it). The one Python module with logic worth pinning, `invisible_cli.py`, has a standalone assert-based test (no pytest): **`python3 scripts/invisible_cli_test.py`** from `app/` (covers the corrupt-`storage_state` self-heal helpers; the async browser paths are verified live). No extra dependency; `node:test` is built in. Coverage skews toward the pure, load-bearing logic: the message + reaction dispatchers and the `classifyMessage`/`shouldHandleReaction` gates plus the per-channel run budget (`discord-bot.test.ts`), `discord-cli`'s chunking/flag-parsing, the schedule store's queue + cron math, `send-state` (incl. a subprocess test that the record()-lock survives concurrent sends), the shared tool/skill grants (`grants.test.ts` — asserts the per-surface allow-list asymmetries and that `BAKED_SKILL_NAMES` stays the union of what the surfaces stage), `code-cli`, the harness adapter (`harnesses/claude.test.ts` + `runtime.test.ts`), and — the setup for the next paragraph — the transcript sanitizers + `formatThreadMessage` (`transcript.test.ts`), the AgentMail adapter's pure cores against an injected fake client (`mail.test.ts`), and the central credential strip both as a helper and as applied by `runAgent` (`run-env.test.ts` + a `runtime.test.ts` case).

**The sanitization pipeline is now directly unit-tested.** `transcript.test.ts` exercises `normalizeTranscriptText`/`neutralizeStructuralMarkers`/`formatThreadMessage` directly — redaction, the own-message exemption, the trigger marker's placement, the composition-seam and overlapping-separator forgeries, and un-normalized CRLF/U+2028 bodies. The AgentMail migration's refactor to a provider-neutral normalized `formatThreadMessage` is what made that possible (it no longer needs a live provider payload). It's no longer the thin spot it was, but it's still the highest-stakes code here: if you touch it, add real cases to `transcript.test.ts`, AND replicate the manual verification — build the image, exec a script that imports the real functions from the built `transcript.ts`/`mail.ts` (not a hand-copied reimplementation — that's how a bug in the reimplementation itself once slipped through), test against both crafted attack strings and real production thread data, then run `poll.ts` live for a few cycles before calling it done.

## Docs

Per-subsystem essays, co-located near their code:

- [`docs/architecture/mail.md`](docs/architecture/mail.md) — the mail agent + its File-map bullets.
- [`docs/architecture/discord.md`](docs/architecture/discord.md) — the Discord gateway surface.
- [`scripts/harnesses/CLAUDE.md`](scripts/harnesses/CLAUDE.md) — the harness layer (runAgent, adapters, context guards, escalation, multimodal).
- [`docs/architecture/codapi.md`](docs/architecture/codapi.md) — code execution (codapi).
- [`docs/architecture/browsers.md`](docs/architecture/browsers.md) — the two browsers + skill staging / learned skills.
- [`docs/architecture/tool-clis.md`](docs/architecture/tool-clis.md) — files-cli / projects-cli / data-cli / skills-cli.
- [`docs/architecture/heartbeat.md`](docs/architecture/heartbeat.md) — the heartbeat scheduler.
- [`docs/architecture/tui.md`](docs/architecture/tui.md) — the interactive terminal / TUI.
- [`docs/architecture/transcript.md`](docs/architecture/transcript.md) — the transcript-forgery sanitization pipeline.
- [`docs/architecture/security.md`](docs/architecture/security.md) — Auth, the sandbox constraint, and the guardrail philosophy.
- [`docs/architecture/gotchas.md`](docs/architecture/gotchas.md) — a sharp edge: typing Unicode escape sequences.

Deeper design docs live in `docs/superpowers/specs/` (repo root).
