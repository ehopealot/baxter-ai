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

Confirm: (a) the bind mount is visible, (b) `--network none` works (slirp4netns),
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

Starter policy (`codapi-authz.rego`) — **validate with `opa test` and a live
deny/allow before trusting it; input schema is opa-docker-authz's**:

```rego
package docker.authz
default allow = false

# allow everything except container creation, which we constrain
allow { not is_create }
is_create { input.Method == "POST"; regex.match(`/containers/create$`, input.Path) }

allow {
  is_create
  hc := input.Body.HostConfig
  not hc.Privileged                                  # no privileged
  not host_ns(hc.PidMode); not host_ns(hc.NetworkMode); not host_ns(hc.IpcMode)
  allowed_image(input.Body.Image)                    # only our sandbox images
  every b in object.get(hc, "Binds", []) { allowed_bind(b) }
}
host_ns(m) { m == "host" }
allowed_image(img) { img == "codapi/python" }
allowed_image(img) { img == "codapi/node" }
allowed_bind(b) { startswith(b, "/var/tmp/") }       # only CODAPI_TMP-rooted mounts, :ro
```

Point codapi at this daemon (same `CODAPI_DOCKER_SOCK` from Stage 1 — the plugin
lives in the daemon, so no separate socket). A create asking for privileged, a
host namespace, a foreign image, or a `/`-mount is now denied at the daemon.

## Order of operations on the box

1. Stage 1 spike (green) → install rootless → set `CODAPI_DOCKER_SOCK` → `make run`.
2. Stage 2a: install gVisor, register `runsc` in the rootless daemon, flip
   `codapi.json` runtime, `make codapi`, verify a run.
3. Stage 2b: add `opa-docker-authz` + the vetted policy to the rootless daemon.
4. Re-verify after each: `code-cli python` runs, artifacts return, `network:none`
   holds, and (2b) a crafted privileged/foreign-image create is denied.

## Not here (Stage 3, followup)

Per-tenant rootless daemons (restores per-tenant blast radius on the code axis) or
microVMs (Firecracker/Kata — needs bare-metal KVM, box-only, breaks Colima dev
parity). Track in `baxter-control`.
