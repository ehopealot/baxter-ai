This is the open-source agent runtime that powers Baxter Family AI ([bax.bot](https://bax.bot)).

# Baxter AI

Baxter is a standing AI agent for **Discord**. It lives in your server as a bot.
For each message, it starts a scoped agent run. That run can reply, browse the
web, run code in an offline sandbox, and act on a schedule. It runs on
**OpenRouter by default** (any tool-calling model; you need no Claude or
Anthropic account). It also runs on Claude Code or a local model if you prefer.

## Public self-hosting scope

**Discord is the only supported standalone self-hosted surface today.** This
repository also contains the agent-side code for Baxter Family integrations such
as mail, Home, and SMS so their behavior is auditable. Those integrations depend
on product infrastructure and provisioning that are not included here; they are
not a supported standalone setup or compatibility promise.

For a supported self-hosted deployment, configure `BAXTER_SURFACES=discord`.
The quick-start instructions below do exactly that.

This README covers the supported Discord setup and running it. For how it works
inside (the security model, the transcript-sanitization pipeline, the sandbox), see
[`app/CLAUDE.md`](app/CLAUDE.md).

> **Repo layout:** the agent's source lives in [`app/`](app/). The repo root
> holds its orchestration (`Makefile`, `compose.yaml`). Run all commands below
> **from the repo root**. Two optional developer conveniences sit alongside and
> are not needed to run the agent: [`.devcontainer/`](.devcontainer/) (a Claude
> Code dev container, `make dev`) and
> [`tools/claude-review/`](tools/claude-review/) (a post-commit review hook).
>
> **A note on names:** Docker resource names (the containers, the config volume)
> take a prefix from the repo directory's name. This README assumes a checkout
> named `baxter` (so `baxter-discord`, `baxter-app-config`, and so on). If your
> directory has a different name, substitute it in the `baxter-...` names below.

---

## Quick install

```bash
curl -fsSL https://oss.bax.bot/install.sh | bash
```

The script checks the prerequisites, clones Baxter into `~/baxter`, puts the
**`baxter`** CLI on your PATH, and scaffolds `app/.env`. Set
`BAXTER_SURFACES=discord`, then fill in your Discord token and model key (see
[1. Configure](#1-configure)) and run `baxter up`. The script never starts
Baxter and never touches your secrets; it hands off. Install into another
directory with `... | bash -s -- /path/to/dir`. Prefer to do it by hand? The
manual steps follow.

---

## Prerequisites

- **Docker** with the **`docker compose` v2** plugin. Use Colima or Docker
  Desktop on macOS, or native Linux. (`docker compose version` should work.)
- **`make`.**
- An **OpenRouter API key** ([openrouter.ai](https://openrouter.ai/)) for the
  agent runs. This is Baxter's default brain (any tool-calling model; Claude Code
  or a local model also work, see step 2).
- A **Discord application/bot** you control (step 3).

---

## 1. Configure

```bash
cp app/.env.example app/.env
```

Then edit `app/.env`. For the supported standalone deployment, set:

```dotenv
BAXTER_SURFACES=discord
```

The file comments every variable. The essentials:

| Variable | For | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | **Discord** | From the Developer Portal (step 3). The Discord surface is off if this is unset. |
| `DISCORD_GUILD_ALLOWLIST` | Discord | Optional comma-separated guild-id allowlist. Empty means any server it joins. |
| `PERSONA_NAME` | Baxter | The default is `Baxter`. |
| `BAXTER_HARNESS`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | **model** | Which brain drives Baxter. **OpenRouter is the default** (any tool-calling model). See [step 2](#2-choose-baxters-brain-model) for Claude, local, or custom. |

The remaining variables are optional safety caps and tuning. Leave them alone for
a Discord-only install.

---

## 2. Choose Baxter's brain (model)

Baxter's driver is pluggable. The same skills, CLIs, prompts, and surfaces run on
whichever model you point it at. **OpenRouter is the default**, and Baxter runs
well and cheaply on tool-calling models there. **You do not need a Claude or
Anthropic account.**

> **No key yet? Run `baxter shell ollama`.** It runs a small keyless local model
> through [Ollama](https://ollama.com) (`qwen3.5:4b` by default; pass any Ollama
> model as an argument, for example `baxter shell ollama qwen2.5:7b` for a
> stronger one). It opens the terminal talking to that model, so you can chat and
> have it walk you through the setup below without any API key. It serves the
> model on your **host** (it confirms before it downloads), so you need Ollama
> installed (`brew install ollama`, or the Linux install script). It is an
> onboarding convenience, not a day-to-day deployment. Once you pick a real brain
> below, use that for day-to-day.

**OpenRouter (default).**
1. Create an **OpenRouter API key** (openrouter.ai, then *Keys*). It is
   pay-as-you-go per token, with no subscription, so watch your spend.
2. Pick a model that **supports tool/function calling** (required; a model
   without it cannot drive the CLIs). `openai/gpt-4o`, `google/gemini-2.5-pro`,
   and `anthropic/claude-sonnet-4` all work, and many cheaper models do too.
3. Set it in `app/.env` (`.env.example` already ships `BAXTER_HARNESS=openrouter`):
   ```
   BAXTER_HARNESS=openrouter
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=openai/gpt-4o
   #OPENROUTER_MAX_STEPS=40    # optional: caps tool-loop iterations per run
   ```
   A typo in `BAXTER_HARNESS` crashes the daemon at startup on purpose.

### Alternative: Claude Code

Prefer Anthropic's Claude Code as the driver? Set `BAXTER_HARNESS=claude` and
authenticate the CLI. The credentials persist on the `baxter-app-config` volume,
so it is a one-time step. Either add an API key to `app/.env`:
```
BAXTER_HARNESS=claude
ANTHROPIC_API_KEY=sk-ant-...
```
or log in once so the token persists on the volume:
```bash
make app-shell     # drops you into the image with the config volume mounted
claude             # complete the login, then exit
```
With the Claude harness, `BAXTER_MODEL` picks the model (`sonnet` is the default,
`haiku` is cheaper, `opus` is the most capable).

### Alternative: an OpenAI-style model (local or remote)

Set `BAXTER_HARNESS=openai` to drive Baxter off any OpenAI-compatible
**chat/completions** endpoint. Use a self-hosted model through
[Ollama](https://ollama.com/) (the default), LM Studio, llama.cpp, or vLLM, **or
a remote/hosted one** (OpenAI, or any compatible host). In `app/.env` (put each
comment on its own line; an inline `# ...` after a value gets baked into the
value):
```
BAXTER_HARNESS=openai
# default is Ollama's; set a remote URL to point at OpenAI etc.
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen3
```
For a **remote** endpoint you also need a key: `baxter set-key openai <key>`
(local servers usually ignore it). The model **must support tool calling** (Qwen
2.5/3, Llama 3.1/3.3, Mistral, and similar do). On Apple Silicon, a 7 to 8B model
fits in 16 GB, a 32B in 32 GB, and a 70B in 64 GB. (`local` still works as a
back-compat alias for `openai`.)

### Alternative: another provider's native API

Set `BAXTER_HARNESS=custom` to drive Baxter off a keyed LLM API whose **native**
wire format is not OpenAI chat/completions. Pick a **dialect** and point it at
the provider. Two ship: `anthropic` (Claude's Messages API; real Claude by API
key, no Claude Code binary) and `gemini` (Google's `generateContent`). In
`app/.env`:
```
BAXTER_HARNESS=custom
CUSTOM_API_DIALECT=anthropic          # or: gemini
CUSTOM_API_MODEL=claude-sonnet-5      # gemini e.g. gemini-2.5-flash
CUSTOM_API_KEY=sk-ant-...             # the provider key (anthropic x-api-key / Google AI key)
#CUSTOM_API_BASE_URL=                 # optional: point at a proxy / self-host
```
The model **must support tool calling**. This harness is only for a provider with
a *different* native API. OpenAI-compatible endpoints (including most third-party
hosts) use the `openai` harness above. Together they reach essentially every
hosted LLM API.

Web search and page fetching work the same across all four harnesses, through the
keyless `web-cli` (no extra config). Web browsing still uses `playwright-cli`.

**Switch brains** without a hand-edit of `.env`: `baxter harness openrouter
<slug>` (for example `openai/gpt-4o`), `baxter harness claude`, `baxter harness
openai <model> [base-url]`, or `baxter harness custom <anthropic|gemini> <model>
[base-url]`. Each flips `BAXTER_HARNESS` and the model line for you (it does not
touch the API keys). `baxter harness` shows the current setting. (These wrap
`make use-openrouter`, `use-claude`, `use-openai`, and `use-custom`.) Set keys the
same easy way: `baxter set-key <openrouter|openai|anthropic|custom|discord>
<key>`. Each one only edits `.env`. Apply the change with `baxter down && baxter
up` (or `baxter update` on the box).

---

## 3. Set up Discord

1. In the **[Discord Developer
   Portal](https://discord.com/developers/applications)**, click **New
   Application**.
2. Open the **Bot** tab, and **enable the *Message Content* privileged intent**
   (required; without it the bot cannot read message text). Click **Reset
   Token**, copy it, and put it in `DISCORD_BOT_TOKEN` in `app/.env`.
3. Open **OAuth2 → URL Generator**. Tick the **`bot`** scope, then tick the
   permissions you want. Grant everything **except** these (the bot neither
   requests nor exposes membership management): **Create Invite, Kick Members,
   Ban Members, Manage Roles, Manage Channels, Manage Server, Administrator,
   Moderate Members.**
4. Open the generated URL and **add the bot to your server**.

Once the bot is in your server, it responds to DMs, @mentions, replies, and
channel messages. (It ignores only its *own* messages; it treats other bots like
people.)

**Moderation (deleting other users' messages).** Baxter can delete *other users'*
messages, but only where you grant it Discord's **Manage Messages** permission.
Grant it **per channel**: channel settings, then *Permissions*, then the bot (or
its role), then enable *Manage Messages*, in just the channels you want it to
moderate. Everywhere else, Discord itself refuses the delete, so the permission
is the real boundary, not prompt text. The bot can always still delete its *own*
messages anywhere. Leave *Manage Messages* off the server-wide invite grant in
step 3 unless you want it to moderate every channel.

---

## 4. Run

Install the **`baxter`** CLI once. It is the everyday interface (a thin wrapper
over the Makefile, runnable from any directory):

```bash
./install.sh          # symlinks `baxter` into /usr/local/bin (or ~/.local/bin)
```

Then:

```bash
baxter up             # build + start Discord (with BAXTER_SURFACES=discord)
baxter status         # what's running
baxter logs discord   # follow the Discord bot
baxter shell          # Baxter's interactive terminal: chat + drive his tools via /slash
baxter down           # stop + remove the deployment (config volume + memory stay intact)
baxter update         # on the box: update to the latest RELEASE + rebuild + restart
                      #   (baxter update main -> track bleeding-edge main instead)
baxter help           # everything else: restart, build, backup, restore, harness
```

`baxter shell` opens an interactive terminal to chat with Baxter and run his
tools directly (`/collections list`, `/code python`, `/web fetch ...`). `baxter
shell <box>` runs the same terminal on a remote box over SSH.

**Under the hood.** `baxter` just calls `make` targets. The Makefile stays the
source of truth for dev and build, and you can call it directly instead: `make
run` (start the selected deployment), `make stop`, `make logs`, `make build-app`,
`make tui` (the terminal), `make backup` / `restore`, and `make harness` /
`use-openrouter MODEL=...` / `use-claude` / `use-openai MODEL=...` (switch the
model). `make discord` runs the supported surface in the foreground for
debugging. `make app-shell` is a raw shell in the image. Other surfaces in this
repository are Baxter Family integrations, not standalone setup targets.

### Production drain

Before maintenance, run `make drain` (optionally `DRAIN_TIMEOUT_SECONDS=600`). It
first serializes the selected content-addressed app image check/build with other
tenants using the same Core checkout, building it when absent before it closes
intake. It then serializes with `make run`, writes the
durable drain marker, asks running Discord and light daemons to close intake, and
waits for active runtime leases to reach zero. On success it gracefully stops only
those app containers; searxng and other compose resources remain running. A timeout returns nonzero and deliberately
leaves both marker and containers in place. The next `make run` clears a successful
marker under the same lifecycle lock, but refuses to reopen while leases remain.
The marker CLI is `node scripts/drain-cli.ts begin|status|clear` inside the app
image/state mount; it has no network listener and Docker local control is the
operator authentication boundary.

---

## Baxter Family integrations

The source includes agent-side mail, Home, and SMS integrations so their behavior
can be inspected. They depend on Baxter Family service-side routing,
authentication, and provisioning that are not included in this repository. They
are not documented or supported as standalone deployments; do not add them to
`BAXTER_SURFACES` for a public self-hosted install.

---


## Everyday operations

- **Watch it:** `baxter logs discord`.
- **Talk to it directly:** `baxter shell`. This is an interactive terminal to
  chat with Baxter and run his tools through `/slash` (`baxter shell <box>` for a
  remote box).
- **Back up its whole state:** `baxter backup` writes a timestamped archive of
  the agent's **entire** durable state (everything under `.mail-agent/`: memory,
  learned skills, collections, schedule, tokens and keys, and the browser session).
  Run `baxter down` first for a clean snapshot. Warning: the archive holds
  credentials and tokens, so keep it private (`backups/` is gitignored).
- **Restore a backup:** run `baxter down` first, then `baxter restore
  backups/baxter-state-<timestamp>.tar.gz`. This **replaces the agent's entire
  state** with that snapshot. It wipes the config volume's `.mail-agent/` and
  extracts the archive, so the box becomes byte-for-byte that backup (mind,
  schedule, tokens, browser session). That makes it the way to *clone* the agent
  onto another box, or to roll one back. It refuses to run while the deployment is up
  (so a live daemon cannot race it). Add `YES=1` to skip the confirmation prompt
  when you script it.
- **Update it:** on the box, `baxter update` moves to the latest **release** and
  rebuilds and restarts (`baxter update main` tracks bleeding-edge `main`
  instead). Locally, run `baxter down && baxter up` after you edit. Your memory,
  keys, and schedule (on the config volume) carry over.

## License

Baxter is licensed under the [Apache License 2.0](LICENSE). This license does
not grant rights to the Baxter name, logos, or other trademarks.

## Security notes

In the supported Discord profile, the container's only standing credentials are
your model auth and Discord bot token. There is no payment info and no linked
personal account. Code enforces the real guardrails, not prompt text: the daily
send caps, loop prevention (the agent never acts on its own messages), and an
offline code sandbox. The full model is in [`app/CLAUDE.md`](app/CLAUDE.md); read
it before you change anything in `app/`.
