#!/usr/bin/env bash
# Host-side orchestration for `baxter shell bonsai` (via `make tui-run BONSAI=1`): a
# batteries-included, KEYLESS local brain so a brand-new user can talk to Baxter with no
# API key and be walked through setting up their real model/surfaces.
#
# The model is served on the HOST by Ollama, and the containerized TUI points at it over
# host.docker.internal via the existing `openai` harness (Ollama's :11434 is that
# harness's default target). Ollama runs on macOS AND Linux, manages the model/quant/
# download itself, and its server is robust -- so none of the MLX serving fragility.
# Design: docs/superpowers/specs/2026-07-26-bonsai-local-model-design.md
set -euo pipefail

# --- config (env-overridable) ------------------------------------------------
BONSAI_MODEL="${BONSAI_MODEL:-llama3.2:3b}"     # any name `ollama pull` accepts
BONSAI_PORT="${BONSAI_PORT:-11434}"             # Ollama's default port
SERVER_LOG="${BONSAI_SERVER_LOG:-/tmp/bonsai-ollama.log}"
# Launch params passed from the Makefile (fallbacks let bonsai.sh be run directly too).
APP_IMAGE="${APP_IMAGE:-baxter-app}"
APP_NET="${APP_NET:-baxter-net}"
APP_CONFIG_VOLUME="${APP_CONFIG_VOLUME:-baxter-app-config}"
TUI_FLAGS="${TUI_FLAGS:-}"

have_ollama() { command -v ollama >/dev/null 2>&1; }
# Ollama's native /api/tags is always up when the server is; a plain readiness signal.
server_up()   { curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:$BONSAI_PORT/api/tags" 2>/dev/null; }
have_model()  { ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$BONSAI_MODEL"; }

# --check: report what it WOULD do and exit 0 (works anywhere, so the branches are
# smoke-testable without pulling a model).
if [ "${1:-}" = "--check" ]; then
  echo "bonsai --check:"
  echo "  ollama installed:      $(have_ollama && echo yes || echo NO)"
  echo "  ollama server up:      $(server_up && echo yes || echo no)"
  echo "  model ($BONSAI_MODEL):  $(have_ollama && have_model && echo present || echo missing)"
  echo "  would serve on :$BONSAI_PORT and launch the TUI via host.docker.internal (openai harness)"
  exit 0
fi

# --- guards ------------------------------------------------------------------
if ! have_ollama; then
  echo "baxter shell bonsai needs Ollama -- a keyless local model runner (https://ollama.com)." >&2
  case "$(uname -s)" in
    Darwin) echo "Install it:  brew install ollama   (or download the app from https://ollama.com)" >&2 ;;
    Linux)  echo "Install it:  curl -fsSL https://ollama.com/install.sh | sh" >&2 ;;
    *)      echo "Install it from https://ollama.com, then re-run." >&2 ;;
  esac
  exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH." >&2; exit 1; }
command -v curl   >/dev/null 2>&1 || { echo "curl not found on PATH." >&2; exit 1; }

# --- ensure the Ollama server is running -------------------------------------
# On macOS the Ollama app usually runs it already; otherwise start `ollama serve` and
# stop it on exit. If it was already up (the user's own daemon), we leave it alone.
if server_up; then
  echo "-> using the Ollama server already on :$BONSAI_PORT"
else
  echo "-> starting the Ollama server (log: $SERVER_LOG)..."
  # OLLAMA_HOST=0.0.0.0 so the container can reach it via host.docker.internal -- Ollama
  # binds 127.0.0.1 by default, which is host-loopback-only and unreachable from Docker.
  OLLAMA_HOST="0.0.0.0:$BONSAI_PORT" ollama serve >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do server_up && break; kill -0 "$SERVER_PID" 2>/dev/null || { echo "ollama server exited -- see $SERVER_LOG" >&2; exit 1; }; sleep 1; done
  server_up || { echo "ollama server didn't come up within 30s -- see $SERVER_LOG" >&2; exit 1; }
fi

# --- pull the model if missing (confirm first -- it's a download) ------------
if ! have_model; then
  echo "First-time Bonsai setup will download the model '$BONSAI_MODEL' via Ollama (a couple GB)."
  printf "Proceed? [y/N] "
  read -r ans
  case "$ans" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "aborted."; exit 0 ;;
  esac
  echo "-> pulling $BONSAI_MODEL..."
  ollama pull "$BONSAI_MODEL"
fi

# --- launch the containerized TUI pointed at the host Ollama server ----------
# Deliberately KEYLESS: no --env-file, so no provider keys reach the local model's env
# and the onboarding kickoff (bothSurfacesUnconfigured) reliably fires. Config volume +
# network mirror APP_RUN_FLAGS (kept in sync with the Makefile) so memory/skills carry
# over and /code can reach codapi; --add-host makes host.docker.internal resolve on Colima.
# Ollama serves the OpenAI-compatible API under /v1, so OPENAI_BASE_URL ends in /v1 (the
# harness appends /chat/completions). Ollama loads the model on the first request itself.

# Preflight: confirm the CONTAINER can actually reach Ollama (same path the TUI uses),
# so a loopback-bound server or a blocking firewall is a clear error, not a silent hang.
echo "-> checking the container can reach Ollama on the host..."
if ! docker run --rm --add-host host.docker.internal:host-gateway "$APP_IMAGE" \
     node -e "fetch('http://host.docker.internal:$BONSAI_PORT/api/tags',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "" >&2
  echo "The Baxter container can't reach Ollama at host.docker.internal:$BONSAI_PORT." >&2
  echo "Ollama is probably bound to localhost only. Stop it, then restart it on all interfaces:" >&2
  echo "    OLLAMA_HOST=0.0.0.0 ollama serve" >&2
  echo "(If macOS prompts about incoming connections for 'ollama', click Allow.) Then re-run." >&2
  exit 1
fi

echo "-> launching Baxter TUI on Bonsai ($BONSAI_MODEL via Ollama)..."
docker run -it --rm --memory=8g --shm-size=2g \
  --network "$APP_NET" -v "$APP_CONFIG_VOLUME:/home/node" \
  --add-host host.docker.internal:host-gateway \
  -e BAXTER_HARNESS=openai \
  -e OPENAI_BASE_URL="http://host.docker.internal:$BONSAI_PORT/v1" \
  -e OPENAI_MODEL="$BONSAI_MODEL" \
  "$APP_IMAGE" node scripts/tui.mjs $TUI_FLAGS
