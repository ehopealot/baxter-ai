# Running Baxter on a Linux box

How to move Baxter onto a dedicated Linux machine, keep him alive across crashes
and reboots, and deploy new code to him — on a box with **no inbound surface**
(nothing exposed to the internet).

The shape of it:

- **Liveness** — Docker's own `restart: unless-stopped` policy (already on every
  service in `compose.yaml`) resurrects containers after a crash or reboot, as
  long as the Docker daemon is enabled at boot. A small **systemd unit**
  (`baxter.service`) brings the stack up on boot and gives you one
  `systemctl start/stop/status baxter` handle.
- **Deploy** — **manual, pull-based, no inbound needed.** One command from your
  dev machine, `make deploy BOX=box`, pushes to the private GitHub repo and then
  SSHes the box to **pull** (outbound) and restart itself. GitHub never reaches
  into the box, so no webhook / open port is required.

> **Note on the "unpushed" rule.** Baxter's `main` has historically stayed
> unpushed on your laptop. Using GitHub as the deploy transport means you now
> **push `main` to the private repo** and the box pulls it. That's safe here —
> the repo is private and `app/.env` (all the secrets) is gitignored, so only
> code travels. Just a deliberate change worth naming.

---

## What lives where (read this before migrating)

A fresh `git clone` gives you **code only**. Everything stateful is provisioned
separately, and only *some* of it can be carried from the old box:

| Thing | Where it lives | Moving it to the new box |
|---|---|---|
| Code | git | `git clone` / `make deploy BOX=box` |
| Secrets & config (Discord/OpenRouter keys, harness choice, flags) | `app/.env` (gitignored; a host file, **not** in the volume) | **scp it** from the old box |
| **Everything else** — his whole mind (`memory.md`, `CREDENTIALS.md`, projects, learned-skills, per-channel notes), his schedule, the AgentMail API key + any data-cli keys, send-state counters, and the browser session | config volume, all under `.mail-agent/` | **`make backup` → copy → `make restore`** (one full-state tarball) |

