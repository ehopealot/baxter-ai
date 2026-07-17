# Baxter AI

A standing AI agent for **Discord**: it lives in your server as a bot, and for
each message spawns a scoped `claude -p` run that can reply, browse the web, run
code in an offline sandbox, and act on a schedule.

It can **also** poll a dedicated Gmail inbox — but that surface is **experimental**
and opt-in (see [Enabling the Gmail surface](#enabling-the-gmail-surface-experimental)).
Discord is the supported default.

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
> named `baxter` (so `baxter-discord`, `baxter-app-config`, …); if your directory
> has a different name, substitute it in the `baxter-…` names below.

---

## Prerequisites

- **Docker** with the **`docker compose` v2** plugin — Colima or Docker Desktop
  on macOS, or native Linux. (`docker compose version` should work.)
- **`make`.**
- **Claude Code authentication** for the in-container agent runs (see step 2).
- A **Discord application/bot** you control (step 3).
- *(Only for the experimental email surface)* a **dedicated Gmail account** for
  the persona — never a personal inbox, since the agent reads and sends from it.

---

## 1. Configure

```bash
cp app/.env.example app/.env
```

Then edit `app/.env`. Every variable is commented in the file; the essentials:

| Variable | For | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | **Discord** | From the Developer Portal (step 3). The Discord surface is disabled if this is unset. |
| `DISCORD_GUILD_ALLOWLIST` | Discord | Optional comma-separated guild-id allowlist. Empty = any server it's invited to. |
| `PERSONA_NAME` | both | Defaults to `Baxter Burgundy`. |
| `BAXTER_MODEL` | both | `sonnet` (default), `haiku` (cheaper), or `opus` (most capable). |
| `GMAIL_USER_EMAIL`, `OPERATOR_EMAIL`, `ALLOWED_SENDERS`, `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` | Gmail *(experimental)* | Only needed if you enable the email surface — see the [Gmail section](#enabling-the-gmail-surface-experimental). |

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

### Alternative: drive Baxter with OpenRouter instead of Claude Code (experimental)

Baxter's driver is pluggable. Instead of Claude Code you can run it on any
tool-calling model hosted on **[OpenRouter](https://openrouter.ai/)** — the same
skills, CLIs, prompts, and surfaces, just a different brain. It's **experimental**
(less battle-tested than the default Claude path), so treat it as beta.

1. Create an **OpenRouter API key** (openrouter.ai → *Keys*). OpenRouter is
   pay-as-you-go per token — no subscription — so keep an eye on spend.
2. Pick a **model that supports tool/function calling** (e.g. `openai/gpt-4o`,
   `google/gemini-2.5-pro`, `anthropic/claude-sonnet-4`). Tool calling is
   required — a model without it can't drive the CLIs.
3. In `app/.env`:
   ```
   BAXTER_HARNESS=openrouter
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=openai/gpt-4o
   #OPENROUTER_MAX_STEPS=40    # optional: caps tool-loop iterations per run
   ```
   You don't need `ANTHROPIC_API_KEY` or the Claude login above while
   `BAXTER_HARNESS=openrouter` — set it back to `claude` (or unset it) to switch
   back. A typo'd `BAXTER_HARNESS` crashes the daemon at startup on purpose.
4. Redeploy (`make stop && make run`). Every surface — Discord, heartbeat, and
   the opt-in Gmail poller — now runs through OpenRouter.

**Or run a local model.** Set `BAXTER_HARNESS=local` to drive Baxter off any
OpenAI-compatible **chat/completions** endpoint — a self-hosted model via
[Ollama](https://ollama.com/) (the default), LM Studio, llama.cpp, or vLLM. In
`app/.env`:
```
BAXTER_HARNESS=local
OPENAI_BASE_URL=http://localhost:11434/v1   # default; Ollama's OpenAI API
OPENAI_MODEL=qwen3                           # a model tag your server has loaded
#OPENAI_API_KEY=                             # optional; most local servers ignore it
```
The model **must support tool calling** (Qwen 2.5/3, Llama 3.1/3.3, Mistral, and
similar do). On Apple Silicon the Mac's unified memory runs these at usable speed;
a ~7–8B model fits in 16 GB, ~32B in 32 GB, and a 70B in 64 GB. The same
`OPENAI_BASE_URL` mechanism also points at OpenAI or any other compatible host.

Web search and page fetching work the same across all three harnesses, via the
keyless `web-cli` (no extra config); web browsing still uses `playwright-cli`.

---

## 3. Set up Discord

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

**Moderation (deleting others' messages).** Baxter can delete *other users'*
messages, but only where you grant it Discord's **Manage Messages** permission.
Grant it **per channel** — channel settings → *Permissions* → the bot (or its
role) → enable *Manage Messages* — in just the channels you want it to moderate.
Everywhere else Discord itself refuses the delete, so the permission is the real
boundary, not prompt text; the bot can always still delete its *own* messages
anywhere. Leave *Manage Messages* off the server-wide invite grant in step 3
unless you actually want it moderating every channel.

---

## 4. Run

Start the default fleet — the Discord gateway, the heartbeat scheduler, and the
code sandbox — detached, each with a restart policy:

```bash
make run
```

Stop it (leaves your config volume and memory intact):

```bash
make stop
```

Targets:

| Command | Does |
|---|---|
| `make run` | Build the images, then start the **default fleet** (Discord + heartbeat + codapi) via `docker compose`. |
| `make run-gmail` | Same, **plus** the experimental Gmail poller (see below). |
| `make stop` | Stop + remove the fleet. |
| `make logs` | Follow logs from the whole fleet. |
| `make discord` | Run **just** the Discord gateway in the **foreground** (handy for debugging). |
| `make gmail` | Run **just** the Gmail poller in the foreground. |
| `make auth` | The one-time (weekly) Gmail OAuth authorization — experimental surface. |
| `make app-shell` | A shell in the image with the config volume mounted. |
| `make backup` / `make restore` | Snapshot / restore the agent's mind. `restore` resets it to an exact snapshot (`make stop` first; `RESTORE_FILE=…`, `YES=1` to skip the prompt). |

---

## Enabling the Gmail surface (experimental)

> ⚠️ **The Gmail surface is experimental and opt-in.** It works — but it carries
> real overhead the Discord side doesn't: a Google Cloud project with an OAuth
> consent screen and client, and — because the Gmail scopes are "restricted" and
> the consent screen stays in **Testing** mode — a **refresh token Google expires
> every 7 days**, so you re-run `make auth` roughly weekly. Enable it only if you
> actually want the email side.

If you do want it:

1. In the **[Google Cloud Console](https://console.cloud.google.com/)**, create a
   project and **enable the Gmail API**.
2. Configure the **OAuth consent screen**: user type **External**, left in
   **Testing** mode. Add the scopes **`gmail.modify`** and **`gmail.send`**.
   Under **Test users**, add **only** the **dedicated Gmail address** — that's the
   account you authorize as in step 4, and Testing mode rejects any sign-in not
   listed here. **Do not add your `OPERATOR_EMAIL`**: it only ever *receives* mail,
   so it never needs to authorize — and `make auth` saves whatever account
   completes the flow *without checking which one it is*. Leaving your personal
   address off the test-user list means an accidental sign-in with it during
   `make auth` fails loudly, instead of silently handing the agent read/send
   access to your personal inbox.
3. Create an **OAuth client ID** of type **Web application**, and add
   **`http://localhost:8080/oauth2callback`** as an authorized redirect URI. Copy
   the client ID and secret into `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` in `app/.env`. Also set `GMAIL_USER_EMAIL`,
   `OPERATOR_EMAIL` (**your** address, for operational notices — keep it different
   from the dedicated one), and `ALLOWED_SENDERS` (comma-separated addresses
   allowed to trigger the agent; **fails closed** — empty means no mail is ever
   processed).
4. Run the one-time authorization:
   ```bash
   make auth
   ```
   It prints a Google URL — open it, **sign in as the dedicated Gmail account**,
   and approve. Google redirects to `localhost:8080` (published by the command),
   the refresh token is saved to the config volume, and you're done.
5. Bring the fleet up **with** the poller:
   ```bash
   make run-gmail
   ```

> **The 7-day token.** Because the consent screen stays in Testing mode (getting
> the restricted scopes out of Testing needs a paid security audit), Google
> expires the refresh token after 7 days. The poller emails your `OPERATOR_EMAIL`
> a reminder on day 6 — just re-run `make auth` when you get it.

---

## Everyday operations

- **Watch it:** `make logs` (whole fleet), or `docker logs -f baxter-discord` /
  `baxter-heartbeat` / `baxter-run` for one daemon.
- **Re-auth Gmail** roughly weekly *(only if you enabled it)* — `make auth` when
  the day-6 reminder lands.
- **Back up its memory** — `make backup` writes a timestamped archive of the
  agent's memory files. ⚠️ These can contain account credentials the agent has
  saved, so keep the archives private (they're gitignored).
- **Restore a backup** — `make stop` first, then
  `make restore RESTORE_FILE=backups/baxter-mind-<timestamp>.tar.gz`. This resets
  the agent's mind to *exactly* that snapshot (it wipes anything written since,
  so it's a clean baseline — handy for repeatable A/B runs); the browser session,
  tokens, schedule, and daily send counters are left untouched. It refuses to run
  while the fleet is up (so a live daemon can't race it); add `YES=1` to skip the
  confirmation prompt when scripting.
- **Update it** — pull/edit the code, then `make stop && make run` (or
  `make run-gmail`) to rebuild and redeploy. Your memory, tokens, and schedule
  (on the config volume) carry over.

## Security notes

The container's only standing credential is your Claude auth and the Discord bot
token (plus, if you enable it, the dedicated Gmail account) — no payment info, no
linked personal accounts. The real guardrails are enforced in code, not prompt
text: the sender allowlist (fails closed), the daily send caps, loop prevention
(the agent never acts on its own messages), and an offline code sandbox. The full
model is in [`app/CLAUDE.md`](app/CLAUDE.md); read it before changing anything in
`app/`.
