PROJECT := $(notdir $(CURDIR))
IMAGE := $(PROJECT)-dev
CONFIG_VOLUME := $(PROJECT)-claude-config
ENV_FILE := $(if $(wildcard .devcontainer/.env),--env-file .devcontainer/.env,)

# Docker-outside-of-Docker: mount the daemon's socket instead of running a
# nested daemon, and join the socket's owning group by GID (works even
# though that GID has no name inside the container) so the non-root `node`
# user can use it. The socket path/gid must be resolved from the daemon's
# own point of view, not the host's: bind-mount sources and file ownership
# are meaningless unless read from wherever the daemon itself sees them.
#
# Colima runs the daemon inside a Lima VM and only exposes docker.sock to
# the host via an SSH-forwarded proxy file (reported by `docker context
# inspect`); that path doesn't exist inside the VM's own mount namespace,
# and its host-side owner has nothing to do with the VM's docker group. So
# for Colima we bind-mount the daemon's real in-VM socket at
# /var/run/docker.sock and read its gid via `colima ssh`. Other backends
# (Docker Desktop, native Linux) forward /var/run/docker.sock straight
# through, so the host's own path/stat are accurate there. Everything
# resolves empty if Docker isn't reachable, in which case the run below
# just skips the mount.
DOCKER_CONTEXT := $(shell docker context show 2>/dev/null)
ifeq ($(DOCKER_CONTEXT),colima)
DOCKER_SOCK := /var/run/docker.sock
DOCKER_SOCK_EXISTS := 1
DOCKER_GID := $(shell colima ssh -- stat -c '%g' /var/run/docker.sock 2>/dev/null)
else
DOCKER_HOST_SOCK := $(shell docker context inspect $$(docker context show) --format '{{.Endpoints.docker.Host}}' 2>/dev/null | sed -n 's@^unix://@@p')
DOCKER_SOCK := $(if $(DOCKER_HOST_SOCK),$(DOCKER_HOST_SOCK),/var/run/docker.sock)
DOCKER_SOCK_EXISTS := $(wildcard $(DOCKER_SOCK))
DOCKER_GID := $(shell stat -L -c '%g' "$(DOCKER_SOCK)" 2>/dev/null || stat -L -f '%g' "$(DOCKER_SOCK)" 2>/dev/null)
endif

APP_IMAGE := $(PROJECT)-app
APP_CONFIG_VOLUME := $(PROJECT)-app-config

# Relocatable-fleet seam (env file): point a fleet at a per-tenant env file.
# Defaults to app/.env, so a plain `make run` AND every foreground docker-run
# target is unchanged; baxter-control passes TENANT_ENV=/agents/<id>/app.env.
# Override by passing TENANT_ENV=<path> as a make argument (like PROJECT); with
# ?= an env-prefix value is honored too (unlike PROJECT's := footgun). The
# comment MUST stay on its own line -- a trailing `# ...` on the assignment folds
# the spaces into the value and breaks `test -f`/`--env-file`.
TENANT_ENV ?= app/.env
# APP_ENV_FILE follows the TENANT_ENV seam directly (one knob, no APP_ENV alias)
# so check-env and the foreground docker-run targets (mail/discord/tui/inbox/
# app-shell) all agree on the effective env file.
APP_ENV_FILE := $(if $(wildcard $(TENANT_ENV)),--env-file $(TENANT_ENV),)
# The /home/node mount source: the TENANT_STATE seam (a host path => bind mount)
# or the named config volume (default) -- factored out so APP_RUN_FLAGS and
# app-shell share ONE definition and can't drift (tenant env + operator state).
# patsubst strips a trailing slash: docker stores the CLEANED bind source, so a
# `--filter volume=/path/` (shell tab-completion adds the slash) would match
# nothing and silently bypass restore's running-fleet guard. Canonicalize here.
APP_STATE_SRC := $(if $(TENANT_STATE),$(patsubst %/,%,$(TENANT_STATE)),$(APP_CONFIG_VOLUME))
# Where `make backup` writes snapshots of Baxter's memory. Gitignored -- these
# contain secrets (memory.md stores account credentials in full).
BACKUP_DIR := backups

# Code-execution sandbox (codapi). Shared user-defined network so run/discord can
# resolve `codapi` by name. CODAPI_TMP is bind-mounted into the codapi container
# at an identical host path so codapi's per-run code dir resolves on the host
# daemon (docker-outside-of-docker). Pinned codapi binary + its checksum.
APP_NET := $(PROJECT)-net
CODAPI_TMP := /var/tmp/$(PROJECT)-codapi
CODAPI_VERSION ?= 0.14.0
# Both release checksums; the codapi Dockerfile picks the one matching the build
# arch. CODAPI_ARCH is the DAEMON's arch (arm64 on a Pi, amd64 on an N100) --
# read from the daemon, not the client, so it's right under docker-outside-of-
# docker -- and is passed as TARGETARCH so the build self-selects on any host.
CODAPI_SHA256_ARM64 ?= c293b409f57ef788589081091cd915c75e2b0468aecc1549dfcc7943f45d3bd8
CODAPI_SHA256_AMD64 ?= 292be3d1a37ae918308a9e40de828d38dfd61d5b490369caea00c108bb6ee985
CODAPI_ARCH := $(shell docker version --format '{{.Server.Arch}}' 2>/dev/null)

# Shared docker-run flags for the FOREGROUND single-surface debug targets
# (`make mail` / `make discord`): memory/shm sizing, the shared network, env
# file, and the persistent config volume. The detached fleet runs via compose
# (see compose.yaml + `make run`), which encodes these same settings per service.
# -v source = APP_STATE_SRC (the TENANT_STATE seam, mirroring compose's
# ${TENANT_STATE:-config}), so a foreground `make mail/discord/tui/app-shell
# TENANT_ENV=.. TENANT_STATE=..` debugs the RIGHT tenant's env AND state, never a
# mix of tenant env + operator state.
APP_RUN_FLAGS := --memory=8g --shm-size=2g --network $(APP_NET) $(APP_ENV_FILE) -v "$(APP_STATE_SRC):/home/node"

