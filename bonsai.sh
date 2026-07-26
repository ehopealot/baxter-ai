#!/usr/bin/env bash
# Host-side orchestration for `baxter shell bonsai` (via `make tui-run BONSAI=1`): a
# batteries-included, KEYLESS local brain so a brand-new user can talk to Baxter with no
# API key and be walked through setting up their real model/surfaces.
#
# A small 4-bit MLX chat model (default Llama-3.2-3B-Instruct-4bit, ~1.8 GB) is served on
# the HOST by mlx_lm.server (MLX needs Apple-Silicon/Metal, which the Docker/Colima VM can't
# reach), and the containerized TUI is pointed at it over host.docker.internal via the
# existing `openai` harness. macOS/Apple-Silicon only. Design:
# docs/superpowers/specs/2026-07-26-bonsai-local-model-design.md
set -euo pipefail

# --- config (env-overridable) ------------------------------------------------
BONSAI_DIR="${BONSAI_DIR:-.models}"
# Default: a 4-bit MLX chat model (mainline mlx supports 2-8 bit, NOT 1-bit -- the
# prism-ml 1-bit build needs a patched mlx). A 4-bit 3B is also far more coherent than a
# 1-bit 8B for the onboarding job. Override with BONSAI_MODEL=<any mlx-community model>.
BONSAI_MODEL="${BONSAI_MODEL:-mlx-community/Llama-3.2-3B-Instruct-4bit}"
# Not 8080 -- it's a very common port (dev servers, ssh -L forwards, ...); a distinctive
# default avoids colliding with whatever else the user is running.
BONSAI_PORT="${BONSAI_PORT:-8917}"
VENV="$BONSAI_DIR/mlx-venv"
MODEL_DIR="$BONSAI_DIR/$(basename "$BONSAI_MODEL")"
SERVER_LOG="${BONSAI_SERVER_LOG:-/tmp/bonsai-server.log}"
# Launch params passed from the Makefile (fallbacks let bonsai.sh be run directly too).
APP_IMAGE="${APP_IMAGE:-baxter-app}"
APP_NET="${APP_NET:-baxter-net}"
APP_CONFIG_VOLUME="${APP_CONFIG_VOLUME:-baxter-app-config}"
TUI_FLAGS="${TUI_FLAGS:-}"

