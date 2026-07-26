# Bonsai — a batteries-included local brain for `baxter shell`

## Motivation

A brand-new user has no API key and no configured surface, so today the first-run TUI
can *tell* them to go get set up but has no brain to do it with until they've already
done the hard part (picked a provider, pasted a key). **Bonsai closes that gap:** a tiny
1-bit local model that runs with **no key and no account**, so a user can `baxter shell
bonsai` and immediately talk to something that walks them through configuring their
*real* model/brain (and Discord/email). Batteries included; the local model's only job
is onboarding.

Model: [`prism-ml/Bonsai-8B-mlx-1bit`](https://huggingface.co/prism-ml/Bonsai-8B-mlx-1bit)
— MLX 1-bit, **1.30 GB**, Qwen3-8B base, 64k ctx, Apache-2.0, served by `mlx_lm.server`
(OpenAI-compatible).

> **Update — first real run (2026-07-26), the default model changed.** Mainline `mlx`
> only supports 2–8-bit quantization (`ValueError: bits 1 not supported`), so the
> `prism-ml` 1-bit build won't load without a patched mlx. The default is now
> **`mlx-community/Llama-3.2-3B-Instruct-4bit`** (~1.8 GB, 4-bit) — which is also far
> more coherent for the onboarding job than a 1-bit 8B — overridable via `BONSAI_MODEL`.
> Two other things the first run taught us, now fixed in `bonsai.sh`: the default port
> moved off **8080** (a common collision — an `ssh -L` forward held it) to **8917** with a
> "verify it's really the model server before reuse" check; and readiness is now a **real
> `max_tokens:1` completion**, not `/health` (mlx serves `/health` 200 *before* the
> weights load, so we were launching the TUI onto a still-loading server) — which also
> auto-discovers the chat path (`/v1/chat/completions` vs bare).

## The constraint that shapes the design

MLX is **Apple-Silicon/Metal only**, and the Docker/Colima Linux VM the TUI runs in
cannot touch Metal. So the **model server runs on the host**, and the containerized TUI
reaches it over `host.docker.internal`. Consequences:

- **`baxter shell bonsai` is a macOS-on-Apple-Silicon convenience.** On anything else
  (e.g. the self-hosted Fedora box) the script **fails fast** with a clear message
  pointing at normal model setup. It is explicitly not a fleet/production path.
- The daemons (Discord/mail/heartbeat) are **out of scope** — this is shell-only. If a
  user wants the fleet on a local model, the in-shell Bonsai brain explains the manual
  `.env` steps (`BAXTER_HARNESS=openai` + `OPENAI_BASE_URL`); the `help-user-setup`
  skill already owns the "change your model/brain" walkthrough. No daemon wiring here.

## Architecture

Host runs the model; container runs the TUI; they meet over `host.docker.internal`.
**No new harness** — the existing `openai` (formerly `local`) harness already speaks
OpenAI chat/completions and needs **no API key** for a local base URL.

```
baxter shell bonsai   →   make tui-run BONSAI=1   →   bonsai.sh (HOST)
  1. guard      uname: Darwin + arm64, and `docker` present   (else: clear error, exit)
  2. detect     is mlx-lm importable in ./.models/mlx-venv?  is the model in ./.models?
  3. confirm    if EITHER is missing, print the plan (install mlx-lm, download ~1.3 GB
                into ./.models) and ask [y/N] — abort on anything but yes
  4. provision  python3 -m venv ./.models/mlx-venv ; pip install mlx-lm
                huggingface download → ./.models/Bonsai-8B-mlx-1bit
  5. serve      ./.models/mlx-venv/bin/mlx_lm.server --model ./.models/Bonsai-8B-mlx-1bit
                --port ${BONSAI_PORT:-8080}   (background); poll /v1/models until ready
  6. launch     docker run … (the existing tui-run flags) PLUS:
                  -e BAXTER_HARNESS=openai
                  -e OPENAI_BASE_URL=http://host.docker.internal:${BONSAI_PORT}/v1
                  -e OPENAI_MODEL=prism-ml/Bonsai-8B-mlx-1bit
                  --add-host host.docker.internal:host-gateway   (Colima needs this)
  7. cleanup    trap EXIT → kill the mlx_lm.server process group
```

### Entry point

Extend the **existing** shell entry point with an argument — no new verb/target:

- `baxter shell`         → `make tui-run`            (unchanged: configured harness/model)
- `baxter shell <box>`   → SSH to box, run TUI       (unchanged)
- `baxter shell bonsai`  → `make tui-run BONSAI=1`   (new: the host-orchestrated flow)

`bonsai` is a reserved first-arg keyword in `bin/baxter`'s `shell` verb; it sets
`BONSAI=1` on the `make tui-run` call. When `BONSAI=1`, the `tui-run` recipe delegates
the whole host-orchestration + launch to `bonsai.sh` instead of the plain `docker run`
(the host setup + server + trap can't live cleanly in a make recipe). `BONSAI=0`/unset
keeps `tui-run` exactly as it is today.

### Files

- **`bonsai.sh`** (repo root, beside `install.sh`/`bootstrap.sh`) — the host
  orchestration: guard → detect → confirm → provision → serve → launch the TUI → trap
  cleanup. Pure host bash; the only new code with real logic.
- **`Makefile`** — `tui-run` gains a `BONSAI` toggle that shells out to `bonsai.sh`;
  add `bonsai.sh`-relevant vars (`BONSAI_PORT`, model id) near the other config.
- **`bin/baxter`** — the `shell` verb recognizes a `bonsai` first arg and forwards it.
- **`.gitignore`** — ignore `/.models/` (venv + weights; ~1.3 GB, never committed).
- **`README.md`** — a short "Talk to Baxter with no key (`baxter shell bonsai`)" note
  with the macOS-only caveat.

## Config / env

The `openai` harness reads `OPENAI_MODEL` (required) and `OPENAI_BASE_URL` (defaults to
Ollama's `:11434`); a local base URL needs no `OPENAI_API_KEY`. `mlx_lm.server` is a
single-model server, so the request's `model` field is nominal — we still set
`OPENAI_MODEL` to the real id for clear logs. Knobs (all optional, sensible defaults):
`BONSAI_PORT` (8080), `BONSAI_MODEL` (`prism-ml/Bonsai-8B-mlx-1bit`), `BONSAI_DIR`
(`./.models`).

## Caveats (documented in the script + README)

1. **macOS/Apple-Silicon only** — guarded, fails fast elsewhere.
2. **1-bit 8B is low quality, and its tool-calling is unreliable.** This is fine for the
   job: the TUI is a **terminal surface**, where a reply is the model's final *text*, not
   a tool call — so plain chat works, and the onboarding kickoff + `onboardingHint`
   already inject the setup context into the prompt so Bonsai can talk a user through
   setup **without** loading a skill. It may fumble actually *loading* `help-user-setup`
   via the `Skill` tool; acceptable for "get talking without a key."
3. First run downloads ~1.3 GB and installs mlx-lm — hence the explicit confirm.

## Testing plan

- **Host script logic that's pure-ish** is factored so it can be checked without a Mac:
  the platform guard, the "already provisioned?" detection, and the confirm gate are
  small functions/branches; where practical, a `bats`-free smoke (`bonsai.sh --check`
  prints what it *would* do and exits 0) lets CI/lint exercise the branches. Bash logic
  that must touch MLX is verified manually.
- **The harness path is already covered** — `openai`/`local` has unit tests; pointing it
  at a local base URL adds no new runner code.
- **Manual acceptance (on the Mac):** `baxter shell bonsai` cold (installs, downloads,
  serves, TUI opens, onboarding kickoff fires, a chat round-trips), then warm (skips
  install/download, starts fast), then on exit the server is gone (no orphaned
  `mlx_lm.server`). Plus the guard: run on Linux → clean refusal.

## Deferred (not v1)

- A cross-platform **GGUF + Ollama/llama.cpp** variant (runs in-container, no Mac needed
  but slower on CPU) — the model ships GGUF quants too; revisit if non-Mac onboarding
  matters.
- Model-size choice / swap via `BONSAI_MODEL` beyond the 8B (a smaller/faster default).
- Automating the daemons-on-local path (intentionally left to the in-shell walkthrough).
- **Generalize to any local LLM in `./.models`** (user idea): let `baxter shell` run
  against an arbitrary user-supplied local model — MLX *or* a GGUF via Ollama/llama.cpp —
  built into `./.models`, not just the pinned Bonsai. `BONSAI_MODEL`/`BONSAI_DIR` are the
  seams; the generalization is a model-agnostic `baxter shell local <id>` plus a
  runtime-selector (MLX-server vs Ollama) around the same host-serve/point-the-TUI flow.
