# Run Baxter on a Linux box

This guide moves Baxter onto a dedicated Linux box. It keeps him alive across
crashes and reboots. It deploys new code to him. The box has no inbound surface:
nothing is exposed to the internet.

The shape of it:

- **Liveness**: Docker's `restart: unless-stopped` policy brings a container
  back after a crash or a reboot. Every service in `compose.yaml` already has
  this policy. It works as long as the Docker daemon starts at boot. A small
  systemd unit (`baxter.service`) brings the stack up at boot. It also gives you
  one handle: `systemctl start/stop/status baxter`.
- **Deploy**: manual and pull-based. It needs no inbound access. One command
  from your dev machine, `make deploy BOX=box`, pushes to the private GitHub
  repo. Then it SSHes the box, and the box pulls (outbound) and restarts itself.
  GitHub never reaches into the box, so you need no webhook and no open port.

> **Note on the "unpushed" rule.** Baxter's `main` has stayed unpushed on your
> laptop in the past. This deploy transport uses GitHub, so now you push `main`
> to the private repo and the box pulls it. This is safe here. The repo is
> private, and `app/.env` (all the secrets) is gitignored, so only code travels.
> It is a deliberate change worth naming.

---

## What lives where (read this before you migrate)

A fresh `git clone` gives you code only. Everything with state is set up
separately, and you can carry only some of it from the old box.

| Thing | Where it lives | Move it to the new box |
|---|---|---|
| Code | git | `git clone` / `make deploy BOX=box` |
| Secrets and config (Discord/OpenRouter keys, harness choice, flags) | `app/.env` (gitignored; a host file, **not** in the volume) | **scp it** from the old box |
| **Everything else** -- his whole mind (`memory.md`, `CREDENTIALS.md`, projects, learned-skills, per-channel notes), his schedule, the Resend API key and any data-cli keys, send-state counters, and the browser session | the config volume, all under `.mail-agent/` | **`make backup`, copy, `make restore`** (one full-state tarball) |

`make backup` snapshots all of `.mail-agent/`: his entire state, not only the
mind. So a migration is just clone, then `.env`, then `make restore`. Two things
live outside the tarball. The first is `app/.env` (a host file; scp it). The
second is the Claude CLI's own token under `~/.claude/` on the volume, but only
if you run the **claude** harness by subscription login rather than by an API key
in `.env`; re-auth that on the new box (step 6b). The **openrouter** and
**local** harnesses keep their key in `app/.env`, so for those (the current
setup) there is nothing extra. The tarball itself holds secrets (the Resend API
key, data-cli keys, credentials). `backups/` is gitignored; keep the file safe.

---

## Set up the new box (once)

**1. Docker and compose v2, started at boot.**
```
# install Docker Engine + the compose v2 CLI plugin (distro-specific), then:
sudo systemctl enable --now docker          # <- survives reboot
sudo usermod -aG docker "$USER"             # so `make` can reach the socket
# log out/in (or `newgrp docker`) for the group to take effect
```

**2. Get the code.** First push `main` to the private repo from your laptop
(`git push origin main`). Then, on the box:
```
sudo mkdir -p /opt/baxter && sudo chown "$USER" /opt/baxter
git clone git@github.com:ehopealot/baxter-ai.git /opt/baxter
```
The box must reach GitHub over SSH. Add a read-only deploy key for this repo
(least privilege; the box only pulls), or use an HTTPS token.

> The Makefile derives the fleet name from the directory (`PROJECT := $(notdir
> $(CURDIR))`). At `/opt/baxter` it resolves to `baxter` on its own, so
> `PROJECT=baxter` is redundant there. But always pass it as a make **argument**,
> never as an env prefix (`:=` ignores the env var and would build a stray
> `app-*` fleet).

**3. Bring the secrets over.** From the old box or your laptop:
```
scp app/.env  box:/opt/baxter/app/.env
```

**4. First start.** This creates the external network and the config volume
(`ensure`), and it builds the images:
```
cd /opt/baxter && make run PROJECT=baxter
```
Mail runs in the light container by default; `BAXTER_SURFACES` in `app/.env`
is only needed to narrow or disable surfaces (the light container reads it
from there).

**5. Migrate his full state.** On the **old** box, stop the fleet for a clean
snapshot. Then back up everything:
```
make stop
make backup                                  # writes backups/baxter-state-<ts>.tar.gz (his ENTIRE state)
```
Copy that tarball into `/opt/baxter/backups/` on the new box. Then:
```
make stop                                    # restore refuses while containers hold the volume
make restore RESTORE_FILE=backups/baxter-state-<ts>.tar.gz
make run PROJECT=baxter
```
This carries his whole mind, schedule, tokens, keys, and browser session. The
new box **is** the old Baxter. (Fresh install with no old box? Skip this step;
he starts empty.)

