# Baxter TUI (`baxter shell`) — Design Spec

**Status:** draft (spec review) · **Date:** 2026-07-23

## Goal

An interactive terminal front-end for talking to Baxter and driving his tools
directly. `baxter shell` opens it **locally** (against the local app image + the
shared config volume); `baxter shell <box>` (or `BOX=<box> baxter shell`) opens it
on a **remote box** over SSH. Two input modes: free-text **chat** (spawns a fresh
Baxter run) and **`/slash` commands** (invoke a tool directly, or a meta command).
**Fresh agent session per chat turn** for v1 — no history threading yet; continuity
comes from Baxter's persistent `MEMORY_DIR`, not from the conversation.

This replaces `baxter shell`'s current behavior (a raw bash shell in the app image).
The raw bash shell is **no longer exposed via `baxter`** (operator decision) —
`make app-shell` remains for dev/debugging.

## Non-goals (v1)

- Conversation memory / multi-turn threading (explicitly "for now"). Each chat line
  is an independent run.
- A full-screen TUI (panes, mouse). v1 is a **streaming line REPL**; full-screen is a
  possible v2 (see Open Decisions).
- Managing the fleet — that's the rest of `baxter` (`up`/`down`/`logs`/…). This is
  strictly a *conversation + tool* surface.

## User-facing surface

```
baxter shell                 # local: docker run the app image + config volume, launch the TUI
baxter shell <box>           # remote: ssh -t <box>, run the TUI there
BOX=<box> baxter shell        # same, via env (mirrors make deploy's BOX convention)
```

**BOX simply selects the run *environment*** — no `BOX` runs the terminal locally;
`BOX=<box>` runs the identical terminal on that box (against that box's live Baxter).
The TUI itself is the same either way.

Inside the REPL:

```
> what's on my todo list?                 # CHAT -> spawns a fresh run, streams live
> /projects list                          # SLASH tool passthrough -> runs projects-cli, raw output
> /code python                            # runs code-cli python (body from a follow-up / heredoc)
> /web fetch https://…                    # web-cli fetch
> /files grep TODO                        # files-cli grep
> /discord fetch-history <ch>             # discord-cli
> /schedule list                          # schedule-cli
> /skill checklist                        # print a skill's SKILL.md
> /memory                                 # print memory.md
> /tools                                  # list available slash tools
> /harness                                # show current model/harness
> /help    /clear    /exit
```

## Architecture

### Where it runs
The TUI is a program **inside the app container** — it needs Baxter's tools (the
CLI shims on PATH), his config volume (`/home/node`, i.e. `MEMORY_DIR`, keys), and
his harness config (`app/.env`). So:

- **Local:** `docker run -it --rm <app-image> node scripts/tui.mjs`, mounting the
  **shared** `${PROJECT}-app-config` volume and `app/.env` (same flags as
  `make app-shell`/`make mail`). Mounting the shared volume means you talk to the
  **real** Baxter — his live memory/projects/skills — and concurrent writes with the
  running fleet are the already-accepted Edit-over-Write case.
- **Remote:** `ssh -t <box> 'cd <repo> && ./bin/baxter shell'` — the remote `baxter`
  re-invokes the *local* path on the box. One code path; SSH is the only new topology
  (operator-authenticated, no inbound surface added).

`baxter shell` (in `bin/baxter`) does the local-vs-remote routing and the
`docker run` / `ssh` invocation. A tiny `make tui` target builds + runs it locally so
the CLI wrapper stays thin (matches how `baxter` delegates lifecycle to `make`).

### The REPL (`scripts/tui.mjs`)
A Node `readline` loop. Each line is classified and handled:

1. **Chat** (no leading `/`): render a prompt from `tui-prompt.md` (Baxter-as-himself,
   "direct terminal session with the operator", + the standard `{{MEMORY_PATH}}` /
   `{{PROJECTS_LIST}}` / `{{LOADED_SKILLS}}` / `{{LEARNED_SKILLS_LIST}}` preamble
   slots), then call `runAgent({ prompt, allowedTools: TUI_TOOLS, … })`. Stream the
   run's events to the terminal **live** (see Rendering). Fresh session each turn.
2. **Slash tool passthrough** (`/code`, `/files`, `/projects`, `/data`, `/skills`,
   `/web`, `/discord`, `/schedule`, `/mail`, `/playwright`, `/invisible`): look the
   verb up in a **static allowlist** mapping it to a CLI, spawn that CLI **directly**
   (argv array — never a shell string), stream its stdout/stderr. Bypasses the LLM —
   this is the operator running Baxter's tools by hand.
3. **Meta** (`/help`, `/tools`, `/memory`, `/skill <name>`, `/harness`, `/clear`,
   `/exit`): handled in-process (read a file, print a table, quit).

### Live rendering
Reuse `parseRunnerEvents` (`harnesses/runner-events.mjs`), which already normalizes
the openrouter/local/claude event protocol into
`{kind: "text"|"tool_use"|"tool_result"|"result"|"note"}`. A pure `renderEvent(ev)`
maps each to a terminal line:

- `text` → Baxter's words.
- `tool_use` → dim `→ <tool> <short args>`.
- `tool_result` → indented, truncated output (with a `…(+N lines)` marker).
- `result` → a done marker + elapsed time; `note` → dim aside.

