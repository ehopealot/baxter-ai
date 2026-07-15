# Baxter Code Execution via codapi — Design Spec

**Date:** 2026-07-14
**Status:** Approved design (supersedes the Piston design after an arm64 spike killed Piston)
**Component:** `app/` (the "Baxter Burgundy" agent)

## Goal

Give Baxter the ability to **write, run, and save/reuse Python and Node code** in a sandbox isolated from his own container — for computation, parsing, and data work he can't do through the browser-automation JS path he has today. Code runs **offline** (no network) in an ephemeral, resource-capped container, with a curated set of common libraries pre-installed.

Reuse the project's established boundary pattern: the spawned `claude -p` run's *granted* path to the sandbox is a scoped CLI (`code-cli`), exactly as it reaches Gmail via `gmail.mjs` and Discord via `discord-cli`. (Unlike those two, `code-cli` holds no secret, so per Security posture it's a scoping/convenience layer, not a hard boundary — the enforced limits live in codapi's own config.)

## Why codapi, not Piston/Judge0 (the arm64 story)

The original design chose **Piston**. A spike killed it: **this host is native `aarch64`** (`docker info` → Ubuntu 24.04 / aarch64; the app/CLAUDE.md docs describing Colima-on-Mac are stale). Runners built on `isolate` + prebuilt **amd64** language packages cannot run here:

- **Piston** (official amd64 image): API boots under emulation, but every execution fails with `clone failed: Invalid argument` — qemu-user can't emulate the namespace-creating `clone()` that isolate's sandbox needs.
- **otakulabz/piston-arm** (a native-arm64 engine): `clone` now works, but Piston's package index only serves **amd64** runtime binaries, so exec dies with `qemu-x86_64: … ld-linux-x86-64.so.2`. No arm64 runtime packages exist upstream.
- **Judge0**: same `isolate` foundation + amd64 language packs → same wall, and heavier (Postgres + Redis + workers).

**codapi** (`github.com/nalgeon/codapi`, MIT) wins because a *sandbox is just a Docker image you choose*. We point it at official multi-arch base images (`python:3.12-slim`, `node:20-slim`) with the libs baked in, so everything is **arm64-native — no emulation, no runtime-package building, and no separate lib-provisioning step** (the single biggest risk in the Piston design disappears). codapi is a small Go binary that shells out to the `docker` CLI to run each request in a fresh, hardened, offline container.

**Spike evidence (2026-07-14):** end-to-end `POST /v1/exec` on this host returned `ok:true`, `arch aarch64`, `numpy 2.5.1`, a real computed result, in ~100ms; a socket attempt inside the sandbox returned `Network is unreachable`.

## Non-goals

- **No arbitrary *host* code execution.** Baxter never gets the docker socket, bare `Bash`, or a raw `docker`/`node <script>` command. His granted path is `code-cli` (see Security posture for the unauthenticated-API caveat — the sandbox is reachable other ways on the network, but that yields only offline, capped, sandboxed execution, never host access).
- **No runtime package installation.** The sandbox is offline; libraries are baked into the sandbox images ahead of time, not `pip install`ed per run.
- **No networked code.** Executions run with no network (the primary safety property). If a real need for networked code emerges later, that's a separate, deliberate design.
- **No new languages beyond Python + Node** for v1 (codapi makes more trivial to add later — a new `sandboxes/<lang>` dir).

## Architecture

### codapi as a standing service
- A small **`baxter-codapi` image**: `FROM docker:cli` (the docker CLI, which codapi shells out to), with the pinned `codapi` `linux_arm64` binary and our config (`codapi.json` + `sandboxes/*`) **baked in** (COPYed at build). Baking config in — rather than bind-mounting it — is required under docker-outside-of-docker: a bind-mount source must resolve on the host daemon, and our config lives inside the dev/app filesystem, not on the host. Build context streams to the daemon, so the baked files always land.
- Started detached by a new **`make codapi`** target on the shared docker network **`<project>-net`**, with:
  - `-v /var/run/docker.sock:/var/run/docker.sock` — codapi drives the host daemon to launch sandbox siblings. **Not `--privileged`** (unlike Piston); the socket is the elevated grant.
  - `-v <host-tmp>:<host-tmp>` **at an identical path** + `-e TMPDIR=<host-tmp>` — so the per-request code dir codapi creates (`os.MkdirTemp`, honors `TMPDIR`) resolves on the host when it bind-mounts `<dir>:/sandbox:ro` into the sandbox. This is the one docker-outside-of-docker subtlety, proven in the spike.
  - Listens on port 1313, reachable on the network as `http://codapi:1313`. Not published to a host port (internal to the network).
- `make codapi` also builds the two **sandbox images** (`codapi/python`, `codapi/node`) on the host daemon, so `docker run codapi/python …` resolves.

