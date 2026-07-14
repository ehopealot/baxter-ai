# Baxter × Discord Integration — Design Spec

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan
**Component:** `app/` (the "Baxter Burgundy" agent)

## Goal

Let Baxter Burgundy participate in a Discord server the same way he already
handles email: added to a server, he can do anything on it **except manage
membership** (no adding people, no controlling which channels exist or who is
in them). Built with **discord.js v14**. Each triggering message spawns a
scoped `claude -p` run whose context is the message history of the channel the
message arrived on, plus per-channel memory. Baxter decides for himself when
it is natural to respond, always responds to DMs and @mentions, is liberal
about writing memory notes about a channel's history, and can author his own
ad-hoc skills to learn new bots/integrations over time.

This mirrors the existing mail agent's architecture (see `app/CLAUDE.md`): a
long-running daemon that, per trigger, spawns one bounded `claude -p` run; a
single credential-holding CLI the run invokes as a subprocess; skills and
memory on a persistent config volume.

**Guiding principle — lean on existing bots, don't build features here.** Keep
this integration thin: it gives Baxter the ability to *read and act in* a
channel, and everything beyond that we prefer to get from bots already in the
server rather than implementing in our code. Scheduled/recurring posting, polls,
role-menus, etc. are reached by Baxter *talking to an existing bot* (e.g. asking
ReminderBot to schedule a reminder) — which is exactly what the ad-hoc-skill
mechanism is for: he learns a server bot's command syntax once and writes
himself a skill so he can drive it again later. This keeps our surface small and
lets capability grow without code changes.

## Non-goals

- No membership management: adding/removing people, roles, or channels.
- No slash-command / interaction framework (message-driven only for v1).
- No voice.
- **No bespoke feature-building for things existing bots already do.** In
  particular, no scheduling/reminder engine of our own — Baxter schedules by
  asking a server bot like ReminderBot, not via code we write. (Baxter still
  only acts in response to a message he can see; he does not post proactively on
  his own timer.)
- No change to the email agent's behavior; the two share the image, volume,
  skills, and memory but run as independent processes.

## Architecture

### Process & deployment model

A new **`scripts/discord-bot.mjs`** gateway daemon, built into the *same*
`app/` image, run as its own container via a new **`make discord`** target,
sharing the same config volume (`/home/node`) as the mail poller. It:

- logs in with discord.js v14 and holds the persistent gateway websocket,
- receives `messageCreate` events,
- decides whether/how to respond (see Trigger gate),
- spawns one scoped `claude -p` run per triggering message — the same
  `runClaude`-style pattern `poll.mjs` uses (stream-json logging, timestamped
  action trace, out-of-tokens detection and notice).

The mail poller (`poll.mjs`) and Discord bot (`discord-bot.mjs`) are
independent OS processes / containers: either can crash or restart without
affecting the other. Shared, reused code (spawn wrapper, stream-json logging,
`ensureSkills`, out-of-tokens detection, memory paths) is factored into a small
module both entrypoints import, rather than duplicated.

### Credential boundary (mirrors `gmail.mjs`)

Two token consumers, both reading `DISCORD_BOT_TOKEN` from env/volume. The
spawned `claude -p` run **never sees the raw token**:

- **`scripts/discord-bot.mjs`** — the gateway *listener* (receives events,
  runs the response gate, dispatches runs). Needs the gateway connection.
- **`scripts/discord-cli.mjs`** — a token-scoped CLI the run calls as
  `Bash(discord-cli ...)`. Uses Discord's **REST API** (`@discordjs/rest`,
  stateless — no gateway needed) for all *actions*. This is the only file the
  run touches Discord through, exactly as `gmail.mjs` is for email.

`discord-cli` command surface (v1):

| Command | REST action |
|---|---|
| `send <channelId>` (body on stdin) | post a message |
| `reply <channelId> <messageId>` (body on stdin) | post a reply referencing a message |
| `react <channelId> <messageId> <emoji>` | add a reaction |
| `fetch-history <channelId> [--limit N] [--before ID]` | read recent messages (JSON) |
| `create-thread <channelId> <name> [--messageId ID]` | start a thread |
| `send-thread <threadId>` (body on stdin) | post in a thread |
| `edit <channelId> <messageId>` (body on stdin) | edit one of Baxter's own messages |
| `delete-own <channelId> <messageId>` | delete one of Baxter's own messages |
| `pin` / `unpin <channelId> <messageId>` | pin management |
| `typing <channelId>` | show typing indicator |
| `whoami` | Baxter's own bot user id / name (for loop-prevention checks) |

Commands that would touch membership/roles/channel-existence are **not
implemented** — defense in depth alongside the denied Discord permissions.

### Trigger & the "should I respond?" gate

On each `messageCreate`:

