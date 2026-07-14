# Baxter Code Execution via Piston — Design Spec

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan
**Component:** `app/` (the "Baxter Burgundy" agent)

## Goal

Give Baxter the ability to **write, run, and save/reuse Python and Node code** in a sandbox isolated from his own container — for computation, parsing, and data work he can't do through the browser-automation JS path he has today. Code runs **offline** (no network) in an ephemeral, resource-capped environment, with a curated set of common libraries pre-installed.

Reuse the project's established boundary pattern: the spawned `claude -p` run's *granted* path to the sandbox is a scoped CLI (`code-cli`), exactly as it reaches Gmail via `gmail.mjs` and Discord via `discord-cli`. (Unlike those two, `code-cli` holds no secret, so per Security posture it's a scoping/convenience layer, not a hard boundary — the enforced limits live in Piston's own config.)

## Non-goals

- **No arbitrary *host* code execution.** Baxter never gets the docker socket, bare `Bash`, or a raw `docker`/`node <script>` command. His granted path to the sandbox is `code-cli` (see Security posture for the unauthenticated-API caveat — the sandbox is reachable other ways, but only ever as offline, capped, sandboxed execution, never host access).
- **No runtime package installation.** The sandbox is offline; libraries are provisioned ahead of time, not `pip install`ed per run.
- **No networked code.** Executions run with no network (the primary safety property). If a real need for networked code emerges later, that's a separate, deliberate design.
- **No new languages beyond Python + Node** for v1 (Piston makes more trivial to add later).

## Why Piston, and the one risk

**Piston** (`engineer-man/piston`) is a self-hostable, purpose-built code-execution engine — the same tool many Discord "run code" bots use. It provides mature, multi-language sandboxing (via `isolate`/nsjail) and an existing catalog of language *runtime* packages, so Python and Node come off the shelf. Baxter reaches it over HTTP, so **the docker socket never touches Baxter's container** — Piston does its own sandboxing in its own (privileged) service.

**The one gap:** Piston's packages are *runtimes*, not library bundles — each execution runs against a **vanilla stdlib** environment, so `import numpy` fails out of the box. We close this with a **provisioning step** (not a from-scratch custom package): after Piston is up, install the vanilla `python`/`node` runtime packages, then `pip install` / `npm install` the curated libs **into those installed runtimes' directories** so every execution picks them up, offline.

⚠️ **This is the risk to retire first.** Whether "install libs into the installed Piston runtime" is actually picked up by Piston's execution environment on the current version is unverified. **Implementation Task 1 is a spike that proves it end-to-end** (provision numpy, run code that imports it). If it doesn't hold cleanly, the fallback is a **custom sandbox broker** (a small HTTP service, holding the socket, that runs code in ephemeral hardened containers built from our own lib-included images) — same external interface (`code-cli` → HTTP), so nothing downstream changes.

## Architecture

### Piston as a standing service
- Stock `ghcr.io/engineer-man/piston` container, started detached by a new **`make piston`** target, `--privileged` (its sandbox requires it), on a shared docker network **`<project>-net`**. Its `/piston/packages` is a named volume (`<project>-piston`) so provisioned runtimes + libs survive restarts. Listens on port 2000, reachable on the network as `http://piston:2000`. Not published to a host port (kept internal to the network).
- Piston runs **privileged**, but it's a separate, controlled container Baxter cannot influence (he can't change its launch flags or reach its socket). `code-cli` is his intended path, but note it is not the *only* one: Piston's API is unauthenticated and on the same network, and Baxter's `playwright-cli`/`invisible-cli` can `goto http://piston:2000` and `eval` a same-origin `fetch` straight to it. See Security posture — the practical consequence is that per-run limits must be pinned in **Piston's own config**, not just set in `code-cli`'s request.

### Shared network
- `make piston` creates `<project>-net` if absent. `make run` / `make discord` gain `--network <project>-net` so the app container can resolve `piston`. (Bridge networks still NAT out, so the app keeps its internet for Claude/Gmail/Discord.)

### `code-cli` — the boundary
- `app/scripts/code-cli.mjs`, installed on PATH as `code-cli` (Dockerfile shim, like `discord-cli`). Usage:
  `code-cli python|node [--file <path>] [--timeout-ms <n>]` — the program is read from **stdin** (default) or `--file`.
- POSTs to `http://piston:2000/api/v2/execute` with `{ language, version, files:[{content}], stdin, run_timeout, run_memory_limit }` and returns the run's **stdout, stderr, and exit code** (plus compile output for compiled langs — N/A for python/node) in a readable form. `code-cli`'s request limits are a convenience/default; the **enforced** ceiling is Piston's own `max_*` config (see below), since the API is reachable without going through `code-cli`.
- Resolves the runtime `version` from Piston's `/api/v2/runtimes` (so it isn't hard-coded to drift). Fails clearly when Piston is unreachable ("code sandbox unavailable — is `make piston` running?").
- Holds **no credential** — unlike `gmail.mjs`/`discord-cli`, its job is scoping the run to the sandbox, not protecting a secret.
- The run's `--allowedTools` gains `Bash(code-cli *)` (both daemons).

