# codapi hardening — box operator runbook (Stages 1–2)

(part of Baxter — see [architecture map](../../CLAUDE.md). Design + rationale:
`docs/superpowers/specs/2026-07-28-codapi-sandbox-hardening-design.md`.)

**Why:** every tenant's codapi mounts a docker socket that is root-equivalent, so
a codapi/escaped-sandbox compromise is full-host, all-tenants. Stage 0 (done, in
`compose.yaml`) hardens the codapi *server* but does NOT change that. Stages 1–2
are **box provisioning** — they all converge on one idea: **codapi should drive a
dedicated ROOTLESS daemon that (a) isn't host-root, (b) runs sandboxes under
gVisor, and (c) refuses dangerous API calls.** Then set `CODAPI_DOCKER_SOCK` to
that daemon's socket and `make run` picks it up. These steps run on the Fedora
box; they cannot be validated in the Colima/DooD dev container.

> The wiring is already in `compose.yaml`: codapi mounts
> `${CODAPI_DOCKER_SOCK:-/var/run/docker.sock}`. Unset = today (host root daemon).
> Export `CODAPI_DOCKER_SOCK=/run/user/<uid>/docker.sock` (or the authz proxy
> socket) in the fleet's environment to switch. `${...}` interpolates from the
> ambient env, so `baxter-control`'s systemd `EnvironmentFile` can also carry it.

## Stage 1 — rootless daemon for codapi

### 1a. SPIKE FIRST (the design gates on this — DooD + rootless is where it breaks)

Before wiring anything, prove codapi actually works against a rootless daemon.
codapi writes each run's code to a host temp dir (`CODAPI_TMP`) and bind-mounts it
into the sandbox; under rootless the **bind source must resolve in the rootless
daemon's namespace**. Verify, as the box user:

```bash
# install rootless docker for the box user (no root daemon involvement)
dockerd-rootless-setuptool.sh install            # needs uidmap, slirp4netns
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
systemctl --user enable --now docker             # + `loginctl enable-linger <user>`

# spike: can a sandbox run with a bind mount + no network + limits, rootless?
mkdir -p /tmp/spk && echo 'print("ok")' > /tmp/spk/main.py
docker run --rm --network none --read-only --cap-drop all \
  --memory 512m --pids-limit 64 -v /tmp/spk:/sandbox:ro python:3.12-slim \
  python /sandbox/main.py
```

Confirm: (a) the bind mount is visible, (b) `--network none` works (trivial — no
rootless networking involved for a no-network container),
(c) `--memory`/`--pids-limit` enforce (needs cgroup v2 delegation — Fedora has it;
if not: the `cpu`/`memory` controllers must be delegated to the user slice). **If
any fails, STOP and record it** — the fix may be a `CODAPI_TMP` path both codapi
and the rootless daemon can see, or falling back to Podman. Do not wire Stage 1
until the spike is green.

### 1b. Wire it

```bash
export CODAPI_DOCKER_SOCK=/run/user/$(id -u)/docker.sock
make run PROJECT=... TENANT_ENV=... TENANT_STATE=...
# (baxter-control: put CODAPI_DOCKER_SOCK in /agents/<id>/app.env or a box-wide drop-in)
```

Now a codapi compromise reaches only the rootless user's namespace, not host root.
**Multi-tenant note:** one shared rootless daemon means all tenants' sandboxes
share that namespace (host-root-safe, not tenant-isolated). Per-tenant rootless
daemons = Stage 3 (deferred).

## Stage 2a — gVisor (runsc) on the sandbox containers

Run untrusted code under gVisor's syscall interception (collapses the kernel
escape surface). arm64-supported.

```bash
# install gVisor and register it as a runtime IN THE ROOTLESS daemon
# (see gvisor.dev/docs/user_guide/install ; then, in the rootless daemon's
#  ~/.config/docker/daemon.json):
#   { "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } } }
systemctl --user restart docker
```

Then flip the sandbox runtime — `runc` stays the default so an un-provisioned box
still runs; switch only where `runsc` is installed. In `app/codapi/codapi.json`
`box`: `"runtime": "runsc"`, rebuild the codapi image (`make codapi`). Verify a
`code-cli python` run still works and stays offline. (Keep dev on `runc` for
Colima parity — this is a box-only edit; do not commit `runsc` as the default.)

