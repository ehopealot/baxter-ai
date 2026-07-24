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
- **Every area's steps are in THIS skill (below) — don't hand off.** When they pick
  "Discord" / "email" / "model", walk the matching section here. Do **NOT** load the
  operational **`discord`** skill (or any other) to set something up — those skills
  *operate* a surface once it's already connected (send/read/moderate); they don't
  configure it. The setup/first-time steps live right here.
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

Baxter's driver ("harness") is pluggable — the same skills, surfaces, and prompts run on
whichever model you point it at. **OpenRouter is the default and the easiest** (no
Claude/Anthropic account). Whatever they pick, the model **must support tool/function
calling** — Baxter drives everything through tools, so a model without it can't work.

**Use the `baxter` CLI — the easy, footgun-free path.** Two commands do it, no `.env`
hand-editing: `baxter set-key <type> <key>` writes an API key into `app/.env` (0600, and it
isn't echoed), and `baxter harness <type> …` flips the harness + model line for them. Each
harness is `set-key` (if it needs a key) + `harness` + apply. Walk the one they chose:

### OpenRouter (default, recommended)
Any tool-calling model, pay-as-you-go, no subscription.
```
baxter set-key openrouter sk-or-...           # get a key at openrouter.ai → Keys
baxter harness openrouter openai/gpt-4o        # any tool-calling model (or google/gemini-2.5-pro, a cheaper one, …)
```

### Claude Code (Anthropic)
Real Claude via Anthropic's Claude Code.
```
baxter set-key anthropic sk-ant-...            # from console.anthropic.com
baxter harness claude                          # BAXTER_MODEL picks the model: sonnet (default) / haiku / opus
```
Or authenticate interactively instead of a key (the token persists on the config volume):
`make app-shell`, run `claude`, complete the login, exit — then `baxter harness claude`.

### An OpenAI-style model (local OR remote)
Any OpenAI-compatible chat/completions endpoint — a local model (Ollama/LM Studio/vLLM) OR
a hosted one (OpenAI, or any compatible host).
```
# Local (e.g. Ollama) -- no key needed; default base URL is Ollama's http://localhost:11434/v1:
baxter harness openai qwen3
# Remote/hosted -- set the key AND pass the endpoint's base URL:
baxter set-key openai sk-...
baxter harness openai gpt-4o https://api.openai.com/v1
```
A **remote** endpoint REQUIRES the key — a `401 Invalid API key` means it's missing or
wrong. Local models fit in unified memory: ~7–8B in 16 GB, ~32B in 32 GB, ~70B in 64 GB.
(`baxter harness local …` still works — it's a back-compat alias for `openai`.)

### Another provider's native API (custom)
A keyed LLM API whose **native** wire format isn't OpenAI chat/completions — pick a
**dialect**: `anthropic` (Claude's Messages API) or `gemini` (Google's generateContent).
OpenAI-compatible endpoints use the `openai` harness above, not this.
```
baxter set-key custom sk-ant-...               # anthropic x-api-key / Google AI key
baxter harness custom anthropic claude-sonnet-5      # or:  baxter harness custom gemini gemini-2.5-flash
```

### Apply it + check
`baxter harness` with no arguments shows the current setting; `baxter version` shows what's
installed. A harness/key change only takes effect when the containers are recreated — apply
it with the ground-rule commands above (`baxter down && baxter up`, plus `baxter up mail` /
`baxter voice` if those surfaces are on).

**Prefer the CLI, but you can hand-edit** `app/.env` instead (`BAXTER_HARNESS` +
`OPENROUTER_*` / `ANTHROPIC_API_KEY` / `OPENAI_*` / `CUSTOM_API_*`). If you do, keep every
comment on its OWN line — an inline `# …` after a value gets baked into the value (a common
"my model/key is ignored" trap the CLI avoids).

---

## B. Setting up Discord

(The steps are right here — walk them through these. This is **setup**, so don't load the
operational `discord` skill; that one is for *using* Discord after it's connected.)

This is the default surface. Steps (they do these in the Discord Developer Portal at
**discord.com/developers/applications**):

1. **New Application** → give it a name.
2. **Bot** tab → enable the **Message Content** privileged intent (required — without
   it Baxter can't read messages). *(That's the only privileged intent needed; voice,
   if they want it later, uses a non-privileged one.)*
3. On the same **Bot** tab, click **Reset Token**, copy the token it reveals (the portal
   doesn't display a bot's token until you reset it), then set it with
   **`baxter set-key discord <token>`** (or put `DISCORD_BOT_TOKEN=...` in `app/.env`).
   Treat it like a password — it's the whole Discord credential.
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

1. Create an **AgentMail API key** at **agentmail.to → dashboard**, then set it with
   **`baxter set-key agentmail <key>`** (or put `AGENTMAIL_API_KEY=...` in `app/.env`).
2. Set two more in `app/.env` (these aren't keys, so they're hand-edited):
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
