---
name: code
description: Run Python or Node code in an isolated, offline sandbox via code-cli -- for computation, parsing, and data work. Reach for it liberally whenever the restricted shell fights you (denied python3/node, chained/piped commands, fiddly quoting) -- a short program beats wrestling one-liners. Pre-installed libs (Python numpy/pandas/python-dateutil/beautifulsoup4; Node lodash/dayjs). No network in the sandbox. Separate from the browser-automation JS path.
allowed-tools: Bash(code-cli:*)
---

# Running code with code-cli

`code-cli` runs a Python or Node program in a fresh, **offline**, resource-capped
sandbox that's isolated from your own container, and returns its output. Use it
for real computation, parsing, and data crunching — the things you can't do by
hand or through the browser. It is **separate** from the `playwright-cli` /
`invisible-cli` browser-automation JS: that drives a web page; this runs a plain
program with libraries and gives you back stdout.

**Reach for this liberally — the moment the shell fights you, switch.** The
restricted Bash tool denies un-allowlisted commands (`python3`, `node`, `jq`,
`find /`, …) and refuses compound shell that involves them (`a && b`, piping into
an interpreter like `… | python3` / `… | jq`, heredocs into interpreters — but a
heredoc **into an allowed CLI** like `code-cli` is fine, as is piping from a
simple safe command (`printf … | code-cli python`); that's how you pass the
program in), so it's easy to get stuck ping-ponging on rejected one-liners.
Don't. The instant you're reaching for a `python3 -c '…'` / `node -e '…'`
one-liner, or stringing together grep/sed/awk to parse or reshape something, or a
command comes back denied — **stop and write a short program for `code-cli`
instead.** A few lines of Python/Node here is almost always cleaner and faster
than wrestling the shell. **`python3`/`node`/`jq` are denied on purpose — don't
keep retrying them; `code-cli` is the sanctioned way to run code, every time.**

Because the sandbox is isolated it can't open your workspace or the persisted
tool-result files — it only sees what you hand it. Small constants: just write
them into the program. **Larger data (a fetched page, a `discord-cli
fetch-history` dump, a big JSON blob): don't wrestle it into a string literal —
pass the program with `--file` and _pipe the data in_.** It arrives as a file
named `input` the program reads. See **Passing data in** below.

## Commands

The program is read from **stdin** by default, or from a file with `--file`:

| Invocation | What it does |
|---|---|
| `… \| code-cli python` | Run the piped Python program. |
| `… \| code-cli node` | Run the piped Node (JavaScript) program. |
| `code-cli python --file <path>` | Run a saved `.py` file. |
| `code-cli node --file <path>` | Run a saved `.js` file. |

Pipe the program in directly — a heredoc or `printf ... |` — rather than writing
a temp file you then can't delete (the shell can't remove files). Example:

```
code-cli python <<'PY'
import numpy as np
print(np.mean([2, 4, 6]))
PY
```

## Passing data in

The sandbox is offline and isolated: it **can't** read your workspace files, the
persisted tool-result files, or receive real stdin. There is exactly one way to
feed it external data — and it's the fix for "I have a big blob and can't cram it
into a one-liner":

> **Write the program to a file, run it with `--file`, and pipe the data in.**
> Whatever you pipe lands in the sandbox as a file named **`input`** that your
> program opens.

- **Python:** `data = open("input").read()` (then `json.loads(data)`, etc.)
- **Node:** `const data = require("fs").readFileSync("input", "utf8")`

**Text (UTF-8) only.** This channel carries *text* — codapi ships `files` as
JSON strings, so raw bytes can't ride through: piping a binary (an image, a PDF,
a zip) corrupts it silently, and the program just gets garbage. Binary goes the
*other* way: **generate** it inside the sandbox and return it as an artifact (see
**Generating files** below). There's no supported way to feed an existing binary
file *in* — parse binaries with the browser/`WebFetch` tools outside instead.

Why a file and not stdin: with `--file`, the program comes from the file, which
frees stdin to carry your data — but the sandbox receives it as the `input` file,
**not** on `sys.stdin`. So read `open("input")`, not `sys.stdin`. (Without
`--file`, stdin _is_ the program, so there's no data channel — that mode is for a
program with no external input.)

