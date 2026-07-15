---
name: discord
description: Act in a Discord server via discord-cli -- send/reply/react, read channel history, manage threads, edit/delete your own messages. You can do anything on the server EXCEPT manage membership (no adding people, roles, or channels). Also covers per-channel memory and writing your own ad-hoc skills for new bots.
allowed-tools: Bash(discord-cli:*)
---

# Acting in Discord with discord-cli

`discord-cli` is your interface to Discord. It talks to the Discord REST API
with the bot token (which you never see) — you just call the commands. You are
a full member of the server and can do anything on it **except manage
membership**: you cannot add or remove people, change roles, or create/delete
channels, and those commands intentionally do not exist. Don't try to route
around that.

Every command that sends text takes the message **body on stdin** (like
`gmail.mjs`), so pipe it in. IDs are Discord snowflake strings.

## Commands

| Command | What it does |
|---|---|
| `discord-cli whoami` | Your own bot user id/name (JSON). Use it to recognize your own messages. |
| `… \| discord-cli send <channelId>` | Post a message (body on stdin). Prints the new message JSON. |
| `… \| discord-cli reply <channelId> <messageId>` | Reply referencing a specific message (body on stdin). |
| `discord-cli react <channelId> <messageId> <emoji>` | Add a reaction. Emoji is a literal unicode char (`👍`) or a custom `<:name:id>`. |
| `discord-cli unreact <channelId> <messageId> <emoji>` | Remove **your own** reaction of that emoji (only yours -- it's the `@me` endpoint, not moderation). |
| `discord-cli fetch-history <channelId> [--limit N] [--before ID]` | Read recent messages, chronological JSON array. Pull more context than your prompt already shows. |
| `discord-cli create-thread <channelId> <name> [--messageId ID]` | Start a thread (optionally off a message). |
| `… \| discord-cli send-thread <threadId>` | Post in a thread (body on stdin). |
| `… \| discord-cli edit <channelId> <messageId>` | Edit **one of your own** messages (body on stdin). |
| `discord-cli delete-own <channelId> <messageId>` | Delete **one of your own** messages. |
| `discord-cli pin` / `unpin <channelId> <messageId>` | Pin management. |
| `discord-cli typing <channelId>` | Show the typing indicator (for a longer task). |

Notes:
- Messages over Discord's 2000-char limit are split automatically by `send`,
  `reply`, and `send-thread` (the printed JSON is the final chunk). `edit` does
  NOT split -- keep edited content under 2000 chars.
- Mentions in text: a user is `<@id>`, a channel is `<#id>`, a custom emoji is
  `<:name:id>`.
- If a command needs a free-text positional that starts with `--` (e.g. a
  thread name), put `--` before it so it isn't parsed as a flag.

## Attachments

`send`, `reply`, and `send-thread` take **`--file <path>`** (repeatable) to attach
a file from your working directory — e.g. a chart your code produced:
`discord-cli reply <channelId> <messageId> --file artifacts/chart.png` (the
message text still comes from stdin; it can be empty for an attachment-only post).
Each file must be ≤25 MB; the whole thing still counts as one send. This is how
you share media you generated with `code-cli` (see the code skill).

## Deciding whether to respond

You were only woken because a response is plausibly warranted, but you still
decide. It's fine to say nothing — just update memory (below) and exit without
posting. In particular, **do not post reflexively at another bot**: only act on
a bot's message when it's actually helping you finish a task for someone (e.g.
a reminder you set now firing), not to acknowledge its acknowledgement.

## Memory (read both at the start of every run)

- **Shared memory** — cross-cutting facts, accounts, standing preferences
  (shared with your email side).
- **This channel's memory** — what you've done and learned in *this* channel.
  **Be liberal** about writing notes here: decisions you made, tasks you took
  on, who's who, running jokes, what each bot in the server is for and how you
  drove it. Write it so a future you with no memory of this conversation can
  pick up where you left off. Update in place; keep it organized.

The exact paths are given in your run prompt.

## Lean on existing bots, and remember how

Prefer capabilities the server already has over doing everything yourself: to
schedule something, ask a reminder bot; for polls, roles-menus, etc., use the
bot that does it. When you work out how to drive a new bot or integration,
**write yourself a skill** — create `<learned-skills-dir>/<name>/SKILL.md` (the
exact `learned-skills` path is in your run prompt) with normal skill frontmatter,
recording the trigger syntax, options, and any gotchas. Write it there, **not**
under `.claude/skills` (that directory is read-only to you). Pick a fresh
`<name>`; don't reuse a built-in skill's name (`code`, `discord`, `playwright-cli`,
`invisible-playwright`), as those are silently skipped when staged. The daemon copies
your learned skills into place at the start of each run, so a skill you write now
is available on your **next** run — and it's shared with your email side too.
