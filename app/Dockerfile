# syntax=docker/dockerfile:1

# Base image pinned by manifest-list DIGEST, not the moving `node:22-slim` tag.
# `node:22-slim` gets re-published whenever Node/Debian ships a patch; when Docker
# then re-pulls a new digest, EVERY layer below `FROM` rebuilds (curl, the global
# CLIs, the python/xvfb apt + Firefox download, `npm ci`) -- turning a normally
# seconds-long `baxctl update` (source-only COPY at the end) into a multi-minute
# from-scratch base rebuild. Pinning the digest makes the base stable: it rebuilds
# only when we deliberately bump this line, so every update in between is a cache
# hit AND the image is reproducible (same discipline as the sha-pinned whisper
# model + the ARG-pinned CLI versions below). It's the multi-arch INDEX digest, so
# BuildKit still selects amd64/arm64 per --platform. To refresh (picks up upstream
# Node/Debian security patches -- do this deliberately, not implicitly):
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | sed 's/.*"token":"//;s/".*//')
#   curl -sI -H "Authorization: Bearer $TOKEN" \
#     -H "Accept: application/vnd.oci.image.index.v1+json" \
#     https://registry-1.docker.io/v2/library/node/manifests/22-slim | grep -i docker-content-digest
# (or `docker buildx imagetools inspect node:22-slim` -- its "Digest:" line IS the
# index digest; do NOT use `docker manifest inspect --verbose`, which prints a
# per-ARCH manifest digest per entry and no index digest -- pasting one breaks the
# aarch64/amd64 selection this build relies on). Then paste the new sha256 here AND
# update `container:` in .github/workflows/check.yml (kept in sync so CI runs under
# the same Node the image ships).
ARG NODE_IMAGE=node:22-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf

# ---- base image: browsers + node deps, no app source ----
# The app source is COPY'd only in `final`, so editing scripts never re-runs the browser installs or npm ci below.
FROM ${NODE_IMAGE} AS base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update && apt-get install -y --no-install-recommends curl

WORKDIR /app

# Cache the Playwright browser binary at a fixed image path instead of
# $HOME/.cache -- at runtime the persistent config volume is mounted over
# /home/node, which would otherwise shadow it on every container start.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

# Global CLIs, installed as root: the Claude Code CLI (to spawn `claude -p`
# per email) and the Playwright CLI (browser automation skill), plus the
# system libraries and browser binary needed to actually launch Chromium
# headless. Skill files land at ./.claude/skills (cwd-relative, confirmed by
# testing) so they're baked in here rather than /home/node, which the
# config volume mount would shadow at runtime.
#
# Versions default to `latest` (unchanged behavior) but are ARG-pinnable for a
# reproducible build (`--build-arg CLAUDE_CODE_VERSION=x.y.z`). The npm cache rides
# a BuildKit cache mount so a rebuild reuses already-downloaded tarballs.
#
# `install --skills` itself never exits -- it spawns a persistent
# `cliDaemon.js` and just sits there once it's up, instead of exiting after
# writing the skill files. `timeout` cuts it off once the files are down
# (confirmed by testing they land well within a few seconds); `|| true`
# swallows the resulting killed-by-timeout exit code, which is expected.
ARG CLAUDE_CODE_VERSION=latest
ARG PLAYWRIGHT_CLI_VERSION=latest
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" \
    && playwright-cli install-browser --with-deps \
    && chmod -R a+rX /opt/playwright-browsers \
    && (timeout 30 playwright-cli install --skills || true)

# Second browser path: invisible_playwright's anti-detect Firefox, driven by
# scripts/invisible_cli.py (installed as `invisible-cli` below) for sites that
# fingerprint/block ordinary automation. It's a Python library pinning
# playwright 1.55 (its patched Firefox's Juggler protocol), so it lives in its
# own venv -- entirely separate from the Node/@playwright/cli stack above,
# which can't drive this browser. `invisible_playwright fetch` pulls the patched
# Firefox (~100MB) for the build host's arch -- upstream publishes both arm64 and
# x86_64, so this builds on a Pi or an N100 alike -- at build time into /opt (NOT /home/node,
# which the config volume shadows at runtime) via XDG_CACHE_HOME. Its
# "headless" is really headed-under-Xvfb (true headless is itself a detection
# signal), hence the xvfb package. chown so the runtime `node` user can read
# the binary and write the geoip cache alongside it.
ENV INVISIBLE_CACHE=/opt/invisible-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-venv xvfb \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir "git+https://github.com/feder-cr/invisible_playwright.git" \
    && /opt/venv/bin/python -m playwright install-deps firefox \
    && XDG_CACHE_HOME=$INVISIBLE_CACHE /opt/venv/bin/python -m invisible_playwright fetch \
    && chown -R node:node $INVISIBLE_CACHE

