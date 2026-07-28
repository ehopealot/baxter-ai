# Relocatable-Fleet Seams (core) — Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the plan derived from this spec.

**Goal:** Add a small, backward-compatible set of parameterization "seams" to core Baxter's compose + Makefile so an *external* orchestrator can run many independent fleets on one host, each with its own env file and state directory — **without** putting any tenant/multi-tenant/hosting logic into public core.

**Architecture:** Core stays single-tenant and unaware of tenancy. It already keys the whole fleet off `${PROJECT}` (image, container names, network, config-volume name). We add two more env-driven knobs — the **env file** and the **state mount** — plus one optional knob (**which surfaces start**). Every knob defaults to today's exact behavior via `${VAR:-default}`, so a plain `make run` / `make run-mail` is byte-for-byte unchanged. The private `baxter-control` repo (out of scope here) drives these knobs; core never learns what a "tenant" is.

**Tech Stack:** docker compose v2 (variable interpolation in `env_file`, volume `source`, and `COMPOSE_PROFILES`), GNU make, the existing `bin/baxter` + `deploy/` machinery.

## Global Constraints

- **Backward compatibility is absolute.** With none of the new vars set, `make run`, `make run-mail`, `make voice`, `make stop`, `make deploy`, and the reference `deploy/baxter.service` behave exactly as today. This is the whole justification for the change living in public core: it is clean parameterization ("make the fleet's env file and state dir relocatable"), not multi-tenancy.
- **No tenant vocabulary in core.** No `/agents`, no "tenant", no customer/billing/routing concepts in any **runtime or config** file (Makefile, compose.yaml, bin/, app/, deploy/). Core exposes generic knobs (`TENANT_ENV`, `TENANT_STATE`, `BAXTER_SURFACES`); it does not model who sets them or why. (These var *names* are the one concession — they hint at the consumer — but they carry no logic.) **Exception:** this design doc's own illustrative examples use `/agents/alice` for concreteness; a grep for `/agents` should find it *only* in `docs/superpowers/specs/`, never in an executable/config path.
- **`make check` stays green.** These are compose/Makefile/systemd changes; the TypeScript app is untouched, so `tsc --noEmit` + the 531-test suite are unaffected. The change is verified by the compose/deploy smoke checks below, not by new unit tests.
- The existing "argument, not env prefix" rule for `PROJECT` (the Makefile's `PROJECT := $(notdir $(CURDIR))` ignores an env var) applies to any new make-driven var too: pass them as make **arguments**.

---

## Seam 1 — Relocatable env file (`TENANT_ENV`)

Today every service hardcodes `env_file: [app/.env]`. Make the path a variable that defaults to `app/.env`:

```yaml
# each of: run, discord, heartbeat, voice
env_file: [ "${TENANT_ENV:-app/.env}" ]
```

- Unset → `app/.env`, unchanged.
- Set (e.g. `TENANT_ENV=/agents/alice/app.env`) → that fleet loads a different customer's tokens/config.
- Compose interpolates `${}` in `env_file` (v2); this repo already relies on interpolation for `image`/`container_name`/volume+network names, so the mechanism is proven here. **Verify** on the box's compose version during implementation (smoke check below).

## Seam 2 — Relocatable state mount (`TENANT_STATE`)

Today the config volume is a named external volume mounted `config:/home/node`. Compose short-syntax already routes by source shape: a source containing `/` is a **bind mount**, a bare name is a **named volume**. So one substitution covers both the current behavior and a per-fleet host directory:

```yaml
# each of: run, discord, heartbeat, voice
volumes:
  - "${TENANT_STATE:-config}:/home/node"
```

- Unset → named volume `config` (= `${PROJECT}-app-config`), unchanged. The top-level `volumes: config:` external declaration stays for this default path.
- Set to a host path (e.g. `TENANT_STATE=/agents/alice/.mail-agent` → bind-mounts that dir to `/home/node`, so inside the container it is still just `~/.mail-agent`. **The containment code in `paths.ts`/`invisible_cli.py` never changes and never learns the identifier** — this is the core insight that makes the split cheap.

> Note: when `TENANT_STATE` is a host path, the external `config` volume simply goes unused for that fleet; no conditional volume typing is needed.

**Bind-mount ownership gotcha (a provisioning duty for `baxter-control`, not core).** Unlike a named volume — which inherits the image's `/home/node` ownership on first use — a bind-mounted host dir gets **no** ownership fixup. If the host dir doesn't pre-exist, docker creates it **root-owned**, but the container runs as `USER node` (uid 1000, `app/Dockerfile`), so the first `~/.mail-agent` write hits `EACCES` and the fleet crash-loops (and verification step 3 below fails for a reason the seam itself can't fix). Core makes no attempt to `chown` a bind source. So the spec's contract is: **`baxter-control` must pre-create `TENANT_STATE` owned `1000:1000` before the first `up`** (state it in the `baxctl add` provisioning flow). This is the one operational asymmetry between the named-volume default and the bind path.

## Seam 3 — Per-fleet surface selection (`BAXTER_SURFACES`)

Lets an operator start only the surfaces a given fleet needs (a Discord-only customer runs 2 Node procs, not 3), trimming idle footprint. Re-profiles services that currently start unconditionally, so it must be implemented **without changing the default**: unset `BAXTER_SURFACES` ⇒ exactly today's behavior.

Mechanism: assign profiles to the currently-unprofiled surfaces, then have **each Makefile target set `COMPOSE_PROFILES` to its full profile set** — do NOT keep the existing `--profile` flags.

```yaml
discord:    { profiles: ["discord"], ... }
heartbeat:  { profiles: ["heartbeat"], ... }
# run keeps "mail", voice keeps "voice"
```

**Critical:** docker compose does **not** merge `--profile` flags with `COMPOSE_PROFILES` — a `--profile` flag on the command line *replaces* the env var (compose-go's `WithDefaultProfiles`: the env value is only the default used when no flag is passed). So the naive `export COMPOSE_PROFILES := $(BAXTER_SURFACES)` while targets keep `--profile mail` would make `make run-mail` resolve to `{mail}` only and **silently drop discord+heartbeat** (and `stop`/`logs` would skip them too). The fix is to drop every `--profile` flag and compose the full set per target via `COMPOSE_PROFILES`, which unions cleanly and is unambiguous:

```make
# default preserves today's `make run` (discord+heartbeat) exactly.
BAXTER_SURFACES ?= discord,heartbeat
# each target composes its OWN full profile set; NO --profile flags remain.
run:      … ; COMPOSE_PROFILES="$(BAXTER_SURFACES)"            $(COMPOSE) up -d
run-mail: … ; COMPOSE_PROFILES="$(BAXTER_SURFACES),mail"       $(COMPOSE) up -d
# stop/logs mean "everything that COULD be running" -> the full fixed set, NOT
# parameterized on BAXTER_SURFACES: it may have drifted narrower since `up`
# (edited in baxter-control, or a stop with a different value), and a dropped
# surface's container would then fall out of `down`'s scope -> SIGKILL mop-up.
stop:         COMPOSE_PROFILES="discord,heartbeat,mail,voice"  $(COMPOSE) down
logs:         COMPOSE_PROFILES="discord,heartbeat,mail,voice"  $(COMPOSE) logs -f
voice:        COMPOSE_PROFILES="$(BAXTER_SURFACES),voice"      $(COMPOSE) up -d voice
```
(codapi carries no profile, so it always starts regardless — unchanged.)

- **Audit every `--profile` site**, not just run/run-mail: today `stop` (`--profile mail --profile voice down`), `logs` (`… logs -f`), the mail-stop helper (`--profile mail stop run`), and `voice` (`--profile voice up -d voice`) all carry the flag and all must migrate to the `COMPOSE_PROFILES` form, or profiled discord/heartbeat silently fall out of their stop/log/teardown paths (degrading `stop` to the `docker rm -f` SIGKILL mop-up).
- **Verify** with `BAXTER_SURFACES` unset: `make run` starts discord+heartbeat and *not* mail/voice; `make run-mail` adds mail; `make stop` tears **all** (incl. discord/heartbeat) down gracefully; `make logs` shows them. This backward-compat check is the guard against a mis-wired default silently stopping a surface.

## Makefile: no `TENANT` convenience in core (DECIDED)

Core stays convention-free: it knows only the generic `TENANT_ENV` / `TENANT_STATE`
knobs and **not** the `/agents/<id>` layout. `baxter-control` passes the concrete
paths explicitly (e.g. from its systemd template unit and `baxctl`):

```
make run-mail PROJECT=baxter-alice \
  TENANT_ENV=/agents/alice/app.env \
  TENANT_STATE=/agents/alice/.mail-agent
```

The Makefile needs to **export the two vars through to compose** (so
`docker compose` sees them) and pass `PROJECT` as an argument as today.

**Also fix `check-env` (Makefile:132) to gate on the effective env file.** Today it
hardcodes `test -f app/.env`; with `TENANT_ENV` set it checks the wrong path —
either failing spuriously on a multi-tenant box that has no default `app/.env`, or
passing vacuously against a stale `app/.env` while the real tenant file is missing
(surfacing only as compose's late `env_file` error, exactly what `check-env`
exists to pre-empt). Fix:

```make
# a make argument, per this spec's arg-not-env-prefix rule. The comment MUST be
# on its own line: a trailing `# ...` on the assignment makes GNU make include
# the spaces before `#` in the value (`app/.env   `), so `test -f` then fails
# even when app/.env exists (the canonical make trailing-space footgun).
TENANT_ENV ?= app/.env
check-env:
	@test -f "$(TENANT_ENV)" || { echo "$(TENANT_ENV) missing -- copy app/.env.example and fill it in" >&2; exit 1; }
```

No `/agents` string, no bare `TENANT` var, appears in any **runtime or config**
file (Makefile, compose.yaml, bin/, app/, deploy/) — this spec's illustrative
examples are the sole exception (see Global Constraints). This keeps the public
boundary clean: core is "a relocatable single fleet"; the tenant layout is
entirely `baxter-control`'s.

## What is explicitly NOT in core

The boundary that keeps the hosting layer private. None of these land in this repo:

- The `/agents/<id>` scaffolding, `app.env` templates, provisioning.
- The systemd **template** unit (`baxter@.service`) and `baxter-tenants.target`.
- The `baxctl` control CLI (tenant add/rm/list/logs/restart).
- Any customer, billing, routing, or fleet-inventory concept.

All of that lives in `baxter-control` (separate private repo, consumes core as a pinned git submodule). See its design doc (kept out of this repo).

## Verification (smoke, on the box or a compose-v2 host)

1. **Default unchanged:** with no new vars, `make run` starts `${PROJECT}-discord` + `${PROJECT}-heartbeat` on `config` volume + `app/.env`; `make run-mail` additionally starts `${PROJECT}-run`; `make stop` tears them down. Compare container list + mounts to a pre-change baseline.
2. **Seam 1:** `TENANT_ENV=/tmp/t/app.env` → `docker inspect` shows the fleet loaded that env file (e.g. a sentinel var visible in the container env).
3. **Seam 2:** `TENANT_STATE=/tmp/t/.mail-agent PROJECT=baxter-t` → `docker inspect` shows a **bind** mount of that host dir at `/home/node`; a file written by the run appears on the host path.
4. **Two fleets, no collision:** bring up `PROJECT=baxter-a` and `PROJECT=baxter-b` with distinct `TENANT_STATE`; drive a browser (`invisible-cli open`) in each concurrently; confirm distinct `/tmp/invisible-cli.sock` (separate container `/tmp`), distinct `storage_state`, no cross-fleet cookie bleed.
5. **Seam 3 (if shipped):** `make run` default profiles unchanged; `BAXTER_SURFACES=discord` starts only discord.
6. `make check` green (unchanged app).

## Self-review notes

- All three seams ship. Seams 1–2 are provably backward-compatible via `${VAR:-default}`; Seam 3 (`BAXTER_SURFACES`) re-profiles two services, so its backward-compat rests on the Makefile default `BAXTER_SURFACES ?= discord,heartbeat` and is guarded by the smoke test — the one place a mistake could silently stop a default surface.
- No `TENANT` convenience and no `/agents` string in core (decided): core exposes only generic `TENANT_ENV`/`TENANT_STATE`; `baxter-control` supplies concrete paths.
- The security payoff (no cross-tenant cookie/socket leak) is a *consequence* of per-fleet containers giving each fleet its own `/tmp`/PID namespace — it needs no code change to `invisible_cli.py`, and this spec adds none.
- **Out of scope / followup:** the SMS surface (`sms-bot.ts`, a new core sub-project) and the shared SMS router (in `baxter-control`) are deferred — see the `baxter-control` design's SMS section, marked followup. Not built in this work.
