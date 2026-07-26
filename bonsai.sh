#!/usr/bin/env bash
# Host-side orchestration for `baxter shell bonsai` (via `make tui-run BONSAI=1`): a
# batteries-included, KEYLESS local brain so a brand-new user can talk to Baxter with no
# API key and be walked through setting up their real model/surfaces.
#
# The model (prism-ml/Bonsai-8B-mlx-1bit, MLX 1-bit, ~1.3 GB) is served on the HOST by
# mlx_lm.server (MLX needs Apple-Silicon/Metal, which the Docker/Colima Linux VM can't
# reach), and the containerized TUI is pointed at it over host.docker.internal via the
# existing `openai` harness. macOS/Apple-Silicon only. Design:
# docs/superpowers/specs/2026-07-26-bonsai-local-model-design.md
set -euo pipefail

# --- config (env-overridable) ------------------------------------------------
BONSAI_DIR="${BONSAI_DIR:-.models}"
BONSAI_MODEL="${BONSAI_MODEL:-prism-ml/Bonsai-8B-mlx-1bit}"
BONSAI_PORT="${BONSAI_PORT:-8080}"
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
server_up()   { curl -sf "http://127.0.0.1:$BONSAI_PORT/v1/models" >/dev/null 2>&1; }

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
  echo "baxter shell bonsai needs macOS on Apple Silicon (MLX/Metal) — detected $(uname -s)/$(uname -m)." >&2
  echo "Elsewhere, set up a real model/brain instead (e.g. \`baxter harness openrouter <model>\`; the help-user-setup skill walks you through it)." >&2
  exit 1
fi
command -v docker  >/dev/null 2>&1 || { echo "docker not found on PATH." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found (macOS ships it; else install from python.org)." >&2; exit 1; }
command -v curl    >/dev/null 2>&1 || { echo "curl not found on PATH." >&2; exit 1; }

# --- confirm before any install/download (a ~1.3 GB download + a pip install) ----
if ! have_mlx || ! have_model; then
  echo "First-time Bonsai setup will:"
  have_mlx   || echo "  • create a venv at $VENV and pip install mlx-lm"
  have_model || echo "  • download $BONSAI_MODEL (~1.3 GB) into $MODEL_DIR"
  printf "Proceed? [y/N] "
  read -r ans
  case "$ans" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "aborted."; exit 0 ;;
  esac
fi

# --- provision ---------------------------------------------------------------
if ! have_mlx; then
  echo "→ creating venv + installing mlx-lm (first run only)…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet mlx-lm
fi
if ! have_model; then
  echo "→ downloading $BONSAI_MODEL → $MODEL_DIR…"
  BONSAI_MODEL="$BONSAI_MODEL" MODEL_DIR="$MODEL_DIR" "$VENV/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(os.environ["BONSAI_MODEL"], local_dir=os.environ["MODEL_DIR"])
PY
fi

# --- serve (reuse an already-running server; else start it + trap-kill on exit) ---
# --host 0.0.0.0 so the container can reach it via host.docker.internal (the default
# 127.0.0.1 bind is host-only). This exposes the model server on the local network for
# the session's lifetime — acceptable for a dev onboarding tool.
if server_up; then
  echo "→ reusing model server already on :$BONSAI_PORT"
else
  echo "→ starting mlx_lm.server on :$BONSAI_PORT (log: $SERVER_LOG)…"
  "$VENV/bin/mlx_lm.server" --model "$MODEL_DIR" --host 0.0.0.0 --port "$BONSAI_PORT" >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
  printf "→ waiting for the model to load"
  for _ in $(seq 1 90); do server_up && break; kill -0 "$SERVER_PID" 2>/dev/null || { echo; echo "server exited early — see $SERVER_LOG" >&2; exit 1; }; printf "."; sleep 1; done
  echo
  server_up || { echo "server didn't come up within 90s — see $SERVER_LOG" >&2; exit 1; }
fi

# --- launch the containerized TUI pointed at the host server -----------------
# Deliberately KEYLESS: no --env-file, so no provider keys reach the 1-bit model's env
# and the onboarding kickoff (bothSurfacesUnconfigured) reliably fires. Config volume +
# network mirror APP_RUN_FLAGS (kept in sync with the Makefile) so memory/skills carry
# over and /code can reach codapi; --add-host makes host.docker.internal resolve on Colima.
# NOT `exec` — the shell must survive the TUI so the EXIT trap can stop the server after.
echo "→ launching Baxter TUI on Bonsai…"
docker run -it --rm --memory=8g --shm-size=2g \
  --network "$APP_NET" -v "$APP_CONFIG_VOLUME:/home/node" \
  --add-host host.docker.internal:host-gateway \
  -e BAXTER_HARNESS=openai \
  -e OPENAI_BASE_URL="http://host.docker.internal:$BONSAI_PORT/v1" \
  -e OPENAI_MODEL="$BONSAI_MODEL" \
  "$APP_IMAGE" node scripts/tui.mjs $TUI_FLAGS
