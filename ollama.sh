#!/usr/bin/env bash
# Host-side orchestration for `baxter shell ollama` (via `make tui-run OLLAMA=1`): a
# batteries-included, KEYLESS local brain so a brand-new user can talk to Baxter with no
# API key and be walked through setting up their real model/surfaces.
#
# The model is served on the HOST by Ollama, and the containerized TUI points at it over
# host.docker.internal via the existing `openai` harness (Ollama's :11434 is that
# harness's default target). Ollama runs on macOS AND Linux, manages the model/quant/
# download itself (~/.ollama), and its server is robust. Design:
# docs/superpowers/specs/2026-07-26-local-model-design.md
set -euo pipefail

# --- config (env-overridable) ------------------------------------------------
DEFAULT_MODEL="qwen3.5:4b"                        # offered when the user has no models (newest small Qwen; native tool-calling)
OLLAMA_MODEL="${OLLAMA_MODEL:-}"                 # explicit model (positional/env); empty -> pick interactively
OLLAMA_PORT="${OLLAMA_PORT:-11434}"             # Ollama's default port (ours, not OLLAMA_HOST)
# Ollama caps context at 4096 by default; Baxter's prompt (system preamble + tools + the
# embedded onboarding guide) overflows that. Raise it on the server we start. This is
# Ollama's own env var, so a user's setting flows through. (Only applies to a server WE
# start -- a reused daemon keeps its own default; see the reused-server note below.)
OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-8192}"
SERVER_LOG="${OLLAMA_SERVER_LOG:-/tmp/baxter-ollama.log}"
# Launch params passed from the Makefile (fallbacks let ollama.sh be run directly too).
APP_IMAGE="${APP_IMAGE:-baxter-app}"
APP_NET="${APP_NET:-baxter-net}"
APP_CONFIG_VOLUME="${APP_CONFIG_VOLUME:-baxter-app-config}"
TUI_FLAGS="${TUI_FLAGS:-}"