platform_ok() { [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; }
have_mlx()    { [ -x "$VENV/bin/mlx_lm.server" ]; }
have_model()  { [ -f "$MODEL_DIR/config.json" ]; }
# The chat path mlx serves at (/v1/chat/completions vs bare /chat/completions) varies by
# version; model_ready() discovers it and stores the prefix here, and the launch folds it
# into OPENAI_BASE_URL so the harness (which appends /chat/completions) hits the right one.
CHAT_PREFIX="/v1"

# Ready = the MODEL actually answers a tiny real completion. NOT /health: mlx_lm.server
# binds the port and serves /health BEFORE the weights finish loading, so a health probe
# reports "up" while a real request would still block on the load. A max_tokens:1 chat
# probe confirms the model is truly loaded AND discovers the working chat path. A random
# squatter (ssh -L forward, other dev server) 404s this, so it's also the reuse check.
model_ready() {
  local prefix
  for prefix in /v1 ""; do
    if curl -sf -o /dev/null -m 30 -X POST "http://127.0.0.1:$BONSAI_PORT${prefix}/chat/completions" \
         -H 'content-type: application/json' \
         -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' 2>/dev/null; then
      CHAT_PREFIX="$prefix"
      return 0
    fi
  done
  return 1
}

# --check: report what it WOULD do and exit 0 (works off-Mac, so the branches are
# smoke-testable in CI/lint without touching MLX).
if [ "${1:-}" = "--check" ]; then
  echo "bonsai --check:"
  echo "  platform Darwin/arm64:  $(platform_ok && echo yes || echo NO)"
  echo "  mlx-lm venv ($VENV):    $(have_mlx && echo present || echo missing)"
  echo "  model ($MODEL_DIR):     $(have_model && echo present || echo missing)"
  echo "  would serve :$BONSAI_PORT and launch the TUI via host.docker.internal (openai harness)"
  exit 0
fi

# --- guards ------------------------------------------------------------------
if ! platform_ok; then
  echo "baxter shell bonsai needs macOS on Apple Silicon (MLX/Metal) -- detected $(uname -s)/$(uname -m)." >&2
  echo "Elsewhere, set up a real model/brain instead (e.g. \`baxter harness openrouter <model>\`; the help-user-setup skill walks you through it)." >&2
  exit 1
fi
command -v docker  >/dev/null 2>&1 || { echo "docker not found on PATH." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found (macOS ships it; else install from python.org)." >&2; exit 1; }
command -v curl    >/dev/null 2>&1 || { echo "curl not found on PATH." >&2; exit 1; }

# --- confirm before any install/download (a ~1.3 GB download + a pip install) ----
if ! have_mlx || ! have_model; then
  echo "First-time Bonsai setup will:"
  have_mlx   || echo "  - create a venv at $VENV and pip install mlx-lm"
  have_model || echo "  - download $BONSAI_MODEL (~1.3 GB) into $MODEL_DIR"
  printf "Proceed? [y/N] "
  read -r ans
  case "$ans" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "aborted."; exit 0 ;;
  esac
fi

# --- provision ---------------------------------------------------------------
if ! have_mlx; then
  echo "-> creating venv + installing mlx-lm (first run only)..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet mlx-lm
fi
if ! have_model; then
  echo "-> downloading $BONSAI_MODEL -> $MODEL_DIR..."
  BONSAI_MODEL="$BONSAI_MODEL" MODEL_DIR="$MODEL_DIR" "$VENV/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(os.environ["BONSAI_MODEL"], local_dir=os.environ["MODEL_DIR"])
PY
fi

# --- serve (reuse an already-running server; else start it + trap-kill on exit) ---
# --host 0.0.0.0 so the container can reach it via host.docker.internal (the default
# 127.0.0.1 bind is host-only). This exposes the model server on the local network for
# the session's lifetime -- acceptable for a dev onboarding tool.
if model_ready; then
  echo "-> reusing model server already on :$BONSAI_PORT"
else
  # If something ELSE is already listening on the port (not our model server -- e.g. an
  # ssh -L forward), bail with guidance rather than silently talking to it and 404ing.
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$BONSAI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $BONSAI_PORT is already in use by another process (not a model server)." >&2
    echo "Free it, or pick another port:  BONSAI_PORT=8918 baxter shell bonsai" >&2
    exit 1
  fi
  echo "-> starting mlx_lm.server on :$BONSAI_PORT (log: $SERVER_LOG)..."
  "$VENV/bin/mlx_lm.server" --model "$MODEL_DIR" --host 0.0.0.0 --port "$BONSAI_PORT" >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
  printf '%s' "-> waiting for the model to load (first token can take a bit)"
  # model_ready does a REAL completion, so a passing probe means the weights are loaded
  # and the chat path is known -- no launching the TUI onto a still-loading server.
  ready=""
  for _ in $(seq 1 40); do
    model_ready && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || { echo; echo "server exited early -- see $SERVER_LOG" >&2; exit 1; }
    printf "."; sleep 2
  done
  echo
  [ -n "$ready" ] || { echo "model didn't become ready -- see $SERVER_LOG" >&2; exit 1; }
fi
echo "-> model ready (chat path: ${CHAT_PREFIX:-/}chat/completions)"

# --- launch the containerized TUI pointed at the host server -----------------
# Deliberately KEYLESS: no --env-file, so no provider keys reach the 1-bit model's env
# and the onboarding kickoff (bothSurfacesUnconfigured) reliably fires. Config volume +
# network mirror APP_RUN_FLAGS (kept in sync with the Makefile) so memory/skills carry
# over and /code can reach codapi; --add-host makes host.docker.internal resolve on Colima.
# OPENAI_BASE_URL carries the discovered CHAT_PREFIX (the harness appends
# /chat/completions), so it hits whichever of /v1/chat/completions or /chat/completions
# this mlx build actually serves -- confirmed live by model_ready above.
# NOT `exec` -- the shell must survive the TUI so the EXIT trap can stop the server after.
echo "-> launching Baxter TUI on Bonsai..."
docker run -it --rm --memory=8g --shm-size=2g \
  --network "$APP_NET" -v "$APP_CONFIG_VOLUME:/home/node" \
  --add-host host.docker.internal:host-gateway \
  -e BAXTER_HARNESS=openai \
  -e OPENAI_BASE_URL="http://host.docker.internal:$BONSAI_PORT$CHAT_PREFIX" \
  -e OPENAI_MODEL="$BONSAI_MODEL" \
  "$APP_IMAGE" node scripts/tui.mjs $TUI_FLAGS
