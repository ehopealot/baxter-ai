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
APP_ENV := app/.env
APP_ENV_FILE := $(if $(wildcard $(APP_ENV)),--env-file $(APP_ENV),)
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
# (`make gmail` / `make discord`): memory/shm sizing, the shared network, env
# file, and the persistent config volume. The detached fleet runs via compose
# (see compose.yaml + `make run`), which encodes these same settings per service.
APP_RUN_FLAGS := --memory=8g --shm-size=2g --network $(APP_NET) $(APP_ENV_FILE) -v "$(APP_CONFIG_VOLUME):/home/node"

# `docker compose`, fed the project name + the vars compose.yaml interpolates.
# Inline (not a global `export`) so it can't leak into unrelated recipes. Compose
# only *runs* the images the build targets produce; `make run`/`stop` wrap it.
COMPOSE := COMPOSE_PROJECT_NAME=$(PROJECT) PROJECT=$(PROJECT) CODAPI_TMP=$(CODAPI_TMP) docker compose

.PHONY: build-dev dev build-app build-codapi check-arch check-env ensure run run-gmail deploy deploy-local gmail discord voice stop logs auth app-shell backup restore codapi heartbeat harness use-claude use-openrouter use-local

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

build-app: check-arch
	docker build -t $(APP_IMAGE) --build-arg TARGETARCH=$(CODAPI_ARCH) ./app

# Fail fast if the app env file (tokens, OAuth creds, sender allowlist) is
# missing. Without it the app-running targets build the whole image first and
# only fail at the very end: compose rejects the required env_file (run /
# heartbeat), while the docker-run targets (gmail / discord) start with no env
# at all and the agent dies at runtime.
check-env:
	@test -f app/.env || { echo "app/.env missing -- copy app/.env.example and fill it in" >&2; exit 1; }

# Ensure the durable resources compose treats as `external` exist: the shared
# network and the config volume. Compose only manages containers, so these
# survive `docker compose down`; `make auth` also creates the volume on a fresh
# host. Idempotent -- inspect-or-create.
ensure:
	@docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	@docker volume inspect $(APP_CONFIG_VOLUME) >/dev/null 2>&1 || docker volume create $(APP_CONFIG_VOLUME)

# Build the codapi images: the host-arch python/node sandboxes + the server image
# (pinned, arch-selected codapi binary + baked config). Separated from starting
# the container so compose can just reference the pre-built $(PROJECT)-codapi tag.
# NOT privileged at runtime -- the socket mount (in compose.yaml) lets it launch
# hardened sandbox siblings. `check-arch` gives a clear message on an
# unsupported/empty daemon arch instead of an opaque ADD-of-a-404 in the Dockerfile.
build-codapi: check-arch
	cp app/sandboxes/emit-artifacts.sh app/sandboxes/python/emit-artifacts.sh
	cp app/sandboxes/emit-artifacts.sh app/sandboxes/node/emit-artifacts.sh
	docker build -t codapi/python app/sandboxes/python
	docker build -t codapi/node   app/sandboxes/node
	docker build -t $(PROJECT)-codapi \
		--build-arg CODAPI_VERSION=$(CODAPI_VERSION) \
		--build-arg CODAPI_SHA256_ARM64=$(CODAPI_SHA256_ARM64) \
		--build-arg CODAPI_SHA256_AMD64=$(CODAPI_SHA256_AMD64) \
		--build-arg TARGETARCH=$(CODAPI_ARCH) app/codapi

# Bring up the DEFAULT fleet detached: Discord gateway + heartbeat scheduler +
# codapi sandbox, each with a restart policy, via compose (compose.yaml). The
# Gmail poller is deliberately NOT started -- it's opt-in (experimental: Google
# OAuth overhead + a 7-day token), gated behind compose's `gmail` profile; use
# `make run-gmail` to include it. The Makefile builds the images + owns the
# network/volume; compose runs the containers. `up -d` is idempotent (recreates
# only changed services). Tear it all down with `make stop`.
run: check-env build-app build-codapi ensure
	$(COMPOSE) up -d
	@echo "Baxter up: $(PROJECT)-discord $(PROJECT)-heartbeat $(PROJECT)-codapi-svc (Gmail poller not managed by this target -- use 'make run-gmail')"

# Same as `make run`, plus the experimental Gmail poller ($(PROJECT)-run, gated in
# compose's `gmail` profile). Do `make auth` first so it has a valid token.
run-gmail: check-env build-app build-codapi ensure
	$(COMPOSE) --profile gmail up -d
	@echo "Baxter fleet up (incl. Gmail poller): $(PROJECT)-run $(PROJECT)-discord $(PROJECT)-heartbeat $(PROJECT)-codapi-svc"

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
# run-gmail rebuilds the images (cached when nothing changed) and `compose up -d`
# recreates only the containers whose image or config changed; the external config
# volume + app/.env are left intact, so Baxter's memory, tokens and schedule
# survive the redeploy. Swap run-gmail for `run` if you don't run the (opt-in,
# weekly-auth) Gmail poller.
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
	$(MAKE) run-gmail PROJECT=$(PROJECT)