have_ollama()      { command -v ollama >/dev/null 2>&1; }
# Ollama's native /api/tags is always up when the server is; a plain readiness signal.
server_up()        { curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:$OLLAMA_PORT/api/tags" 2>/dev/null; }
model_installed()  { ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$1"; }

# --check: report what it WOULD do and exit 0 (works anywhere, so the branches are
# smoke-testable without pulling a model).
if [ "${1:-}" = "--check" ]; then
  m="${OLLAMA_MODEL:-$DEFAULT_MODEL}"
  echo "ollama --check:"
  echo "  ollama installed:      $(have_ollama && echo yes || echo NO)"
  echo "  ollama server up:      $(server_up && echo yes || echo no)"
  echo "  model ($m):  $(have_ollama && model_installed "$m" && echo present || echo missing)"
  echo "  would serve on :$OLLAMA_PORT and launch the TUI via host.docker.internal (openai harness)"
  exit 0
fi

# --- guards ------------------------------------------------------------------
if ! have_ollama; then
  echo "baxter shell ollama needs Ollama -- a keyless local model runner (https://ollama.com)." >&2
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
  echo "-> using the Ollama server already on :$OLLAMA_PORT"
  echo "   (note: its own context limit applies -- if a request overflows, quit that Ollama"
  echo "    and re-run so this manages it, or set OLLAMA_CONTEXT_LENGTH on your daemon.)"
else
  echo "-> starting the Ollama server (ctx $OLLAMA_CONTEXT_LENGTH, log: $SERVER_LOG)..."
  # OLLAMA_HOST=0.0.0.0 so the container can reach it via host.docker.internal -- Ollama
  # binds 127.0.0.1 by default, which is host-loopback-only and unreachable from Docker.
  # OLLAMA_CONTEXT_LENGTH raises the 4096 default so Baxter's prompt fits.
  OLLAMA_HOST="0.0.0.0:$OLLAMA_PORT" OLLAMA_CONTEXT_LENGTH="$OLLAMA_CONTEXT_LENGTH" ollama serve >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do server_up && break; kill -0 "$SERVER_PID" 2>/dev/null || { echo "ollama server exited -- see $SERVER_LOG" >&2; exit 1; }; sleep 1; done
  server_up || { echo "ollama server didn't come up within 30s -- see $SERVER_LOG" >&2; exit 1; }
fi

# --- choose the model --------------------------------------------------------
# A model named explicitly (positional/env) is used as-is; otherwise show a NUMBERED
# list of installed models (pick by number or name), or offer the default if none.
if [ -z "$OLLAMA_MODEL" ]; then
  MODELS=()
  while IFS= read -r name; do [ -n "$name" ] && MODELS+=("$name"); done < <(ollama list 2>/dev/null | awk 'NR>1{print $1}')
  if [ "${#MODELS[@]}" -gt 0 ]; then
    echo "Installed Ollama models:"
    i=1; for m in "${MODELS[@]}"; do printf "  %2d) %s\n" "$i" "$m"; i=$((i + 1)); done
    printf "Pick a number or name [enter for %s]: " "$DEFAULT_MODEL"
    read -r pick
    if [ -z "$pick" ]; then
      OLLAMA_MODEL="$DEFAULT_MODEL"
    elif printf '%s' "$pick" | grep -qE '^[0-9]+$' && [ "$pick" -ge 1 ] && [ "$pick" -le "${#MODELS[@]}" ]; then
      OLLAMA_MODEL="${MODELS[$((pick - 1))]}"   # numbered pick (1-based -> 0-based)
    else
      OLLAMA_MODEL="$pick"                       # typed a name (may need a pull)
    fi
  else
    echo "No Ollama models are installed yet."
    OLLAMA_MODEL="$DEFAULT_MODEL"
  fi
fi

# --- pull the model if it isn't installed (confirm -- it's a download) -------
if ! model_installed "$OLLAMA_MODEL"; then
  printf "Model '%s' isn't installed -- download it now (a couple GB)? [Y/n] " "$OLLAMA_MODEL"
  read -r ans
  case "$ans" in
    [nN]|[nN][oO]) echo "aborted."; exit 0 ;;
  esac
  echo "-> pulling $OLLAMA_MODEL..."
  ollama pull "$OLLAMA_MODEL"
fi

# --- verify the server's effective context is big enough (fail UP FRONT) -----
# A reused daemon may cap num_ctx at Ollama's 4096 default, which 400s mid-chat once
# Baxter's prompt (~5k+) overflows. Warm the model up (a tiny request loads it with the
# server's num_ctx), then read the loaded context from /api/ps and check it here instead.
echo "-> loading $OLLAMA_MODEL + checking context size..."
curl -sf -o /dev/null -m 120 -X POST "http://127.0.0.1:$OLLAMA_PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$OLLAMA_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" 2>/dev/null || true
ctx="$(curl -s -m 5 "http://127.0.0.1:$OLLAMA_PORT/api/ps" 2>/dev/null | grep -o '"context_length":[0-9]*' | grep -o '[0-9]*' | head -1)"
# Only enforce when we could actually read it (older Ollama omits the field -> skip).
if [ -n "$ctx" ] && [ "$ctx" -lt 8192 ]; then
  echo "" >&2
  echo "Ollama's context is only $ctx tokens -- too small for Baxter (needs >= 8192; its" >&2
  echo "prompt + embedded setup guide is ~5k and grows). This is a reused server at Ollama's" >&2
  echo "default. Quit that Ollama and re-run so this manages it, or restart yours with:" >&2
  echo "    OLLAMA_CONTEXT_LENGTH=8192 ollama serve" >&2
  exit 1
fi
[ -n "$ctx" ] && echo "   context: $ctx tokens (ok)"

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
     node -e "fetch('http://host.docker.internal:$OLLAMA_PORT/api/tags',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "" >&2
  echo "The Baxter container can't reach Ollama at host.docker.internal:$OLLAMA_PORT." >&2
  echo "Ollama is probably bound to localhost only. Stop it, then restart it on all interfaces:" >&2
  echo "    OLLAMA_HOST=0.0.0.0 ollama serve" >&2
  echo "(If macOS prompts about incoming connections for 'ollama', click Allow.) Then re-run." >&2
  exit 1
fi

echo "-> launching Baxter TUI on the local model ($OLLAMA_MODEL via Ollama)..."
docker run -it --rm --memory=8g --shm-size=2g \
  --network "$APP_NET" -v "$APP_CONFIG_VOLUME:/home/node" \
  --add-host host.docker.internal:host-gateway \
  -e BAXTER_HARNESS=openai \
  -e OPENAI_BASE_URL="http://host.docker.internal:$OLLAMA_PORT/v1" \
  -e OPENAI_MODEL="$OLLAMA_MODEL" \
  "$APP_IMAGE" node scripts/tui.mjs $TUI_FLAGS
