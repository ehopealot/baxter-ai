---
name: help-user-setup
description: Walk a user through first-time setup or reconfiguration of Baxter, one step at a time — choosing or changing the model/brain, connecting Discord (bot token + invite), and enabling the email surface. Use whenever someone asks for help getting set up, onboarding, configuring, "connecting Discord", changing the model, or "turning on email".
---

# Helping a user set Baxter up

Someone wants help getting Baxter configured. Your job is to be a friendly,
**step-by-step guide** through the three setup areas — you talk them through it,
they do the clicking and key-pasting. Don't dump everything at once.

## Ground rules (important)

- **You can't do the setup FOR them.** You cannot edit `app/.env` (it's outside
  your working directory), create a Discord app, or fetch an API key. So never say
  "I've set that for you." Instead hand them the **exact line to paste** or the
  **exact command to run**, and ask them to do it and tell you when it's done.
- **One step at a time.** Give a single step, let them complete it and confirm,
  then give the next. Ask before moving on. If a step fails, help troubleshoot
  before continuing.
- **These are `.env` edits** in `app/.env`, plus a few `baxter …` commands they run
  in their terminal (the operator CLI on their PATH). A `.env` edit only applies when
  the containers are **recreated** — have them run **`baxter down && baxter up`** when
  done (use `baxter up mail` in place of the bare `baxter up` if they run the email
  surface, so the poller comes back). If they use the **voice** bot, also run
  **`baxter voice`** afterward — it's a separate service that `baxter down` stops and a
  plain `up` doesn't restart (don't use `baxter up all` for this unless email is also
  set up, or the unprovisioned mail poller crash-loops). A plain `baxter restart`
  re-runs the OLD container with the OLD env and will silently NOT pick up the change.
- Each of your runs is fresh, so if they come back mid-setup, **ask where they got
  to**. Jotting a one-line progress note in memory is fine so a later run can resume.

## Start here: ask what to set up first

Ask which they want to tackle first — **the model (brain)**, **Discord**, or
**email** — and let them pick. If they're brand new and unsure, suggest this order
and say why:

1. **Model** first — nothing else works without a brain.
2. **Discord** — the default surface, how they'll actually talk to you.
3. **Email** — optional, enable it later if they want the inbox.

Then walk through the area they chose using the steps below. When it's done, ask if
they want to set up another.

---

## A. Choosing / changing the model (the "brain")

Baxter's driver ("harness") is pluggable — the same skills, surfaces, and prompts run
on whichever model you point it at, set by `BAXTER_HARNESS` in `app/.env`. Ask which
they want; **OpenRouter is the default and the easiest** (no Claude/Anthropic account).
Whatever they pick, the model **must support tool/function calling** — Baxter drives
everything through tools, so a model without it can't work. Walk the one they choose:

### OpenRouter (default, recommended)
Any tool-calling model, pay-as-you-go, no subscription.
1. Create an API key at **openrouter.ai → Keys** (suggest they watch spend).
2. Pick a tool-calling model — `openai/gpt-4o`, `google/gemini-2.5-pro`, and
   `anthropic/claude-sonnet-4` all work; many cheaper ones do too.
3. In `app/.env`:
   ```
   BAXTER_HARNESS=openrouter
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=openai/gpt-4o
   ```

### Claude Code (Anthropic)
Drives Baxter through Anthropic's Claude Code. Authenticate one of two ways:
1. **API key** — get one at **console.anthropic.com**, then in `app/.env`:
   ```
   BAXTER_HARNESS=claude
   ANTHROPIC_API_KEY=sk-ant-...
   ```
