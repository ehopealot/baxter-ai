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

# Shared, CONTENT-ADDRESSED image tags. The app image bakes in NO tenant data -- all
# tenant config is runtime (env files + the mounted config volume) -- so tenants running
# the SAME code can share ONE image instead of a redundant $(PROJECT)-app per tenant
# (which rebuilt + stored a full image's worth of disk for each). But a plain shared
# mutable tag is unsafe when tenants can be at DIFFERENT revisions at once (mid-rollout,
# or one tenant updated and another not): a stale-checkout build would retag the shared
# name out from under a tenant that already deployed newer code, silently running it on
# code it never shipped. So the tag carries the checkout's short commit ($(APP_REV)):
# same revision => same tag => shared+reused; different revision => different tag => never
# clobbered -- for the APP + CODAPI-SERVER images. The other build axes are folded in the same
# way -- for codapi, CODAPI_RUNTIME (runc vs
# the gVisor runsc a hardened box bakes into codapi.json; a runsc/runc clobber would silently
# downgrade the socket-holding sandbox). build-codapi's per-run SANDBOX images (codapi/python-<rev>,
# codapi/node-<rev>) are rev-suffixed too: their names are rewritten into the box.json files at build
# (app/codapi/Dockerfile, from the SANDBOX_REV build arg) and the authz allowlist
# (app/codapi/authz/codapi-authz.rego) accepts the rev-suffix family -- so a stale-checkout build
# can't downgrade a live tenant's sandbox by name either.
# Per-tenant ISOLATION is unchanged -- COMPOSE_PROJECT_NAME, the
# $(PROJECT)-net network, the $(PROJECT)-app-config volume, and every container_name stay
# $(PROJECT)-scoped. APP_IMAGE/CODAPI_IMAGE are recursive (=), so CODAPI_RUNTIME
# (defined far below, or a target-specific / CLI override) resolve at each use, including
# inside the $(COMPOSE) invocations; APP_REV is captured once (:=). Only the *_BASE names
# are ?=-overridable, so an override (e.g. a registry name) keeps the -runsc/-rev
# safety suffixes appended rather than discarding them. Deploy flows re-parse in a sub-make
# AFTER `git checkout`, so APP_REV reflects the deployed rev. APP_REV also gets a `-dirty` suffix
# when the tree has uncommitted/untracked changes ANYWHERE in the repo -- deliberately broader than
# the ./app + app/codapi build contexts, since Makefile/compose edits also change what a fleet runs
# (the one blind spot is gitignored-but-not-dockerignored files INSIDE those contexts, so keep
# build-relevant generated files out of app/). So a hot-patched build can only clobber another dirty
# build, never a clean revision's shared tag -- `make run`/`build-app` have no clean-tree guard the
# way the deploy targets do.
# Cleanup on an already-running box: superseded rev tags accumulate, and the pre-content-addressing
# per-tenant images ($(PROJECT)-app / -codapi -- baxter-<id>-app on a multi-tenant box) are now
# orphaned. LIST the baxter image tags, then `docker rmi` the OLD-revision ones by hand -- keeping
# the current rev (`git rev-parse --short HEAD` in THIS core checkout, plus its -runsc/-dirty
# variants):
#   docker image ls --format '{{.Repository}}:{{.Tag}}' \
#     --filter reference='baxter-app*'     --filter reference='baxter-codapi*' \
#     --filter reference='baxter-*-app'    --filter reference='baxter-*-codapi' \
#     --filter reference='codapi/python-*' --filter reference='codapi/node-*'
# (list TAGS, not `-q` IDs: two rev tags share one ID on a cache-hit rebuild, and `docker rmi <ID>`
# then fails "referenced in multiple repositories". The baxter-*-app filters catch the per-tenant
# orphans without matching the rev-suffixed baxter-app-<rev> names; the codapi/* filters catch the
# now-rev-suffixed sandbox images.) Over-selection can't break a LIVE tenant: rmi won't DELETE an
# image any container (running OR stopped) still holds -- a tag sharing that image's ID is merely
# untagged. But an image with NO container -- an idle -runsc variant, or a stopped tenant's
# current rev on a multi-tenant box (tags are shared and tenants can sit on different revs) -- IS
# deleted outright, so check the rev suffix before each rmi. Do NOT `docker image prune -a`: it also
# deletes the searxng image and any idle CURRENT-rev images the by-hand approach keeps -- the
# codapi/python-<rev> / codapi/node-<rev> sandbox images, whose removal breaks
# /code until the next build.
APP_REV := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)$(shell git status --porcelain --untracked-files=normal 2>/dev/null | grep -q . && echo -dirty)
APP_IMAGE_BASE ?= baxter-app
APP_IMAGE = $(APP_IMAGE_BASE)-$(APP_REV)
CODAPI_IMAGE_BASE ?= baxter-codapi
CODAPI_IMAGE = $(CODAPI_IMAGE_BASE)$(if $(filter runsc,$(CODAPI_RUNTIME)),-runsc)-$(APP_REV)
# The per-run SANDBOX images codapi launches (named in app/codapi/sandboxes/*/box.json, allow-listed
# in the authz rego). Rev-suffixed for the same anti-clobber reason -- codapi resolves them by NAME
# at each run, so a stale-checkout build would otherwise downgrade every tenant's sandbox.
SANDBOX_PYTHON = codapi/python-$(APP_REV)
SANDBOX_NODE = codapi/node-$(APP_REV)
APP_CONFIG_VOLUME := $(PROJECT)-app-config