1. **Structural pre-checks (free, no model call):**
   - Ignore messages authored by Baxter's own bot user id (loop prevention).
   - If `DISCORD_GUILD_ALLOWLIST` is set and the guild is not on it, ignore.
   - **Always-respond** short-circuit for: DMs, @mentions of Baxter, and direct
     replies to one of Baxter's messages → skip the pre-filter, go to full run.
     This fires **even when the sender is another bot**, which is what makes
     "Baxter sets a reminder for himself" work: he asks ReminderBot to remind
     *him*, and when ReminderBot later pings him, that mention triggers a run so
     he can act on it.
   - A *plain* (non-mention, non-reply) message from another bot does not
     trigger a run unless `DISCORD_TRIGGER_ON_BOTS=true` (default false — avoids
     bot-to-bot ping-pong). Other bots' messages are still always included in
     channel context regardless.
2. **Cheap pre-filter (Haiku):** for an ordinary channel message, a fast
   `claude -p --model haiku` classifier receives the recent channel context and
   returns a strict yes/no on whether it is natural for Baxter to chime in. Only
   "yes" proceeds to the full run. (Cheap; may occasionally misjudge; tunable
   via the classifier prompt.)
3. **Full run (Sonnet):** rendered prompt (channel context + per-channel memory
   + shared memory) spawned as a scoped `claude -p`, acting via `discord-cli`.

**Debounce & concurrency (cost/^flood control):**

- Per-channel coalescing window (`DISCORD_DEBOUNCE_MS`, default ~4000ms): rapid
  follow-up messages in the same channel are batched into a single run using the
  latest context, rather than one run per message.
- Runs for the same channel are **serialized** (a per-channel queue) so Baxter
  never talks over himself.
- A global concurrency cap (`DISCORD_MAX_CONCURRENT_RUNS`) bounds simultaneous
  `claude -p` runs across channels.
- A per-day Discord **send cap** (`DISCORD_MAX_SENDS_PER_DAY`), the analog of
  the email `MAX_SENDS_PER_DAY`, enforced in `discord-cli` at the actual send
  call (reusing the `send-state.mjs` counter pattern, keyed separately from
  email).

### Context provided to the run

- **Channel history:** the last N messages (default `DISCORD_HISTORY_LIMIT`
  200 — this lives in a small, few-person channel, so a generous window is cheap
  and keeps Baxter well-oriented; still token-capped as a backstop). Discord's
  REST endpoint returns at most 100 messages per request, so `fetch-history`
  paginates (`before` cursor) to satisfy limits above 100. The **daemon**
  fetches this once and uses it for both the Haiku pre-filter and the full run's
  rendered prompt (author display names + ids, timestamps, content); the full
  run can pull *more* history on demand via `discord-cli fetch-history`. Attacker-influenced content (any
  message body) is passed through the same structural-marker/line-terminator
  neutralization the email transcript uses, so a message can't forge the
  prompt's framing (reuse `neutralizeStructuralMarkers` /
  `normalizeLineTerminators` from `gmail.mjs`).
- **Per-channel memory + shared global:** `~/.mail-agent/discord/<channelId>.md`
  (what Baxter did/learned in *this* channel) **plus** the existing shared
  `memory.md`. The prompt instructs Baxter to be liberal about writing
  channel notes so he can pick up context beyond what the channel scrollback
  shows.

### Ad-hoc skills ("learn new bots/integrations")

Baxter can author new skills at
`~/.mail-agent/memory-workspace/.claude/skills/<name>/SKILL.md`. That directory
is on the persistent config volume, and `ensureSkills()` only overwrites the
*known baked* skills per-name (verified: it `cpSync`s each `SKILL_SRCS` entry by
basename, never wiping the directory or unknown subdirs). So Baxter's own
skills **survive across runs and future wake-ups untouched**. The Discord skill
and prompt explicitly tell him: when you work out how to interact with a new
bot/integration, write yourself a skill so you remember it next time. Ad-hoc
skills are shared across email + Discord (one persona).

### Skills we give him

- A new **`discord`** skill (shape like the `playwright-cli` skill) documenting
  the `discord-cli` surface, Discord conventions (mentions/threads/reactions/
  markdown/embeds), the per-channel memory workflow, and the ad-hoc-skill
  workflow. Added to `SKILL_SRCS` so it's copied into the run's cwd.