`make backup` snapshots **all** of `.mail-agent/` — his entire state, not just the
mind — so migrating is just: clone → `.env` → `make restore`. Two things live
*outside* the tarball: `app/.env` (a host file — scp it), and, if you run the
**claude** harness via subscription login (rather than an API key in `.env`), the
Claude CLI's own token under `~/.claude/` on the volume — re-auth that on the new
box (step 6b). The **openrouter**/**local** harnesses keep their key in `app/.env`,
so for those (the current setup) there's nothing extra. The tarball itself contains
secrets (AgentMail API key, data-cli keys, credentials) — `backups/` is gitignored; keep
the file safe.

---

## One-time setup on the new box

**1. Docker + compose v2, enabled at boot.**
```
# install Docker Engine + the compose v2 CLI plugin (distro-specific), then:
sudo systemctl enable --now docker          # <- survives reboot
sudo usermod -aG docker "$USER"             # so `make` can reach the socket
# log out/in (or `newgrp docker`) for the group to take effect
```

**2. Get the code.** First push `main` to the private repo from your laptop
(`git push origin main`), then on the box:
```
sudo mkdir -p /opt/baxter && sudo chown "$USER" /opt/baxter
git clone git@github.com:ehopealot/baxter-ai.git /opt/baxter
```
The box needs to reach GitHub over SSH — add a **read-only deploy key** for this
repo (least privilege; pull is all the box does), or use an HTTPS token.

> The Makefile derives the fleet name from the directory: `PROJECT := $(notdir
> $(CURDIR))`. Checked out at `/opt/baxter` it resolves to `baxter` on its own,
> so `PROJECT=baxter` is technically redundant there — but always pass it as a
> make **argument**, never an env prefix (`:=` ignores the env var and would
> build a stray `app-*` fleet).

**3. Bring the secrets over.** From the old box / your laptop:
```
scp app/.env  box:/opt/baxter/app/.env
```

**4. First start** — creates the external network + config volume (`ensure`) and
builds the images:
```
cd /opt/baxter && make run-mail PROJECT=baxter
```
(Drop the `-mail` if you don't run the opt-in mail poller.)

**5. Migrate his full state.** On the **old** box, stop the fleet for a clean
snapshot, then back up everything:
```
make stop
make backup                                  # writes backups/baxter-state-<ts>.tar.gz (his ENTIRE state)
```
Copy that tarball into `/opt/baxter/backups/` on the new box, then:
```
make stop                                    # restore refuses while containers hold the volume
make restore RESTORE_FILE=backups/baxter-state-<ts>.tar.gz
make run-mail PROJECT=baxter
```
This carries his whole mind, schedule, tokens, keys, and browser session — the new
box **is** the old Baxter. (Fresh install with no old box? Skip this — he starts
empty.)

**6. Mail:** nothing to re-auth — `AGENTMAIL_API_KEY` is in `app/.env` (scp'd in
step 3), with no expiry and nothing to renew. On a fresh install, set it in
`app/.env` and run `make inbox` once to provision his inbox (it prints
`AGENTMAIL_INBOX_ID`/`BAXTER_EMAIL` to paste in).

**6b. Claude auth (claude harness only):** if `BAXTER_HARNESS=claude` with
subscription login, re-auth on the new box — `make app-shell` → run `claude` → log
in (its token lives in `~/.claude/`, outside the backup). With an API key in
`app/.env` (openrouter/local, or `ANTHROPIC_API_KEY`), there's nothing to do.

**7. Install the boot unit.** First **decide the user** (see the box below) and
create it if you're going dedicated — everything so far (steps 2–6b) should have run
as that user. Then copy the unit and set `User=` via a systemd **drop-in override** —
do **not** edit the tracked `deploy/baxter.service` in place, or its local
modification trips `make deploy`'s clean-tree guard and blocks future deploys.

> **What user?** Use **one** user for the whole flow — it owns the `/opt/baxter`
> checkout, runs `make deploy` over SSH, and is the systemd `User=`. Mixing users
> breaks deploys: git refuses to operate on a repo owned by someone else ("dubious
> ownership"). Two good choices, both in the `docker` group, never root:
> - **Your login user** — simplest; already in `docker`, already owns the clone.
> - **A dedicated `baxter` user** — tidier if the box runs other things. It needs a
>   real shell + SSH-key auth (**not** `nologin` — `make deploy` SSHes in as it) and
>   must own the repo:
>   ```
>   sudo useradd --create-home --shell /bin/bash baxter
>   sudo usermod -aG docker baxter
>   sudo chown -R baxter:baxter /opt/baxter
>   # add your deploy public key to ~baxter/.ssh/authorized_keys, and set
>   #   Host box … User baxter   in your laptop's ~/.ssh/config
>   ```
> The `docker` group is root-equivalent on the host regardless, so this is
> isolation/hygiene, not a hard privilege boundary.

```
sudo cp deploy/baxter.service /etc/systemd/system/baxter.service
sudo systemctl edit baxter                   # opens an override; add these two lines:
                                             #   [Service]
                                             #   User=baxter   (whichever user you chose)
sudo systemctl daemon-reload
sudo systemctl enable --now baxter           # start now + on every boot
systemctl status baxter                      # should read: active (exited)
```
The override lands in `/etc/systemd/system/baxter.service.d/override.conf` (outside
the repo, so the working tree stays clean) and merges over the base unit's
`User=CHANGEME`. That `CHANGEME` is a fail-loud default: forget the override and
systemd refuses to start ("no such user") instead of silently running as root.
`enable --now` is safe even though the fleet is already up from step 4/5 — its
`ExecStart` (`make run-mail`) is idempotent; `compose up -d` no-ops on unchanged
containers.

---

## Deploying new code

From your dev machine, one command — push, then trigger the box's pull + restart:
```
make deploy BOX=box
```
`BOX` is an ssh target: either a `~/.ssh/config` `Host` alias (see below) or
`user@host`. `REMOTE_DIR` (default `/opt/baxter`) and `BRANCH` (default `main`)
override the box path and branch if yours differ. `deploy` runs `git push origin
<branch>` and then, only if the push succeeds, `ssh <box> 'cd <dir> && make
deploy-local BRANCH=<branch>'` — it's the *only* place SSH topology lives, and the
box refuses if it's checked out on a different branch than the one you pushed. Set
up the alias once in `~/.ssh/config` on your laptop:
```
Host box
    HostName 192.168.1.42      # the box's LAN IP or hostname
    User youruser
```

`make deploy-local` is the box side that `deploy` invokes over SSH — run it
directly if you're already on the box (no `ssh` wrapper — you're already there):
```
cd /opt/baxter && make deploy-local            # box on main
cd /opt/baxter && make deploy-local BRANCH=foo  # box tracking branch foo
```
`BRANCH` defaults to `main`; pass it if the box tracks a different branch, or
`deploy-local` will refuse the mismatch.
`make deploy-local` = `git pull --ff-only` + `make run-mail PROJECT=baxter`. It
rebuilds images (Docker layer cache makes unchanged builds fast) and recreates
only the containers whose image or config changed. **The config volume and
`app/.env` are never touched**, so his memory, tokens, and schedule persist
across the deploy.

> **One-time note:** `make deploy` invokes `make deploy-local` on the box, so that
> target must already exist in the box's checkout. A fresh clone (the setup above)
> has it. The only gotcha is *renaming* the box-side target: the box is still on
> the old Makefile, and the pull that would deliver the new one runs *inside*
> `deploy-local` — chicken-and-egg. If you ever rename it, `ssh box 'cd
> /opt/baxter && git pull --ff-only'` once before the next `make deploy`. (Don't
> "fix" this with an auto-pull fallback — it would pull straight past the
> clean-tree guard.)

`make deploy-local` fails loudly on a drifted box instead of quietly shipping
unversioned code: a `git status --porcelain` guard refuses if the working tree
has **local edits or untracked files** (e.g. a hot-patch, or a stray
`compose.override.yaml` that `compose up` would auto-merge — drift that `git pull
--ff-only` alone fast-forwards straight past when it doesn't collide with the
incoming change; gitignored files like `.env` and `backups/` are excluded), and
`--ff-only` refuses **divergent commits** rather than making a merge commit.
Either way, reconcile on the box (`git status`, stash/reset) before deploying
again.

---

## Everyday operations

| Command (on the box) | Does |
|---|---|
| `systemctl status baxter` | Is the stack up? (`active (exited)` = yes) |
| `systemctl restart baxter` | Graceful `make stop` + `make run-mail` |
| `make logs` | Follow the whole fleet's logs |
| `make deploy-local` | Pull latest `main` + restart (what `make deploy` runs here over SSH) |
| `make backup` | Snapshot his **entire** state — mind, schedule, tokens, browser session (do this before risky changes; `make stop` first for a clean one) |

Voice (`make voice`) is opt-in and separate from the `run-mail` fleet the boot
unit manages; start it alongside if you use it (needs `DISCORD_VOICE_CHANNEL_ID`
in `app/.env`).
