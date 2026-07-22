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
`mail.mjs`), so pipe it in. IDs are Discord snowflake strings.

## Commands

| Command | What it does |
|---|---|
| `discord-cli whoami` | Your own bot user id/name (JSON). Use it to recognize your own messages. |
| `discord-cli list-channels [name...]` | **Find a channel by name → its id.** Read-only. Each positional is a case-insensitive **name substring** to match (any of them); with no arg, lists every channel. E.g. `discord-cli list-channels tech` → channels whose name contains "tech". Output is JSON: `{guild, guildId, id, name, type, parentId}` per channel, sorted by name; `type` is `text`/`voice`/`category`/`announcement`/`forum`/`stage`/`thread`/… This is how you resolve "#tech" to a channel id when your prompt didn't hand you one — **don't** pass a guild id, pass the channel name you're looking for. (Guild channels only — threads aren't included; find a thread by reading its parent channel's `fetch-history`.) |
| `… \| discord-cli send <channelId>` | Post a message (body on stdin). Prints the new message JSON. |
| `… \| discord-cli reply <channelId> <messageId>` | Reply referencing a specific message (body on stdin). |
| `discord-cli react <channelId> <messageId> <emoji>` | Add a reaction. Emoji is a literal unicode char (`👍`) or a custom `<:name:id>`. |
| `discord-cli unreact <channelId> <messageId> <emoji>` | Remove **your own** reaction of that emoji (only yours -- it's the `@me` endpoint, not moderation). |
| `discord-cli fetch-history <channelId...> [--limit N] [--since TS] [--until TS] [--from USERID] [--contains STR] [--before ID] [--after ID]` | Read messages, chronological JSON array. Pass **multiple channel ids** to fetch them all, merged chronologically (each message carries its `channel_id`; `--limit` is per-channel). `--since`/`--until` bound a time window (timestamp: ISO 8601 like `2026-07-18T14:00:00Z`, or epoch ms); `--from` keeps one author's messages; `--contains` keeps messages whose content includes a substring (case-insensitive — e.g. a user id to find `<@id>` mentions of them); `--before`/`--after` take raw snowflake ids. Discord has no server-side search, so this pages back and filters, capped at ~2000 messages **per channel**; if the cap is hit before covering the window (or finding enough matches) you **may** get only the newest slice scanned, with a warning on stderr. E.g. every mention of user 123 across two channels this afternoon: `fetch-history <ch1> <ch2> --contains 123 --since 2026-07-18T19:00:00Z`. |
| `discord-cli create-thread <channelId> <name> [--messageId ID]` | Start a thread (optionally off a message). |
| `… \| discord-cli send-thread <threadId>` | Post in a thread (body on stdin). |
| `… \| discord-cli edit <channelId> <messageId>` | Edit **one of your own** messages (body on stdin). |
| `discord-cli delete-own <channelId> <messageId>` | Delete **one of your own** messages (works anywhere). A long reply posts as several messages — to retract it fully, delete **every** id from the send's `message_ids` (see Notes), not just one. |
| `discord-cli delete-any <channelId> <messageId>` | **Moderation:** delete **anyone's** message. Deleting *others'* messages only works in channels where you've been granted Manage Messages — see the note below. |
| `discord-cli pin` / `unpin <channelId> <messageId>` | Pin management. |
| `discord-cli typing <channelId>` | Show the typing indicator (for a longer task). |

Notes:
- Messages over Discord's 2000-char limit are split automatically by `send`,
  `reply`, and `send-thread` into multiple posts. The printed JSON is the final
  chunk's message object PLUS `message_ids` (every part's id, in order) and
  `chunked` (true when it was split). So if you later need to delete or edit that
  reply, use `message_ids` to reach **all** of its parts — deleting just the one
  `id` leaves the earlier chunks behind. `edit` does NOT split -- keep edited
  content under 2000 chars.
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
- **Searching or filtering messages — let `fetch-history` filter, don't scan by
  hand.** This is the DEFAULT for any "find / search / who said / when did / across
  channels" task: reach straight for the filters instead of pulling raw pages and
  eyeballing them. `--from <userId>` (one author), `--since`/`--until` (a time
  window; ISO 8601 or epoch ms), `--contains <substring>` (content — pass a **user
  id** to find `<@id>` mentions of them), and **multiple channel ids** to search
  several at once (results merge chronologically, each tagged with `channel_id`).
  Combine them — every mention of user 123 across two channels since last night is
  one call: `fetch-history <ch1> <ch2> --contains 123 --since <ISO>`. You get just
  the matches, not a blob to grep. Two gotchas: the limit is a **flag**
  (`--limit N`), never a bare trailing number (a bare positional is read as another
  channel id); and a channel you can't read is skipped with a warning, so one bad
  id won't sink a multi-channel search.

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

## Memory (read both before doing any real work — but if your run prompt has a "Status reactions" rule and you're acting on a message, the 👀 react comes first)

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