# Relocatable-fleet seam (env file): point a fleet at a per-tenant env file.
# Defaults to app/.env, so a plain `make run` AND every foreground docker-run
# target is unchanged; baxter-control passes TENANT_ENV=/agents/<id>/app.env.
# Override by passing TENANT_ENV=<path> as a make argument (like PROJECT); with
# ?= an env-prefix value is honored too (unlike PROJECT's := footgun). The
# comment MUST stay on its own line -- a trailing `# ...` on the assignment folds
# the spaces into the value and breaks `test -f`/`--env-file`.
TENANT_ENV ?= app/.env
BASE_ENV ?= app/base.env
BASE_SECRETS_ENV ?= app/base-secrets.env
# APP_ENV_FILE follows the TENANT_ENV seam directly (one knob, no APP_ENV alias)
# so check-env and the foreground docker-run targets (mail/discord/tui/
# app-shell) all agree on the effective env file.
APP_ENV_FILE := $(if $(wildcard $(BASE_ENV)),--env-file $(BASE_ENV),) $(if $(wildcard $(BASE_SECRETS_ENV)),--env-file $(BASE_SECRETS_ENV),) $(if $(wildcard $(TENANT_ENV)),--env-file $(TENANT_ENV),)
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
# Per-run sandbox OCI runtime baked into the codapi image (codapi.json box.runtime).
# `runc` by default so dev/Colima and un-provisioned boxes build unchanged; a
# gVisor-provisioned box exports CODAPI_RUNTIME=runsc (the Ansible codapi-hardening
# role sets it in the fleet's systemd env) so `make run` bakes runsc in.
CODAPI_RUNTIME ?= runc

# Shared docker-run flags for the FOREGROUND single-surface debug targets
# (`make mail` / `make discord`): memory/shm sizing, the shared network, env
# file, and the persistent config volume. The detached fleet runs via compose
# (see compose.yaml + `make run`), which encodes these same settings per service.
# -v source = APP_STATE_SRC (the TENANT_STATE seam, mirroring compose's
# ${TENANT_STATE:-config}), so a foreground `make mail/discord/tui/app-shell
# TENANT_ENV=.. TENANT_STATE=..` debugs the RIGHT tenant's env AND state, never a
# mix of tenant env + operator state.
APP_RUN_FLAGS := --memory=8g --shm-size=2g --network $(APP_NET) $(APP_ENV_FILE) -v "$(APP_STATE_SRC):/home/node"

