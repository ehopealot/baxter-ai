# Repo overview

This repo is **Baxter** — a standing agent that lives in Discord (and on a dedicated Resend mail surface), replies, browses the web, runs code in a sandbox, and acts on a schedule. The agent's source lives in **`app/`**; the repo root holds its orchestration (`Makefile`, `compose.yaml`), an optional operator CLI (`install.sh` + `bin/baxter`), and two optional developer conveniences:

`app/` is **TypeScript, run directly by Node 22 — no build step.** `make check` (from the repo root) type-checks it under strict (`tsc --noEmit`) and runs the test suite.

- **`app/`** — the actual agent. **Read `app/CLAUDE.md` for its architecture, security model, and known gotchas before touching anything in there.**
- **`.devcontainer/`** — an optional Claude Code dev container (`make build-dev` builds it and `make dev` opens a shell with `claude`/`make`). It has no host Docker socket.
- **`tools/claude-review/`** — an optional post-commit review hook (fires a `claude -p` review of each commit into `.claude/reviews/`). See its README for the one-time per-clone setup.

All commands run from the repo root via the `Makefile`:

| Command | Does |
|---|---|
| `make build-app` | Build the `app/` image |
| `make run` | Build the app image, then start the **default fleet** detached via docker compose — Discord gateway + the consolidated light container (mail/home/heartbeat/sms/chat, `scripts/light-bot.ts`). Provisioned fleet app containers receive their scoped direct executor credential through Compose. An absent `BAXTER_SURFACES` starts all app surfaces; setting the variable narrows them |
| `make run-mail` | **Deprecated — fails loud.** Mail is a light surface now, running by default inside the light container (`make run`). A make-level alias can't force it on (the light supervisor never sees make's env), so the target refuses instead of pretending to succeed |
| `make stop` | `COMPOSE_PROFILES="discord,heartbeat,mail,home,sms,chat,light,search" docker compose down` — profiles pinned wide so anything running (the `light` container or searxng) gets a graceful stop regardless of `BAXTER_SURFACES`, not just the SIGKILL of the mop-up (config volume + network left intact); also mops up any pre-compose/retired containers of the same name |
| `make logs` | Follow logs from the fleet, including the light container (mail/home/heartbeat/sms/chat) (`COMPOSE_PROFILES="discord,light,search" docker compose logs -f`; a bare `docker compose logs` is rejected by compose.yaml's `${PROJECT:?}` guards) |
| `make mail` | Build + run **just** the mail surface (`mail-bot.ts`) in the foreground |
| `make discord` | Build + run **just** the Discord gateway in the foreground |
| `make heartbeat` | Bring up the consolidated `light` container (mail/home/heartbeat/sms/chat run supervised in one process, `scripts/light-bot.ts`) || `make app-shell` | Shell into the `app/` image for debugging |

**Operator CLI (`baxter`).** For day-to-day operation there's an ergonomic `baxter` command — run `./install.sh` once to symlink it onto your PATH (`/usr/local/bin`, else `~/.local/bin`), then drive the fleet from any directory: `baxter up [all]`, `baxter down`, `baxter restart [svc]`, `baxter status`, `baxter logs [svc]` (svc: `discord`/`heartbeat`/`mail`/`home`/`chat`/`sms`), `baxter update` (pull + rebuild + restart, on the box), plus `home`/`build`/`backup`/`restore`/`harness`. **`baxter shell`** opens Baxter's **interactive terminal** — chat to him (a fresh run per turn) or run his tools via `/slash` (`/collections list`, `/code python`, `/web fetch …`); `BOX=<box>` (or `baxter shell <box>`) runs the identical terminal on that box over SSH. See `app/CLAUDE.md` (the TUI surface) and `docs/superpowers/specs/2026-07-23-baxter-tui-design.md`. `baxter help` lists the surface. It's a **thin front-end** (`bin/baxter`): lifecycle verbs delegate to the Makefile targets below — still the source of truth for dev/build — and only the per-service logs/status/restart that `make` doesn't parameterize hit `docker` directly. It's installed as a **symlink** to `bin/baxter`, so `git pull` keeps it current; it resolves its own path to find the repo, so it runs from anywhere.

**Discord plus all five light surfaces are the default fleet.** Compose profiles gate `discord`, the consolidated `light` service, and search. Always go through `make`: a bare `docker compose up` has no selected app profile. `make run` maps `BAXTER_SURFACES` (default `discord,sms,chat,home,mail,heartbeat`) onto those profiles; any light surface enables the shared `light` profile. Direct executor credentials are loaded into the app containers from a separate final Compose env file, never through a profile or socket. Unsupported surface names fail before image build. See `README.md`.

The detached fleet is **docker-compose-managed** (`compose.yaml` at the repo root). The Makefile builds the app image and owns the durable `$(PROJECT)-net` network and `$(PROJECT)-app-config` volume (both external so `down` never removes them); Compose runs the containers. Remote code executes in the separate Cloudflare Worker/Container system, never through the host Docker daemon.
