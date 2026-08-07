---
name: help-user-setup
description: Walk a user through first-time setup or reconfiguration of Baxter, one step at a time — choosing or changing the model/brain, connecting Discord (bot token + invite), and enabling the email surface. Use whenever someone asks for help getting set up, onboarding, configuring, "connecting Discord", changing the model, or "turning on email".
---

# Help the user set Baxter up

You guide; they click and paste. Go ONE step at a time and wait for them to say a step is done before you give the next.

## Rules

- You can't do it for them — you can't edit `app/.env` or make accounts. Give the exact command or line to paste, then wait.
- All the steps are here. Don't load other skills to set things up.
- Each of your runs is fresh, so if they come back later, ask where they got to.
- After ANY change, the containers must be recreated to pick it up. Tell them to run **`baxter down && baxter up`** (use **`baxter up mail`** instead if email is on; also run **`baxter voice`** if voice is on). Plain `baxter restart` does NOT pick up changes.

## Which first?

Ask what they want: **model**, **Discord**, or **email**. If they're unsure, do them in this order and say why:

1. **Model** — nothing works without a brain.
2. **Discord** — the main way they'll talk to you.
3. **Email** — optional.

Do one, then ask if they want another.

---

## Model (the brain) — required

The model **must support tool calling**. Pick the ONE option the user wants and give ONLY that option's command(s) — **do not mix them**. Two commands do the work: `baxter set-key <type> <key>` sets a key (hosted options only), and `baxter harness <type> …` switches the model.

**If they want to run LOCALLY (Ollama on their own machine): NO API key, NO URL, and it is NOT OpenRouter — just one command.** If they say "local" or "Ollama", don't ask which server and don't invent options; give them this with their model's name:
```
baxter harness openai qwen3.5:4b        # or whatever model they pulled, e.g. llama3.1, qwen3
```
Only if their local server is NOT Ollama's default do they add its URL: `baxter harness openai <model> http://host:port/v1`. Local model RAM: ~7–8B in 16 GB, ~32B in 32 GB, ~70B in 64 GB.

The **hosted** options below each need an API key (a local model never does):

**OpenRouter** — key from openrouter.ai → Keys.
```
baxter set-key openrouter sk-or-...
baxter harness openrouter openai/gpt-4o        # any tool-calling model (google/gemini-2.5-pro is cheaper)
```

**Claude (Anthropic)** — key from console.anthropic.com.
```
baxter set-key anthropic sk-ant-...
baxter harness claude                          # model via BAXTER_MODEL: sonnet (default) / haiku / opus
```
Or log in instead of a key: `make app-shell`, run `claude`, log in, exit, then `baxter harness claude`.

**Another hosted OpenAI-compatible endpoint** (OpenAI itself, or any compatible host) — needs the key AND the base URL:
```
baxter set-key openai sk-...
baxter harness openai gpt-4o https://api.openai.com/v1
```
A missing or wrong key here → `401 Invalid API key`. (For a LOCAL model use the one command up top — no key, no URL.)

**Custom (a provider whose API isn't OpenAI-format)** — dialect is `anthropic` or `gemini`.
```
baxter set-key custom sk-ant-...
baxter harness custom anthropic claude-sonnet-5      # or: baxter harness custom gemini gemini-2.5-flash
```

Then apply it — recreate the containers: `baxter down && baxter up` (use `baxter up mail` instead if email is on, and also run `baxter voice` if voice is on; see the Rules). `baxter harness` with no arguments shows the current setting. If they hand-edit `app/.env` instead of using the CLI, every `#` comment must be on its OWN line — a comment after a value gets stored as part of the value (a common "my key is ignored" bug).

---

## Discord — the main surface

They do steps 1–4 at **discord.com/developers/applications**:

1. **New Application** → give it a name.
2. **Bot** tab → turn on the **Message Content** intent. Required, or Baxter can't read messages.
3. **Bot** tab → **Reset Token** → copy the token → tell them to run **`baxter set-key discord <token>`**. Treat it like a password.
4. **OAuth2 → URL Generator** → scope **bot** → tick the permissions you want, EXCEPT these (leave them OFF): Create Invite, Kick Members, Ban Members, Manage Roles, Manage Channels, Manage Server, Administrator, Moderate Members. Leave **Manage Messages** off too (grant it later per-channel if you want moderation). Open the generated URL and add the bot to their server.
5. Start it: **`baxter up`**. Then @-mention or DM the bot to test.

Optional: `DISCORD_GUILD_ALLOWLIST` (comma-separated server ids) limits which servers it acts in. Voice is a separate opt-in — point them at the README.

---

## Email (Resend) — optional

1. Create a Resend API key, then set it with **`baxter set-key resend <key>`**.
2. Hand-edit `app/.env` to add these values:
   - `OPERATOR_EMAIL` — their email. Where operational notices go, and always a permitted `send` recipient. Keep it different from Baxter's own inbox.
   - `ALLOWED_SENDERS` — comma-separated senders allowed to trigger Baxter. Empty = nothing is processed, so add at least their address.
   - `ALLOWED_RECIPIENTS` (optional) — comma-separated addresses Baxter's `send` may reach, if it should email anyone beyond the operator. `OPERATOR_EMAIL` is always included, so leaving it empty keeps send operator-only.
3. Set `RESEND_DOMAIN` and include `mail` in `BAXTER_SURFACES`; `baxctl add`/`home` derives and writes `BAXTER_EMAIL`.
4. Start it: **`baxter up mail`**.

---

When an area works, confirm it and ask if they want another (model / Discord / email). When they're done, tell them they're set — `baxter status` and `baxter logs` show how things are running.