- The existing **playwright-cli** and **invisible-playwright** skills come along
  automatically (e.g. to browse a bot's docs while learning it).

### Permissions — "everything except manage membership"

Enforced twice (defense in depth): Discord won't grant it server-side, *and*
`discord-cli` doesn't expose the action.

- **Denied:** Create Invite (adding people), Kick Members, Ban Members, Manage
  Roles (who's in / channel access), Manage Channels (which channels exist),
  Manage Guild, Administrator, and **Moderate Members** (timeout — defaulted to
  deny as membership-adjacent; flip to grant if desired).
- **Granted:** everything else — send/edit/delete messages, add reactions,
  create/use threads, read message history, embed links, attach files, use
  external emoji, mention everyone (if the server allows), pin messages, show
  typing.

### Gateway intents

`Guilds`, `GuildMessages`, `DirectMessages`, `MessageContent` (privileged — must
be enabled in the Developer Portal), `GuildMessageReactions`. Partials for
`Channel`/`Message`/`Reaction` so DM and uncached-message events resolve.

### Bot setup walkthrough (included in the plan)

1. Discord Developer Portal → New Application.
2. Bot tab → enable the **Message Content Intent** (privileged).
3. Reset/copy the **bot token** → `DISCORD_BOT_TOKEN` in `app/.env`.
4. OAuth2 → URL Generator → scope `bot`, tick the granted permissions from
   §Permissions (or use the precomputed permission integer) → open the invite
   URL → add to the server.
5. `make discord`.

### New env (`app/.env.example`)

| Var | Default | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | (unset) | bot token; unset = Discord bot disabled |
| `DISCORD_MAX_SENDS_PER_DAY` | 1000 | daily Discord send cap (flood guard) |
| `DISCORD_HISTORY_LIMIT` | 200 | messages of channel scrollback as context (small channel; paginated past 100/request) |
| `DISCORD_DEBOUNCE_MS` | 4000 | per-channel coalescing window |
| `DISCORD_MAX_CONCURRENT_RUNS` | 5 | global cap on simultaneous runs |
| `DISCORD_TRIGGER_ON_BOTS` | false | whether another bot's message can *trigger* a run (context inclusion is separate — see note) |
| `DISCORD_GUILD_ALLOWLIST` | (empty) | optional; empty = any invited server |

> **Bots in context vs. bots as triggers.** Other bots' messages are *always*
> included in the channel history/context so Baxter can read e.g. ReminderBot's
> confirmation of a schedule he just set. What `DISCORD_TRIGGER_ON_BOTS`
> controls is narrower: whether a *plain* message from another bot starts a run.
> Default `false` avoids bot-to-bot ping-pong. Regardless of this flag, a bot
> message that @mentions Baxter or directly replies to him still triggers a
> response (the always-respond short-circuit wins), and Baxter's own messages
> are always ignored as triggers (loop prevention). Within a single run Baxter
> can send a command to another bot via `discord-cli` and then `fetch-history`
> to read its reply, so he does not need a trigger to complete a bot handoff.

## Security notes

- Discord's invite + role model is itself the fail-closed gate (unlike email,
  where anyone can send): the bot only sees guilds it's invited to and channels
  its role permits. `DISCORD_GUILD_ALLOWLIST` is an optional extra bound.
- DMs from anyone who can DM the bot are answered (per "always respond to a
  DM"). Accepted as an open surface for v1; an operator/user DM allowlist can be
  added later if that surface proves noisy.
- Message content is attacker-influenced and runs through the same
  neutralization pipeline the email transcript uses before entering the prompt.
- The token lives only in `discord-bot.mjs` and `discord-cli.mjs`; the run
  reaches Discord only through `Bash(discord-cli ...)`.

## Testing

- **Unit (`node:test`, no new dep):** the response-gate structural pre-checks
  (self/bot/allowlist/mention/DM/reply classification) and the debounce/queue
  coalescing logic, as pure functions extracted from `discord-bot.mjs`.
  Import the real functions (guard the daemon entry behind the
  `pathToFileURL(argv[1])===import.meta.url` check, as `poll.mjs`/`gmail.mjs`
  do) rather than reimplementing them.
- **`discord-cli` smoke:** against a throwaway test server — `whoami`,
  `fetch-history`, `send`, `react`, `create-thread`, and confirm a
  membership-touching action is absent/refused.
- **End-to-end:** invite the bot to a test server; verify (1) an @mention gets a
  reply, (2) a DM gets a reply, (3) an on-topic channel message triggers a
  natural reply while off-topic chatter does not, (4) a per-channel memory file
  is written, (5) Baxter can author a skill that survives a second run, (6) the
  send cap and self/bot loop-prevention hold under a burst.

## Acceptance criteria

1. `make discord` runs the gateway daemon from the shared image; unset token
   cleanly disables it.
2. Baxter always replies to DMs, @mentions, and direct replies; chimes in on
   channel messages only when the Haiku gate judges it natural.
3. Each run's context is the channel's recent history + that channel's memory
   file + shared memory; the run acts only through `discord-cli`.
4. Baxter cannot add people, manage roles, or create/delete channels — by
   Discord permission and by absent CLI commands.
5. Baxter writes per-channel memory notes and can create persistent ad-hoc
   skills.
6. The email agent is unchanged and unaffected.