`runAgent` today only logs/ships events (`emit(...)`). **Minimal change:** add an
optional `onEvent(rawLine)` callback that `runAgent` calls alongside `emit`, so the
TUI can render live without changing any existing caller. (Alternatively a thin
`streamAgent` wrapper; `onEvent` is the smaller diff.)

### Grants (`grants.mjs`)
Add `TUI_TOOLS` and `TUI_SKILL_NAMES`, following the existing per-surface pattern.
The TUI **trigger** is the trusted operator (like the owner's own Discord DM), so the
chat run gets a **generous** set: `CORE_TOOLS` + `discord-cli` + `schedule-cli` +
`mail.mjs` (i.e. effectively everything a human at the keyboard would want). But this
stays an **allowlist**, not bare bash, and the run still goes through `runAgent` →
`stripRunSecrets`, so the LLM never sees credentials. `TUI_SKILL_NAMES = skillNamesExcept()`
(all baked skills; nothing to exclude).

## Security model (review focus)

1. **Slash passthrough is a strict allowlist.** A `/` verb maps to one of the known
   CLI shims and is spawned with an **argv array**, never `system(line)` / a shell
   string. `/rm foo`, `/;curl…`, backticks, `$(…)` cannot become shell execution —
   an unknown verb errors. This is the single most important invariant and gets a
   dedicated test (see TDD).
2. **Chat runs = the existing boundary.** `runAgent` strips secrets from the run env
   (`stripRunSecrets`), `TUI_TOOLS` is an allowlist, fetched/returned content is still
   treated as untrusted — no new exposure vs. the Discord/mail surfaces.
3. **Operator-trust split.** Slash passthrough runs a CLI **as the operator**, in the
   TUI's own env (which legitimately has the keys — same as typing the CLI in
   `app-shell` today). Chat runs spawn the **scoped, secret-stripped** LLM path. The
   two are deliberately different trust tiers; the code keeps them separate.
4. **No new inbound surface.** Local is a `docker run`; remote is outbound SSH. Nothing
   listens.
5. **Shared config volume** → talks to the real Baxter; concurrent writes with the
   fleet are the accepted `Edit`-over-`Write` case (documented in the prompts).

## Files

| File | Role |
|---|---|
| `app/scripts/tui.mjs` | the REPL: input loop, dispatch, live render |
| `app/scripts/tui-core.mjs` | **pure** cores (parse/classify/dispatch-table/render) — the tested surface |
| `app/tui-prompt.md` | chat prompt template (Baxter-as-himself, direct-terminal framing) |
| `app/scripts/grants.mjs` | `+ TUI_TOOLS`, `+ TUI_SKILL_NAMES` |
| `app/scripts/runtime.mjs` | `+ onEvent` hook on `runAgent` |
| `bin/baxter` | `shell` → TUI (local, or remote per `BOX`) |
| `Makefile` | `+ tui` target (build + docker-run the TUI locally) |
| docs | update `app/CLAUDE.md` + root `CLAUDE.md`/README for the new `shell` behavior |

## TDD plan (what gets pinned first, `node:test`)

Following the repo convention — test the **pure** logic, verify the interactive /
docker / SSH parts live. `tui-core.mjs` holds the pure functions so `tui.mjs` is a
thin I/O shell.

1. **`parseTuiInput(line)` → `{kind, verb, args}`**: slash vs chat vs meta detection;
   argv splitting with quotes; empty/whitespace lines; `//` (escaped, treat as chat);
   trailing spaces.
2. **Slash dispatch allowlist**: every known verb maps to the right CLI; an unknown
   verb is rejected; **security case** — a verb containing shell metacharacters, or a
   non-allowlisted name, never produces an executable command (returns an error, and
   the resolved spawn is always `[cli, ...argvArgs]`, never a shell string).
3. **`renderEvent(parsedEvent)`**: deterministic line output for each event kind;
   truncation + `…(+N)` marker; error-result rendering.
4. **grants**: `TUI_TOOLS` contains the expected CLIs (incl. discord + schedule +
   mail + all CORE); `TUI_SKILL_NAMES` derives from `SKILL_NAMES` like the others
   (pins the no-drift invariant, same as the existing grants tests).
5. **`baxter shell` routing** (small pure helper or a smoke test): `BOX` present → SSH
   form; absent → local docker form. Argv assembly only (no live docker/ssh in the
   unit test).

Live-verified (not unit-tested): the readline loop, `docker run`, SSH, real streaming.

## Decisions (resolved 2026-07-23, operator)

1. **Rendering: line REPL for v1.** No new deps, fits fresh-session-per-run +
   stream-and-scroll, reuses `parseRunnerEvents`. Full-screen (ink/blessed) is a
   possible later upgrade, not v1.
2. **`baxter shell` = TUI only.** The old raw bash shell is **not** exposed via
   `baxter` (no `--bash`); `make app-shell` remains for dev.
3. **Chat tool scope: generous operator set** — `CORE_TOOLS` + `discord-cli` +
   `schedule-cli` + `mail.mjs`. Still an allowlist, still secret-stripped via
   `runAgent`.
4. **`BOX` selects the run environment** — absent → local; `BOX=<box>` (or a
   positional `baxter shell <box>`) → the identical TUI on that box.
