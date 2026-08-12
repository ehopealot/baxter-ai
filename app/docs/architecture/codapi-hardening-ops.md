# codapi hardening — box operator runbook (Stages 1–2)

(part of Baxter — see [architecture map](../../CLAUDE.md). Design + rationale:
`docs/superpowers/specs/2026-07-28-codapi-sandbox-hardening-design.md`.)

**Why:** every tenant's codapi mounts a docker socket that is root-equivalent, so
a codapi/escaped-sandbox compromise is full-host, all-tenants. Stage 0 (done, in
`compose.yaml`) hardens the codapi *server* but does NOT change that. Stages 1–2
converge on one idea: **codapi should drive a dedicated ROOTLESS daemon that (a)
isn't host-root, (b) runs sandboxes under gVisor, and (c) refuses dangerous API
calls.**

> **Stages 1–2 are now automated** by the `codapi-hardening` Ansible role in
> `baxter-control` (`ansible/roles/codapi-hardening/`). It is **off by default**
> (`codapi_hardening_enabled: false`) because it is box-only — rootless docker,
> gVisor and linger cannot run in the molecule test container — and because the
> spike + live authz checks below must pass on the real box first. Set
> `codapi_hardening_enabled: true` (per box or fleet-wide) and re-run the
> playbook. The role installs rootless docker for the box user, installs gVisor
> and registers `runsc` on that rootless daemon, installs `opa-docker-authz` with
> the vetted policy, and drops a `baxter@.service` drop-in exporting
> `CODAPI_DOCKER_SOCK=/run/user/<uid>/docker.sock` + `CODAPI_RUNTIME=runsc`.
> **This doc is now (a) what the role does and (b) the box-only checks the role
> cannot self-verify — run them before trusting the switch.** After enabling,
> `baxctl restart <tenant>` (rebuilds the codapi image with runsc and re-creates
> the fleet against the rootless socket).

> The compose wiring: codapi mounts `${CODAPI_DOCKER_SOCK:-/var/run/docker.sock}`.
> Unset = today (host root daemon, `runc`). `${...}` interpolates from the ambient
> env, which the role's systemd drop-in supplies.

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

Once the spike is green, the `codapi-hardening` role wires this: it installs
rootless docker for the box user (`dockerd-rootless-setuptool.sh`), enables linger,
delegates cgroup v2 controllers to the user slice, and drops a `baxter@.service`
override with `Environment=CODAPI_DOCKER_SOCK=/run/user/<uid>/docker.sock`. You do
not export it by hand. (By hand, for the spike or a one-off:
`export CODAPI_DOCKER_SOCK=/run/user/$(id -u)/docker.sock` then `make run`.)

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

The role installs gVisor and registers `runsc` for you; it also sets
`CODAPI_RUNTIME=runsc` in the fleet's systemd env. **The runtime is selected at
image-build time, not by hand-editing `codapi.json`:** the codapi Dockerfile takes
a `CODAPI_RUNTIME` build arg (allow-listed to `runc`/`runsc`) and rewrites only
`box.runtime` in the baked `codapi.json`; the Makefile passes it (`CODAPI_RUNTIME
?= runc`). So the committed `codapi.json` stays `runc` (Colima/dev parity) and a
provisioned box bakes `runsc` when `make run` builds the image with the role's env
in scope. Verify a `code-cli python` run still works and stays offline after
`baxctl restart`.

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
namespaces, only the rev-suffixed sandbox family `codapi/python-<rev>|node-<rev>` (the
images build-codapi tags and box.json names -- see the Makefile SANDBOX_PYTHON block),
**runtime must be `runsc`** so a compromised
codapi cannot downgrade out of gVisor, resource caps bounded to the codapi.json
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

The role mounts that `.rego` (copied from this checkout, so the deployed policy is
the CI-tested one) into `opa-docker-authz` and registers it in the rootless
daemon's `daemon.json`. codapi needs no reconfiguration — the plugin lives in the
daemon, so it governs every request including a compromised codapi hitting the raw
socket.

**Operational gotcha the role works around: the active policy locks the daemon's
own management API.** default-deny means `docker ps`, `docker plugin ...`, and
image builds against the rootless socket are all denied once the policy is live —
by design (that daemon is dedicated to codapi's sandbox lifecycle, nothing else
should drive it). Two consequences: (1) the fleet's image *builds* still run on the
**host** daemon (only sandbox *creates* use the rootless socket), so builds are
unaffected; (2) the role installs the plugin **before** the policy is active and
then guards that task with a marker file, so a re-converge never has to reach the
now-locked socket. If you ever need to manage the rootless daemon by hand, remove
`authorization-plugins` from its `daemon.json` and restart it (via `systemctl
--user`, which does not go through the socket) first.

## Order of operations on the box

1. **Stage 1 spike FIRST** (above) — prove rootless + DooD bind-mounts work, by
   hand, before enabling anything. If it fails, stop and record it.
2. Set `codapi_hardening_enabled: true` and re-run the playbook. The role does the
   rest: rootless docker, gVisor + `runsc`, `opa-docker-authz` + the vetted policy,
   the systemd drop-in (`CODAPI_DOCKER_SOCK` + `CODAPI_RUNTIME=runsc`).
3. `baxctl restart <tenant>` — rebuilds the codapi image with `runsc` and
   re-creates the fleet against the rootless socket.
4. Re-verify (the role cannot self-check these): `code-cli python` runs, artifacts
   return, `network:none`
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