# Which surfaces a fleet starts (Seam 3). Comma-separated compose profiles;
# each lifecycle target sets COMPOSE_PROFILES to its own full set (compose does
# NOT merge a --profile flag with COMPOSE_PROFILES -- the flag replaces it -- so
# we drop the flags and own the set per target). Default = today's `make run`
# (discord+heartbeat unprofiled-equivalent). codapi carries no profile => always.
BAXTER_SURFACES ?= discord,heartbeat

# SearXNG backend for `web-cli search` (Seam). A per-fleet searxng service behind
# compose's `search` profile; SEARXNG_LOCAL=1 (default) appends `search` to the
# profile set via SEARXNG_SUFFIX, so single-tenant search is always-on with zero
# config. A multi-tenant box shares ONE instance instead: set SEARXNG_LOCAL=0 +
# SEARXNG_URL=http://<shared>:8080 in the tenant env (searxng is stateless -> safe
# to share). `search` is appended to COMPOSE_PROFILES, NOT to BAXTER_SURFACES, so
# it bypasses check-surfaces (it isn't a "surface").
comma := ,
SEARXNG_LOCAL ?= 1
SEARXNG_SUFFIX := $(if $(filter 1,$(SEARXNG_LOCAL)),$(comma)search,)

# `docker compose`, fed the project name + the vars compose.yaml interpolates
# (incl. the TENANT_ENV/TENANT_STATE seams; empty TENANT_STATE => compose's
# `${TENANT_STATE:-config}` default, i.e. the named config volume).
# Inline (not a global `export`) so it can't leak into unrelated recipes. Compose
# only *runs* the images the build targets produce; `make run`/`stop` wrap it.
COMPOSE := COMPOSE_PROJECT_NAME=$(PROJECT) PROJECT=$(PROJECT) CODAPI_TMP=$(CODAPI_TMP) TENANT_ENV=$(TENANT_ENV) TENANT_STATE=$(TENANT_STATE) docker compose

.PHONY: build-dev dev build-app build-codapi check check-arch check-buildkit check-env check-surfaces ensure run run-mail deploy deploy-local mail discord voice home tui tui-run stop logs inbox app-shell backup restore add-skill codapi searxng heartbeat harness use-claude use-openrouter use-openai use-local use-custom set-key release deploy-release deploy-main eval

build-dev:
	docker build -t $(IMAGE) .devcontainer

dev:
	docker run -it --rm \
		$(ENV_FILE) \
		-v "$(shell pwd):/app" \
		-v "$(CONFIG_VOLUME):/home/node" \
		$(if $(DOCKER_SOCK_EXISTS),-v "$(DOCKER_SOCK):/var/run/docker.sock",) \
		$(if $(DOCKER_GID),--group-add $(DOCKER_GID),) \
		$(IMAGE)

# Fail fast on an unsupported/empty daemon arch (shared by the two targets that
# pass TARGETARCH to a Dockerfile arch-select), so the operator gets a clear
# message instead of an opaque ADD-of-a-404 / case-guard exit deep in the build.
check-arch:
	@case "$(CODAPI_ARCH)" in arm64|amd64) ;; \
	  *) echo "cannot use daemon arch '$(CODAPI_ARCH)' (need arm64 or amd64; is docker running?)" >&2; exit 1 ;; esac

# BuildKit is required (the app image uses cache mounts + conditional stages, and modern
# Docker has no legacy builder to fall back on). `docker buildx version` is NOT a reliable
# probe -- a daemon can have built-in BuildKit with no buildx CLI (and vice versa: Colima
# ships Docker WITHOUT the buildx plugin, so `docker build` delegates to a missing buildx and
# fails). So probe a real, trivial BuildKit build; if it can't run, say how to fix it instead
# of letting the operator hit Docker's opaque "buildx component is missing" mid-build.
check-buildkit:
	@printf 'FROM scratch\n' | DOCKER_BUILDKIT=1 docker build -q - >/dev/null 2>&1 || { \
	  echo "Docker BuildKit isn't working -- Baxter's image needs it (cache mounts + conditional stages)." >&2; \
	  echo "Almost always a missing 'buildx' plugin. Install it, then retry:" >&2; \
	  echo "  Colima / Docker CLI on macOS:  brew install docker-buildx \\" >&2; \
	  echo "      && mkdir -p ~/.docker/cli-plugins \\" >&2; \
	  echo "      && ln -sfn \$$(brew --prefix)/opt/docker-buildx/bin/docker-buildx ~/.docker/cli-plugins/docker-buildx" >&2; \
	  echo "  Fedora/RHEL:    sudo dnf install docker-buildx-plugin" >&2; \
	  echo "  Debian/Ubuntu:  sudo apt-get install docker-buildx-plugin" >&2; \
	  echo "  Docker Desktop: bundled -- update Docker Desktop" >&2; \
	  echo "  docs: https://docs.docker.com/go/buildx/" >&2; \
	  exit 1; }

# Type-check + run the app's node:test suite -- the one gate every commit must keep
# green. `tsc --noEmit` is CHECK-ONLY: Node 22 strips types at runtime, so we never
# emit JS (no build step). Runs on the HOST against app/node_modules (`cd app &&
# npm install` once to get the `typescript` devDep).
check:
	cd app && ./node_modules/.bin/tsc --noEmit && node --test

# VOICE gates the ~1GB voice stack (whisper.cpp STT compile, Piper TTS, ffmpeg,
# ONNX voices, muzak archive) into the image via the Dockerfile's WITH_VOICE ARG.
# Default 0 -> the whisper-builder/voice-1 stages fall out of BuildKit's graph, so a
# plain `make run` skips them entirely; `make voice` overrides VOICE=1 to bake the
# voice surface back into the SAME tag. DOCKER_BUILDKIT=1 is required for the
# Dockerfile's cache mounts + conditional stages (default on modern Docker, pinned
# here so an older client still uses the BuildKit frontend).
VOICE ?= 0
build-app: check-arch check-buildkit
	DOCKER_BUILDKIT=1 docker build -t $(APP_IMAGE) --build-arg WITH_VOICE=$(VOICE) --build-arg TARGETARCH=$(CODAPI_ARCH) ./app

