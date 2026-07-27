# A batteries-included local brain — `baxter shell ollama`

## Motivation

A brand-new user has no API key and no configured surface, so the first-run TUI can
*tell* them to go get set up but has no brain to do it with until they've already done
the hard part (picked a provider, pasted a key). **`baxter shell ollama` closes that
gap:** a small local model that runs with **no key and no account** (via Ollama), so a
user can start talking to Baxter immediately and have it walk them through configuring
their *real* model/brain (and Discord/email). Batteries included; the local model's only
job is onboarding.

## Architecture

Host runs the model (Ollama); the containerized TUI points at it over
`host.docker.internal`. **No new harness** — the existing `openai` (formerly `local`)
harness already speaks OpenAI chat/completions, needs **no API key** for a local base
URL, and its default base URL *is* Ollama's `:11434`. **Model management is Ollama's
own** (`ollama pull` → `~/.ollama/models`): shared across projects, no repo-local
weights, Ollama owns versioning/GC/quantization.

```
baxter shell ollama [model]   →   make tui-run OLLAMA=1 [OLLAMA_MODEL=…]   →   ollama.sh (HOST)
  1. guard      ollama installed? (else: per-OS install hint) + docker/curl present
  2. serve      reuse a running Ollama, else `OLLAMA_HOST=0.0.0.0 ollama serve` (0.0.0.0
                so the container can reach it -- Ollama binds localhost by default) + trap
  3. pull       model missing → confirm [y/N] → `ollama pull <model>` (Ollama loads it on
                first request; no readiness/path guessing needed)
  4. preflight  a CONTAINER-side reachability probe to host.docker.internal:11434 -- a
                loopback bind or a blocking firewall is a CLEAR error, not a silent hang
  5. launch     docker run … -e BAXTER_HARNESS=openai
                  -e OPENAI_BASE_URL=http://host.docker.internal:11434/v1
                  -e OPENAI_MODEL=<model>   --add-host host.docker.internal:host-gateway
```

Cross-platform: Ollama runs on macOS (Metal) and Linux, so this isn't Apple-only.
Keyless by design — **no `--env-file`**, so no provider keys reach the local model's env
and the first-run onboarding kickoff (`bothSurfacesUnconfigured`) reliably fires.

### Entry point

An argument on the existing shell verb — no new command:

- `baxter shell`               → `make tui-run`                       (configured harness/model)
- `baxter shell <box>`         → SSH to box, run TUI                  (unchanged)
- `baxter shell ollama`        → `make tui-run OLLAMA=1`              (local model, default `qwen3.5:4b`)
- `baxter shell ollama <model>`→ `make tui-run OLLAMA=1 OLLAMA_MODEL=<model>` (any Ollama model)

`ollama` is a reserved first-arg keyword in `bin/baxter`'s `shell` verb; an optional
following positional is the model. When `OLLAMA=1`, the `tui-run` recipe delegates the
whole host-orchestration + launch to `ollama.sh` and skips `check-env` (a fresh user has
no `app/.env`; this runs a clean keyless env).

### Files

- **`ollama.sh`** (repo root) — the host orchestration (guard → serve → pull → preflight
  → launch → trap-cleanup). Has a `--check` mode that reports state without pulling.
- **`Makefile`** — `tui-run` gains an `OLLAMA` toggle (+ `OLLAMA_MODEL`) that shells to
  `ollama.sh`.
- **`bin/baxter`** — the `shell` verb recognizes `ollama [model]`.
- **`README.md`** — the "no key yet?" note. **`.gitignore`** — `/.models/` (leftover MLX
  cruft; Ollama uses `~/.ollama`).

## Config / env

`OLLAMA_MODEL` (default `qwen3.5:4b` -- newest small Qwen, native tool-calling + strong
for its size; earlier tries: qwen2.5:7b worked, llama3.2:3b was too weak at tools, and
1-bit 8B was incoherent), `OLLAMA_PORT` (default `11434`),
`OLLAMA_SERVER_LOG`. The `openai` harness reads `OPENAI_MODEL`/`OPENAI_BASE_URL`; a local
base URL needs no key.

## Caveats

- **1–8B local models are modest.** Fine for chatting and being talked through setup;
  don't expect fleet-grade reasoning. The TUI is a **terminal surface** (reply is final
  *text*, not a tool call), so plain chat works even if the model's tool-calling is weak.
- **Shell-only.** Pointing the Discord/mail *daemons* at a local model stays a manual
  walkthrough (the in-shell model explains it); no daemon wiring here.
- First run downloads a couple GB via `ollama pull` — hence the explicit confirm.

## History — why not MLX (the road here)

v1 targeted the MLX 1-bit `prism-ml/Bonsai-8B-mlx-1bit` (hence the original "bonsai"
name). The MLX serving layer proved a dead-end on the first real Mac run, in order:
mainline `mlx` can't load 1-bit quant (`bits 1 not supported`); its default port 8080
collided with an `ssh -L` forward; `mlx_lm.server` serves `/health` 200 *before* the
weights load (so readiness lied); and finally the **container couldn't get a response
from `mlx_lm.server` even though the host could** (loopback worked, the docker-gateway
hop hung — single-threaded Python server and/or a loopback bind). Ollama fixes every one
of those: robust threaded server, stable `:11434`, `ollama pull` handles the model, and
`OLLAMA_HOST=0.0.0.0` + the reachability preflight make the container hop explicit. MLX's
only edge (bleeding-edge Apple perf, exotic quants) isn't what onboarding needs.

## Deferred (not v1)

- Auto-installing Ollama (currently: guard + per-OS install hint).
- Running Ollama *in a container* on Linux (on the shared network, no `host.docker.internal`
  hop) as an alternative to the host daemon.
- Automating the daemons-on-local path (intentionally left to the in-shell walkthrough).