# Which surfaces a fleet starts (Seam 3). Resolve an unset Make variable from
# the same tenant env file Compose passes to the containers, then fall back to
# the full default fleet. This makes profile selection and light-bot's runtime
# configuration one validated value. Command-line/environment assignments still
# intentionally override the tenant file.
# codapi carries no profile => always.
BAXTER_SURFACES ?= $(or $(shell test -f "$(TENANT_ENV)" && awk -F= '/^BAXTER_SURFACES=/{v=$$2} END{print v}' "$(TENANT_ENV)"),discord,sms,chat,home,mail,heartbeat)
LIFECYCLE_LOCK ?= /tmp/$(PROJECT)-lifecycle.lock
DRAIN_TIMEOUT_SECONDS ?= 300

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

# The five light daemons (mail/home/heartbeat/sms/chat) run consolidated in ONE
# container (compose's `light` service, scripts/light-bot.ts). The supervisor
# itself decides which of them to start from BAXTER_SURFACES (and `home` still
# encompasses `chat`, in-process); the Makefile only maps any-of-the-five to
# the `light` profile and drops the five names from the profile set.
LIGHT_SURFACES := $(filter home heartbeat sms chat mail,$(subst $(comma), ,$(BAXTER_SURFACES)))
NONLIGHT_SURFACES := $(filter-out home heartbeat sms chat mail,$(subst $(comma), ,$(BAXTER_SURFACES)))
empty :=
space := $(empty) $(empty)
# Comma-joined profile list: surviving surfaces + light (if any light surface
# is enabled) + search (if SEARXNG_LOCAL). strip keeps empties out of the join.
PROFILE_WORDS = $(strip $(NONLIGHT_SURFACES) $(if $(LIGHT_SURFACES),light,) $(if $(filter 1,$(SEARXNG_LOCAL)),search,))
PROFILE_CSV = $(subst $(space),$(comma),$(PROFILE_WORDS))

# `docker compose`, fed the project name + the shared image tags + the vars
# compose.yaml interpolates (incl. the TENANT_ENV/TENANT_STATE seams; empty
# TENANT_STATE => compose's `${TENANT_STATE:-config}` default, i.e. the named config
# volume). Inline (not a global `export`) so it can't leak into unrelated recipes.
# Recursive (=), not :=, so image tags resolve at each use. Compose only *runs* the images the build targets
# produce; `make run`/`stop` wrap it.
COMPOSE = COMPOSE_PROJECT_NAME=$(PROJECT) PROJECT=$(PROJECT) APP_IMAGE=$(APP_IMAGE) CODAPI_IMAGE=$(CODAPI_IMAGE) CODAPI_TMP=$(CODAPI_TMP) BASE_ENV=$(BASE_ENV) BASE_SECRETS_ENV=$(BASE_SECRETS_ENV) TENANT_ENV=$(TENANT_ENV) TENANT_STATE=$(TENANT_STATE) BAXTER_SURFACES=$(BAXTER_SURFACES) docker compose

.PHONY: build-dev dev build-app build-codapi check check-arch check-buildkit check-env check-surfaces ensure run drain clear-drain recover-drain run-mail deploy deploy-local mail discord home tui tui-run stop logs app-shell backup restore add-skill codapi searxng heartbeat harness use-claude use-openrouter use-openai use-local use-custom set-key release deploy-release deploy-main eval

DRAIN_CLI = docker run --rm -v "$(APP_STATE_SRC):/home/node" $(APP_IMAGE) node scripts/drain-cli.ts

# Standalone drain commands run the current checkout's CLI before they mutate
# drain state or stop containers, so make the content-addressed app image available
# locally first. The image is shared across tenants in this checkout, so lock the
# inspect-and-build transaction on the checkout directory before the per-fleet
# lifecycle lock. Pin the parent-resolved tag through the sub-make: a concurrent
# checkout/source change cannot make the build and the subsequent drain CLI disagree.
ENSURE_DRAIN_IMAGE = flock -x "$(CURDIR)" bash -ec 'docker image inspect "$$1" >/dev/null 2>&1 || { echo "drain image not built yet -- building once…"; $(MAKE) build-app APP_IMAGE="$$1"; }' _ "$(APP_IMAGE)"

