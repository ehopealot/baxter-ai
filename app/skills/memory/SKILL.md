---
name: memory
description: Read and write your SHARED memory files (memory.md, CREDENTIALS.md) with memory-cli, so concurrent runs across your surfaces can't clobber each other. append to add a fact (no version needed); read then write --expect <version> to revise. Use this instead of native Write/Edit on the memory files.
allowed-tools: Bash(memory-cli:*)
---

# Your shared memory with memory-cli

`memory-cli` is how you write your **shared memory files** — `memory.md` (standing
facts, what you've done) and `CREDENTIALS.md` (account logins). These are shared by
**every one of your surfaces** (email, Discord, heartbeat, voice): another run may be
writing the same file at the very moment you are. `memory-cli` coordinates those
writes so nobody's update is silently lost — **use it instead of native `Write`/`Edit`
on these files.**

`target` is `memory` (the default) or `credentials`.

## Commands

| Command | What it does |
|---|---|
| `memory-cli read [target]` | Print the file (read it into context), and a **`version:` line** on stderr. A not-yet-written file reads as empty. |
| `… \| memory-cli append <target>` | Add what you pipe in to the end of the file. Lock-serialized, so **concurrent appends never clobber** — no version needed. |
| `… \| memory-cli write <target> --expect <version>` | Replace the file's **whole** contents with what you pipe in, **only if** it still matches `<version>`. Prints the new `version:`. |

## Adding a fact → `append` (the easy path)

To record something new — a fact, a note about what you did, a new login in
`credentials` — just pipe it to `append`:

```
printf -- '- Registered at example.com (login in CREDENTIALS.md).\n' | memory-cli append memory
```

No version, no read first. Two runs appending at the same time both succeed — their
facts are both kept. This is the common case; reach for it by default.

## Revising in place → `read` then `write --expect`

To change or reorganize existing content (correct a fact, fold notes into a section,
prune stale lines), you replace the whole file, guarded by a version so you can't
overwrite a concurrent change:

- `memory-cli read memory` prints the current contents **and** a `version: abc12345`
  line. That token is the version you're editing.
- Edit the text, then `… | memory-cli write memory --expect abc12345` — it writes
  **only if** the file is still at `abc12345`, and prints the **new** `version:`.
- If another run wrote in the meantime, your write is **rejected** ("changed since you
  read it"). Don't retry the same body — **`read` it again**, reapply your change to
  the fresh contents, and `write` with the new version. Nobody's edit is lost.

The `version:` line is **tool metadata, not part of the file** — never paste it into
the body you write. It's on **stderr**, so to grab just the version of a large file:
`memory-cli read memory 2>&1 >/dev/null`.

## Keep it curated

`memory.md` is loaded into the start of every run, so an ever-growing file costs you
context everywhere. `append` is convenient, but don't let memory become an append-only
log: periodically **`read` it and `write --expect`** to fold loose appends into the
right section, tighten wording, and drop what's no longer true. The same applies to
`credentials` — when a password **changes**, don't `append` a second block for the
same site (you'd end up with two conflicting logins); `read credentials`, update that
site's entry in place, and `write credentials --expect <version>`. Keep passwords out
of `memory.md` — put logins in `credentials` and leave only a pointer in memory.