# The Gmail poller alone, in the foreground (was the original `make run`). For
# running or debugging just the email daemon. Stops the compose-managed poller
# first (it lives in the `gmail` profile, hence `--profile gmail`) so the two
# don't race the same inbox (double-replies); it comes back on the next
# `make run-gmail`.
gmail: check-env build-app ensure
	-$(COMPOSE) --profile gmail stop run 2>/dev/null
	@echo "note: fleet poller $(PROJECT)-run stopped (if it was up); it stays down until the next 'make run-gmail'"
	docker run -it --rm $(APP_RUN_FLAGS) $(APP_IMAGE)

# The Discord gateway alone, in the foreground. Same image + config volume as the
# poller (shares memory, skills, token), different entrypoint. Stops the compose-
# managed gateway first so the two don't both answer every message; it comes back
# on the next `make run`, which starts a detached copy alongside the others.
discord: check-env build-app ensure
	-$(COMPOSE) stop discord 2>/dev/null
	@echo "note: fleet gateway $(PROJECT)-discord stopped (if it was up); it stays down until the next 'make run'"
	docker run -it --rm $(APP_RUN_FLAGS) $(APP_IMAGE) node scripts/discord-bot.mjs

# Stop + remove the fleet. `compose down` (with the gmail profile, so the profiled
# poller gets a graceful stop too, not just the SIGKILL of the mop-up below)
# clears the compose-managed containers; the trailing `docker rm -f` mops up any
# pre-compose containers of the same name (a one-time need on the first switch to
# compose, silenced since it's a routine no-op afterward). Both leave the external
# network + config volume intact.
stop:
	-$(COMPOSE) --profile gmail --profile voice down
	-docker rm -f $(PROJECT)-run $(PROJECT)-discord $(PROJECT)-heartbeat $(PROJECT)-voice $(PROJECT)-codapi-svc >/dev/null 2>&1

# Follow logs from the whole fleet. `--profile gmail --profile voice` so the
# opt-in poller's and voice bot's logs are included when they're running (harmless
# when they aren't). Goes through $(COMPOSE) because compose.yaml's
# `${PROJECT:?}`/`${CODAPI_TMP:?}` guards reject a bare `docker compose logs`.
logs:
	$(COMPOSE) --profile gmail --profile voice logs -f

# Just the codapi sandbox: build its images, then start it via compose.
codapi: build-codapi ensure
	$(COMPOSE) up -d codapi
	@echo "codapi running on $(APP_NET) at http://codapi:1313"

# Just the heartbeat scheduler via compose (its `depends_on` brings codapi up
# too, hence the codapi build).
heartbeat: check-env build-app build-codapi ensure
	$(COMPOSE) up -d heartbeat
	@echo "heartbeat driver running ($(PROJECT)-heartbeat)"

# "Fast Baxter" voice surface (opt-in, `voice` profile). Self-disables unless
# DISCORD_VOICE_CHANNEL_ID is set in app/.env (and the GuildVoiceStates intent is
# enabled in the Developer Portal). No codapi dependency -- it just joins voice.
voice: check-env build-app ensure
	$(COMPOSE) --profile voice up -d voice
	@echo "voice bot running ($(PROJECT)-voice) -- needs DISCORD_VOICE_CHANNEL_ID in app/.env to actually join"

auth: build-app
	docker run -it --rm \
		-p 8080:8080 \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE) node scripts/authorize.mjs

app-shell: build-app
	docker run -it --rm \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE) /bin/bash