This is the pattern for "fetch outside, parse inside" — pull the data with a
browser CLI / `WebFetch` / `discord-cli`, then pipe it straight into the parser:

```
# Parse a channel's history without hand-quoting a huge JSON string:
discord-cli fetch-history <channel> --limit 100 | code-cli python --file scan.py
# where scan.py starts:  import json; msgs = json.loads(open("input").read())
```

Both `discord-cli …` and `code-cli …` are allowed commands, so piping one into
the other is fine (it's piping into a *denied* interpreter like `… | python3`
that the shell refuses). Save `scan.py` with the `Write` tool first (see **Save
and reuse** below). No pipe? Then no `input` file is created — that's the
no-external-data case.

## Output

`code-cli` prints the program's stdout, then any stderr under `[stderr]`, then a
final `[ok]` (the program finished cleanly) or `[error]` (it exited non-zero /
threw). A program that runs and *then* errors is a completed run — you'll see its
output plus `[error]`; that's the program's problem to fix, not a sandbox
failure. If instead you see `code-cli: ... (is the sandbox up? 'make codapi')`,
the sandbox itself is unreachable.

## Available libraries (pre-installed, offline)

- **Python:** `numpy`, `pandas`, `python-dateutil`, `beautifulsoup4`; for media:
  `pillow` (images), `matplotlib` (charts — Agg backend, use `savefig`), `reportlab`
  (PDFs), and the stdlib `wave` module + `numpy` for audio (WAV).
- **Node:** `lodash`, `dayjs`

## The sandbox is offline — fetch outside, parse inside

There is **no network** inside the sandbox, on purpose. Code can't reach the
internet, so **don't** try to `requests.get(...)` / `fetch(...)` from inside it.
The pattern is: fetch the page or data **outside** — with `WebFetch`, or the
browser CLIs — then hand the content to the program (feed HTML to
`beautifulsoup4`, numbers to `numpy`/`pandas`). For anything bigger than a small
constant, hand it over via the **`input` file** — pipe it in with `--file` (see
**Passing data in** above), rather than baking a giant literal into the source.
Each run is also **ephemeral** (nothing persists between runs) and
**time/memory-capped**, so keep programs self-contained and reasonably quick.

## Generating files (charts, images, PDFs, audio)

Your code can produce **files**, not just text. Save them as **plain filenames
directly in `/tmp/artifacts/`** (all of `/tmp` is writable, but **only top-level
files in `/tmp/artifacts/` are returned** — files in subdirectories are silently
ignored, and scratch files elsewhere in `/tmp` aren't shipped back), and
`code-cli` returns each one to
**`artifacts/<name>` in your working directory** and prints a line like
`[wrote artifacts/chart.png (142 KB)]`. Then you can share it — on Discord,
attach it with `discord-cli reply <ch> <msg> --file artifacts/chart.png` (see the
discord skill). Examples:

```
# a chart
code-cli python <<'PY'
import matplotlib.pyplot as plt
plt.plot([1, 2, 3], [1, 4, 9]); plt.title("demo")
plt.savefig("/tmp/artifacts/chart.png")
PY
# then:  discord-cli reply <channel> <message> --file artifacts/chart.png
```

Notes: each artifact is capped at **8 MB**, and a run's artifacts at **~10 MB
total** — anything over either limit comes back as `[… too big …]`, not returned.
Use plain filenames (spaces and unicode are fine); don't nest into
subdirectories (those files just don't come back). Still
**offline** and **ephemeral** — the file only persists once `code-cli` has
returned it to your `artifacts/` dir.

## Save and reuse

To reuse a program, save it to a file in your working directory (which persists)
with the `Write` tool, then run it any time with `code-cli python --file
myscript.py`. If you work out a genuinely reusable pattern (a parser, a
calculation you do often), capture it as a learned skill: create
`learned-skills/<name>/SKILL.md` in your working directory (with normal skill
frontmatter) — **not** under `.claude/skills`, which is read-only to you. Pick a
fresh `<name>`; don't reuse a built-in skill's name (`code`, `discord`,
`playwright-cli`, `invisible-playwright`), as those are silently skipped when
staged. The daemon stages your learned skills into place at the start of each
run, so a skill you write now is available on your **next** run, on both your
email and Discord sides.
