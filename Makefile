PROJECT := $(notdir $(CURDIR))
IMAGE := $(PROJECT)-dev
CONFIG_VOLUME := $(PROJECT)-claude-config
ENV_FILE := $(if $(wildcard .env),--env-file .env,)

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
APP_ENV_FILE := $(if $(wildcard app/.env),--env-file app/.env,)
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

.PHONY: build-dev dev build-app build-codapi check-env ensure run run-gmail gmail discord stop logs auth app-shell backup restore codapi heartbeat

build-dev:
	docker build -t $(IMAGE) .

dev:
	docker run -it --rm \
		$(ENV_FILE) \
		-v "$(shell pwd):/app" \
		-v "$(CONFIG_VOLUME):/home/node" \
		$(if $(DOCKER_SOCK_EXISTS),-v "$(DOCKER_SOCK):/var/run/docker.sock",) \
		$(if $(DOCKER_GID),--group-add $(DOCKER_GID),) \
		$(IMAGE)

build-app:
	docker build -t $(APP_IMAGE) ./app

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
# hardened sandbox siblings. The arch guard fires here, at the point CODAPI_ARCH
# is produced, so an unsupported/empty daemon arch gives a clear message instead
# of an opaque ADD-of-a-404 deep in the Dockerfile.
build-codapi:
	@case "$(CODAPI_ARCH)" in arm64|amd64) ;; \
	  *) echo "cannot use daemon arch '$(CODAPI_ARCH)' (need arm64 or amd64; is docker running?)" >&2; exit 1 ;; esac
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
	-$(COMPOSE) --profile gmail down
	-docker rm -f $(PROJECT)-run $(PROJECT)-discord $(PROJECT)-heartbeat $(PROJECT)-codapi-svc >/dev/null 2>&1

# Follow logs from the whole fleet. `--profile gmail` so the poller's logs are
# included when it's running (harmless when it isn't). Goes through $(COMPOSE)
# because compose.yaml's `${PROJECT:?}`/`${CODAPI_TMP:?}` guards reject a bare
# `docker compose logs`.
logs:
	$(COMPOSE) --profile gmail logs -f

# Just the codapi sandbox: build its images, then start it via compose.
codapi: build-codapi ensure
	$(COMPOSE) up -d codapi
	@echo "codapi running on $(APP_NET) at http://codapi:1313"

# Just the heartbeat scheduler via compose (its `depends_on` brings codapi up
# too, hence the codapi build).
heartbeat: check-env build-app build-codapi ensure
	$(COMPOSE) up -d heartbeat
	@echo "heartbeat driver running ($(PROJECT)-heartbeat)"

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

# Snapshot Baxter's "mind" -- his memory files and any skills he's written --
# from the config volume into $(BACKUP_DIR)/baxter-mind-<timestamp>.tar.gz.
# The volume is mounted read-only; the transient browser scratch is excluded.
# Needs no image (uses alpine). Runs while the daemons are up. SECRETS: the
# archive includes memory.md, which stores account credentials in full -- keep
# it private (it's gitignored) and encrypt if you sync it anywhere.
backup:
	@mkdir -p "$(BACKUP_DIR)"
	docker run --rm \
		-v "$(APP_CONFIG_VOLUME):/src:ro" \
		-v "$(CURDIR)/$(BACKUP_DIR):/backup" \
		alpine tar czf "/backup/baxter-mind-$$(date +%Y%m%d-%H%M%S).tar.gz" \
			-C /src --exclude='.playwright' --exclude='.playwright-cli' \
			.mail-agent/memory-workspace
	@ls -lh "$(BACKUP_DIR)" | tail -1

# Restore a snapshot back into the config volume:
#   make restore RESTORE_FILE=backups/baxter-mind-20260714-120000.tar.gz
# Overwrites memory files with the archived versions (does not delete others).
restore:
	@test -n "$(RESTORE_FILE)" || { echo "set RESTORE_FILE=backups/<file>.tar.gz"; exit 1; }
	docker run --rm \
		-v "$(APP_CONFIG_VOLUME):/dst" \
		-v "$(CURDIR):/backup:ro" \
		alpine tar xzf "/backup/$(RESTORE_FILE)" -C /dst
	@echo "restored $(RESTORE_FILE) into $(APP_CONFIG_VOLUME)"