# Snapshot Baxter's ENTIRE durable state -- everything under .mail-agent: his mind
# (memory-workspace: memory.md, CREDENTIALS.md, projects, learned-skills, per-
# channel notes, browser session), his schedule, and his tokens/keys/counters
# (gmail-token, data-keys, send-state, invisible-state, ...). One tarball = the
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
# contains secrets (the gmail token, any
# data-cli keys, CREDENTIALS.md) -- backups/ is gitignored; keep the tarball safe.
backup:
	@mkdir -p "$(BACKUP_DIR)"
	docker run --rm \
		-v "$(APP_CONFIG_VOLUME):/src:ro" \
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
	@holders=$$(docker ps --filter volume=$(APP_CONFIG_VOLUME) --format '{{.Names}}'); \
	 if [ -n "$$holders" ]; then \
	   echo "refusing: these running containers hold $(APP_CONFIG_VOLUME) and would race the restore:"; \
	   echo "  $$holders"; \
	   echo "run 'make stop' first, then restore, then start with your chosen config."; \
	   exit 1; \
	 fi
	@if [ "$(YES)" != "1" ]; then \
	   printf 'Replace Baxter'\''s ENTIRE state on %s with %s? This WIPES everything currently on the volume (mind, schedule, tokens, keys, browser session) and loads the snapshot. [y/N] ' "$(APP_CONFIG_VOLUME)" "$(RESTORE_FILE)"; \
	   read ans; case "$$ans" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1;; esac; \
	 fi
	docker run --rm \
		-e RF="$(RESTORE_FILE)" \
		-e OM="$(OLD_MIND)" \
		-v "$(APP_CONFIG_VOLUME):/dst" \
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
				echo "refusing: $$RF looks like an OLD mind-only baxter-mind-* snapshot (every entry is under memory-workspace/). Restoring it as a full state would WIPE the tokens/schedule/keys/browser session it does NOT contain. Use a full baxter-state-* backup -- or set OLD_MIND=1 to force (then re-run make auth)."; exit 1; \
			fi; \
			rm -rf /dst/.mail-agent; \
			tar xzf "/backup/$$RF" -C /dst'
	@echo "restored $(RESTORE_FILE) into $(APP_CONFIG_VOLUME) -- full state replaced (mind, schedule, tokens, keys, browser session)"
# ^ The listing check runs BEFORE the wipe (set -e aborts first): it rejects an
#   unreadable, empty, WRONG (typo'd path to some other tarball), or malformed
#   archive -- so a bad RESTORE_FILE never leaves the volume wiped-but-not-restored.
#   And since every accepted entry is a regular file/dir under .mail-agent/ with no
#   `..` component and no non-regular member (symlink/hardlink/fifo/device), the
#   extract cannot escape the volume or plant a special file. An OLD mind-only
#   `baxter-mind-*` tarball would pass those checks (its entries are under
#   .mail-agent/) yet restoring it as a full state would WIPE the tokens/schedule/
#   browser session it lacks -- so a dedicated check refuses it (every entry under
#   memory-workspace/) unless OLD_MIND=1 forces it; if you force, re-run `make auth`.

# Switch which brain drives Baxter by editing $(APP_ENV) in place -- only
# BAXTER_HARNESS and the model line change; API keys and everything else are left
# untouched. It edits the file only; redeploy to apply:  make stop && make run
#   make harness                                     # show the current setting
#   make use-claude                                  # back to Claude Code (the default)
#   make use-openrouter MODEL=z-ai/glm-4.6           # any tool-calling model on OpenRouter
#   make use-local MODEL=qwen3 [BASE_URL=http://host:11434/v1]   # Ollama / vLLM / etc.
harness:
	@grep -E "^(BAXTER_HARNESS|OPENROUTER_MODEL|OPENAI_MODEL|OPENAI_BASE_URL)=" $(APP_ENV) 2>/dev/null || echo "BAXTER_HARNESS unset -> claude (default)"

use-claude:
	@test -f $(APP_ENV) || { echo "$(APP_ENV) missing -- copy app/.env.example first"; exit 1; }
	@sh app/scripts/set-env-var.sh $(APP_ENV) BAXTER_HARNESS claude
	@echo "harness -> claude. Apply with:  make stop && make run"

use-openrouter:
	@test -f $(APP_ENV) || { echo "$(APP_ENV) missing -- copy app/.env.example first"; exit 1; }
	@test -n "$(MODEL)" || { echo "usage: make use-openrouter MODEL=<slug>   (e.g. z-ai/glm-4.6, from openrouter.ai/models)"; exit 1; }
	@sh app/scripts/set-env-var.sh $(APP_ENV) BAXTER_HARNESS openrouter
	@sh app/scripts/set-env-var.sh $(APP_ENV) OPENROUTER_MODEL '$(MODEL)'
	@grep -qE "^OPENROUTER_API_KEY=." $(APP_ENV) || echo "note: OPENROUTER_API_KEY is not set in $(APP_ENV) -- add it before redeploying."
	@echo "harness -> openrouter, model $(MODEL). Apply with:  make stop && make run"

use-local:
	@test -f $(APP_ENV) || { echo "$(APP_ENV) missing -- copy app/.env.example first"; exit 1; }
	@test -n "$(MODEL)" || { echo "usage: make use-local MODEL=<tag> [BASE_URL=<url>]"; exit 1; }
	@sh app/scripts/set-env-var.sh $(APP_ENV) BAXTER_HARNESS local
	@sh app/scripts/set-env-var.sh $(APP_ENV) OPENAI_MODEL '$(MODEL)'
	@if [ -n "$(BASE_URL)" ]; then sh app/scripts/set-env-var.sh $(APP_ENV) OPENAI_BASE_URL '$(BASE_URL)'; fi
	@echo "harness -> local, model $(MODEL). $(if $(BASE_URL),base $(BASE_URL).,Default base: Ollama http://localhost:11434/v1.) Apply with:  make stop && make run"