2. **Interactive login** (no key in `.env`; the token persists on the config volume, so
   it's one-time): they run `make app-shell`, then `claude`, complete the login, exit.
   Set `BAXTER_HARNESS=claude` in `app/.env`.

`BAXTER_MODEL` picks the model — `sonnet` (default), `haiku` (cheaper), `opus` (most
capable).

### A local or OpenAI-compatible model
Runs Baxter off any **OpenAI-compatible chat/completions** endpoint — a local model via
[Ollama](https://ollama.com) (the default), LM Studio, llama.cpp, or vLLM, or a hosted one
(OpenAI itself, or any provider that speaks that API).
1. Start the server and load a **tool-calling** model (Qwen 2.5/3, Llama 3.1/3.3, and
   Mistral all qualify).
2. In `app/.env`:
   ```
   BAXTER_HARNESS=local
   OPENAI_BASE_URL=http://localhost:11434/v1   # default = Ollama; point elsewhere as needed
   OPENAI_MODEL=qwen3                           # the model tag your server has loaded
   #OPENAI_API_KEY=                             # optional; most local servers ignore it
   ```
Hardware rough guide (Apple Silicon unified memory): a ~7–8B model fits in 16 GB, ~32B in
32 GB, ~70B in 64 GB.

### Another provider's native API (custom)
For a keyed LLM API whose **native** wire format isn't OpenAI chat/completions — pick a
**dialect**. Two ship: `anthropic` (Claude's Messages API — real Claude by key, no Claude
Code binary) and `gemini` (Google's `generateContent`). In `app/.env`:
```
BAXTER_HARNESS=custom
CUSTOM_API_DIALECT=anthropic          # or: gemini
CUSTOM_API_MODEL=claude-sonnet-5      # gemini e.g. gemini-2.5-flash
CUSTOM_API_KEY=...                    # anthropic x-api-key / Google AI key
#CUSTOM_API_BASE_URL=                 # optional: point at a proxy / self-host
```
(OpenAI-compatible endpoints use the `local` harness above, not this one.)

### Switching harness/model later without hand-editing `.env`
One command flips `BAXTER_HARNESS` + the model line for them (API keys untouched); then
apply it by recreating the containers, per the apply-changes ground rule above:
```
baxter harness                                      # show the current setting
baxter harness openrouter <model>                   # e.g. openrouter openai/gpt-4o
baxter harness claude
baxter harness local <tag> [base-url]
baxter harness custom <anthropic|gemini> <model> [base-url]
```

---

## B. Setting up Discord

This is the default surface. Steps (they do these in the Discord Developer Portal at
**discord.com/developers/applications**):

1. **New Application** → give it a name.
2. **Bot** tab → enable the **Message Content** privileged intent (required — without
   it Baxter can't read messages). *(That's the only privileged intent needed; voice,
   if they want it later, uses a non-privileged one.)*
3. On the same **Bot** tab, click **Reset Token**, copy the token it reveals (the
   portal doesn't display a bot's token until you reset it), and put it in `app/.env`:
   ```
   DISCORD_BOT_TOKEN=...
   ```
   (Treat it like a password — it's the whole Discord credential.)
4. **Invite the bot:** OAuth2 → URL Generator → scope **`bot`** → tick the permissions
   you want it to have — everything **except**: Create Invite, Kick Members, Ban
   Members, Manage Roles, Manage Channels, Manage Server, Administrator, Moderate
   Members. Also leave **Manage Messages** unticked here — grant it per-channel later,
   only in the channels where you want Baxter to moderate. Open the generated URL and
   add the bot to your server.
5. **Start it:** `baxter up` — Discord is the default surface, so it comes up with the
   fleet. Then @-mention or DM the bot to check it responds.

Optional: `DISCORD_GUILD_ALLOWLIST` (comma-separated guild ids) restricts which
servers it acts in; empty = any server it's invited to. Voice is a separate opt-in —
point them at the README's "Enabling the voice surface" if they ask.

---

## C. Setting up email (AgentMail)

Optional, opt-in surface — a dedicated inbox Baxter polls and replies to in-thread.
One API key, no Google account, no OAuth.

1. Create an **AgentMail API key** at **agentmail.to → dashboard**, put it in
   `app/.env`:
   ```
   AGENTMAIL_API_KEY=...
   ```
2. Set two more in `app/.env`:
   - `OPERATOR_EMAIL` — **their** address. The ONLY recipient Baxter's `send` can
     reach, and where operational notices go. Keep it different from Baxter's own
     inbox address.
   - `ALLOWED_SENDERS` — comma-separated addresses allowed to trigger the agent.
     **Fails closed**: empty means no mail is ever processed, so at least add their
     own address.
3. **Provision the inbox** (once): they run
   ```
   baxter inbox
   ```
   It creates-or-shows Baxter's inbox and prints `AGENTMAIL_INBOX_ID` and
   `BAXTER_EMAIL` — have them paste **both** into `app/.env`.
4. **Start with the poller** (email is opt-in, a plain `baxter up` skips it):
   ```
   baxter up mail
   ```

---

When they finish an area, confirm it's working and ask if they'd like to set up
another (model / Discord / email). If everything's done, let them know they're all
set and how to check status (`baxter status`, `baxter logs`).
