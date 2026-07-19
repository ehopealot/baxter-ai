---
name: projects
description: Keep cross-cutting project notes with projects-cli -- one markdown file per project, shared across your email and Discord runs, for context that spans multiple threads or channels. make/list/open/save; save takes the whole file on stdin.
allowed-tools: Bash(projects-cli:*)
---

# Cross-cutting projects with projects-cli

`projects-cli` gives you a small set of **projects** — one markdown file each —
that follow you across surfaces. A project you write while acting in Discord is
readable when you're answering an email, and vice versa. Use it for anything
that spans more than one thread or channel: a multi-step task you're carrying,
a running plan, standing context about an ongoing effort, decisions made so far.

This is different from your memory files. Memory (shared `memory.md`, the
per-channel Discord notes) is where you record facts and what you've done.
A **project** is a focused working document for one ongoing effort — reach for
it when a single task or topic is big enough that it deserves its own page you
keep coming back to and updating.

## Commands

| Command | What it does |
|---|---|
| `projects-cli list` | Every project: slug, title, size, last-modified. |
| `projects-cli make <name>` | Start a new project. Prints its slug. Errors if one with that slug already exists. |
| `projects-cli open <slug>` | Print a project's full contents (read it into context). |
| `… \| projects-cli save <slug>` | Replace a project's **whole** file with what you pipe in (body on stdin). |

## How to use it

- **Check what already exists first.** Your current projects are listed in the
  "Your projects" section of your run prompt, and `projects-cli list` shows them
  any time. Before you `make` anything, check that list — if a project for this
  already exists, `open` it and work from there rather than creating a second
  one. Only `make` a new project when nothing fits.
- **`save` is a whole-file overwrite, not an append or a patch.** It replaces
  the entire file with exactly what you send on stdin. So the normal edit cycle
  is: `open` the project, take its current contents, make your changes to the
  *full* text, then `save` the complete new version back. If you `save` only a
  fragment, you erase everything else — send the whole document every time.
- **Pipe content straight into `save` — don't stage a scratch file.** Send the
  full text directly on stdin, e.g. a heredoc:
  ```
  projects-cli save <slug> <<'EOF'
  # <title>
  …the whole document…
  EOF
  ```
  (or `printf … | projects-cli save <slug>`). Writing the contents to a
  separate `.txt` first and then feeding that in just litters your workspace
  with a duplicate you can't `rm` — go straight to `save`.
- `make` seeds the file with a title and a created-on line; `save` fills in the
  real contents. You must `make` a project before you can `save` to it (a `save`
  to a name that doesn't exist errors and tells you to make it first).
- The `<slug>` for `open`/`save` is what `list` prints (a lowercased,
  hyphenated form of the name). Passing the original name works too — it's
  slugified the same way.

## When to use a project vs. just replying

Most messages don't need one — answer them and move on. Start (or update) a
project when a task is genuinely ongoing and cross-cutting: something you'll be
picking back up in a *later* run, quite possibly on the *other* surface. Keeping
the plan and state in a project means a future you (with no memory of this
conversation) can `open` it and immediately know where things stand.