# better-sqlite3 compiles a native addon. Its published package ships prebuilt
# binaries for linux-x64/linux-arm64 glibc (matching this base) and sets
# "gypfile": false to skip the build -- but `npm ci` (unlike `npm install`) runs
# the auto node-gyp-rebuild lifecycle anyway (verified: reproduces even off a
# lockfile-only install with no source changes), so the toolchain still has to
# be here or `npm ci` below fails. python3 is already pulled in by the
# invisible_playwright block above; make/g++ are not, so add them.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ util-linux

# Node deps in their own layer, keyed only on the manifest+lockfile, so a source
# edit (COPY . . in `final`) never re-installs. `npm ci` (not `npm install`) is
# lockfile-exact + reproducible; the npm cache rides a BuildKit cache mount.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---- final image: add the app source + shims ----
FROM base AS final

COPY . .

# `invisible-cli` on PATH -> the wrapper, run by the venv's Python so it picks
# up invisible_playwright + its pinned playwright 1.55 (the daemon re-execs
# sys.executable, so the venv is used for the background browser process too).
RUN printf '#!/bin/sh\nexec /opt/venv/bin/python /app/scripts/invisible_cli.py "$@"\n' \
      > /usr/local/bin/invisible-cli \
    && chmod +x /usr/local/bin/invisible-cli

# `discord-cli` on PATH -> the Node REST CLI the Discord run invokes as a
# subprocess (the sole holder of DISCORD_BOT_TOKEN besides discord-bot.ts).
RUN printf '#!/bin/sh\nexec node /app/scripts/discord-cli.ts "$@"\n' \
      > /usr/local/bin/discord-cli \
    && chmod +x /usr/local/bin/discord-cli

# `mail-cli` on PATH -> the Node mail CLI the mail/heartbeat/TUI runs invoke as a
# friendly name. Mirrors discord-cli above.
RUN printf '#!/bin/sh\nexec node /app/scripts/mail-cli.ts "$@"\n' \
      > /usr/local/bin/mail-cli \
    && chmod +x /usr/local/bin/mail-cli

# `sms-cli` on PATH -> the token-scoped Sendblue send CLI (sms-surface replies + heartbeat delivery).
RUN printf '#!/bin/sh\nexec node /app/scripts/sms-cli.ts "$@"\n' \
      > /usr/local/bin/sms-cli \
    && chmod +x /usr/local/bin/sms-cli

# `chat-cli` on PATH -> the Home Chats surface's send CLI (writes straight to
# chat-transcript.ts, no external provider -- mirrors the sms-cli shim above).
RUN printf '#!/bin/sh\nexec node /app/scripts/chat-cli.ts "$@"\n' \
      > /usr/local/bin/chat-cli \
    && chmod +x /usr/local/bin/chat-cli

# `code-cli` on PATH -> the token-less boundary CLI the run invokes to reach the
# remote Cloudflare executor through its Unix signing relay.
RUN printf '#!/bin/sh\nexec node /app/scripts/code-cli.ts "$@"\n' \
      > /usr/local/bin/code-cli \
    && chmod +x /usr/local/bin/code-cli

# `web-cli` on PATH -> credential-less web search (SearXNG) + fetch.
RUN printf '#!/bin/sh\nexec node /app/scripts/web-cli.ts "$@"\n' \
      > /usr/local/bin/web-cli \
    && chmod +x /usr/local/bin/web-cli

# `schedule-cli` on PATH -> Baxter's boundary to the heartbeat schedule (locked
# add/cancel/list). Granted to the email + Discord runs, NOT to a heartbeat-
# fired run (a scheduled task can't touch the schedule).
RUN printf '#!/bin/sh\nexec node /app/scripts/schedule-cli.ts "$@"\n' \
      > /usr/local/bin/schedule-cli \
    && chmod +x /usr/local/bin/schedule-cli

