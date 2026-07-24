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
  in their terminal (the operator CLI on their PATH). Config changes take effect on
  the next restart — remind them to run `baxter up` (or `baxter restart`) when done.
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

Baxter's driver is pluggable; the same skills and surfaces run on whichever model
you point it at. **OpenRouter is the default and needs no Claude/Anthropic account.**

**Default — OpenRouter:**
1. Create an OpenRouter API key at **openrouter.ai → Keys** (pay-as-you-go per
   token; suggest they watch spend).
2. Pick a model that **supports tool/function calling** (required). Good picks:
   `openai/gpt-4o`, `google/gemini-2.5-pro`, `anthropic/claude-sonnet-4`; many
   cheaper models work too.
3. In `app/.env`:
   ```
   BAXTER_HARNESS=openrouter
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=openai/gpt-4o
   ```

**Alternatives** (only if they ask — don't push these):
- **Claude Code:** `BAXTER_HARNESS=claude` + `ANTHROPIC_API_KEY=sk-ant-...` (or
  `make app-shell` then `claude` to log in interactively). `BAXTER_MODEL` picks
  `sonnet`/`haiku`/`opus`.
- **Local model:** `BAXTER_HARNESS=local`, `OPENAI_BASE_URL` (default Ollama
  `http://localhost:11434/v1`), `OPENAI_MODEL=<tag>`. Must support tool calling.
- **Another provider's native API:** `BAXTER_HARNESS=custom`,
  `CUSTOM_API_DIALECT=anthropic|gemini`, `CUSTOM_API_MODEL`, `CUSTOM_API_KEY`.

**Changing the brain without hand-editing `.env`** — the easy path, tell them about
it: they run one of these in their terminal (it edits `.env` for them; keys are left
untouched), then restart:
```
baxter harness                       # show the current setting
baxter harness openrouter <model>    # e.g. openrouter openai/gpt-4o
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
3. **Copy the bot token** and put it in `app/.env`:
   ```
   DISCORD_BOT_TOKEN=...
   ```
   (Treat it like a password — it's the whole Discord credential.)
4. **Invite the bot:** OAuth2 → URL Generator → scope **`bot`** → tick the
   permissions you want it to have (everything **except** manage-membership:
   no Kick/Ban, Manage Roles, Manage Channels, Manage Guild, Administrator). Open the
   generated URL and add the bot to your server.
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
