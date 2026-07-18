---
name: discord
description: Act in a Discord server via discord-cli -- send/reply/react, read channel history, manage threads, edit/delete your own messages, and moderate (delete anyone's message) in channels where you've been granted Manage Messages. You can do anything on the server EXCEPT manage membership (no adding people, roles, or channels). Also covers per-channel memory and writing your own ad-hoc skills for new bots.
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
| `discord-cli fetch-history <channelId> [--limit N] [--since TS] [--until TS] [--from USERID] [--before ID] [--after ID]` | Read messages, chronological JSON array. `--since`/`--until` take a timestamp (ISO 8601 like `2026-07-18T14:00:00Z`, or epoch ms) to bound a time window; `--from` keeps only one author's messages; `--before`/`--after` take raw snowflake ids. Discord has no server-side search, so this pages back and filters — a time window bounds the scan (else it scans up to ~2000 messages). E.g. "what did user 123 say in this channel yesterday afternoon": `fetch-history <ch> --from 123 --since 2026-07-17T20:00:00Z --until 2026-07-18T03:00:00Z`. |
| `discord-cli create-thread <channelId> <name> [--messageId ID]` | Start a thread (optionally off a message). |
| `… \| discord-cli send-thread <threadId>` | Post in a thread (body on stdin). |
| `… \| discord-cli edit <channelId> <messageId>` | Edit **one of your own** messages (body on stdin). |
| `discord-cli delete-own <channelId> <messageId>` | Delete **one of your own** messages (works anywhere). |
| `discord-cli delete-any <channelId> <messageId>` | **Moderation:** delete **anyone's** message. Deleting *others'* messages only works in channels where you've been granted Manage Messages — see the note below. |
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
- **Reading history — don't fight the JSON.** Your prompt already includes the
  triggering message and recent channel history, so most of the time you don't
  need `fetch-history` at all — act on what's already in front of you. When you
  *do* need older messages or a field from the raw array, remember the sandbox
  auto-denies **compound** Bash: no `a && b`, no piping into an interpreter
  (`… | python3`, `… | jq`), no heredocs *into interpreters*, and no `find /`.
  (A heredoc into an allowed CLI like `discord-cli`/`code-cli` is fine — that's
  how you pass message bodies.) So don't try to grep-and-parse the blob with a
  chained command — it just gets rejected. Run **one** simple command per Bash
  call (a single `grep`/`head`), or open the persisted tool-result file with the
  **`Read`** tool and scan it there. To pull one specific message you already
  know the id of, a single `discord-cli fetch-history <ch> --limit N` then a lone
  `grep <id> <persisted-result-file>` (the path the truncated tool result points
  you at) is enough. And for
  anything past a simple find — actually parsing/transforming the JSON — don't
  fight it in the shell: paste the slice into a `code-cli python` program (see the
  code skill), which is built exactly for that.

## Moderating: deleting others' messages

`delete-any` deletes **anyone's** message, not just your own. It's a moderation
tool, gated by Discord itself: the operator grants you **Manage Messages** in
only a specific few channels, and Discord refuses the delete of **anyone else's**
message (a `403` error) anywhere you don't have it — so you physically cannot
moderate *others'* messages outside those channels. (Your own messages are always
deletable everywhere; `delete-own` is the clearer command for those.) If
`delete-any` fails with a permissions/`403` error, that channel simply isn't one
you moderate; don't retry.

Use it **sparingly and only with clear cause** — obvious spam, something a person
in the channel asked you to remove, or a mess you yourself made across several
messages. It's not for silencing disagreement or tidying other people's words on
a whim; when in doubt, leave the message and say something instead. You **cannot
edit** other people's messages at all (Discord only lets the original author edit
content) — `edit` remains your-own-messages-only.

## Attachments

`send`, `reply`, and `send-thread` take **`--file <path>`** (repeatable) to attach
a file from your working directory — e.g. a chart your code produced:
`discord-cli reply <channelId> <messageId> --file artifacts/chart.png` (the
message text still comes from stdin; it can be empty for an attachment-only post).
Each file must be ≤25 MB; the whole thing still counts as one send. This is how
you share media you generated with `code-cli` (see the code skill).

Unlike a plain send, a `--file` post is **not** auto-split at 2000 chars — keep
the message text under the limit or the post errors; put any long write-up in a
separate follow-up `send`/`reply` after the attachment.

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
