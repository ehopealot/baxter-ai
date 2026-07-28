# codapi Sandbox Hardening (Stages 0–2) — Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the plan derived from this spec, stage by stage.

**Goal:** Shrink the blast radius of the one place multi-tenant Baxter is *not* per-tenant isolated: **every tenant's codapi container mounts the host docker socket** (`compose.yaml`), which is root-equivalent, so a codapi (or escaped-sandbox→codapi) compromise is a full-host, all-tenants compromise. Reduce that with layered defense, in stages, without breaking the existing offline-sandbox contract.

**Architecture:** Three independent links to defend — (①) untrusted code escaping the sandbox container, (②) codapi itself being compromised, (③) the socket granting host root. Stage 0 hardens the codapi server (link ②). Stage 1 makes the socket non-root (link ③, the biggest single win). Stage 2 adds gVisor to the sandboxes (link ①) and a body-inspecting authz layer on the socket (link ③). Stage 3 (per-tenant exec engine / microVMs) is **out of scope here** — followup.

**Tech Stack:** docker compose v2, codapi (`app/codapi/`), rootless Docker/Podman, gVisor (`runsc`), a Docker authorization plugin or filtering proxy. Target box is **native arm64** (Fedora); gVisor supports arm64, Firecracker/Kata need bare-metal KVM (→ Stage 3, box-only).

## Current state (accurate — build on it, don't duplicate)

**Already hardened — the per-run SANDBOX containers** (`app/codapi/codapi.json` — `box` unless noted): `runtime: runc`, `network: none` (offline — no exfil, the core property), `writable: false` (read-only rootfs), code mounted `:/sandbox:ro`, `cap_drop: [all]`, `cpu:1`/`memory:512`/`nproc:64`/`nofile=96`, `/tmp` tmpfs; non-root `user: sandbox` and `timeout:15` live in the **`step`** object. **Do not weaken these.**

**The gaps this spec closes:**
- The **codapi *server*** container (`compose.yaml` `codapi:` service) has **no** hardening — no `cap_drop`, no `no-new-privileges`, not read-only, no pids/mem cap, runs as **root**. (`app/codapi/Dockerfile` is `FROM docker:cli`, no `USER`.)
- The socket is the **host root daemon** (`/var/run/docker.sock`).
- Sandbox `runtime` is `runc` (shared kernel).
- Nothing inspects the socket API calls codapi makes (no privileged/mount/image allowlisting).

## Global Constraints

- **Never weaken the sandbox `box` config.** `network: none` + read-only + cap_drop + non-root are load-bearing and must survive every change.
- **Backward compatibility / staged rollout.** Each stage must leave the fleet runnable on a box that hasn't done that stage's host provisioning yet. Gate rootless (Stage 1) behind a socket-path variable defaulting to today's `/var/run/docker.sock`; gate gVisor (Stage 2a) so `runtime: runc` remains the default until `runsc` is installed. A plain `make run` on an un-provisioned box behaves as today.
- **`make check` stays green** (531 tests). These are compose/codapi.json/Dockerfile/ops changes; validate with `docker compose config`, `codapi.json` schema sanity, and box-side runtime checks — not new unit tests, except the authz filter (Stage 2b), which gets its own tests.
- **Honesty about Stage 0.** Hardening the codapi server raises the bar for a codapi RCE that does *not* use the socket, but **the socket remains root-equivalent until Stage 1/2** — Stage 0 alone does not fix the shared-daemon risk. Say so; don't oversell it.

---

## Stage 0 — Harden the codapi server container (link ②)

Defense-in-depth so an escaped-sandbox-into-codapi has minimal local leverage (the socket is still the prize — Stage 1/2). All in `compose.yaml`'s `codapi:` service unless noted:

