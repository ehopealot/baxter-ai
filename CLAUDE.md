# Repo overview

This repo is **Baxter Burgundy** — a standing agent ("Baxter") that lives in Discord (and, opt-in, polls a dedicated Gmail inbox), replies, browses the web, runs code in a sandbox, and acts on a schedule. The agent's source lives in **`app/`**; the repo root holds its orchestration (`Makefile`, `compose.yaml`) and two optional developer conveniences:

- **`app/`** — the actual agent. **Read `app/CLAUDE.md` for its architecture, security model, and known gotchas before touching anything in there.**
- **`.devcontainer/`** — an optional Claude Code dev container (`make build-dev` builds it, `make dev` drops you into a shell with `claude`/`docker`/`make`, driving the host Docker daemon). You don't need it to run the agent.
- **`tools/claude-review/`** — an optional post-commit review hook (fires a `claude -p` review of each commit into `.claude/reviews/`). See its README for the one-time per-clone setup.

All commands run from the repo root via the `Makefile`:

| Command | Does |
|---|---|
| `make build-app` | Build the `app/` image |
| `make run` | Build the images, then start the **default fleet** detached via docker compose — Discord gateway + heartbeat scheduler + codapi sandbox, each with a restart policy. The Gmail poller is **opt-in** (see below) and NOT started |
| `make run-gmail` | Same as `make run` **plus** the experimental Gmail poller (`$(PROJECT)-run`, gated behind compose's `gmail` profile) |
| `make stop` | `docker compose --profile gmail down` the fleet — graceful stop incl. the opt-in poller (config volume + network left intact); also mops up any pre-compose containers of the same name |
| `make logs` | Follow logs from the fleet, incl. the poller when it's up (`$(COMPOSE) --profile gmail logs -f`; a bare `docker compose logs` is rejected by compose.yaml's `${PROJECT:?}` guards) |
| `make gmail` | Build + run **just** the Gmail poller (`poll.mjs`) in the foreground |
| `make discord` | Build + run **just** the Discord gateway in the foreground |
| `make codapi` / `make heartbeat` | Build + start just that one service via compose |
| `make auth` | One-time (weekly) interactive Gmail OAuth bootstrap (publishes port 8080) — only for the experimental Gmail surface |
| `make app-shell` | Shell into the `app/` image for debugging |

**Discord is the default surface; the Gmail poller is opt-in.** The `run` compose service (`poll.mjs`) carries `profiles: ["gmail"]`, so a plain `docker compose up` (`make run`) skips it and only `make run-gmail` (`--profile gmail`) starts it. Gmail is experimental — the Google Cloud OAuth setup plus a 7-day refresh token that must be renewed by hand (`make auth`) make it higher-maintenance than Discord. See `README.md`.

The detached fleet is **docker-compose-managed** (`compose.yaml` at the repo root). The Makefile builds the images (the arch-specific codapi binary can't be expressed as a compose `build.arg`) and owns the two durable resources — the `$(PROJECT)-net` network and the `$(PROJECT)-app-config` volume, both declared `external` so `down` never removes them; compose only runs the containers. **First switch to compose:** if you have hand-started containers from before this (named `<project>-run`/`-discord`/`-heartbeat`/`-codapi-svc`), run `make stop` once before the first `make run` — compose won't adopt a same-named foreign container, and `make stop`'s `docker rm -f` clears them.

Docker access from inside the dev container is via a host-socket mount (Docker-outside-of-Docker); the Makefile auto-detects Colima vs Docker Desktop vs native Linux for the socket path/GID. If `make dev` was started before Docker/Colima was ready, `docker` commands inside it will fail with a permission error — exit and re-run `make dev`. (`docker compose` needs the v2 CLI plugin — standard with Docker Desktop / Colima on the host.)