**6. Mail.** There is nothing to re-auth. `RESEND_API_KEY` is in `app/.env` (you
scp'd it in step 3). It has no expiry and nothing to renew. On a fresh install,
set `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and `BAXTER_EMAIL` in `app/.env`.
There is no separate inbox command (mail routes through the Resend webhook; it
does not poll).

**6b. Claude auth (claude harness only).** If `BAXTER_HARNESS=claude` with
subscription login, re-auth on the new box. Run `make app-shell`, then run
`claude`, then log in (its token lives in `~/.claude/`, outside the backup). With
an API key in `app/.env` (openrouter or local, or `ANTHROPIC_API_KEY`), there is
nothing to do.

**7. Install the boot unit.** First decide the user (see the box below). Create
it if you go dedicated. Everything so far (steps 2 to 6b) should have run as that
user. Then copy the unit and set `User=` with a systemd **drop-in override**. Do
**not** edit the tracked `deploy/baxter.service` in place. A local edit to it
trips `make deploy`'s clean-tree guard and blocks future deploys.

> **What user?** Use **one** user for the whole flow. It owns the `/opt/baxter`
> checkout, it runs `make deploy` over SSH, and it is the systemd `User=`. Mixing
> users breaks deploys: git refuses to operate on a repo owned by someone else
> ("dubious ownership"). Two good choices, both in the `docker` group, never
> root:
> - **Your login user**. This is the simplest. It is already in `docker` and
>   already owns the clone.
> - **A dedicated `baxter` user**. This is tidier if the box runs other things.
>   It needs a real shell and SSH-key auth (**not** `nologin`; `make deploy`
>   SSHes in as it), and it must own the repo:
>   ```
>   sudo useradd --create-home --shell /bin/bash baxter
>   sudo usermod -aG docker baxter
>   sudo chown -R baxter:baxter /opt/baxter
>   # add your deploy public key to ~baxter/.ssh/authorized_keys, and set
>   #   Host box … User baxter   in your laptop's ~/.ssh/config
>   ```
> The `docker` group is root-equivalent on the host anyway, so this is isolation
> and hygiene, not a hard privilege boundary.

```
sudo cp deploy/baxter.service /etc/systemd/system/baxter.service
sudo systemctl edit baxter                   # opens an override; add these two lines:
                                             #   [Service]
                                             #   User=baxter   (whichever user you chose)
sudo systemctl daemon-reload
sudo systemctl enable --now baxter           # start now + on every boot
systemctl status baxter                      # should read: active (exited)
```
The override lands in `/etc/systemd/system/baxter.service.d/override.conf`
(outside the repo, so the working tree stays clean). It merges over the base
unit's `User=CHANGEME`. That `CHANGEME` is a fail-loud default: if you forget the
override, systemd refuses to start ("no such user") instead of a silent run as
root. `enable --now` is safe even though the fleet is already up from step 4 or
5. Its `ExecStart` (`make run`) is idempotent; `compose up -d` does nothing
on unchanged containers.

---

## Deploy new code

From your dev machine, run one command. It pushes, then it triggers the box's
pull and restart:
```
make deploy BOX=box
```
`BOX` is an ssh target: a `~/.ssh/config` `Host` alias (see below), or
`user@host`. `REMOTE_DIR` (default `/opt/baxter`) and `BRANCH` (default `main`)
override the box path and branch if yours differ. `deploy` runs `git push origin
<branch>`. Then, only if the push succeeds, it runs `ssh <box> 'cd <dir> && make
deploy-local BRANCH=<branch>'`. This is the only place the SSH topology lives.
The box refuses if it is checked out on a different branch than the one you
pushed. Set up the alias once in `~/.ssh/config` on your laptop:
```
Host box
    HostName 192.168.1.42      # the box's LAN IP or hostname
    User youruser
```

`make deploy-local` is the box side that `deploy` invokes over SSH. Run it
directly if you are already on the box (no `ssh` wrapper; you are already there):
```
cd /opt/baxter && make deploy-local            # box on main
cd /opt/baxter && make deploy-local BRANCH=foo  # box tracking branch foo
```
`BRANCH` defaults to `main`. Pass it if the box tracks a different branch, or
`deploy-local` refuses the mismatch. `make deploy-local` runs `git pull
--ff-only`, then `make run PROJECT=baxter`. It rebuilds the images (the
Docker layer cache makes an unchanged build fast). It recreates only the
containers whose image or config changed. It never touches the config volume or
`app/.env`, so his memory, tokens, and schedule persist across the deploy.

> **One-time note:** `make deploy` invokes `make deploy-local` on the box, so
> that target must already exist in the box's checkout. A fresh clone (the setup
> above) has it. The one gotcha is a rename of the box-side target. The box is
> still on the old Makefile, and the pull that would deliver the new one runs
> inside `deploy-local`: a chicken-and-egg problem. If you ever rename it, run
> `ssh box 'cd /opt/baxter && git pull --ff-only'` once before the next `make
> deploy`. Do not "fix" this with an auto-pull fallback; it would pull straight
> past the clean-tree guard.

`make deploy-local` fails loudly on a drifted box, rather than a quiet ship of
unversioned code. A `git status --porcelain` guard refuses if the working tree
has local edits or untracked files (for example, a hot-patch, or a stray
`compose.override.yaml` that `compose up` would auto-merge). `git pull --ff-only`
alone fast-forwards straight past this drift when it does not collide with the
incoming change. Gitignored files, like `.env` and `backups/`, are excluded.
`--ff-only` also refuses divergent commits rather than make a merge commit.
Either way, reconcile on the box (`git status`, then stash or reset) before you
deploy again.

---

## Everyday operations

| Command (on the box) | Does |
|---|---|
| `systemctl status baxter` | Is the stack up? (`active (exited)` = yes) |
| `systemctl restart baxter` | A graceful `make stop` and `make run` |
| `make logs` | Follow the whole fleet's logs |
| `make deploy-local` | Pull the latest `main` and restart (what `make deploy` runs here over SSH) |
| `make backup` | Snapshot his **entire** state: mind, schedule, tokens, browser session (do this before a risky change; `make stop` first for a clean one) |

Voice (`make voice`) is opt-in. It is separate from the `make run` fleet that the
boot unit manages. Start it alongside if you use it (it needs
`DISCORD_VOICE_CHANNEL_ID` in `app/.env`).
