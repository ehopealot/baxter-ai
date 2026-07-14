# syntax=docker/dockerfile:1
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

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
# `install --skills` itself never exits -- it spawns a persistent
# `cliDaemon.js` and just sits there once it's up, instead of exiting after
# writing the skill files. `timeout` cuts it off once the files are down
# (confirmed by testing they land well within a few seconds); `|| true`
# swallows the resulting killed-by-timeout exit code, which is expected.
RUN npm install -g @anthropic-ai/claude-code @playwright/cli@latest \
    && playwright-cli install-browser --with-deps \
    && chmod -R a+rX /opt/playwright-browsers \
    && (timeout 30 playwright-cli install --skills || true)

# Second browser path: invisible_playwright's anti-detect Firefox, driven by
# scripts/invisible_cli.py (installed as `invisible-cli` below) for sites that
# fingerprint/block ordinary automation. It's a Python library pinning
# playwright 1.55 (its patched Firefox's Juggler protocol), so it lives in its
# own venv -- entirely separate from the Node/@playwright/cli stack above,
# which can't drive this browser. The patched Firefox (~100MB, arm64 build
# published upstream) is fetched at build time into /opt (NOT /home/node,
# which the config volume shadows at runtime) via XDG_CACHE_HOME. Its
# "headless" is really headed-under-Xvfb (true headless is itself a detection
# signal), hence the xvfb package. chown so the runtime `node` user can read
# the binary and write the geoip cache alongside it.
ENV INVISIBLE_CACHE=/opt/invisible-cache
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-venv xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir "git+https://github.com/feder-cr/invisible_playwright.git" \
    && /opt/venv/bin/python -m playwright install-deps firefox \
    && XDG_CACHE_HOME=$INVISIBLE_CACHE /opt/venv/bin/python -m invisible_playwright fetch \
    && chown -R node:node $INVISIBLE_CACHE

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# `invisible-cli` on PATH -> the wrapper, run by the venv's Python so it picks
# up invisible_playwright + its pinned playwright 1.55 (the daemon re-execs
# sys.executable, so the venv is used for the background browser process too).
RUN printf '#!/bin/sh\nexec /opt/venv/bin/python /app/scripts/invisible_cli.py "$@"\n' \
      > /usr/local/bin/invisible-cli \
    && chmod +x /usr/local/bin/invisible-cli

# `discord-cli` on PATH -> the Node REST CLI the Discord run invokes as a
# subprocess (the sole holder of DISCORD_BOT_TOKEN besides discord-bot.mjs).
RUN printf '#!/bin/sh\nexec node /app/scripts/discord-cli.mjs "$@"\n' \
      > /usr/local/bin/discord-cli \
    && chmod +x /usr/local/bin/discord-cli

RUN chown -R node:node /app

USER node

CMD ["node", "scripts/poll.mjs"]
