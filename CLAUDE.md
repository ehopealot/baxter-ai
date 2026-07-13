# Repo overview

This repo has two independent parts:

- **Root** (`Dockerfile`, `Makefile`, `scripts/claude-review/`) — a generic Claude Code dev sandbox with an automated post-commit review hook. `make build-dev` builds it, `make dev` drops you into it. Not related to the mail agent below except as the container this session runs in.
- **`app/`** — a standing Gmail-polling agent ("Baxter Burgundy") that reads mail from a dedicated inbox and can reply, browse the web, and register accounts on the persona's behalf. This is the actual project. **See `app/CLAUDE.md` for its architecture, security model, and known gotchas before touching anything in there.**

All `app/`-related commands run from the repo root via the shared `Makefile`:

| Command | Does |
|---|---|
| `make build-app` | Build the `app/` image |
| `make run` | Build + run the mail-agent daemon (`poll.mjs`) in the foreground |
| `make auth` | One-time interactive Gmail OAuth bootstrap (publishes port 8080) |
| `make app-shell` | Shell into the `app/` image for debugging |

Docker access from inside the dev container is via a host-socket mount (Docker-outside-of-Docker); the Makefile auto-detects Colima vs Docker Desktop vs native Linux for the socket path/GID. If `make dev` was started before Docker/Colima was ready, `docker` commands inside it will fail with a permission error — exit and re-run `make dev`.
