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
CODAPI_SHA256 ?= c293b409f57ef788589081091cd915c75e2b0468aecc1549dfcc7943f45d3bd8

.PHONY: build-dev dev build-app run discord auth app-shell backup restore codapi

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

run: build-app
	docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	docker run -it --rm \
		--memory=8g --shm-size=2g \
		--network $(APP_NET) \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE)

# The Discord gateway daemon. Own container, same image + config volume as
# `run` (shares memory, skills, and the token), different entrypoint.
discord: build-app
	docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	docker run -it --rm \
		--memory=8g --shm-size=2g \
		--network $(APP_NET) \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE) node scripts/discord-bot.mjs

# The offline code-execution sandbox (codapi). Builds the arm64 python/node
# sandbox images + the codapi server image (config baked in), then runs codapi
# on the shared network. NOT privileged -- it gets the docker socket to launch
# hardened sandbox siblings. TMPDIR is bind-mounted at an identical host path so
# codapi's per-run code dir resolves on the host daemon (docker-outside-of-docker).
# Enforced limits (offline, memory, pids, timeout) live in app/codapi/codapi.json.
codapi:
	docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	docker build -t codapi/python app/sandboxes/python
	docker build -t codapi/node   app/sandboxes/node
	docker build -t $(PROJECT)-codapi \
		--build-arg CODAPI_VERSION=$(CODAPI_VERSION) \
		--build-arg CODAPI_SHA256=$(CODAPI_SHA256) app/codapi
	docker rm -f $(PROJECT)-codapi-svc >/dev/null 2>&1 || true
	docker run -d --name $(PROJECT)-codapi-svc --restart unless-stopped \
		--network $(APP_NET) --network-alias codapi \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $(CODAPI_TMP):$(CODAPI_TMP) \
		-e TMPDIR=$(CODAPI_TMP) \
		$(PROJECT)-codapi
	@echo "codapi running on $(APP_NET) at http://codapi:1313"

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
