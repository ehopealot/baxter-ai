---
name: collections
description: Organize related user data in category-oriented Markdown collections with collections-cli -- one file per collection, shared across all your surfaces. make/list/open/save; save takes the whole file on stdin and an --expect <version> from open/make (a concurrency guard so parallel runs can't clobber each other).
allowed-tools: Bash(collections-cli:*)
---

# Cross-cutting collections with collections-cli

`collections-cli` gives you a small set of **collections** — one Markdown file each —
that follow you across surfaces. A collection you write while acting in Discord is
readable when you're answering an email, and vice versa.

A Collection's title names its **category**. Everything that logically belongs under
that category may go together: objects, items, or related facts about a project, person,
place, interest, decision area, or any other durable topic. A Collection can support an
ongoing effort, but it does not have to be a project or a task.

This is different from your memory files. Memory (shared `memory.md`, the per-channel
Discord notes) holds broad facts and continuity. Use a Collection when related user data
benefits from its own named, organized page that a future run can deliberately open.

It's also different from a **checklist** (`checklist-cli`). A Collection **aggregates**
data that does not get "done"; a checklist is items you **check off and clear**. If each
entry can be marked complete (groceries, packing, errands), use `checklist-cli` instead.

## Organize user data; separate your own comments

- Keep the Collection title as the category. Under it, prefer list-like Markdown:
  optional subgroup headings, bullets or numbered entries, and nested facts/details.
  Choose the grouping that fits the data rather than forcing a fixed schema.
- Keep user-provided facts and source data outside comment blocks so they remain part of
  the Collection's visible content.
- Put your own observations, judgments, uncertainty, follow-ups, and notes for a future
  Baxter inside exact `<comment>...</comment>` blocks. Home omits the tags and everything
  inside them. Keep comments concise and never hide user-provided facts inside them.

## Example

```markdown
# Favorite Places

## Restaurants

- Bar Iris
  - Neighborhood: Polk Gulch
  - Likes: quiet back room; citrus drinks
- Zuni Café
  - Usual order: roast chicken

## Parks

1. Alta Plaza
   - Best time: weekday mornings

<comment>
Ask which restaurant should be the default birthday recommendation.
</comment>
```

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

- **Check what already exists first and avoid duplicates.** Your current Collections
  are listed in the "Your collections" section of your run prompt, and
  `collections-cli list` shows them any time. Before you `make` anything, check that
  list — if an existing Collection's category fits, `open` and update it. Only `make`
  a new Collection when nothing fits.
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
- `make` seeds the file with a title and a created-on `<comment>` block and prints a
  `version:`; `save --expect <that version>` fills in the real contents (no
  separate `open` needed right after a `make`). You must `make` a collection before
  you can `save` to it (a `save` to a name that doesn't exist errors and tells you
  to make it first).
- The `<slug>` for `open`/`save` is what `list` prints (a lowercased,
  hyphenated form of the name). Passing the original name works too — it's
  slugified the same way.

## When to use a Collection vs. just replying

Be proactive: when related information naturally forms a durable, reusable category,
create or update its Collection without waiting to be asked. A future you can `open` it
and recover the organized context across runs and surfaces. Check existing Collections
first, and do not create noisy or speculative Collections for one-off facts that belong
in an ordinary reply or broad memory instead.