### Shared network
- `make codapi` creates `<project>-net` if absent. `make run` / `make discord` gain `--network <project>-net` **and each ensures the network exists first** (so they never hard-fail when codapi hasn't been started — a review finding from the Piston plan, fixed here). Bridge networks still NAT out, so the app keeps its internet for Claude/Gmail/Discord.

### Sandbox images & codapi config
- **`app/sandboxes/python/Dockerfile`**: `FROM python:3.12-slim`, add a non-root `sandbox` user (home `/sandbox`), `pip install` the curated Python libs. **`app/sandboxes/node/Dockerfile`**: `FROM node:20-slim`, `sandbox` user, `npm install -g` (or a baked `node_modules`) the curated Node libs.
- **`app/codapi/codapi.json`**: the box defaults — `network:"none"`, `cap_drop:["all"]`, `writable:false` (read-only rootfs), non-root `user:"sandbox"`, plus the enforced ceilings `memory`, `nproc` (pids), `cpu`, step `timeout`, and `noutput`. These are the load-bearing limits (see Security posture).
- **`app/codapi/sandboxes/python/{box.json,commands.json}`** and **`.../node/…`**: `box.json` names the image (`codapi/python`); `commands.json` defines the `run` command (`engine:"docker"`, `entry:"main.py"`/`"main.js"`, one step invoking the interpreter).
- **Curated libraries** (offline-usable only — no HTTP clients like `requests`/`axios`, since the sandbox has no network; **fetching happens outside** the sandbox via the browser CLIs or `WebFetch`, and only *parsing/computation* happens inside):
  - Python: `numpy`, `pandas`, `python-dateutil`, `beautifulsoup4`
  - Node: `lodash`, `dayjs`
  - (Kept small and listed in one place — the two Dockerfiles — so it's easy to extend.)

### `code-cli` — the boundary
- `app/scripts/code-cli.mjs`, installed on PATH as `code-cli` (Dockerfile shim, like `discord-cli`). Usage:
  `code-cli python|node [--file <path>]` — the program is read from **stdin** (default) or `--file`.
- POSTs to `http://codapi:1313/v1/exec` with `{ sandbox, command:"run", files:{ "": <source> } }` and returns the run's **stdout, stderr, and ok/exit** in a readable form. No version resolution is needed (the sandbox name — `python`/`node` — fully identifies the runtime, unlike Piston's version lookup). `code-cli`'s only ceiling knobs are codapi's config; the CLI just selects the sandbox and passes the code.
- Fails clearly when codapi is unreachable ("code sandbox unavailable — is `make codapi` running?"). The reachability hint matches **only** connection errors (`ECONNREFUSED`/fetch failure), never every error.
- Holds **no credential** — unlike `gmail.mjs`/`discord-cli`, its job is scoping the run to the sandbox, not protecting a secret.
- The run's `--allowedTools` gains `Bash(code-cli *)` (both daemons).

### Skill & prompt
- **`app/skills/code/SKILL.md`** documents the `code-cli` surface: the two languages, the available libraries, stdin-vs-`--file`, that execution is **offline** and resource/time-capped, and the write→run→save→reuse loop. Added to both daemons' `SKILL_SRCS`, and **`"code"` added to `BAKED_SKILL_NAMES`** in `runtime.mjs` (so a learned skill can't shadow it).
- A prompt line in `prompt.md` and `discord-prompt.md`: run Python/Node via `code-cli` for computation/parsing (with the named libs, offline), and note it's separate from the browser-automation JS path.

### Save & reuse
- Baxter writes `.py`/`.js` to his `memory-workspace` cwd (persists on the config volume), runs with `code-cli python --file script.py`, and re-runs anytime — the same write→save→reuse loop he already has for playwright scripts, plus he can capture a reusable pattern as a learned skill.

## Security posture

