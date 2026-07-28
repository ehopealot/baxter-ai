# Relocatable-Fleet Seams (core) — Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the plan derived from this spec.

**Goal:** Add a small, backward-compatible set of parameterization "seams" to core Baxter's compose + Makefile so an *external* orchestrator can run many independent fleets on one host, each with its own env file and state directory — **without** putting any tenant/multi-tenant/hosting logic into public core.

**Architecture:** Core stays single-tenant and unaware of tenancy. It already keys the whole fleet off `${PROJECT}` (image, container names, network, config-volume name). We add two more env-driven knobs — the **env file** and the **state mount** — plus one optional knob (**which surfaces start**). Every knob defaults to today's exact behavior via `${VAR:-default}`, so a plain `make run` / `make run-mail` is byte-for-byte unchanged. The private `baxter-control` repo (out of scope here) drives these knobs; core never learns what a "tenant" is.

**Tech Stack:** docker compose v2 (variable interpolation in `env_file`, volume `source`, and `COMPOSE_PROFILES`), GNU make, the existing `bin/baxter` + `deploy/` machinery.

## Global Constraints

- **Backward compatibility is absolute.** With none of the new vars set, `make run`, `make run-mail`, `make voice`, `make stop`, `make deploy`, and the reference `deploy/baxter.service` behave exactly as today. This is the whole justification for the change living in public core: it is clean parameterization ("make the fleet's env file and state dir relocatable"), not multi-tenancy.
- **No tenant vocabulary in core.** No `/agents`, no "tenant", no customer/billing/routing concepts in any tracked file in this repo. Core exposes generic knobs (`TENANT_ENV`, `TENANT_STATE`, `BAXTER_SURFACES`); it does not model who sets them or why. (These var *names* are the one concession — they hint at the consumer — but they carry no logic.)
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

## Seam 3 — Per-fleet surface selection (`BAXTER_SURFACES`)

Lets an operator start only the surfaces a given fleet needs (a Discord-only customer runs 2 Node procs, not 3), trimming idle footprint. Re-profiles services that currently start unconditionally, so it must be implemented **without changing the default**: unset `BAXTER_SURFACES` ⇒ exactly today's behavior.

Mechanism: assign profiles to the currently-unprofiled surfaces and let the Makefile map `BAXTER_SURFACES` → `COMPOSE_PROFILES`, defaulting to today's set.

```yaml
discord:    { profiles: ["discord"], ... }
heartbeat:  { profiles: ["heartbeat"], ... }
# run keeps "mail", voice keeps "voice"
```

```make
# Makefile: default preserves current `make run` (discord+heartbeat) and
# `run-mail` (adds mail). Empty/unset BAXTER_SURFACES => the current defaults.
BAXTER_SURFACES ?= discord,heartbeat
export COMPOSE_PROFILES := $(BAXTER_SURFACES)
```

- The `run`/`run-mail`/`voice` targets must resolve to the same profile sets they enable today when `BAXTER_SURFACES` is unset. The `mail` target/`run-mail` must still add `mail`, and `voice` still add `voice`, *on top of* whatever `BAXTER_SURFACES` selects — i.e. the target-specific profile is unioned in, not overwritten. **Explicitly verify** `make run` still starts discord+heartbeat and *not* mail/voice, and `make run-mail` adds mail.
- Gotcha to pin in the plan: a service with a profile does **not** start unless its profile is active, so mis-wiring the default silently stops discord/heartbeat on a plain `make run`. The smoke test (below) is the guard.

## Makefile: no `TENANT` convenience in core (DECIDED)

Core stays convention-free: it knows only the generic `TENANT_ENV` / `TENANT_STATE`
knobs and **not** the `/agents/<id>` layout. `baxter-control` passes the concrete
paths explicitly (e.g. from its systemd template unit and `baxctl`):

```
make run-mail PROJECT=baxter-alice \
  TENANT_ENV=/agents/alice/app.env \
  TENANT_STATE=/agents/alice/.mail-agent
```

The Makefile only needs to **export the two vars through to compose** (so
`docker compose` sees them) and pass `PROJECT` as an argument as today. No
`/agents` string, no `TENANT` var, appears anywhere in this repo. This keeps the
public boundary clean: core is "a relocatable single fleet"; the tenant layout is
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
