---
name: collections
description: Keep cross-cutting collection notes with collections-cli -- one markdown file per collection, shared across all your surfaces (email, Discord, heartbeat, voice), for context that spans multiple threads or channels. make/list/open/save; save takes the whole file on stdin and an --expect <version> from open/make (a concurrency guard so parallel runs can't clobber each other).
allowed-tools: Bash(collections-cli:*)
---

# Cross-cutting collections with collections-cli

`collections-cli` gives you a small set of **collections** — one markdown file each —
that follow you across surfaces. A collection you write while acting in Discord is
readable when you're answering an email, and vice versa. Use it for anything
that spans more than one thread or channel: a multi-step task you're carrying,
a running plan, standing context about an ongoing effort, decisions made so far.

This is different from your memory files. Memory (shared `memory.md`, the
per-channel Discord notes) is where you record facts and what you've done.
A **collection** is a focused working document for one ongoing effort — reach for
it when a single task or topic is big enough that it deserves its own page you
keep coming back to and updating.

It's also different from a **checklist** (`checklist-cli`). A collection **aggregates**
notes/context that never gets "done"; a checklist is items you **check off and clear**.
If each entry can be marked complete (groceries, packing, errands), that's a checklist —
use `checklist-cli`, not a collection.

## Commands

| Command | What it does |
|---|---|
| `collections-cli list` | Every collection: slug, title, size, last-modified. |
| `collections-cli make <name>` | Start a new collection. Prints its slug **and a `version:`**. Errors if one with that slug already exists. |
| `collections-cli open <slug>` | Print a collection's full contents (read it into context), and a **`version:` line** (on stderr — see below). |
| `… \| collections-cli save <slug> --expect <version>` | Replace a collection's **whole** file with what you pipe in (body on stdin), **only if** it still matches `<version>`. Prints the new `version:`. |

## Versions (so two runs can't clobber each other)

Collections are shared across all your surfaces (email, Discord, heartbeat, voice), so two of you can edit
the same collection at once. To stop one save from silently wiping the other's, every
`open`/`make`/`save` prints a short **`version:` token** (8 hex chars), and `save`
**requires** the version you started from:

- `open <slug>` (or `make`) shows the current contents **and** a `version: abc12345`
  line. That token is the version you're editing.
- `save <slug> --expect abc12345` writes your new full text **only if** the file is
  still at `abc12345`. On success it prints the **new** `version:` — reuse that if
  you save the same collection again in this run (no need to re-`open`).
- If someone else saved in the meantime, your save is **rejected** ("changed since
  you read it"). Don't retry with the same body — **`open` it again**, reapply your
  change to the fresh contents, and `save` with the new version. You'll never lose
  their edit or yours.

The `version:` line is **tool metadata, not part of the collection** — never paste it
into the body you save. It prints on **stderr**, so if a collection is ever too large
to read comfortably and you only need its version to save, grab just that line with
`collections-cli open <slug> 2>&1 >/dev/null` (that redirects the body away and keeps
only the `version:` line).

## How to use it

- **Check what already exists first.** Your current collections are listed in the
  "Your collections" section of your run prompt, and `collections-cli list` shows them
  any time. Before you `make` anything, check that list — if a collection for this
  already exists, `open` it and work from there rather than creating a second
  one. Only `make` a new collection when nothing fits.
- **`save` is a whole-file overwrite, not an append or a patch.** It replaces
  the entire file with exactly what you send on stdin. So the normal edit cycle
  is: `open` the collection (note its `version:`), take its current contents, make
  your changes to the *full* text, then `save` the complete new version back with
  `--expect <that version>`. If you `save` only a fragment, you erase everything
  else — send the whole document every time.
- **Pipe content straight into `save` — don't stage a scratch file.** Send the
  full text directly on stdin, e.g. a heredoc:
  ```
  collections-cli save <slug> --expect <version> <<'EOF'
  # <title>
  …the whole document…
  EOF
  ```
  (or `printf … | collections-cli save <slug> --expect <version>`). Writing the
  contents to a separate `.txt` first and then feeding that in just litters your
  workspace with a duplicate you can't `rm` — go straight to `save`.
- `make` seeds the file with a title and a created-on line and prints a
  `version:`; `save --expect <that version>` fills in the real contents (no
  separate `open` needed right after a `make`). You must `make` a collection before
  you can `save` to it (a `save` to a name that doesn't exist errors and tells you
  to make it first).
- The `<slug>` for `open`/`save` is what `list` prints (a lowercased,
  hyphenated form of the name). Passing the original name works too — it's
  slugified the same way.

## When to use a collection vs. just replying

Most messages don't need one — answer them and move on. Start (or update) a
collection when a task is genuinely ongoing and cross-cutting: something you'll be
picking back up in a *later* run, quite possibly on *another* surface. Keeping
the plan and state in a collection means a future you (with no memory of this
conversation) can `open` it and immediately know where things stand.