### Provisioning
- **`make piston-provision`** (idempotent): (1) wait for the Piston API to be ready; (2) install the `python` and `node` runtime packages via Piston's package API; (3) install the curated libs into those installed runtimes so they're available offline at exec time. Exact install mechanics (`docker exec piston …` + the runtime's `pip`/`npm`, targeting the right site-packages / module path) are pinned down in the plan after the Task-1 spike confirms the approach.
- **Curated libraries** (offline-usable only — no HTTP clients like `requests`/`axios`, since the sandbox has no network; **fetching happens outside** the sandbox via the browser CLIs or `WebFetch`, and only *parsing/computation* happens inside):
  - Python: `numpy`, `pandas`, `python-dateutil`, `beautifulsoup4` (parse HTML Baxter pipes in)
  - Node: `lodash`, `dayjs`
  - (Kept small and listed in one place so it's easy to extend.)

### Skill & prompt
- **`app/skills/code/SKILL.md`** documents the `code-cli` surface: the two languages, the available libraries, stdin-vs-`--file`, that execution is **offline** and resource/time-capped, and the write→run→save→reuse loop. Added to both daemons' `SKILL_SRCS`, and **`"code"` added to `BAKED_SKILL_NAMES`** in `runtime.mjs` (so a learned skill can't shadow it).
- A prompt line in `prompt.md` and `discord-prompt.md`: run Python/Node via `code-cli` for computation/parsing (with the named libs, offline), and note it's separate from the browser-automation JS path.

### Save & reuse
- Baxter writes `.py`/`.js` to his `memory-workspace` cwd (persists on the config volume), runs with `code-cli python --file script.py`, and re-runs anytime — the same write→save→reuse loop he already has for playwright scripts, plus he can capture a reusable pattern as a learned skill.

## Security posture

- **Offline execution** is the core property — no network in the sandbox, so even a prompt-injected run can only compute and read the output; there's no exfil path from the sandbox. (Baxter feeding a secret *into* the sandbox is a non-issue precisely because the sandbox can't reach the network.)
- **Ephemeral + capped** — each run is a fresh, resource- and time-limited execution.
- **Socket isolation** — the docker socket / privilege lives in Piston's container, never Baxter's; his *granted* path is `code-cli` → HTTP, and `Bash` stays scoped (never grant raw `docker`/bare `Bash`).
- **The Piston API is unauthenticated and network-reachable from Baxter's container** (including via browser JS through `playwright-cli`/`invisible-cli` `eval`). So `code-cli` is a *convenience/scoping* layer, not a hard boundary — accepted, because the worst case is (a) code execution he already has through `code-cli` anyway, and (b) `/api/v2/packages` install/uninstall of Piston's own runtime packages. Both are bounded by the sandbox being **offline and ephemeral**. The one thing this makes load-bearing: **per-run time/memory maxima must be pinned in Piston's own config** (the `.env.example` knobs), so a direct `/execute` call can't request unbounded resources and exhaust the host. (Optional hardening for later: an authenticated proxy in front of Piston, or disabling `/api/v2/packages` after provisioning.)
- **Residual risk** — an `isolate`/kernel escape *inside Piston* → privileged container → host. This is the standard, accepted Piston model (widely run for public Discord bots); mitigated by keeping the Piston image updated. Documented in `app/CLAUDE.md`.
- No credentials live in the sandbox.

## Components / files

**Created:**
- `app/scripts/code-cli.mjs` — the boundary CLI.
- `app/scripts/code-cli.test.mjs` — unit tests for its pure helpers.
- `app/skills/code/SKILL.md` — the `code` skill.
- `scripts/piston-provision.sh` (or a `make` recipe) — idempotent runtime + lib provisioning.

**Modified:**
- `Makefile` — `piston`, `piston-provision` targets; `<project>-net` network; `--network` on `run`/`discord`.
- `app/Dockerfile` — install the `code-cli` shim on PATH.
- `app/scripts/poll.mjs`, `app/scripts/discord-bot.mjs` — `Bash(code-cli *)` in `allowedTools`; `code` added to `SKILL_SRCS`.
- `app/scripts/runtime.mjs` — `"code"` added to `BAKED_SKILL_NAMES`.
- `app/prompt.md`, `app/discord-prompt.md` — the `code-cli` line.
- `app/.env.example` — Piston knobs (runtime versions; per-exec time/memory **maxima**, applied to Piston's own config so they're the enforced ceiling regardless of who calls the API; network name if configurable).
- `app/CLAUDE.md` — a "Code execution" section (architecture, the offline/privileged posture, provisioning, the socket-isolation and residual-risk notes).

## Testing

- **Unit (`node:test`):** `code-cli` pure helpers — arg/flag parsing, request-body construction, output formatting, and the Piston-unreachable error path (mock the fetch).
- **Task-1 spike (the risk):** provision a lib and run code that imports it; confirm it resolves. Gate: if this fails, switch to the custom-broker fallback before proceeding.
- **Integration (Piston up):** `code-cli python` running `print(2+2)` and `import numpy; print(numpy.__version__)`; `code-cli node` running `console.log` and a lib; an **offline check** (code that opens a network socket fails), confirming no exfil path.
- **End-to-end:** `make piston` + `make piston-provision`, then a Discord/email message asking Baxter to compute something with a lib; confirm he runs it via `code-cli` and reports the result, and that a `.py` he saves is re-runnable.

## Acceptance criteria

1. `make piston` + `make piston-provision` bring up a standing, offline Piston sandbox with Python + Node and the curated libs, on the shared network.
2. `make run` / `make discord` join that network; Baxter can run Python and Node via `code-cli` (stdin or `--file`) and gets stdout/stderr/exit back.
3. Executions are offline (a socket attempt fails) and resource/time-capped **by Piston's own config** (a direct `/execute` bypassing `code-cli` can't request more); the curated libs import successfully.
4. Baxter's *granted* path to the sandbox is `code-cli` — no docker socket, raw `docker`, or bare `Bash` in his container — with the understanding that the Piston API is otherwise network-reachable, so the enforced limits live in Piston's config, not the CLI.
5. Baxter can save a script to `memory-workspace` and re-run it; the `code` skill documents the surface and can't be shadowed by a learned skill.
6. The email and Discord agents are otherwise unchanged.
