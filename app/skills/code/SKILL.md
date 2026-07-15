---
name: code
description: Run Python or Node code in an isolated, offline sandbox via code-cli -- for computation, parsing, and data work. Pre-installed libs (Python numpy/pandas/python-dateutil/beautifulsoup4; Node lodash/dayjs). No network in the sandbox. Separate from the browser-automation JS path.
allowed-tools: Bash(code-cli:*)
---

# Running code with code-cli

`code-cli` runs a Python or Node program in a fresh, **offline**, resource-capped
sandbox that's isolated from your own container, and returns its output. Use it
for real computation, parsing, and data crunching — the things you can't do by
hand or through the browser. It is **separate** from the `playwright-cli` /
`invisible-cli` browser-automation JS: that drives a web page; this runs a plain
program with libraries and gives you back stdout.

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
browser CLIs — then **pipe the content in** and parse/compute on it (e.g. feed
HTML to `beautifulsoup4`, numbers to `numpy`/`pandas`). Each run is also
**ephemeral** (nothing persists between runs) and **time/memory-capped**, so keep
programs self-contained and reasonably quick.

## Generating files (charts, images, PDFs, audio)

Your code can produce **files**, not just text. Save them to **`/tmp/artifacts/`**
inside the sandbox (the one writable dir), and `code-cli` returns each one to
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

Notes: each artifact is capped at **8 MB** (bigger ones come back as
`[… too big …]`, not returned); names are reduced to a safe filename (no paths);
still **offline** and **ephemeral** — the file only persists once `code-cli` has
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