# Fail fast if the app env file (API key, sender allowlist, tokens) is
# missing. Without it the app-running targets build the whole image first and
# only fail at the very end: compose rejects the required env_file (run /
# heartbeat), while the docker-run targets (mail / discord) start with no env
# at all and the agent dies at runtime.
check-env:
	@test -f "$(TENANT_ENV)" || { echo "$(TENANT_ENV) missing -- copy app/.env.example and fill it in" >&2; exit 1; }

# Ensure the durable resources compose treats as `external` exist: the shared
# network and the config volume. Compose only manages containers, so these
# survive `docker compose down`. Idempotent -- inspect-or-create. (`make run`/
# `run-mail` depend on this, so the volume exists before any daemon starts.)
ensure:
	@docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	@# Only the named-volume path needs the volume. When TENANT_STATE binds a host
	@# dir, the named volume is unused -- don't create 20 empty stray volumes.
	@test -n "$(TENANT_STATE)" || docker volume inspect $(APP_CONFIG_VOLUME) >/dev/null 2>&1 || docker volume create $(APP_CONFIG_VOLUME)

# Build the codapi images: the host-arch python/node sandboxes + the server image
# (pinned, arch-selected codapi binary + baked config). Separated from starting
# the container so compose can just reference the pre-built $(PROJECT)-codapi tag.
# NOT privileged at runtime -- the socket mount (in compose.yaml) lets it launch
# hardened sandbox siblings. `check-arch` gives a clear message on an
# unsupported/empty daemon arch instead of an opaque ADD-of-a-404 in the Dockerfile.
build-codapi: check-arch check-buildkit
	cp app/sandboxes/emit-artifacts.sh app/sandboxes/python/emit-artifacts.sh
	cp app/sandboxes/emit-artifacts.sh app/sandboxes/node/emit-artifacts.sh
	docker build -t codapi/python app/sandboxes/python
	docker build -t codapi/node   app/sandboxes/node
	docker build -t $(PROJECT)-codapi \
		--build-arg CODAPI_VERSION=$(CODAPI_VERSION) \
		--build-arg CODAPI_SHA256_ARM64=$(CODAPI_SHA256_ARM64) \
		--build-arg CODAPI_SHA256_AMD64=$(CODAPI_SHA256_AMD64) \
		--build-arg TARGETARCH=$(CODAPI_ARCH) app/codapi

# `voice` in BAXTER_SURFACES only works with a VOICE=1 image (the default
# build-app is VOICE=0 -- the ~1GB voice stack is absent). So allow it ONLY when
# VOICE=1 is passed (`make run VOICE=1 BAXTER_SURFACES=...,voice` builds the voice
# image AND starts the voice service in one shot -- command-line VOICE propagates
# to the build-app prereq); reject voice+VOICE!=1 fast, before the long build.
# Its own prereq, ordered first (fail-fast, like check-env), not duplicated
# across run/run-mail.
check-surfaces:
	@test -n "$(strip $(BAXTER_SURFACES))" || { echo "BAXTER_SURFACES is empty -- delete the line to get the default (discord,heartbeat); a blank value would start no real surfaces (run: codapi only; run-mail: codapi + mail poller only)" >&2; exit 1; }
	@case ",$(BAXTER_SURFACES)," in *,voice,*) test "$(VOICE)" = "1" || { echo "BAXTER_SURFACES includes 'voice' but VOICE is not 1 -- the voice stack only exists in a VOICE=1 image. Pass VOICE=1 (per-tenant: set BAXTER_VOICE=1 in the tenant's app.env; the systemd unit forwards it)." >&2; exit 1; };; esac

# Bring up the DEFAULT fleet detached: Discord gateway + heartbeat scheduler +
# codapi sandbox, each with a restart policy, via compose (compose.yaml). The
# mail poller is deliberately NOT started -- it's opt-in, gated behind
# compose's `mail` profile; use `make run-mail` to include it. The Makefile builds
# the images + owns the network/volume; compose runs the containers. `up -d` is
# idempotent (recreates only changed services). Tear it all down with `make stop`.
run: check-surfaces check-env build-app build-codapi ensure
	COMPOSE_PROFILES="$(BAXTER_SURFACES)$(SEARXNG_SUFFIX)" $(COMPOSE) up -d
	@echo "Baxter up: surfaces [$(BAXTER_SURFACES)] + $(PROJECT)-codapi-svc$(if $(SEARXNG_SUFFIX), + $(PROJECT)-searxng,) (mail poller not managed by this target -- use 'make run-mail')"

# Same as `make run`, plus the mail poller ($(PROJECT)-run, gated in compose's
# `mail` profile). Do `make inbox` once first so BAXTER_EMAIL / the inbox exist.
run-mail: check-surfaces check-env build-app build-codapi ensure
	COMPOSE_PROFILES="$(BAXTER_SURFACES),mail$(SEARXNG_SUFFIX)" $(COMPOSE) up -d
	@echo "Baxter fleet up: surfaces [$(BAXTER_SURFACES)] + mail poller ($(PROJECT)-run) + $(PROJECT)-codapi-svc$(if $(SEARXNG_SUFFIX), + $(PROJECT)-searxng,)"

# `make deploy BOX=box` -- the one-shot deploy, run on YOUR machine: push this
# branch, then SSH the box to pull + restart. This is the only place SSH topology
# lives; the box-side work is `deploy-local` (below), which never SSHes.
#   make deploy BOX=box                      # BOX is an ssh target: a ~/.ssh/config
#                                            # Host alias, or user@host
#   make deploy BOX=me@10.0.0.4 REMOTE_DIR=/srv/baxter BRANCH=main
# Push and remote step are &&-chained, so a rejected push (e.g. non-fast-forward)
# aborts before touching the box. REMOTE_DIR (where the repo is checked out on the
# box) and BRANCH default to /opt/baxter and main. BRANCH is forwarded to the box
# so deploy-local can refuse if the box is checked out on a different branch --
# otherwise pushing one branch while the box pulls another is a silent no-op that
# "succeeds" on stale code.
REMOTE_DIR ?= /opt/baxter
BRANCH ?= main
deploy:
	@test -n "$(BOX)" || { echo "usage: make deploy BOX=<ssh-target> [REMOTE_DIR=/opt/baxter] [BRANCH=main]" >&2; exit 1; }
	git push origin $(BRANCH) && ssh $(BOX) 'cd $(REMOTE_DIR) && make deploy-local BRANCH=$(BRANCH)'