- `cap_drop: [ALL]` — codapi talks to the daemon over the unix socket; it needs no host caps of its own (container-launch privilege comes from the socket, not caps).
- `security_opt: ["no-new-privileges:true"]`.
- `pids_limit` + `mem_limit` on codapi itself (it's a pool of 8; cap it).
- `read_only: true` **if** codapi writes only under `TMPDIR` (`CODAPI_TMP`, already a writable bind) — **verify** it writes nowhere else (else add a `tmpfs`). If it does, add `tmpfs: [/tmp]` and keep the `CODAPI_TMP` bind writable.
- **Non-root codapi (stretch):** add a `USER` in `app/codapi/Dockerfile` in the socket's group so codapi accesses `docker.sock` without root. `docker:cli` has no non-root user by default → needs a `useradd` + matching the host socket GID (fragile across hosts; a compose `group_add: [<docker-gid>]` may be simpler). If it fights the DooD socket-GID, defer to Stage 1 (rootless changes the socket ownership story anyway).

**Verify:** `docker compose config` renders; a code run still works end-to-end (`code-cli python`), artifacts still return, offline still enforced.

## Stage 1 — Non-root socket: rootless Docker for codapi (link ③, biggest win)

Point codapi at a **rootless** dockerd/podman socket instead of the host root daemon. A socket compromise then yields an unprivileged user namespace, **not host root** — downgrading the worst case from "host root, all tenants" to "one rootless user's namespace."

- **SPIKE FIRST (task 1), because DooD + rootless is where this breaks:** codapi writes each run's code to a host temp dir (`CODAPI_TMP`) and bind-mounts it into the sandbox; under rootless the **bind source must resolve in the rootless daemon's namespace**. Verify: (a) `CODAPI_TMP` path is visible/writable to the rootless daemon, (b) `network: none` still works (trivially — a no-network container needs no rootless networking machinery), (c) `cpu`/`memory`/`nproc` limits still enforce (needs cgroup v2 delegation — Fedora has it), (d) the sandbox images run. If a blocker is found, record it and stop before wiring.
- **Wiring:** parameterize the socket in `compose.yaml`: `${CODAPI_DOCKER_SOCK:-/var/run/docker.sock}:/var/run/docker.sock`. Default = today. A rootless box sets `CODAPI_DOCKER_SOCK=/run/user/<uid>/docker.sock`. Ship an ops doc + a `scripts/setup-rootless-docker.sh` for the box (enable lingering, `dockerd-rootless-setuptool.sh install`, cgroup delegation).
- **Multi-tenant note (for baxter-control):** one shared rootless daemon makes all tenants' sandboxes share that namespace — host-root-safe but not tenant-isolated. Per-tenant rootless daemons = Stage 3.

## Stage 2a — gVisor on the sandbox containers (link ①)

`runtime: "runc"` → `runtime: "runsc"` in `codapi.json`'s `box`, so untrusted code runs under gVisor's syscall-interception (collapses the kernel escape surface). **Gate it:** keep `runc` the default and switch via a build-time/config toggle so a box without `runsc` still runs. Host provisioning: install gVisor, register the `runsc` runtime in the (rootless, post-Stage-1) daemon's `daemon.json`. Verify a run works under `runsc` and offline/limits still hold. (arm64-supported; keep dev on `runc` for Colima parity — the toggle handles the divergence.)

## Stage 2b — Body-inspecting authz on the socket (link ③)

**The trap:** an endpoint-level socket proxy (e.g. `tecnativa/docker-socket-proxy`) is *insufficient* — it gates *which* endpoints, but if `/containers/create` is allowed (codapi needs it), the caller can still pass `Privileged`, host bind mounts, `--pid=host`. **Parameter-level** control requires inspecting the request body, which **rejects**: `Privileged:true`, any host-namespace (`pid`/`net`/`ipc` = host), any bind mount outside the tenant's own `CODAPI_TMP`, and any image not in `{codapi/python, codapi/node}`. Two forms, and they are **not** wired the same way:

- **Plugin variant (recommended):** a Docker **authorization plugin** (`opa-docker-authz` + a Rego policy) configured **daemon-side** (`authorization-plugins` in the rootless daemon's `daemon.json`). The daemon consults it on *every* request; **codapi's socket path is unchanged**. It governs *all* clients of that daemon — so it constrains even a compromised codapi hitting the raw socket directly.
- **Proxy variant:** a filtering proxy as a **new service**; **codapi's socket path points at the proxy**, the proxy talks to the daemon. Only governs clients routed through it (a codapi that can reach the real socket bypasses it) — so pre-Stage-1, against the shared host daemon, only the *plugin* form actually constrains a compromised codapi.
- **This is the one piece with real logic → it gets tests** (policy unit tests: a create with `Privileged:true` / a `/`-mount / a non-allowlisted image is denied; a legitimate sandbox create is allowed).

## Testability & where it lives

- **Validatable in the dev container:** `docker compose config` for Stage 0/1 wiring; `codapi.json` shape; the Stage 2b authz policy tests. `make check` unaffected.
- **Box-side only (like the seams' behavioral smoke):** that rootless actually runs codapi (Stage 1 spike), gVisor runs a sandbox (Stage 2a), the authz plugin denies/permits live (Stage 2b integration). Mark these explicitly; the operator runs them on the Fedora box.
- **Lives in core** (`app/codapi/`, `compose.yaml`, `codapi.json`, ops scripts) — every codapi instance benefits, single- and multi-tenant. The **per-tenant** rootless daemon and **microVM** options are **Stage 3**, noted for `baxter-control`, not built here.

## Self-review notes

- Grounded in the real config: the sandbox `box` is already hardened, so Stage 0 targets the *server*, and the spec says plainly Stage 0 doesn't fix the socket. Stages map 1:1 to the three links.
- Every stage is independently shippable and gated to not break an un-provisioned box (socket-path var; runc default; authz opt-in).
- The known-hard part (rootless + DooD bind-mount resolution) is a spike-first task with an explicit stop condition, not a blind wiring.