## Stage 2b — body-inspecting authz on the daemon

**The trap:** an endpoint-level socket proxy (`tecnativa/docker-socket-proxy`)
gates *which* endpoints but NOT request bodies — if `/containers/create` is
allowed (codapi needs it), the caller can still pass `Privileged`, host mounts,
`--pid=host`. You need **parameter-level** control. Cleanest: an **authorization
plugin on the rootless daemon** (`opa-docker-authz` + a Rego policy) — it sees
every request body and the whole daemon is dedicated to codapi, so no custom
proxy/stream-forwarding to get wrong.

```bash
# run opa-docker-authz for the rootless daemon, then in daemon.json:
#   { "authorization-plugins": ["openpolicyagent/opa-docker-authz-v2:0.9"] }
# with a policy bundle mounting the rego below. systemctl --user restart docker.
```

**The policy is a real, tested file: [`app/codapi/authz/codapi-authz.rego`](../../codapi/authz/codapi-authz.rego)**, with a regression suite
([`codapi-authz_test.rego`](../../codapi/authz/codapi-authz_test.rego)) that CI runs on every push (`opa test`, `.github/workflows/check.yml`).
It is **default-deny** and constrains `/containers/create` (no privileged, no host
namespaces, only `codapi/python|node`, resource caps bounded to the codapi.json
ceilings, `MemorySwap` bounded, no `--mount`, only read-only `CODAPI_TMP` binds,
`?query`-tolerant matching). Every reviewer-found bypass — including a
fail-*closed* trap (`opa test` caught legit creates being denied when host-ns keys
were absent) — is a passing test case.

Two things you still MUST do on the box (the tests can't verify them):
1. **Confirm the input schema** — the policy assumes `opa-docker-authz` v2's
   `input.Method` / `input.Path` (full RequestURI) / `input.Body`; if your plugin
   version differs, adjust ONLY the accessors at the top of the `.rego`. Verify with
   a live deny/allow (step 4).
2. **Set the real bind prefix + tune the endpoint allowlist** — replace `/var/tmp/`
   with the box's actual `CODAPI_TMP` (`/var/tmp/<project>-codapi/`), and confirm
   codapi's *real* API calls all appear in the lifecycle allow-list (observe the
   plugin debug log; a too-tight list breaks code exec — the default-deny cuts both
   ways).

Mount that `.rego` into `opa-docker-authz` per its docs. codapi needs no
reconfiguration — the plugin lives in the daemon (the same `CODAPI_DOCKER_SOCK`
from Stage 1), so it governs every request including a compromised codapi hitting
the raw socket.

## Order of operations on the box

1. Stage 1 spike (green) → install rootless → set `CODAPI_DOCKER_SOCK` → `make run`.
2. Stage 2a: install gVisor, register `runsc` in the rootless daemon, flip
   `codapi.json` runtime, `make codapi`, verify a run.
3. Stage 2b: add `opa-docker-authz` + the vetted policy to the rootless daemon.
4. Re-verify after each: `code-cli python` runs, artifacts return, `network:none`
   holds, and (2b) crafted creates are denied — **including with a query string**
   (`docker -H <sock> create --name x --privileged alpine` → `/containers/create?name=x`;
   a `?`-carrying create is exactly what a `$`-anchored matcher lets slip), a
   foreign image, `--pid=host`, a `..`/`:rw` bind, a **`--mount`** bind of
   `/etc:rw` (which the `Binds`-only checks would miss), an **uncapped** create
   (missing any of `--memory`/`--pids-limit`/`--cpus`), and an **over-capped** one
   (e.g. `--memory 64g`). Because the policy is
   default-deny, also confirm codapi's *legitimate* runs still pass (a too-tight
   endpoint allowlist breaks code exec) — this is the tuning loop.

## Not here (Stage 3, followup)

Per-tenant rootless daemons (restores per-tenant blast radius on the code axis) or
microVMs (Firecracker/Kata — needs bare-metal KVM, box-only, breaks Colima dev
parity). Track in `baxter-control`.
