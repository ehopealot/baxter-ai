# Baxter Burgundy

A standing AI agent that lives in a **dedicated Gmail inbox** and/or a **Discord
server**. It polls for new mail / messages, and for each one spawns a scoped
`claude -p` run that can reply, browse the web, run code in an offline sandbox,
and act on a schedule. You can run either surface on its own or both together.

This README covers **setup and running**. For how it works internally (the
security model, the transcript-sanitization pipeline, the sandbox), see
[`app/CLAUDE.md`](app/CLAUDE.md).

> **Repo layout:** the project lives in [`app/`](app/). The repo root is a
> separate, generic Claude Code dev sandbox (its own `Dockerfile`) — unrelated to
> the agent except that the shared `Makefile` drives both. All commands below run
> **from the repo root**.
>
> **A note on names:** Docker resource names (containers, the config volume) are
> prefixed with the **repo directory's name**. This README assumes a checkout
> named `baxter` (so `baxter-run`, `baxter-app-config`, …); if your directory has
> a different name, substitute it in the `baxter-…` names below.

---

## Prerequisites

- **Docker** with the **`docker compose` v2** plugin — Colima or Docker Desktop
  on macOS, or native Linux. (`docker compose version` should work.)
- **`make`.**
- **Claude Code authentication** for the in-container agent runs (see step 2).
- For the email side: a **dedicated Gmail account** for the persona (don't use a
  personal inbox — the agent reads and sends from it).
- For the Discord side: a **Discord application/bot** you control.

---

## 1. Configure

```bash
cp app/.env.example app/.env
```

Then edit `app/.env`. Every variable is commented in the file; the essentials:

| Variable | For | Notes |
|---|---|---|
| `GMAIL_USER_EMAIL` | Gmail | The dedicated account the agent reads/sends as. |
| `OPERATOR_EMAIL` | Gmail | **You** — where operational notices (e.g. the re-auth reminder) go. Keep it different from `GMAIL_USER_EMAIL`. |
| `ALLOWED_SENDERS` | Gmail | Comma-separated addresses allowed to trigger the agent. **Fails closed** — empty means no mail is ever processed. |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Gmail | From Google Cloud (step 3). |
| `DISCORD_BOT_TOKEN` | Discord | From the Developer Portal (step 4). **Leave unset to disable Discord entirely.** |
| `DISCORD_GUILD_ALLOWLIST` | Discord | Optional comma-separated guild-id allowlist. Empty = any server it's invited to. |
| `PERSONA_NAME` | both | Defaults to `Baxter Burgundy`. |
| `BAXTER_MODEL` | both | `sonnet` (default), `haiku` (cheaper), or `opus` (most capable). |

The remaining variables are safety caps and tuning (send/day limits, poll
interval, heartbeat guardrails) with sensible defaults — leave them unless you
have a reason to change them.

---

## 2. Authenticate Claude

The spawned `claude -p` runs need the Claude Code CLI authenticated. The
credentials live on the persistent config volume (`baxter-app-config`, mounted at
`/home/node`), so you only do this once. Two options:

- **API key (simplest):** add a line to `app/.env`:
  ```
  ANTHROPIC_API_KEY=sk-ant-...
  ```
  It's passed into every container via `--env-file`, and the CLI picks it up.

- **Subscription login:** authenticate the CLI interactively so its token
  persists on the volume:
  ```bash
  make app-shell     # drops you into the image with the config volume mounted
  claude             # complete the login, then exit
  ```

---

## 3. Gmail setup

