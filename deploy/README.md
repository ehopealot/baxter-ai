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
- **Deploy** — **manual, pull-based, no inbound needed.** You `git push` to the
  private GitHub repo from your dev machine; the box **pulls** (outbound) and
  restarts itself: `ssh box 'cd /opt/baxter && make deploy'`. GitHub never
  reaches into the box, so no webhook / open port is required.

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
| Code | git | `git clone` / `make deploy` |
| Secrets & config (Discord/OpenRouter keys, harness choice, flags) | `app/.env` (gitignored) | **scp it** from the old box |
| Baxter's **mind** — `memory.md`, `CREDENTIALS.md`, skills, learned-skills | config volume, under `.mail-agent/memory-workspace` | `make backup` → copy → `make restore` |
| Gmail OAuth token | config volume, *outside* memory-workspace | **not** in backup → `make auth` (weekly anyway) |
| Schedule + daily send-state counters | config volume, *outside* memory-workspace | **not** in backup → re-seed on first run (send-state resets daily) |
| data-cli keys | `~/.mail-agent/data-keys.json` (0600, outside memory-workspace) | **not** in backup → re-add by hand (only if you've configured a *keyed* source; espn + nominatim are keyless, so today: nothing to move) |
| Browser session | config volume, `.playwright*` | **not** in backup → re-login as needed |

`make backup` deliberately snapshots only `memory-workspace` (his mind), so a
migration is: clone → `.env` → restore the mind → let the rest re-provision.

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
cd /opt/baxter && make run-gmail PROJECT=baxter
```
(Drop the `-gmail` if you don't run the opt-in Gmail poller.)

**5. Migrate Baxter's mind.** On the **old** box:
```
make backup                                  # writes backups/baxter-mind-<ts>.tar.gz
```
Copy that tarball into `/opt/baxter/backups/` on the new box, then:
```
make stop                                    # restore refuses while containers hold the volume
make restore RESTORE_FILE=backups/baxter-mind-<ts>.tar.gz
make run-gmail PROJECT=baxter
```

**6. Gmail only:** `make auth` (interactive OAuth, re-run weekly).

**7. Install the boot unit.** Edit `deploy/baxter.service` — set `User=` to your
box user (the one in the `docker` group) — then:
```
sudo cp deploy/baxter.service /etc/systemd/system/baxter.service
sudo systemctl daemon-reload
sudo systemctl enable --now baxter           # start now + on every boot
systemctl status baxter                      # should read: active (exited)
```
`enable --now` is safe even though the fleet is already up from step 4/5 — its
`ExecStart` (`make run-gmail`) is idempotent; `compose up -d` no-ops on unchanged
containers.

---

## Deploying new code

From your dev machine, push, then trigger the box's pull:
```
git push origin main
ssh box 'cd /opt/baxter && make deploy'
```
`make deploy` = `git pull --ff-only` + `make run-gmail PROJECT=baxter`. It
rebuilds images (Docker layer cache makes unchanged builds fast) and recreates
only the containers whose image or config changed. **The config volume and
`app/.env` are never touched**, so his memory, tokens, and schedule persist
across the deploy.

`make deploy` fails loudly on a drifted box instead of quietly shipping
unversioned code: a clean-tree guard refuses if the working tree has **local
edits** (e.g. a hot-patch left on the box — which `git pull --ff-only` alone
would fast-forward straight past when the edits don't overlap the incoming
change), and `--ff-only` refuses **divergent commits** rather than making a merge
commit. Either way, reconcile on the box (`git status`, stash/reset) before
deploying again.

---

## Everyday operations

| Command (on the box) | Does |
|---|---|
| `systemctl status baxter` | Is the stack up? (`active (exited)` = yes) |
| `systemctl restart baxter` | Graceful `make stop` + `make run-gmail` |
| `make logs` | Follow the whole fleet's logs |
| `make deploy` | Pull latest `main` + restart |
| `make backup` | Snapshot his mind (do this before risky changes) |

Voice (`make voice`) is opt-in and separate from the `run-gmail` fleet the boot
unit manages; start it alongside if you use it (needs `DISCORD_VOICE_CHANNEL_ID`
in `app/.env`).
