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

.PHONY: build-dev dev build-app run auth app-shell

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
	docker run -it --rm \
		--memory=8g --shm-size=2g \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE)

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