drain: ensure
	@$(ENSURE_DRAIN_IMAGE)
	@flock -x "$(LIFECYCLE_LOCK)" bash -ec ' \
		$(DRAIN_CLI) begin; \
		for c in "$(PROJECT)-discord" "$(PROJECT)-light"; do docker inspect -f "{{.State.Running}}" "$$c" 2>/dev/null | grep -qx true && docker kill --signal SIGUSR1 "$$c"; done; \
		deadline=$$(( $$(date +%s) + $(DRAIN_TIMEOUT_SECONDS) )); \
		while :; do status="$$($(DRAIN_CLI) status)" || status=; echo "$$status"; leases=$$(printf "%s" "$$status" | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(JSON.parse(s).leaseCount===0?\"0\":\"1\"))") || leases=1; test "$$leases" = 0 && break; test $$(date +%s) -lt $$deadline || { echo "drain timed out; marker and containers retained" >&2; exit 1; }; sleep 1; done; \
		COMPOSE_PROFILES="discord,light" $(COMPOSE) stop discord light; echo "Baxter drained: intake closed and leases are zero"'

clear-drain:
	@$(ENSURE_DRAIN_IMAGE)
	@flock -x "$(LIFECYCLE_LOCK)" bash -ec '$(DRAIN_CLI) clear'

# Explicit stale-lease recovery. Docker is the liveness authority: stop every
# container that can own a run lease, verify none is running, only then erase
# the durable marker/lease records. Never substitute `drain-cli recover` alone.
recover-drain: ensure
	@$(ENSURE_DRAIN_IMAGE)
	@flock -x "$(LIFECYCLE_LOCK)" bash -ec ' \
		for c in "$(PROJECT)-discord" "$(PROJECT)-light"; do docker inspect -f "{{.State.Running}}" "$$c" 2>/dev/null | grep -qx true && docker stop "$$c"; done; \
		for c in "$(PROJECT)-discord" "$(PROJECT)-light"; do running=$$(docker inspect -f "{{.State.Running}}" "$$c" 2>/dev/null || true); test "$$running" != true || { echo "refusing stale-lease recovery: $$c is still running" >&2; exit 1; }; done; \
		docker rm -f "$(PROJECT)-voice" >/dev/null 2>&1 || true; $(DRAIN_CLI) recover; echo "Baxter drain state recovered after all app containers stopped"'


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

# Build the app image.
build-app: check-arch check-buildkit
	DOCKER_BUILDKIT=1 docker build -t $(APP_IMAGE) --build-arg TARGETARCH=$(CODAPI_ARCH) ./app

# Fail fast if the app env file (API key, sender allowlist, tokens) is
# missing. Without it the app-running targets build the whole image first and
# only fail at the very end: compose rejects the required env_file (run /
# heartbeat), while the docker-run targets (mail / discord) start with no env
# at all and the agent dies at runtime.
check-env:
	@test -f "$(TENANT_ENV)" || { echo "$(TENANT_ENV) missing -- copy app/.env.example and fill it in" >&2; exit 1; }

# Ensure the durable resources compose treats as `external` exist: the shared
# network and the config volume. Compose only manages containers, so these
# survive `docker compose down`. Idempotent -- inspect-or-create. (`make run`
# depends on this, so the volume exists before any daemon starts.)
ensure:
	@docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	@# Only the named-volume path needs the volume. When TENANT_STATE binds a host
	@# dir, the named volume is unused -- don't create 20 empty stray volumes.
	@test -n "$(TENANT_STATE)" || docker volume inspect $(APP_CONFIG_VOLUME) >/dev/null 2>&1 || docker volume create $(APP_CONFIG_VOLUME)