# `usage-cli` on PATH -> the run's per-tenant model-spend report (`/usage`).
RUN printf '#!/bin/sh\nexec node /app/scripts/usage-cli.ts "$@"\n' \
      > /usr/local/bin/usage-cli \
    && chmod +x /usr/local/bin/usage-cli

# `files-cli` on PATH -> the run's read-only, workspace-confined list/search
# (`list`/`grep`). The run has no `ls`/`grep`/`find`; this is the scoped analog,
# unable to escape MEMORY_DIR (so the tokens in the parent dir stay unreachable).
RUN printf '#!/bin/sh\nexec node /app/scripts/files-cli.ts "$@"\n' \
      > /usr/local/bin/files-cli \
    && chmod +x /usr/local/bin/files-cli

# `collections-cli` on PATH -> cross-cutting collection notes (make/list/open/save),
# one markdown file per collection under the shared MEMORY_DIR, so context carries
# across all four claude-spawning surfaces. Confined to COLLECTIONS_DIR like files-cli.
RUN printf '#!/bin/sh\nexec node /app/scripts/collections-cli.ts "$@"\n' \
      > /usr/local/bin/collections-cli \
    && chmod +x /usr/local/bin/collections-cli

# `memory-cli` on PATH -> CAS-protected access to the shared memory files
# (memory.md, CREDENTIALS.md) under MEMORY_DIR: read/append/write --expect, so
# concurrent runs across surfaces can't clobber each other's memory writes.
RUN printf '#!/bin/sh\nexec node /app/scripts/memory-cli.ts "$@"\n' \
      > /usr/local/bin/memory-cli \
    && chmod +x /usr/local/bin/memory-cli

# `calendar-cli` on PATH -> Baxter's calendar: manage its own events and
# poll/agenda the family's read-only feed.
RUN printf '#!/bin/sh\nexec node /app/scripts/calendar-cli.ts "$@"\n' \
      > /usr/local/bin/calendar-cli \
    && chmod +x /usr/local/bin/calendar-cli

# `checklist-cli` on PATH -> checkable-item lists (groceries, packing, todos):
# make/add/check/clear + `find` for natural-language "I did X" resolution. Distinct
# from collections-cli (checklists get completed + cleared; collections aggregate).
RUN printf '#!/bin/sh\nexec node /app/scripts/checklist-cli.ts "$@"\n' \
      > /usr/local/bin/checklist-cli \
    && chmod +x /usr/local/bin/checklist-cli

# `recipes-cli` on PATH -> step-oriented recipe store (list/show/save/rm). STATE_DIR
# store; save validates the format. Mirrors the checklist-cli shim above.
RUN printf '#!/bin/sh\nexec node /app/scripts/recipes-cli.ts "$@"\n' \
      > /usr/local/bin/recipes-cli \
    && chmod +x /usr/local/bin/recipes-cli

# `link-cli` on PATH -> resolve a list/chat/recipe to its home.bax.bot URL (read-only).
# Mirrors the recipes-cli shim above.
RUN printf '#!/bin/sh\nexec node /app/scripts/link-cli.ts "$@"\n' \
      > /usr/local/bin/link-cli \
    && chmod +x /usr/local/bin/link-cli

# `data-cli` on PATH -> curated data-source gateway (list/describe/<source> ...).
# Owns each source's host + any API key (read from DATA_KEYS_PATH at runtime, not
# env); the run supplies only the path + query params. Confined to each source's
# fixed base host like web-cli is to http(s).
RUN printf '#!/bin/sh\nexec node /app/scripts/data-cli.ts "$@"\n' \
      > /usr/local/bin/data-cli \
    && chmod +x /usr/local/bin/data-cli

# `skills-cli` on PATH -> read-only discovery into the open agent-skills ecosystem
# (skills.sh). `find` only -- NO install verb; host-locked to the registry; returns
# validated metadata for the run to SUGGEST, install stays an operator host action.
RUN printf '#!/bin/sh\nexec node /app/scripts/skills-cli.ts "$@"\n' \
      > /usr/local/bin/skills-cli \
    && chmod +x /usr/local/bin/skills-cli

RUN chown -R node:node /app

USER node

CMD ["node", "--import", "./scripts/drain-startup-alert-hook.ts", "scripts/mail-bot.ts"]
