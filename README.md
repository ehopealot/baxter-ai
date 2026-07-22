# Baxter AI

A standing AI agent for **Discord**: it lives in your server as a bot, and for
each message spawns a scoped `claude -p` run that can reply, browse the web, run
code in an offline sandbox, and act on a schedule.

It can **also** poll a dedicated **AgentMail** inbox and reply in-thread — that
surface is opt-in (see [Enabling the mail surface](#enabling-the-mail-surface)).
Discord is the default.

This README covers **setup and running**. For how it works internally (the
security model, the transcript-sanitization pipeline, the sandbox), see
[`app/CLAUDE.md`](app/CLAUDE.md).

> **Repo layout:** the agent's source lives in [`app/`](app/); the repo root
> holds its orchestration (`Makefile`, `compose.yaml`). All commands below run
> **from the repo root**. Two optional developer conveniences sit alongside and
> aren't needed to run the agent: [`.devcontainer/`](.devcontainer/) (a Claude
> Code dev container — `make dev`) and [`tools/claude-review/`](tools/claude-review/)
> (a post-commit review hook).
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
- *(Only for the email surface)* an **AgentMail API key** ([agentmail.to](https://agentmail.to/))
  — one key, no Google account and no OAuth. Baxter gets his own inbox on it.

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
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `BAXTER_EMAIL`, `OPERATOR_EMAIL`, `ALLOWED_SENDERS` | Mail | Only needed if you enable the email surface — see the [mail section](#enabling-the-mail-surface). |

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
   the opt-in mail poller — now runs through OpenRouter.

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

**Switching brains** without hand-editing `.env`: `make use-claude`,
`make use-openrouter MODEL=<slug>` (e.g. `z-ai/glm-4.6`), or
`make use-local MODEL=<tag> [BASE_URL=<url>]` flip `BAXTER_HARNESS` and the model
line for you (API keys untouched); `make harness` shows the current setting. Each
only edits `.env` — run `make stop && make run` to apply.

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
| `make run-mail` | Same, **plus** the opt-in mail poller (see below). |
| `make stop` | Stop + remove the fleet. |
| `make logs` | Follow logs from the whole fleet. |
| `make discord` | Run **just** the Discord gateway in the **foreground** (handy for debugging). |
| `make mail` | Run **just** the mail poller in the foreground. |
| `make inbox` | One-time AgentMail inbox provisioning — prints the inbox id/address for `app/.env`. |
| `make app-shell` | A shell in the image with the config volume mounted. |
| `make backup` / `make restore` | Snapshot / restore the agent's mind. `restore` resets it to an exact snapshot (`make stop` first; `RESTORE_FILE=…`, `YES=1` to skip the prompt). |
| `make harness` / `make use-claude` / `make use-openrouter MODEL=…` / `make use-local MODEL=…` | Show or switch which model drives Baxter (edits `.env`; `make stop && make run` to apply). |

---

## Enabling the mail surface

The mail surface polls a dedicated **[AgentMail](https://agentmail.to/)** inbox and
replies in-thread. It's opt-in (Discord is the default), but low-maintenance: a
single API key — no Google account, no OAuth consent screen, no token to renew.

1. Create an **AgentMail API key** (agentmail.to → dashboard) and set it in
   `app/.env`:
   ```
   AGENTMAIL_API_KEY=...
   ```
   Also set `OPERATOR_EMAIL` (**your** address — the only recipient Baxter's
   `send` can reach, and where operational notices go; keep it different from the
   agent's own address) and `ALLOWED_SENDERS` (comma-separated addresses allowed
   to trigger the agent; **fails closed** — empty means no mail is ever processed).
2. Provision Baxter's inbox (once):
   ```bash
   make inbox
   ```
   It creates-or-shows his inbox on AgentMail's default `@agentmail.to` domain and
   prints `AGENTMAIL_INBOX_ID` and `BAXTER_EMAIL` — paste both into `app/.env`.
3. Bring the fleet up **with** the poller:
   ```bash
   make run-mail
   ```

That's it — there's no periodic re-auth. (A custom sending domain is an AgentMail
paid-plan option; the default `@agentmail.to` address needs no DNS.)

---

## Everyday operations

- **Watch it:** `make logs` (whole fleet), or `docker logs -f baxter-discord` /
  `baxter-heartbeat` / `baxter-run` for one daemon.
- **Back up its whole state** — `make backup` writes a timestamped archive of the
  agent's **entire** durable state (everything under `.mail-agent/`: memory,
  learned skills, projects, schedule, tokens/keys, and the browser session).
  `make stop` first for a clean snapshot. ⚠️ The archive contains credentials and
  tokens, so keep it private (`backups/` is gitignored).
- **Restore a backup** — `make stop` first, then
  `make restore RESTORE_FILE=backups/baxter-state-<timestamp>.tar.gz`. This
  **replaces the agent's entire state** with that snapshot — it wipes the config
  volume's `.mail-agent/` and extracts the archive, so the box becomes byte-for-byte
  that backup (mind, schedule, tokens, browser session). That makes it the way to
  *clone* the agent onto another box, or roll one back. It refuses to run while the
  fleet is up (so a live daemon can't race it); add `YES=1` to skip the confirmation
  prompt when scripting.
- **Update it** — pull/edit the code, then `make stop && make run` (or
  `make run-mail`) to rebuild and redeploy. Your memory, keys, and schedule
  (on the config volume) carry over.

## Security notes

The container's only standing credential is your Claude auth and the Discord bot
token (plus, if you enable it, the AgentMail API key) — no payment info, no
linked personal accounts. The real guardrails are enforced in code, not prompt
text: the sender allowlist (fails closed), the daily send caps, loop prevention
(the agent never acts on its own messages), and an offline code sandbox. The full
model is in [`app/CLAUDE.md`](app/CLAUDE.md); read it before changing anything in
`app/`.
