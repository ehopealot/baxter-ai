# OpenRouter Harness — Design (minimal v1)

**Date:** 2026-07-17
**Status:** approved (architecture + tool surface + SDK), building

## Goal

A second harness for driving Baxter — an alternative to Claude Code — backed by
**OpenRouter**, reusing the existing skills/CLIs (discord-cli, code-cli,
schedule-cli, playwright-cli, invisible-cli, gmail). Selected with
`BAXTER_HARNESS=openrouter`. Follows through on the harness-adapter seam.

## Why an SDK (and which)

OpenRouter is an OpenAI-compatible HTTP endpoint; the **agentic tool-execution
loop** is not something OpenRouter runs for you on the plain API. Rather than
hand-roll that loop (and the tool-call message plumbing, a bug-prone area), we
use OpenRouter's **official Agent SDK, `@openrouter/agent`** (v0.7.2, actively
maintained; deps `@openrouter/sdk` + `zod`). It provides:

- `new OpenRouter({ apiKey })`
- `tool({ name, description, inputSchema: z.object(...), execute })` — our
  security-critical code lives in `execute`.
- `callModel({ model, messages, tools, stopWhen: [stepCountIs(N), maxCost($)],
  allowFinalResponse: true })` — runs the loop, executes tools, appends results,
  repeats until a stop condition; `await result.getText()` for the final text.

So we write **tool executors + the security allowlist**, not the loop.

## Architecture (fits the existing seam — no changes to runtime.mjs/daemons)

Two new files, plus a registry line:

- **`scripts/harnesses/openrouter-runner.mjs`** — a standalone agentic loop,
  **spawned exactly like `claude -p`**: reads the rendered prompt on **stdin**,
  runs `@openrouter/agent`'s `callModel` loop with our tools, emits normalized
  events (JSONL) on stdout as they happen, and a final `result` line.
- **`scripts/harnesses/openrouter.mjs`** — the adapter (`name` /
  `buildInvocation` / `parseEvents` / `detectOutcome`), registered in
  `runtime.mjs`'s `HARNESSES`. `buildInvocation` →
  `node openrouter-runner.mjs --allowed "<allowedTools>"`; the runner reads
  `OPENROUTER_MODEL`/`OPENROUTER_API_KEY` from env.

`runAgent`, `allowedTools`, skills-staging, and all three daemons are
**unchanged** — the runner consumes `allowedTools` and the already-staged
`.claude/skills`.

## Tool surface (structured, NO shell — chosen for safety)

Baxter acts through the CLIs + file read/write + loading skill docs. Structured
tools eliminate the shell-injection surface (no bash string to parse/allowlist):

- **`run_cli({ cli, args?, stdin? })`** — spawn an **allowlisted** CLI via
  `execFile` (no shell). The allowlist is a map `friendlyName → { command,
  prefixArgs }` derived from the caller's `allowedTools` `Bash(...)` patterns
  (`Bash(discord-cli *)` → `discord-cli`; `Bash(node <gmail> *)` → `gmail` →
  `node <gmail>`). A `cli` not in the map is rejected. **This is the enforced
  permission boundary** — only the scoped CLIs run, so tokens stay unreachable.
- **`read_file` / `write_file` / `edit_file`** — confined to the run's **cwd**
  (`MEMORY_DIR`; resolve + assert the path stays inside cwd). Covers memory,
  CREDENTIALS.md, channel files, and learned skills (all under cwd). Stricter
  than the Claude path on reads (the token file, outside cwd, stays unreadable).
  **Writes additionally refuse `<cwd>/.claude/`** — Claude Code denies a run's
  `Write`/`Edit` into its own `.claude/skills/`, which is the entire reason
  learned skills detour through `learned-skills/` + the `BAKED_SKILL_NAMES`
  shadow guard; without this carve-out a run could author a skill and
  `load_skill` it **in the same run**, bypassing that guard. Reads of `.claude/`
  (e.g. `load_skill`) stay allowed.
- **`load_skill({ name })`** — reads `<cwd>/.claude/skills/<name>/SKILL.md`.
- Granted per `allowedTools`: `Read`→read_file, `Write`→write_file,
  `Edit`→edit_file, `Skill`→load_skill; `run_cli` whenever any `Bash(...)`
  pattern is present.

**Deferred (v1):** `web_fetch`/`web_search`. Baxter browses via `playwright-cli`
(a CLI through `run_cli`), so v1 still browses; native web tools are a fast-follow.

## Prompt bridge

The existing prompts are written for Claude Code ("the Bash tool", "the Skill
tool", "restricted shell"). The runner prepends a **system message** mapping that
language onto the structured tools (run a CLI the prompt gives as
`discord-cli …` → call `run_cli`; open a skill's doc → `load_skill`), then passes
the rendered Baxter prompt as the **user** message. The prompts stay unchanged.

## Event protocol (runner → adapter)

Runner emits one JSON object per stdout line; the adapter's `parseEvents` maps
`t` → the normalized `kind`:

- `{ "t":"tool_use", "name":..., "input":... }` → `tool_use`
- `{ "t":"tool_result", "is_error":bool, "content":... }` → `tool_result`
- `{ "t":"text", "text":... }` → `text`
- `{ "t":"result", "subtype":"success"|"error", "text":..., "out_of_tokens":bool, "resets_at":num|null }` → `result`

`tool_use`/`tool_result` are emitted from **inside** each tool's `execute` (start
/ end), giving live per-tool visibility without needing SDK step hooks.
`detectOutcome` reads `out_of_tokens`/`resets_at` off the final `result` line
(set on an OpenRouter 402/429/rate-limit).

## Security (parity with, or stricter than, the Claude path)

- `run_cli` allowlist = only the scoped CLIs (same boundary as Claude's `Bash`
  allowlist); `execFile`, no shell → no injection.
- read/write confined to cwd → the token file (outside cwd) is unreadable
  (stricter than Claude, whose `Read` can open it).
- **writes additionally refuse `<cwd>/.claude/`** (matching Claude Code's denial
  of a run writing its own skills dir) → a run can't author a skill and
  `load_skill` it in the same run; learned skills still go through
  `learned-skills/` + `ensureSkills`'s `BAKED_SKILL_NAMES` shadow guard. Reads of
  `.claude/` stay allowed.
- Daemons already strip `DISCORD_BOT_TOKEN`/the gmail token from the runner's env
  (`RUN_ENV`) — unchanged; `discord-cli` reads its token from the 0600 file.
- Bounded runaway: `stopWhen: [stepCountIs(N), maxCost($)]` + a per-`run_cli`
  timeout + `maxBuffer`.

## Config

- `OPENROUTER_API_KEY` (required), `OPENROUTER_MODEL` (required; must support
  tool calling), `OPENROUTER_MAX_STEPS` (default e.g. 40),
  `OPENROUTER_MAX_COST_USD` (optional). `BAXTER_HARNESS=openrouter` selects it.
- The runner fails loud on a missing `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`.

## Testing

Unit-test the pure, security-critical parts (no API/key needed):
`allowedTools` → cli allowlist map; `run_cli` rejection of a non-allowed cli;
path-confinement (reject a path escaping cwd); the adapter's
`buildInvocation`/`parseEvents`/`detectOutcome`. The live `callModel` loop is
verified manually once an `OPENROUTER_API_KEY` + tool-calling `OPENROUTER_MODEL`
are set (redeploy).

## Non-goals (v1)

Native `web_fetch`/`web_search`, streaming token output, multi-model routing,
prompt rewrites. The Claude path is untouched and stays the default.