# Pull the latest branch from the git remote and (re)start the full fleet -- the
# box side of `make deploy`. `deploy` SSHes in and runs this; run it by hand if
# you're already on the box:  cd /opt/baxter && make deploy-local [BRANCH=<branch>]
# (BRANCH defaults to main -- pass it if the box tracks a different branch).
# A clean-tree guard + --ff-only so a drifted box fails loudly instead of silently
# shipping unversioned code. The porcelain check rejects any local edits OR
# untracked files (e.g. a hot-patch, or a stray compose.override.yaml that
# `compose up` would auto-merge) -- drift that --ff-only alone fast-forwards
# straight past whenever it doesn't collide with the incoming change; gitignored
# files (.env, .claude/, backups/) are excluded, so a healthy box stays clean.
# --ff-only then rejects divergent commits rather than making a merge commit.
# run-mail rebuilds the images (cached when nothing changed) and `compose up -d`
# recreates only the containers whose image or config changed; the external config
# volume + app/.env are left intact, so Baxter's memory, keys and schedule
# survive the redeploy. Swap run-mail for `run` if you don't run the (opt-in)
# mail poller.
deploy-local:
	@# Refuse if the box isn't on the branch being deployed: a bare `git pull` below
	@# pulls whatever branch is checked out, so a mismatch would "succeed" on the
	@# wrong code. BRANCH defaults to main; `make deploy` forwards the pushed branch.
	@cur=$$(git rev-parse --abbrev-ref HEAD); \
	  test "$$cur" = "$(BRANCH)" || { echo "refusing to deploy: box is on '$$cur', not '$(BRANCH)' -- checkout $(BRANCH), or pass BRANCH=$$cur if that's the branch you mean to deploy" >&2; exit 1; }
	@# --untracked-files=normal pinned so a box-local status.showUntrackedFiles=no
	@# (a common large-repo speed tweak) can't silently disable the untracked check.
	@test -z "$$(git status --porcelain --untracked-files=normal)" || \
	  { echo "refusing to deploy: working tree has local edits or untracked files -- reconcile (git status) first" >&2; exit 1; }
	git pull --ff-only
	$(MAKE) run-mail PROJECT=$(PROJECT)

# Cut a versioned release: tag vX.Y.Z on an up-to-date main and push it -- the
# .github/workflows/release.yml workflow then creates the GitHub Release. Refuses
# unless the tree is clean, on main, and in sync with origin/main (so the tag only
# ever marks pushed code), and won't clobber an existing tag.
#   make release VERSION=v0.1.0
# The tag is SIGNED (`git tag -s`), so it needs a signing key configured first --
# one-time setup (SSH, reusing your push key):
#     git config --global gpg.format ssh
#     git config --global user.signingkey ~/.ssh/id_ed25519.pub
#   (or GPG: git config --global gpg.format openpgp; user.signingkey <KEYID>)
# then add the PUBLIC key to GitHub -> Settings -> SSH and GPG keys as a *signing*
# key -- that drives the "Verified" badge, the real check for an SSH-signed tag.
# To ALSO verify locally with `git tag -v vX.Y.Z`, the SSH path (unlike GPG) needs
# an allowed-signers file:
#     echo "$(git config user.email) $(cat ~/.ssh/id_ed25519.pub)" >> ~/.ssh/allowed_signers
#     git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
# Without a signing key configured, `git tag -s` errors -- deliberately, so a
# release can't go out unsigned by accident.
release:
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=vX.Y.Z" >&2; exit 1; }
	@echo "$(VERSION)" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$$' || { echo "VERSION must be semver like v0.1.0 (got '$(VERSION)')" >&2; exit 1; }
	@test -z "$$(git status --porcelain --untracked-files=normal)" || { echo "working tree not clean -- commit or stash first" >&2; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "main" || { echo "cut releases from main (on $$(git rev-parse --abbrev-ref HEAD))" >&2; exit 1; }
	@git fetch --quiet --force --tags origin main && test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "main is not in sync with origin/main -- push/pull first" >&2; exit 1; }
	@git rev-parse -q --verify "refs/tags/$(VERSION)" >/dev/null && { echo "tag $(VERSION) already exists" >&2; exit 1; } || true
	git tag -s "$(VERSION)" -m "$(VERSION)"
	git push origin "$(VERSION)"
	@echo "pushed tag $(VERSION) -- the release workflow will create the GitHub Release."