# Build the codapi images: the host-arch python/node sandboxes + the server image
# (pinned, arch-selected codapi binary + baked config). Separated from starting
# the container so compose can just reference the pre-built $(CODAPI_IMAGE) tag.
# NOT privileged at runtime -- the socket mount (in compose.yaml) lets it launch
# hardened sandbox siblings. `check-arch` gives a clear message on an
# unsupported/empty daemon arch instead of an opaque ADD-of-a-404 in the Dockerfile.
build-codapi: check-arch check-buildkit
	cp app/sandboxes/emit-artifacts.sh app/sandboxes/python/emit-artifacts.sh
	cp app/sandboxes/emit-artifacts.sh app/sandboxes/node/emit-artifacts.sh
	docker build -t $(SANDBOX_PYTHON) app/sandboxes/python
	docker build -t $(SANDBOX_NODE)   app/sandboxes/node
	docker build -t $(CODAPI_IMAGE) \
		--build-arg CODAPI_VERSION=$(CODAPI_VERSION) \
		--build-arg CODAPI_SHA256_ARM64=$(CODAPI_SHA256_ARM64) \
		--build-arg CODAPI_SHA256_AMD64=$(CODAPI_SHA256_AMD64) \
		--build-arg CODAPI_RUNTIME=$(CODAPI_RUNTIME) \
		--build-arg SANDBOX_REV=$(APP_REV) \
		--build-arg TARGETARCH=$(CODAPI_ARCH) app/codapi

# Reject empty or unsupported surface selections before building.
SUPPORTED_SURFACES := discord sms chat home mail heartbeat
check-surfaces:
	@test -n "$(strip $(BAXTER_SURFACES))" || { echo "BAXTER_SURFACES is empty -- delete the line to get the default (discord + the five light surfaces); a blank value would start no real surfaces (run: codapi only)" >&2; exit 1; }
	@for surface in $(subst $(comma), ,$(BAXTER_SURFACES)); do case " $(SUPPORTED_SURFACES) " in *" $$surface "*) ;; *) echo "unsupported BAXTER_SURFACES entry: $$surface" >&2; exit 1 ;; esac; done
# Bring up the DEFAULT fleet detached: Discord gateway + the consolidated light
# container (mail/home/heartbeat/sms/chat in one process, scripts/light-bot.ts)
# + codapi sandbox, each with a restart policy, via compose (compose.yaml). An
# explicitly supplied BAXTER_SURFACES narrows the runtime light set (the light
# container reads it from app/.env; unset runs all five). The Makefile builds
# the images + owns the network/volume; compose runs the containers. `up -d` is
# idempotent (recreates only changed services). Tear it all down with `make stop`.
run: check-surfaces check-env build-app build-codapi ensure
	@flock -x "$(LIFECYCLE_LOCK)" bash -ec '$(DRAIN_CLI) clear || { echo "drain marker has active leases; run make recover-drain only after confirming this fleet is down" >&2; exit 1; }; docker rm -f "$(PROJECT)-voice" >/dev/null 2>&1 || true; COMPOSE_PROFILES="$(PROFILE_CSV)" $(COMPOSE) up -d'
	@echo "Baxter up: surfaces [$(BAXTER_SURFACES)]$(if $(LIGHT_SURFACES), via $(PROJECT)-light,) + $(PROJECT)-codapi-svc$(if $(SEARXNG_SUFFIX), + $(PROJECT)-searxng,)"

# DEPRECATED target, kept only to fail loud: mail is a light surface now --
# the light supervisor starts the mail loop whenever `mail` is in
# BAXTER_SURFACES (from the env_file). A make-level alias cannot force it on
# (the supervisor never sees make's env), so an alias would look like success
# while starting nothing. Put mail in BAXTER_SURFACES and use `make run`.
run-mail:
	@echo "'make run-mail' is gone: mail runs inside the consolidated light container. Put 'mail' in BAXTER_SURFACES (app/.env or the tenant's app.env) and use 'make run'." >&2
	@exit 1

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
# run rebuilds the images (cached when nothing changed) and `compose up -d`
# recreates only the containers whose image or config changed; the external config
# volume + app/.env are left intact, so Baxter's memory, keys and schedule
# survive the redeploy. Mail follows BAXTER_SURFACES like every other surface.
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
	$(MAKE) run PROJECT=$(PROJECT)

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
	$(MAKE) run PROJECT=$(PROJECT)

