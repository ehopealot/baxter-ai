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
# which can't drive this browser. `invisible_playwright fetch` pulls the patched
# Firefox (~100MB) for the build host's arch -- upstream publishes both arm64 and
# x86_64, so this builds on a Pi or an N100 alike -- at build time into /opt (NOT /home/node,
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

# Voice surface (voice-bot.mjs): ffmpeg (@discordjs/voice transcodes the TTS WAV
# to 48k stereo Opus through it) + Piper, a fast neural TTS. Piper is a
# self-contained binary + an ONNX voice model, fetched sha256-pinned (like the
# codapi binary) into /opt -- NOT /home/node, which the config volume shadows at
# runtime. Verified on aarch64: real-time factor ~0.03, 22050 Hz mono WAV out.
# The whole block is inert unless the voice daemon runs (off by default).
ENV PIPER_DIR=/opt/piper \
    PIPER_VOICE=/opt/piper/voices/en_US-lessac-medium.onnx
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/piper/voices \
    && curl -fsSL -o /tmp/piper.tgz "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz" \
    && echo "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb  /tmp/piper.tgz" | sha256sum -c - \
    && tar xzf /tmp/piper.tgz -C /opt && rm /tmp/piper.tgz \
    && curl -fsSL -o /opt/piper/voices/en_US-lessac-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" \
    && echo "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f  /opt/piper/voices/en_US-lessac-medium.onnx" | sha256sum -c - \
    && curl -fsSL -o /opt/piper/voices/en_US-lessac-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json" \
    && echo "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0  /opt/piper/voices/en_US-lessac-medium.onnx.json" | sha256sum -c - \
    && chmod -R a+rX /opt/piper
# `piper` on PATH -> the TTS binary with its bundled libs (.so next to it) on the
# loader path. voice-bot.mjs pipes text in and reads a WAV out.
RUN printf '#!/bin/sh\nexec env LD_LIBRARY_PATH=/opt/piper /opt/piper/piper "$@"\n' \
      > /usr/local/bin/piper \
    && chmod +x /usr/local/bin/piper

COPY package.json ./
RUN npm install --omit=dev \
    && node -e "require('@discordjs/voice');require('@snazzah/davey')" # fail the build if the DAVE arm64 binding didn't install (npm optional-deps bug)

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

# `code-cli` on PATH -> the token-less boundary CLI the run invokes to reach the
# offline codapi code-execution sandbox (raw fetch to http://codapi:1313).
RUN printf '#!/bin/sh\nexec node /app/scripts/code-cli.mjs "$@"\n' \
      > /usr/local/bin/code-cli \
    && chmod +x /usr/local/bin/code-cli

# `web-cli` on PATH -> credential-less web fetch + DuckDuckGo search (no key).
RUN printf '#!/bin/sh\nexec node /app/scripts/web-cli.mjs "$@"\n' \
      > /usr/local/bin/web-cli \
    && chmod +x /usr/local/bin/web-cli

# `schedule-cli` on PATH -> Baxter's boundary to the heartbeat schedule (locked
# add/cancel/list). Granted to the email + Discord runs, NOT to a heartbeat-
# fired run (a scheduled task can't touch the schedule).
RUN printf '#!/bin/sh\nexec node /app/scripts/schedule-cli.mjs "$@"\n' \
      > /usr/local/bin/schedule-cli \
    && chmod +x /usr/local/bin/schedule-cli

# `files-cli` on PATH -> the run's read-only, workspace-confined list/search
# (`list`/`grep`). The run has no `ls`/`grep`/`find`; this is the scoped analog,
# unable to escape MEMORY_DIR (so the tokens in the parent dir stay unreachable).
RUN printf '#!/bin/sh\nexec node /app/scripts/files-cli.mjs "$@"\n' \
      > /usr/local/bin/files-cli \
    && chmod +x /usr/local/bin/files-cli

RUN chown -R node:node /app

USER node

CMD ["node", "scripts/poll.mjs"]