1. In the **[Google Cloud Console](https://console.cloud.google.com/)**, create a
   project and **enable the Gmail API**.
2. Configure the **OAuth consent screen**: user type **External**, and leave it
   in **Testing** mode. Add the scopes **`gmail.modify`** and **`gmail.send`**.
   Under **Test users**, add the **dedicated Gmail address** — that's the account
   you authorize as in step 4, and Testing mode rejects any sign-in not listed
   here. (Adding your `OPERATOR_EMAIL` too is a harmless safeguard in case you
   sign in with the wrong account; it only ever *receives* mail, so it isn't
   strictly required.)
3. Create an **OAuth client ID** of type **Web application**, and add
   **`http://localhost:8080/oauth2callback`** as an authorized redirect URI.
   Copy the client ID and secret into `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` in `app/.env`.
4. Run the one-time authorization:
   ```bash
   make auth
   ```
   It prints a Google URL — open it in a browser, **sign in as the dedicated
   Gmail account**, and approve. Google redirects to `localhost:8080` (published
   by the command), the refresh token is saved to the config volume, and you're
   done.

> ⚠️ **The token expires every 7 days.** Because the consent screen stays in
> Testing mode (getting the restricted Gmail scopes out of Testing needs a paid
> security audit), Google expires the refresh token after 7 days. The poller
> emails your `OPERATOR_EMAIL` a reminder on day 6 — just re-run `make auth` when
> you get it.

---

## 4. Discord setup

1. In the **[Discord Developer Portal](https://discord.com/developers/applications)**,
   click **New Application**.
2. Open the **Bot** tab, and **enable the *Message Content* privileged intent**
   (required — without it the bot can't read message text). **Reset Token**, copy
   it, and put it in `DISCORD_BOT_TOKEN` in `app/.env`.
3. Open **OAuth2 → URL Generator**. Tick the **`bot`** scope, then tick the
   permissions you want. Grant everything **except** the following (the bot
   neither requests nor exposes membership management):
   **Create Invite, Kick Members, Ban Members, Manage Roles, Manage Channels,
   Manage Server, Administrator, Moderate Members.**
4. Open the generated URL and **add the bot to your server**.

Once the bot is in your server, it responds to DMs, @mentions, replies, and
channel messages. (Only its *own* messages are ignored; other bots are treated
like people.)

---

## 5. Run

Bring up the whole fleet — Gmail poller, Discord gateway, heartbeat scheduler,
and the code sandbox — detached, each with a restart policy:

```bash
make run
```

Tear it down (leaves your config volume and memory intact):

```bash
make stop
```

That's the normal way to run it. A few more targets:

| Command | Does |
|---|---|
| `make run` | Build the images, then start the **whole fleet** via `docker compose`. |
| `make stop` | Stop + remove the fleet. |
| `make logs` | Follow logs from the whole fleet. |
| `make gmail` | Run **just** the Gmail poller in the **foreground** (handy for debugging). |
| `make discord` | Run **just** the Discord gateway in the foreground. |
| `make auth` | The one-time (weekly) Gmail OAuth authorization. |
| `make app-shell` | A shell in the image with the config volume mounted. |
| `make backup` / `make restore` | Snapshot / restore the agent's memory files. |

> **Running only one surface?** `make run` always starts the Gmail poller, and
> unsetting `DISCORD_BOT_TOKEN` cleanly disables the Discord gateway. So for a
> **Discord-only** standing deployment, either run `make discord` on its own or
> remove the `run` service from `compose.yaml`; for **Gmail-only**, just skip the
> Discord steps (step 4) and leave `DISCORD_BOT_TOKEN` unset.

---

## Everyday operations

- **Watch it:** `make logs` (whole fleet), or `docker logs -f baxter-run` /
  `baxter-discord` / `baxter-heartbeat` for one daemon.
- **Re-auth Gmail** roughly weekly — `make auth` when the day-6 reminder lands.
- **Back up its memory** — `make backup` writes a timestamped archive of the
  agent's memory files. ⚠️ These can contain account credentials the agent has
  saved, so keep the archives private (they're gitignored).
- **Update it** — pull/edit the code, then `make stop && make run` to rebuild and
  redeploy. Your memory, tokens, and schedule (on the config volume) carry over.

## Security notes

The container's only credential is the dedicated Gmail account (plus your Claude
auth and Discord token) — no payment info, no linked personal accounts. The real
guardrails are enforced in code, not prompt text: the sender allowlist (fails
closed), the daily send caps, loop prevention (the agent never acts on its own
messages), and an offline code sandbox. The full model is in
[`app/CLAUDE.md`](app/CLAUDE.md); read it before changing anything in `app/`.