# `baxter update main` -> return to (and pull) main, for bleeding-edge dev boxes.
# Handles the detached-HEAD state a prior `deploy-release` leaves.
deploy-main:
	@test -z "$$(git status --porcelain --untracked-files=normal)" || { echo "refusing to update: working tree has local edits or untracked files -- reconcile (git status) first" >&2; exit 1; }
	git checkout --quiet main
	git pull --ff-only origin main
	$(MAKE) run PROJECT=$(PROJECT)

# The mail surface alone, in the foreground (was the original `make run`). For
# running or debugging just the email daemon. Stops the light container first
# (the mail surface now lives inside it) so the two don't race the same inbox
# (single-link supersession -- one mail link wins); that stops ALL light
# surfaces with it, and `make run` brings them back.
mail: check-env build-app ensure
	-COMPOSE_PROFILES="light" $(COMPOSE) stop light 2>/dev/null
	@echo "note: light container stopped (ALL light surfaces: $${BAXTER_SURFACES:-?}) -- a foreground mail session would fight its mail link otherwise (single-link supersession). 'make run' brings them back."
	docker run -it --rm $(APP_RUN_FLAGS) $(APP_IMAGE)

# The Discord gateway alone, in the foreground. Same image + config volume as the
# mail surface (shares memory, skills, token), different entrypoint. Stops the compose-
# managed gateway first so the two don't both answer every message; it comes back
# on the next `make run`, which starts a detached copy alongside the others.
discord: check-env build-app ensure
	-COMPOSE_PROFILES="discord" $(COMPOSE) stop discord 2>/dev/null
	@echo "note: fleet gateway $(PROJECT)-discord stopped (if it was up); it stays down until the next 'make run'"
	docker run -it --rm $(APP_RUN_FLAGS) $(APP_IMAGE) node --import ./scripts/drain-startup-alert-hook.ts scripts/discord-bot.ts

# Baxter's interactive terminal (`baxter shell` -> this). Same flags as `make mail`
# (APP_RUN_FLAGS -- the --network $(APP_NET) matters so code-cli/`/code` reach codapi),
# but runs the TUI entrypoint. `-it` for the interactive REPL. Shares the config
# volume, so you talk to the REAL Baxter (his live memory/skills/collections). codapi
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

# Stop + remove the fleet. `compose down` (profiles pinned wide, so anything
# running gets a graceful stop, not just the SIGKILL of the mop-up below)
# clears the compose-managed containers; the trailing `docker rm -f` mops up any
# pre-compose containers of the same name and the retired mail container
# ($(PROJECT)-run) on boxes upgraded from standalone mail (silenced since it's
# a routine no-op afterward). Both leave the external
# network + config volume intact.
stop:
	-COMPOSE_PROFILES="discord,heartbeat,mail,home,sms,chat,light,search" $(COMPOSE) down
	# Also removes a legacy voice container from pre-removal deployments; it is not a supported service.
	-docker rm -f $(PROJECT)-run $(PROJECT)-discord $(PROJECT)-heartbeat $(PROJECT)-voice $(PROJECT)-home $(PROJECT)-sms $(PROJECT)-chat $(PROJECT)-light $(PROJECT)-searxng $(PROJECT)-codapi-svc >/dev/null 2>&1

# Follow logs from the whole fleet. COMPOSE_PROFILES enables the full set
# (discord,light,search) so the Discord gateway, light container
# (mail/home/heartbeat/sms/chat), and searxng's logs are included
# when they're running -- and, unlike a BAXTER_SURFACES-derived set,
# never drops a surface from the log view if that value drifted (harmless
# when they aren't). Goes through $(COMPOSE) because compose.yaml's
# `${PROJECT:?}`/`${CODAPI_TMP:?}` guards reject a bare `docker compose logs`.
logs:
	COMPOSE_PROFILES="discord,light,search" $(COMPOSE) logs -f

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

