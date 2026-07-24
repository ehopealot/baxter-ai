# Baxter AI

A standing AI agent for **Discord**: it lives in your server as a bot, and for
each message spawns a scoped agent run that can reply, browse the web, run
code in an offline sandbox, and act on a schedule. It runs on **OpenRouter by
default** (any tool-calling model — no Claude/Anthropic account required), or on
Claude Code or a local model if you prefer.

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
- An **OpenRouter API key** ([openrouter.ai](https://openrouter.ai/)) for the agent
  runs — Baxter's default brain (any tool-calling model; Claude Code or a local model
  also work — see step 2).
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
| `PERSONA_NAME` | both | Defaults to `Baxter`. |
| `BAXTER_HARNESS`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | **model** | Which brain drives Baxter — **OpenRouter by default** (any tool-calling model). See [step 2](#2-choose-baxters-brain-model) for Claude / local / custom. |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `BAXTER_EMAIL`, `OPERATOR_EMAIL`, `ALLOWED_SENDERS` | Mail | Only needed if you enable the email surface — see the [mail section](#enabling-the-mail-surface). |

The remaining variables are safety caps and tuning (send/day limits, poll
interval, heartbeat guardrails) with sensible defaults — leave them unless you
have a reason to change them.

---

## 2. Choose Baxter's brain (model)

Baxter's driver is pluggable — the same skills, CLIs, prompts, and surfaces run on
whichever model you point it at. **OpenRouter is the default**, and Baxter runs well
(and cheaply) on tool-calling models there. **You do not need a Claude/Anthropic account.**

**OpenRouter (default).**
1. Create an **OpenRouter API key** (openrouter.ai → *Keys*) — pay-as-you-go per token,
   no subscription, so keep an eye on spend.
2. Pick a model that **supports tool/function calling** (required — a model without it
   can't drive the CLIs). `openai/gpt-4o`, `google/gemini-2.5-pro`, and
   `anthropic/claude-sonnet-4` all work, and many cheaper models do too.
3. Set it in `app/.env` (`.env.example` already ships `BAXTER_HARNESS=openrouter`):
   ```
   BAXTER_HARNESS=openrouter
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=openai/gpt-4o
   #OPENROUTER_MAX_STEPS=40    # optional: caps tool-loop iterations per run
   ```
   A typo'd `BAXTER_HARNESS` crashes the daemon at startup on purpose.

### Alternative: Claude Code

Prefer Anthropic's Claude Code as the driver? Set `BAXTER_HARNESS=claude` and
authenticate the CLI — credentials persist on the `baxter-app-config` volume, so it's a
one-time step. Either add an API key to `app/.env`:
```
BAXTER_HARNESS=claude
ANTHROPIC_API_KEY=sk-ant-...
```
or log in interactively so the token persists on the volume:
```bash
make app-shell     # drops you into the image with the config volume mounted
claude             # complete the login, then exit
```
With the Claude harness, `BAXTER_MODEL` picks the model (`sonnet` default, `haiku`
cheaper, `opus` most capable).

### Alternative: a local model

Set `BAXTER_HARNESS=local` to drive Baxter off any
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

### Alternative: another provider's native API

Set `BAXTER_HARNESS=custom` to drive Baxter off a keyed LLM API whose **native**
wire format isn't OpenAI chat/completions — pick a **dialect** and point it at the
provider. Two ship: `anthropic` (Claude's Messages API — real Claude by API key, no
Claude Code binary) and `gemini` (Google's `generateContent`). In `app/.env`:
```
BAXTER_HARNESS=custom
CUSTOM_API_DIALECT=anthropic          # or: gemini
CUSTOM_API_MODEL=claude-sonnet-5      # gemini e.g. gemini-2.5-flash
CUSTOM_API_KEY=sk-ant-...             # the provider key (anthropic x-api-key / Google AI key)
#CUSTOM_API_BASE_URL=                 # optional: point at a proxy / self-host
```
The model **must support tool calling**. This harness is only for providers with a
*different* native API; OpenAI-compatible endpoints (including most third-party
hosts) use the `local` harness above — together they reach essentially every hosted
LLM API.

Web search and page fetching work the same across all four harnesses, via the
keyless `web-cli` (no extra config); web browsing still uses `playwright-cli`.

**Switching brains** without hand-editing `.env`: `baxter harness openrouter <slug>`
(e.g. `openai/gpt-4o`), `baxter harness claude`,
`baxter harness local <tag> [base-url]`, or
`baxter harness custom <anthropic|gemini> <model> [base-url]` flip `BAXTER_HARNESS`
and the model line for you (API keys untouched); `baxter harness` shows the current
setting. (These wrap `make use-openrouter`/`use-claude`/`use-local`/`use-custom`.)
Each only edits `.env` — apply with
`baxter down && baxter up` (or `baxter update` on the box).

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

Install the **`baxter`** CLI once — it's the everyday interface (a thin wrapper over the
Makefile, runnable from any directory):

```bash
./install.sh          # symlinks `baxter` into /usr/local/bin (or ~/.local/bin)
```

Then:

```bash
baxter up             # build + start the default fleet (Discord + heartbeat + codapi)
                      #   baxter up mail -> + the mail poller;  baxter up all -> + voice
baxter status         # what's running
baxter logs discord   # follow one service (discord|heartbeat|mail|voice|codapi); `baxter logs` = all
baxter shell          # Baxter's interactive terminal: chat + drive his tools via /slash
baxter down           # stop + remove the fleet (config volume + memory stay intact)
baxter update         # on the box: git pull + rebuild + restart in one shot
baxter help           # everything else: restart, voice, inbox, build, backup, restore, harness
```

`baxter shell` opens an interactive terminal to chat with Baxter and run his tools
directly (`/projects list`, `/code python`, `/web fetch …`); `baxter shell <box>` runs the
same terminal on a remote box over SSH.

**Under the hood.** `baxter` just calls `make` targets — the Makefile stays the source of
truth for dev/build, and you can call it directly instead: `make run` / `run-mail` (start
the fleet), `make stop`, `make logs`, `make build-app`, `make inbox`, `make tui` (the
terminal), `make backup` / `restore`, and `make harness` / `use-openrouter MODEL=…` /
`use-claude` / `use-local MODEL=…` (switch the model). `make discord` / `make mail` run one
surface in the foreground for debugging; `make app-shell` is a raw shell in the image.

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
   baxter inbox
   ```
   It creates-or-shows his inbox on AgentMail's default `@agentmail.to` domain and
   prints `AGENTMAIL_INBOX_ID` and `BAXTER_EMAIL` — paste both into `app/.env`.
3. Bring the fleet up **with** the poller:
   ```bash
   baxter up mail
   ```

That's it — there's no periodic re-auth. (A custom sending domain is an AgentMail
paid-plan option; the default `@agentmail.to` address needs no DNS.)

---

## Everyday operations

- **Watch it:** `baxter logs` (whole fleet), or `baxter logs discord` (or `heartbeat` /
  `mail` / `voice` / `codapi`) for one service.
- **Talk to it directly:** `baxter shell` — an interactive terminal to chat with Baxter
  and run his tools via `/slash` (`baxter shell <box>` for a remote box).
- **Back up its whole state** — `baxter backup` writes a timestamped archive of the
  agent's **entire** durable state (everything under `.mail-agent/`: memory,
  learned skills, projects, schedule, tokens/keys, and the browser session).
  `baxter down` first for a clean snapshot. ⚠️ The archive contains credentials and
  tokens, so keep it private (`backups/` is gitignored).
- **Restore a backup** — `baxter down` first, then
  `baxter restore backups/baxter-state-<timestamp>.tar.gz`. This
  **replaces the agent's entire state** with that snapshot — it wipes the config
  volume's `.mail-agent/` and extracts the archive, so the box becomes byte-for-byte
  that backup (mind, schedule, tokens, browser session). That makes it the way to
  *clone* the agent onto another box, or roll one back. It refuses to run while the
  fleet is up (so a live daemon can't race it); add `YES=1` to skip the confirmation
  prompt when scripting.
- **Update it** — on the box, `baxter update` (git pull + rebuild + restart in one shot);
  locally, `baxter down && baxter up` after editing. Your memory, keys, and schedule
  (on the config volume) carry over.

## Security notes

The container's only standing credential is your Claude auth and the Discord bot
token (plus, if you enable it, the AgentMail API key) — no payment info, no
linked personal accounts. The real guardrails are enforced in code, not prompt
text: the sender allowlist (fails closed), the daily send caps, loop prevention
(the agent never acts on its own messages), and an offline code sandbox. The full
model is in [`app/CLAUDE.md`](app/CLAUDE.md); read it before changing anything in
`app/`.
