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
# Arch-select the Piper binary the same way codapi/Dockerfile does (buildkit sets
# TARGETARCH to arm64/amd64; the Makefile also passes it), so the app image builds
# on arm64 AND amd64. Piper's release names differ (aarch64/x86_64), hence the map.
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_SHA256_ARM64=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb
ARG PIPER_SHA256_AMD64=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/piper/voices \
    && case "$TARGETARCH" in \
         arm64) PARCH=aarch64; PSHA="$PIPER_SHA256_ARM64" ;; \
         amd64) PARCH=x86_64;  PSHA="$PIPER_SHA256_AMD64" ;; \
         *) echo "unsupported TARGETARCH '$TARGETARCH' (need arm64 or amd64)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/piper.tgz "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PARCH}.tar.gz" \
    && echo "$PSHA  /tmp/piper.tgz" | sha256sum -c - \
    && tar xzf /tmp/piper.tgz -C /opt && rm /tmp/piper.tgz \
    # Bake a few voices (each sha-pinned) so the operator can switch via VOICE_NAME
    # without a rebuild: "hf/path speaker-name onnx-sha json-sha". lessac = the
    # default (neutral US); amy = US female; ryan = US male. `|| exit 1` fails the
    # build on any bad download/sha (a for-loop wouldn't propagate it otherwise).
    && for V in \
         "en_US/lessac/medium en_US-lessac-medium 5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0" \
         "en_US/amy/medium en_US-amy-medium b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18 95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77" \
         "en_US/ryan/medium en_US-ryan-medium abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a 44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d"; do \
         set -- $V; \
         curl -fsSL -o /opt/piper/voices/$2.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/$1/$2.onnx" \
         && echo "$3  /opt/piper/voices/$2.onnx" | sha256sum -c - \
         && curl -fsSL -o /opt/piper/voices/$2.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/$1/$2.onnx.json" \
         && echo "$4  /opt/piper/voices/$2.onnx.json" | sha256sum -c - \
         || exit 1; \
       done \
    && chmod -R a+rX /opt/piper
# `piper` on PATH -> the TTS binary with its bundled libs (.so next to it) on the
# loader path. voice-bot.mjs pipes text in and reads a WAV out.
RUN printf '#!/bin/sh\nexec env LD_LIBRARY_PATH=/opt/piper /opt/piper/piper "$@"\n' \
      > /usr/local/bin/piper \
    && chmod +x /usr/local/bin/piper

COPY package.json ./
RUN npm install --omit=dev \
    && node -e "require('@discordjs/voice');require('@snazzah/davey')" # fail the build if the arch-matching DAVE binding didn't install (npm optional-deps bug)

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