- **Offline execution** is the core property — `network:"none"` on every run, so even a prompt-injected run can only compute and read the output; there's no exfil path from the sandbox. (Baxter feeding a secret *into* the sandbox is a non-issue precisely because the sandbox can't reach the network.)
- **Ephemeral + capped + hardened** — each run is a fresh `docker run --rm` with `--cap-drop all`, `--read-only` rootfs, a non-root user, and `--memory`/`--pids-limit`/`--cpus`/timeout ceilings from `codapi.json`.
- **Socket isolation** — the elevated grant (the docker socket) lives in codapi's container, never Baxter's; his *granted* path is `code-cli` → HTTP, and `Bash` stays scoped (never grant raw `docker`/bare `Bash`). codapi is **not privileged** — a strictly smaller grant than the Piston design's privileged container, though the socket is still host-root-equivalent (see residual risk).
- **The codapi API is unauthenticated and network-reachable from Baxter's container** (including via browser JS through `playwright-cli`/`invisible-cli` `eval` to `http://codapi:1313`). So `code-cli` is a *convenience/scoping* layer, not a hard boundary — accepted, because the worst case is code execution he already has through `code-cli` anyway, bounded by the sandbox being **offline, capped, ephemeral, non-root, and caps-dropped**. The one thing this makes load-bearing: **per-run limits must be pinned in `codapi.json`** (network/memory/pids/timeout), so a direct `/v1/exec` call can't request an un-hardened run — codapi applies the box config server-side regardless of caller, so this holds.
- **Residual risk** — the codapi container holds the **docker socket** (host-root-equivalent), so a compromise *of codapi itself* reaches the host, and a container-escape from a sandbox would need to also defeat the drop-caps/read-only/non-root/offline hardening first. This is the same class of accepted risk as Piston running privileged (Piston is widely run for public Discord bots on this exact posture); mitigated by keeping codapi and the base images updated, and by the sandbox hardening above. Documented in `app/CLAUDE.md`. (Optional hardening for later: an authenticated proxy in front of codapi, or `runtime:"runsc"` (gVisor) per-sandbox for kernel-level isolation.)
- No credentials live in the sandbox.

## Components / files

**Created:**
- `app/scripts/code-cli.mjs` — the boundary CLI.
- `app/scripts/code-cli.test.mjs` — unit tests for its pure helpers.
- `app/skills/code/SKILL.md` — the `code` skill.
- `app/sandboxes/python/Dockerfile`, `app/sandboxes/node/Dockerfile` — the arm64 sandbox images (libs baked in).
- `app/codapi/codapi.json` — codapi box/step config (the enforced limits).
- `app/codapi/sandboxes/python/{box.json,commands.json}`, `app/codapi/sandboxes/node/{box.json,commands.json}` — codapi sandbox definitions.
- `app/codapi/Dockerfile` — the `baxter-codapi` server image (`FROM docker:cli` + pinned binary + config).

**Modified:**
- `Makefile` — `codapi` target (build sandbox images + server image, run codapi on `<project>-net` with socket + `TMPDIR`-matched mount); `<project>-net` network; `--network` + network-ensure on `run`/`discord`.
- `app/Dockerfile` — install the `code-cli` shim on PATH.
- `app/scripts/poll.mjs`, `app/scripts/discord-bot.mjs` — `Bash(code-cli *)` in `allowedTools`; `code` added to `SKILL_SRCS`.
- `app/scripts/runtime.mjs` — `"code"` added to `BAKED_SKILL_NAMES`.
- `app/prompt.md`, `app/discord-prompt.md` — the `code-cli` line.
- `app/.env.example` — one optional knob, `CODAPI_URL` (default `http://codapi:1313`), plus a comment pointing at `app/codapi/codapi.json` + `make codapi` as where the enforced limits are tuned. (No limit/version env vars: `.env` reaches only the *app* container via `--env-file`, while the limits are baked into the codapi *server image* and the version/sha are Makefile vars — dangling env knobs would change nothing.)
- `app/CLAUDE.md` — a "Code execution" section (architecture, the offline/socket posture, the arm64/codapi rationale, the docker-outside-of-docker `TMPDIR` note, socket-isolation and residual-risk notes).

## Testing

- **Unit (`node:test`):** `code-cli` pure helpers — arg/flag parsing, request-body construction (`{sandbox,command,files}`), output formatting (ok/stdout/stderr), and the codapi-unreachable error path (mock the fetch; assert the hint fires only on connection errors).
- **Integration (codapi up):** `code-cli python` running `print(2+2)` and `import numpy; print(numpy.__version__)`; `code-cli node` running `console.log` and a lib; an **offline check** (code that opens a network socket fails), confirming no exfil path.
- **End-to-end:** `make codapi`, then a Discord/email message asking Baxter to compute something with a lib; confirm he runs it via `code-cli` and reports the result, and that a `.py` he saves is re-runnable.

## Acceptance criteria

1. `make codapi` brings up a standing, offline codapi sandbox with Python + Node and the curated libs, on the shared network, arm64-native (no emulation).
2. `make run` / `make discord` join that network (creating it if needed); Baxter can run Python and Node via `code-cli` (stdin or `--file`) and gets stdout/stderr/ok back.
3. Executions are offline (a socket attempt fails) and resource/time-capped **by `codapi.json`** (a direct `/v1/exec` bypassing `code-cli` still gets the hardened box); the curated libs import successfully.
4. Baxter's *granted* path to the sandbox is `code-cli` — no docker socket, raw `docker`, or bare `Bash` in his container — with the understanding that the codapi API is otherwise network-reachable, so the enforced limits live in `codapi.json`, not the CLI.
5. Baxter can save a script to `memory-workspace` and re-run it; the `code` skill documents the surface and can't be shadowed by a learned skill.
6. The email and Discord agents are otherwise unchanged.