# `baxter update` -> update this checkout to the latest stable RELEASE tag and
# (re)start the fleet (the release-tracking analog of deploy-local). Skips
# pre-releases (tags with a '-'). Detaches HEAD onto the tag; `baxter update main`
# (-> deploy-main) returns to bleeding-edge main.
deploy-release:
	@test -z "$$(git status --porcelain --untracked-files=normal)" || { echo "refusing to update: working tree has local edits or untracked files -- reconcile (git status) first" >&2; exit 1; }
	git fetch --tags --prune --prune-tags --force --quiet origin
	@latest=$$(git tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$$' | head -1); \
	  test -n "$$latest" || { echo "no stable release tags (vX.Y.Z) found -- cut one with 'make release VERSION=vX.Y.Z'" >&2; exit 1; }; \
	  echo "updating to latest release: $$latest"; \
	  git checkout --quiet "$$latest"
	$(MAKE) run-mail PROJECT=$(PROJECT)

# `baxter update main` -> return to (and pull) main, for bleeding-edge dev boxes.
# Handles the detached-HEAD state a prior `deploy-release` leaves.
deploy-main:
	@test -z "$$(git status --porcelain --untracked-files=normal)" || { echo "refusing to update: working tree has local edits or untracked files -- reconcile (git status) first" >&2; exit 1; }
	git checkout --quiet main
	git pull --ff-only origin main
	$(MAKE) run-mail PROJECT=$(PROJECT)

# The mail poller alone, in the foreground (was the original `make run`). For
# running or debugging just the email daemon. Stops the compose-managed poller
# first (it lives in the `mail` profile, hence COMPOSE_PROFILES=mail) so the two
# don't race the same inbox (double-replies); it comes back on the next
# `make run-mail`.
mail: check-env build-app ensure
	-COMPOSE_PROFILES="mail" $(COMPOSE) stop run 2>/dev/null
	@echo "note: fleet poller $(PROJECT)-run stopped (if it was up); it stays down until the next 'make run-mail'"
	docker run -it --rm $(APP_RUN_FLAGS) $(APP_IMAGE)

# The Discord gateway alone, in the foreground. Same image + config volume as the
# poller (shares memory, skills, token), different entrypoint. Stops the compose-
# managed gateway first so the two don't both answer every message; it comes back
# on the next `make run`, which starts a detached copy alongside the others.
discord: check-env build-app ensure
	-COMPOSE_PROFILES="discord" $(COMPOSE) stop discord 2>/dev/null
	@echo "note: fleet gateway $(PROJECT)-discord stopped (if it was up); it stays down until the next 'make run'"
	docker run -it --rm $(APP_RUN_FLAGS) $(APP_IMAGE) node scripts/discord-bot.ts

# Baxter's interactive terminal (`baxter shell` -> this). Same flags as `make mail`
# (APP_RUN_FLAGS -- the --network $(APP_NET) matters so code-cli/`/code` reach codapi),
# but runs the TUI entrypoint. `-it` for the interactive REPL. Shares the config
# volume, so you talk to the REAL Baxter (his live memory/skills/projects). codapi
# should be up (part of the running fleet) for code execution to work.
# Dev: rebuild the image THEN run the TUI (picks up local code edits). `make tui-run` is
# the fast path `baxter shell` uses -- no rebuild.
tui: check-env build-app ensure
	docker run -it --rm $(APP_RUN_FLAGS) $(APP_IMAGE) node scripts/tui.ts $(TUI_FLAGS)

# Fast TUI: run the ALREADY-BUILT image, no per-launch rebuild (that `docker build` cost a
# second-plus even fully cached). The image is built at install and by `baxter build` /
# `baxter update`; this builds it ONCE only if it's missing (a fresh clone that skipped
# install). `baxter shell` uses this -- after editing code, run `baxter build` to refresh.
# OLLAMA=1 (via `baxter shell ollama`) forks the launch host-side to ollama.sh: a keyless
# local model served on the HOST by Ollama + the TUI pointed at it over host.docker.internal.
# It skips check-env (a fresh user has no app/.env; this runs a clean keyless env).
ifeq ($(OLLAMA),1)
tui-run: ensure
	@docker image inspect $(APP_IMAGE) >/dev/null 2>&1 || { echo "app image not built yet -- building once (later launches skip this)…"; $(MAKE) build-app; }
	APP_IMAGE="$(APP_IMAGE)" APP_NET="$(APP_NET)" APP_CONFIG_VOLUME="$(APP_STATE_SRC)" TUI_FLAGS="$(TUI_FLAGS)" OLLAMA_MODEL="$(OLLAMA_MODEL)" ./ollama.sh
else
tui-run: check-env ensure
	@docker image inspect $(APP_IMAGE) >/dev/null 2>&1 || { echo "app image not built yet -- building once (later launches skip this)…"; $(MAKE) build-app; }
	docker run -it --rm $(APP_RUN_FLAGS) $(APP_IMAGE) node scripts/tui.ts $(TUI_FLAGS)
endif

# Stop + remove the fleet. `compose down` (with the mail profile, so the profiled
# poller gets a graceful stop too, not just the SIGKILL of the mop-up below)
# clears the compose-managed containers; the trailing `docker rm -f` mops up any
# pre-compose containers of the same name (a one-time need on the first switch to
# compose, silenced since it's a routine no-op afterward). Both leave the external
# network + config volume intact.
stop:
	-COMPOSE_PROFILES="discord,heartbeat,mail,voice,home,search" $(COMPOSE) down
	-docker rm -f $(PROJECT)-run $(PROJECT)-discord $(PROJECT)-heartbeat $(PROJECT)-voice $(PROJECT)-home $(PROJECT)-searxng $(PROJECT)-codapi-svc >/dev/null 2>&1

# Follow logs from the whole fleet. COMPOSE_PROFILES enables the full set
# (discord,heartbeat,mail,voice,home,search) so the opt-in poller's, voice bot's,
# home surface's, and searxng's logs are included when they're running -- and,
# unlike a BAXTER_SURFACES-derived set,
# never drops a surface from the log view if that value drifted (harmless
# when they aren't). Goes through $(COMPOSE) because compose.yaml's
# `${PROJECT:?}`/`${CODAPI_TMP:?}` guards reject a bare `docker compose logs`.
logs:
	COMPOSE_PROFILES="discord,heartbeat,mail,voice,home,search" $(COMPOSE) logs -f

# Just the codapi sandbox: build its images, then start it via compose.
codapi: build-codapi ensure
	$(COMPOSE) up -d codapi
	@echo "codapi running on $(APP_NET) at http://codapi:1313"

# Just the SearXNG search backend (compose's `search` profile). `web-cli search`
# reaches it at http://searxng:8080. Standalone add-to-a-running-fleet, parallel
# to `make codapi`; no image build (pulls searxng/searxng on first run).
searxng: ensure
	COMPOSE_PROFILES="search" $(COMPOSE) up -d searxng
	@echo "searxng running on $(APP_NET) at http://searxng:8080"

# Just the heartbeat scheduler via compose (its `depends_on` brings codapi up
# too, hence the codapi build).
heartbeat: check-env build-app build-codapi ensure
	$(COMPOSE) up -d heartbeat
	@echo "heartbeat driver running ($(PROJECT)-heartbeat)"

# "Fast Baxter" voice surface (opt-in, `voice` profile). Self-disables unless
# DISCORD_VOICE_CHANNEL_ID is set in app/.env (and the GuildVoiceStates intent is
# enabled in the Developer Portal). No codapi dependency -- it just joins voice.
# Rebuilds the shared app image WITH the voice stack (VOICE=1) before starting the
# opt-in voice container -- `make run`/`discord`/etc. build it voice-less (VOICE=0),
# so voice must bake it back in. The default fleet never needs voice, and a plain
# `make run` won't stop an already-running voice container (different profile), so
# the two coexist on the one tag without a flip-flop.
voice: check-env ensure
	$(MAKE) build-app VOICE=1
	COMPOSE_PROFILES="voice" $(COMPOSE) up -d voice
	@echo "voice bot running ($(PROJECT)-voice) -- needs DISCORD_VOICE_CHANNEL_ID in app/.env to actually join"

# Family-home web surface (opt-in, `home` profile). Standalone way to add just the
# home driver to an already-running fleet (like `make voice`). Idles cleanly if
# home-keys.json isn't provisioned yet (logs once, no crash). No voice-style image
# variant -- the default image runs it. No codapi dep -- it's a plain sync loop.
home: check-env build-app ensure
	COMPOSE_PROFILES="home" $(COMPOSE) up -d home
	@echo "home surface running ($(PROJECT)-home) -- needs home-keys.json (baxctl home <id>) to sync"

# One-time AgentMail inbox provisioning (replaces the old weekly `make auth` OAuth
# bootstrap -- there's no token to renew). Creates-or-returns Baxter's inbox and
# prints the AGENTMAIL_INBOX_ID / BAXTER_EMAIL to paste into app/.env. Needs
# AGENTMAIL_API_KEY set in app/.env.
inbox: check-env build-app
	docker run -it --rm \
		$(APP_ENV_FILE) \
		$(APP_IMAGE) node scripts/make-inbox.ts

app-shell: build-app
	docker run -it --rm \
		$(APP_ENV_FILE) \
		-v "$(APP_STATE_SRC):/home/node" \
		$(APP_IMAGE) /bin/bash

# Snapshot Baxter's ENTIRE durable state -- everything under .mail-agent: his mind
# (memory-workspace: memory.md, CREDENTIALS.md, projects, learned-skills, per-
# channel notes, browser session), his schedule, and his tokens/keys/counters
# (agentmail-key, discord-token, data-keys, send-state, invisible-state, ...). One tarball = the
# whole Baxter, for cloning him to another box (see deploy/README.md) or rollback.
# For a clean clone, `make stop` first so nothing is mid-write. The excludes drop
# Chromium's transient Singleton* lock/socket (a symlink + a socket that exist only
# while a browser is running) so a snapshot taken mid-run still restores (restore
# refuses non-regular files) -- anchored to the .playwright*/ browser dirs so they
# can never match an agent-authored file named Singleton* elsewhere. (busybox tar
# retries an unanchored exclude at every path component, which is why the old broad
# `*/Singleton*` matched at any depth; fnmatch runs with FNM_PATHNAME, so the
# trailing `*Singleton*` does NOT span `/` -- it catches Singleton* directly inside
# the .playwright*/ dir, where Chromium keeps its lock/socket.) NOTE: the tarball
# contains secrets (the AgentMail API key, the discord token, any
# data-cli keys, CREDENTIALS.md) -- backups/ is gitignored; keep the tarball safe.
backup:
	@mkdir -p "$(BACKUP_DIR)"
	docker run --rm \
		-v "$(APP_STATE_SRC):/src:ro" \
		-v "$(CURDIR)/$(BACKUP_DIR):/backup" \
		alpine tar czf "/backup/baxter-state-$$(date +%Y%m%d-%H%M%S).tar.gz" \
			-C /src --exclude='*/.playwright/*Singleton*' --exclude='*/.playwright-cli/*Singleton*' \
			.mail-agent
	@ls -lh "$(BACKUP_DIR)" | tail -1

# Restore a FULL snapshot, REPLACING Baxter's entire state with it -- i.e. clone
# him onto this volume (or roll the whole box back):
#   make restore RESTORE_FILE=backups/baxter-state-20260721-120000.tar.gz
# WIPES the whole .mail-agent first, then extracts, so the volume ends byte-for-byte
# equal to the snapshot -- his mind, schedule, tokens, keys and browser session all
# come from the tarball, nothing on this volume survives. Refuses while any
# container still holds the volume (it would race the restore) -- `make stop` first.
# Set YES=1 to skip the confirmation prompt.
restore:
	@test -n "$(RESTORE_FILE)" || { echo "set RESTORE_FILE=backups/<file>.tar.gz"; exit 1; }
	@case "$(RESTORE_FILE)" in /*|..|../*|*/..|*/../*) echo "RESTORE_FILE must be repo-relative (no leading / or .. component): $(RESTORE_FILE)"; exit 1;; esac
	@test -f "$(CURDIR)/$(RESTORE_FILE)" || { echo "no RESTORE_FILE at $(CURDIR)/$(RESTORE_FILE) -- pass a path relative to the repo root (see 'ls -lh $(BACKUP_DIR)')"; exit 1; }
	@holders=$$(docker ps --filter volume="$(APP_STATE_SRC)" --format '{{.Names}}'); \
	 if [ -n "$$holders" ]; then \
	   echo "refusing: these running containers hold $(APP_STATE_SRC) and would race the restore:"; \
	   echo "  $$holders"; \
	   echo "run 'make stop' first, then restore, then start with your chosen config."; \
	   exit 1; \
	 fi
	@if [ "$(YES)" != "1" ]; then \
	   printf 'Replace Baxter'\''s ENTIRE state on %s with %s? This WIPES everything currently there (mind, schedule, tokens, keys, browser session) and loads the snapshot. [y/N] ' "$(APP_STATE_SRC)" "$(RESTORE_FILE)"; \
	   read ans; case "$$ans" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1;; esac; \
	 fi
	docker run --rm \
		-e RF="$(RESTORE_FILE)" \
		-e OM="$(OLD_MIND)" \
		-v "$(APP_STATE_SRC):/dst" \
		-v "$(CURDIR):/backup:ro" \
		alpine sh -c 'set -e; \
			lst=$$(tar tzf "/backup/$$RF") || { echo "refusing: cannot read $$RF as a tar.gz"; exit 1; }; \
			tv=$$(tar tvzf "/backup/$$RF"); \
			if [ -z "$$lst" ] \
			   || printf "%s\n" "$$lst" | grep -qvE "^[.]mail-agent(/|$$)" \
			   || printf "%s\n" "$$lst" | grep -qE "(^|/)[.][.](/|$$)" \
			   || printf "%s\n" "$$tv" | grep -qvE "^[-d]" \
			   || printf "%s\n" "$$tv" | grep -qE " -> | link to "; then \
				echo "refusing: $$RF is not a plain .mail-agent state snapshot (only regular files/dirs under .mail-agent/, no .., links, fifos or devices; make backup produces valid ones)"; exit 1; \
			fi; \
			if [ "$$OM" != "1" ] && ! printf "%s\n" "$$lst" | grep -qvE "^[.]mail-agent/memory-workspace(/|$$)"; then \
				echo "refusing: $$RF looks like an OLD mind-only baxter-mind-* snapshot (every entry is under memory-workspace/). Restoring it as a full state would WIPE the tokens/schedule/keys/browser session it does NOT contain. Use a full baxter-state-* backup -- or set OLD_MIND=1 to force (then re-run make inbox)."; exit 1; \
			fi; \
			rm -rf /dst/.mail-agent; \
			tar xzf "/backup/$$RF" -C /dst'
	@echo "restored $(RESTORE_FILE) into $(APP_STATE_SRC) -- full state replaced (mind, schedule, tokens, keys, browser session)"
# ^ The listing check runs BEFORE the wipe (set -e aborts first): it rejects an
#   unreadable, empty, WRONG (typo'd path to some other tarball), or malformed
#   archive -- so a bad RESTORE_FILE never leaves the volume wiped-but-not-restored.
#   And since every accepted entry is a regular file/dir under .mail-agent/ with no
#   `..` component and no non-regular member (symlink/hardlink/fifo/device), the
#   extract cannot escape the volume or plant a special file. An OLD mind-only
#   `baxter-mind-*` tarball would pass those checks (its entries are under
#   .mail-agent/) yet restoring it as a full state would WIPE the tokens/schedule/
#   browser session it lacks -- so a dedicated check refuses it (every entry under
#   memory-workspace/) unless OLD_MIND=1 forces it; if you force, re-run `make inbox`.

# Switch which brain drives Baxter by editing $(TENANT_ENV) in place -- only
# BAXTER_HARNESS and the model line change; API keys and everything else are left
# untouched. It edits the file only; redeploy to apply:  baxter down && baxter up
#   make harness                                     # show the current setting
#   make use-claude                                  # Claude Code (opt-in; default is openrouter)
#   make use-openrouter MODEL=z-ai/glm-4.6           # any tool-calling model on OpenRouter
#   make use-openai MODEL=qwen3 [BASE_URL=http://host:11434/v1]  # OpenAI-style: local OR remote
#   make set-key TYPE=openai KEY=sk-...                          # set an API key in app/.env
#   make use-custom DIALECT=anthropic MODEL=claude-sonnet-5      # any keyed LLM API (anthropic|gemini)
harness:
	@grep -E "^(BAXTER_HARNESS|OPENROUTER_MODEL|OPENAI_MODEL|OPENAI_BASE_URL|CUSTOM_API_DIALECT|CUSTOM_API_MODEL|CUSTOM_API_BASE_URL)=" $(TENANT_ENV) 2>/dev/null || echo "BAXTER_HARNESS unset -> openrouter (default)"

use-claude:
	@test -f $(TENANT_ENV) || { echo "$(TENANT_ENV) missing -- copy app/.env.example first"; exit 1; }
	@sh app/scripts/set-env-var.sh $(TENANT_ENV) BAXTER_HARNESS claude
	@model=$$(sed -n 's/^BAXTER_MODEL=//p' $(TENANT_ENV) | head -1); \
	  if [ -n "$$model" ]; then echo "harness -> claude, model $$model."; else echo "harness -> claude, model sonnet (default; set BAXTER_MODEL=haiku|opus to change)."; fi
	@grep -qE "^ANTHROPIC_API_KEY=." $(TENANT_ENV) || echo "  key: no ANTHROPIC_API_KEY -- set it (baxter set-key anthropic <key>) OR log in once (make app-shell, then claude)."
	@echo "  apply:  baxter down && baxter up"

use-openrouter:
	@test -f $(TENANT_ENV) || { echo "$(TENANT_ENV) missing -- copy app/.env.example first"; exit 1; }
	@test -n "$(MODEL)" || { echo "usage: make use-openrouter MODEL=<slug>   (e.g. z-ai/glm-4.6, from openrouter.ai/models)"; exit 1; }
	@sh app/scripts/set-env-var.sh $(TENANT_ENV) BAXTER_HARNESS openrouter
	@sh app/scripts/set-env-var.sh $(TENANT_ENV) OPENROUTER_MODEL '$(MODEL)'
	@echo "harness -> openrouter, model $(MODEL)."
	@grep -qE "^OPENROUTER_API_KEY=." $(TENANT_ENV) || echo "  key: OPENROUTER_API_KEY not set -- add it (baxter set-key openrouter <key>)."
	@echo "  apply:  baxter down && baxter up"

# The OpenAI-style harness (BAXTER_HARNESS=openai): ANY OpenAI-compatible chat/completions
# endpoint -- a local model (Ollama/LM Studio/vLLM) OR a hosted one (OpenAI, etc.). For a
# REMOTE endpoint you also need a key: `baxter set-key openai <key>`.
use-openai:
	@test -f $(TENANT_ENV) || { echo "$(TENANT_ENV) missing -- copy app/.env.example first"; exit 1; }
	@test -n "$(MODEL)" || { echo "usage: make use-openai MODEL=<model> [BASE_URL=<url>]"; exit 1; }
	@sh app/scripts/set-env-var.sh $(TENANT_ENV) BAXTER_HARNESS openai
	@sh app/scripts/set-env-var.sh $(TENANT_ENV) OPENAI_MODEL '$(MODEL)'
	@if [ -n "$(BASE_URL)" ]; then sh app/scripts/set-env-var.sh $(TENANT_ENV) OPENAI_BASE_URL '$(BASE_URL)'; fi
	@echo "harness -> openai (OpenAI-style), model $(MODEL)."
	@base=$$(sed -n 's/^OPENAI_BASE_URL=//p' $(TENANT_ENV) | head -1); \
	  if [ -n "$$base" ]; then echo "  endpoint: $$base"; \
	  else echo "  endpoint: http://localhost:11434/v1 (local Ollama DEFAULT -- OPENAI_BASE_URL is unset). For a REMOTE model (e.g. an OpenAI one) pass its base url too:  baxter harness openai $(MODEL) https://api.openai.com/v1"; fi
	@grep -qE "^OPENAI_API_KEY=." $(TENANT_ENV) || echo "  key: OPENAI_API_KEY not set -- a remote endpoint needs it (baxter set-key openai <key>); local servers can skip it"
	@echo "  apply:  baxter down && baxter up"

# Back-compat alias -- this harness was formerly named "local".
use-local: use-openai

# Set an API key/token in app/.env (0600, gitignored) WITHOUT echoing it -- the machinery
# behind `baxter set-key <type> <key>`. type -> env var in the case below.
set-key:
	@test -f $(TENANT_ENV) || { echo "$(TENANT_ENV) missing -- copy app/.env.example first"; exit 1; }
	@test -n "$(KEY)" || { echo "usage: make set-key TYPE=<openrouter|openai|anthropic|custom|agentmail|discord> KEY=<value>"; exit 1; }
	@case "$(TYPE)" in \
	    openrouter) var=OPENROUTER_API_KEY ;; \
	    openai)     var=OPENAI_API_KEY ;; \
	    anthropic)  var=ANTHROPIC_API_KEY ;; \
	    custom)     var=CUSTOM_API_KEY ;; \
	    agentmail)  var=AGENTMAIL_API_KEY ;; \
	    discord)    var=DISCORD_BOT_TOKEN ;; \
	    *) echo "unknown key type '$(TYPE)' -- one of: openrouter openai anthropic custom agentmail discord" >&2; exit 1 ;; \
	  esac; \
	  sh app/scripts/set-env-var.sh $(TENANT_ENV) "$$var" '$(KEY)'; \
	  echo "set $$var in $(TENANT_ENV) (value hidden). Apply with:  baxter down && baxter up"

use-custom:
	@test -f $(TENANT_ENV) || { echo "$(TENANT_ENV) missing -- copy app/.env.example first"; exit 1; }
	@case "$(DIALECT)" in anthropic|gemini) ;; *) echo "usage: make use-custom DIALECT=<anthropic|gemini> MODEL=<id> [BASE_URL=<url>]"; exit 1 ;; esac
	@test -n "$(MODEL)" || { echo "usage: make use-custom DIALECT=<anthropic|gemini> MODEL=<id> [BASE_URL=<url>]"; exit 1; }
	@sh app/scripts/set-env-var.sh $(TENANT_ENV) BAXTER_HARNESS custom
	@sh app/scripts/set-env-var.sh $(TENANT_ENV) CUSTOM_API_DIALECT '$(DIALECT)'
	@sh app/scripts/set-env-var.sh $(TENANT_ENV) CUSTOM_API_MODEL '$(MODEL)'
	@if [ -n "$(BASE_URL)" ]; then sh app/scripts/set-env-var.sh $(TENANT_ENV) CUSTOM_API_BASE_URL '$(BASE_URL)'; fi
	@echo "harness -> custom, dialect $(DIALECT), model $(MODEL)."
	@base=$$(sed -n 's/^CUSTOM_API_BASE_URL=//p' $(TENANT_ENV) | head -1); \
	  if [ -n "$$base" ]; then echo "  endpoint: $$base"; \
	  elif [ "$(DIALECT)" = "gemini" ]; then echo "  endpoint: https://generativelanguage.googleapis.com (gemini default)"; \
	  else echo "  endpoint: https://api.anthropic.com (anthropic default)"; fi
	@grep -qE "^CUSTOM_API_KEY=." $(TENANT_ENV) || echo "  key: CUSTOM_API_KEY not set -- add the provider key (baxter set-key custom <key>)."
	@echo "  apply:  baxter down && baxter up"

# Bake a skill from the open ecosystem into app/skills/ + grants.ts -- the operator
# "install" step (discovery is Baxter's, via skills-cli find). Fetches with the
# ecosystem's own `npx skills add` into a temp dir, copies the vetted dir into
# app/skills/<name>/, and appends <name> to the shared SKILL_NAMES. NOTHING goes
# live until you review the new SKILL.md + `git diff` and rebuild -- it only stages
# working-tree changes. Needs host node + npx (same as running the skills CLI).
#   make add-skill SKILL=owner/repo@slug [NAME=<name>]
add-skill:
	@test -n "$(SKILL)" || { echo "usage: make add-skill SKILL=owner/repo@slug [NAME=<name>]"; exit 1; }
	node app/scripts/add-skill.ts "$(SKILL)" "$(NAME)"

# Behavioral-regression eval: drive Baxter (the pinned model) against evals/scenarios/
# and assert on his tool-use behavior. Calls a REAL model, so it needs the OpenRouter
# key/model from app/.env (a pre-deploy/nightly gate, not a per-commit test).
#   make eval                      run the whole suite
#   make eval SCENARIO=heartbeat   only matching scenarios
#   make eval EVAL_SAMPLES=1        faster/cheaper (one sample each)
eval:
	@cd app && \
	  OPENROUTER_API_KEY="$${OPENROUTER_API_KEY:-$$(grep -E '^OPENROUTER_API_KEY=' .env 2>/dev/null | cut -d= -f2-)}" \
	  OPENROUTER_MODEL="$${EVAL_MODEL:-$${OPENROUTER_MODEL:-$$(grep -E '^OPENROUTER_MODEL=' .env 2>/dev/null | cut -d= -f2-)}}" \
	  node evals/run.ts $(if $(SCENARIO),--scenario "$(SCENARIO)")