# Standalone way to add the consolidated light container to an already-running
# fleet. `heartbeat` is a legacy alias for this -- the heartbeat scheduler now
# runs inside the light container, not as its own service.
heartbeat: check-surfaces check-env build-app build-codapi ensure
	COMPOSE_PROFILES="light" $(COMPOSE) up -d light
	@echo "light container up ($(PROJECT)-light) -- runs whichever of mail/home/heartbeat/sms/chat are in BAXTER_SURFACES"


# Family-home web surface. Runs inside the consolidated light container
# (compose's `light` profile, scripts/light-bot.ts) alongside the other light
# surfaces -- mail/heartbeat/sms/chat -- the supervisor starts home (and,
# in-process, the Home Chats daemon it encompasses) whenever `home` is in
# BAXTER_SURFACES. Standalone way to bring that container up on an
# already-running fleet (as a standalone target). Idles cleanly if
# home-keys.json isn't provisioned yet (log once, no crash).
home: check-surfaces check-env build-app build-codapi ensure
	COMPOSE_PROFILES="light" $(COMPOSE) up -d light
	@echo "light container up ($(PROJECT)-light) -- home/chat run inside it when BAXTER_SURFACES includes home"

app-shell: build-app
	docker run -it --rm \
		$(APP_ENV_FILE) \
		-v "$(APP_STATE_SRC):/home/node" \
		$(APP_IMAGE) /bin/bash

# Snapshot Baxter's ENTIRE durable state -- everything under .mail-agent: his mind
# (memory-workspace: memory.md, CREDENTIALS.md, collections, learned-skills, per-
# channel notes, browser session), his schedule, and his tokens/keys/counters
# (mail-keys, discord-token, data-keys, send-state, invisible-state, ...). One tarball = the
# whole Baxter, for cloning him to another box (see deploy/README.md) or rollback.
# For a clean clone, `make stop` first so nothing is mid-write. The excludes drop
# Chromium's transient Singleton* lock/socket (a symlink + a socket that exist only
# while a browser is running) so a snapshot taken mid-run still restores (restore
# refuses non-regular files) -- anchored to the .playwright*/ browser dirs so they
# can never match an agent-authored file named Singleton* elsewhere. (busybox tar
# retries an unanchored exclude at every path component, which is why the old broad
# `*/Singleton*` matched at any depth; fnmatch runs with FNM_PATHNAME, so the
# trailing `*Singleton*` does NOT span `/` -- it catches Singleton* directly inside
# the .playwright*/ dir, where Chromium keeps its lock/socket.) An old backup may include
# collections/rendered/ from pre-JSON releases; current code neither reads nor writes it.
# NOTE: the tarball contains secrets (the Resend API key, the Discord token, any
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
				echo "refusing: $$RF looks like an OLD mind-only baxter-mind-* snapshot (every entry is under memory-workspace/). Restoring it as a full state would WIPE the tokens/schedule/keys/browser session it does NOT contain. Use a full baxter-state-* backup -- or set OLD_MIND=1 to force (then re-provision the mail identity with baxctl add/home)."; exit 1; \
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
#   memory-workspace/) unless OLD_MIND=1 forces it; if you force, re-provision the mail identity with baxctl add/home.

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
	@test -n "$(KEY)" || { echo "usage: make set-key TYPE=<openrouter|openai|anthropic|custom|resend|discord> KEY=<value>"; exit 1; }
	@case "$(TYPE)" in \
	    openrouter) var=OPENROUTER_API_KEY ;; \
	    openai)     var=OPENAI_API_KEY ;; \
	    anthropic)  var=ANTHROPIC_API_KEY ;; \
	    custom)     var=CUSTOM_API_KEY ;; \
	    resend)     var=RESEND_API_KEY ;; \
	    discord)    var=DISCORD_BOT_TOKEN ;; \
	    *) echo "unknown key type '$(TYPE)' -- one of: openrouter openai anthropic custom resend discord" >&2; exit 1 ;; \
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
