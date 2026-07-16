# Harness Adapter Seam — Design

**Date:** 2026-07-16
**Status:** approved (design), pending implementation

## Goal

Make the per-message agent driver **generic to the coding-agent harness** instead
of hardcoding Claude Code. Today `runClaude` in `app/scripts/runtime.mjs` spawns
the `claude` binary directly and parses Claude Code's `stream-json` schema inline.
This change extracts everything harness-specific behind a small **adapter
interface**, selected at runtime, so a second harness becomes a well-defined
drop-in.

**Scope (explicitly chosen):** *seam only.* Claude Code remains the sole
implemented adapter. We build the boundary and prove it with a fake adapter in
tests; we do **not** write a second real adapter, because none is chosen yet
(YAGNI). Getting the seam wrong for a hypothetical harness is worse than leaving
a clean, documented extraction point.

## The Claude-Code coupling, today

Two kinds of coupling exist. The seam addresses the first; the second is
deliberately left in place and documented.

**Inside `runClaude` (extracted by this change):**

1. **Invocation** — `spawn("claude", ["-p", "--model", M, "--output-format",
   "stream-json", "--verbose", "--allowedTools", T])`, prompt on stdin.
2. **Stream parsing** — `logStreamEvent` decodes Claude's `stream-json` event
   schema (`assistant`/`user`/`result` events; `tool_use`/`tool_result`/`text`
   content blocks) for live tool visibility.
3. **Outcome detection** — `detectOutOfTokens` reads Claude's `rate_limit_event`
   and `result` shapes to spot a usage/rate-limit stop.

**Caller-side (poll.mjs / discord-bot.mjs / heartbeat.mjs), left in place:**

4. **`allowedTools`** — expressed in Claude's `--allowedTools` grammar
   (`Bash(...) WebSearch Skill Read Write Edit`). It is a **load-bearing security
   boundary**, not cosmetics.
5. **Skills staging** — `ensureSkills` copies baked/learned skills into
   `.claude/skills` via each caller's `beforeRun` hook. Claude Code's skill
   discovery mechanism.

Items 4 and 5 are already passed to the driver as data/hooks, so they are not
"hardcoded" in the driver. Moving them into the adapter would require the adapter
to know each caller's CLI paths and skill directories — real work for a harness
that does not yet exist. They stay caller-side, with a prominent doc comment (see
below) marking them as the remaining Claude coupling a second adapter must handle.

## The adapter interface

A harness adapter is a plain object. Claude's lives in a new
`app/scripts/harnesses/claude.mjs`:

```js
export const claudeHarness = {
  name: "claude",

  // Build the child invocation. Prompt is always fed on stdin by the driver
  // (a whole-thread transcript can exceed MAX_ARG_STRLEN), so this returns only
  // the command + args.
  buildInvocation({ model, allowedTools }) {
    return {
      command: "claude",
      args: ["-p", "--model", model, "--output-format", "stream-json",
             "--verbose", "--allowedTools", allowedTools],
    };
  },

  // Parse ONE stdout line into a normalized event for the generic renderer,
  // or null to skip (partial/non-JSON line, or an event we don't surface).
  parseEvent(line) { /* Claude stream-json → normalized event */ },

  // Scan all raw output lines after the run for terminal signals.
  detectOutcome(rawLines) { return { outOfTokens, resetsAt }; },
};
```

### Normalized event shape

Exactly the union the renderer consumes — **not** a speculative cross-harness
bus. `parseEvent` returns one of:

- `{ kind: "tool_use", name, input }`
- `{ kind: "tool_result", isError, content }`
- `{ kind: "text", text }`
- `{ kind: "result", subtype, text }`
- `null` (skip)

### Driver: `runClaude` → `runAgent`

`runtime.mjs`'s `runClaude` is renamed `runAgent` and becomes harness-agnostic:

- Resolves the adapter from `process.env.BAXTER_HARNESS` (default `"claude"`)
  through a small name→adapter registry, **or** takes an injected `harness`
  option (so tests never spawn a real binary).
- Spawns `adapter.buildInvocation({ model, allowedTools })`, prompt on stdin.
- Line-buffers stdout; for each line: push to `rawLines`, then
  `logEvent(logId, adapter.parseEvent(line))`.
- On close: returns `{ ...adapter.detectOutcome(rawLines), failed }`.

The `{ outOfTokens, resetsAt, failed }` return contract is unchanged, so the
three callers only change the imported name (`runClaude` → `runAgent`).

### Renamings / relocations

- `logStreamEvent(logId, line)` → `logEvent(logId, event)` — a **generic
  renderer** of the normalized shape. Claude's `stream-json` parsing moves into
  `claude.mjs`'s `parseEvent`.
- `detectOutOfTokens` moves into `claude.mjs` as `detectOutcome` (pure Claude
  schema). Its existing test table moves with it.
- `fillTemplate`, `truncate`, `sh`, `formatResetTime`, `ensureSkills`,
  `ensurePlaywrightConfig` stay in `runtime.mjs` — harness-neutral.

## The documentation comment (item 4/5 coupling)

`runAgent` (and/or the adapter registry) carries a comment stating plainly:

> A second harness adapter must ALSO reinterpret two Claude-Code-isms that this
> seam leaves caller-side: (1) `allowedTools`, passed here as an opaque string in
> Claude's `--allowedTools` grammar — it is the enforced tool-permission
> boundary, so a harness without equivalent per-tool scoping **cannot enforce
> that security control**, and swapping it in silently widens what the agent may
> do; (2) the skills mechanism, staged into `.claude/skills` by each caller's
> `beforeRun` — a different harness needs its own discovery/prepare step. Both
> are caller-side today by choice; this is where they live.

## Testing

- **New:** a `runAgent` test injects a fake adapter (canned `buildInvocation`
  pointing at a tiny script or `cat`-style stub, canned `parseEvent`,
  `detectOutcome`) and asserts the orchestration — spawn wiring, per-line
  rendering, rawLines capture, return contract — **without spawning `claude`**.
- **Relocated:** `detectOutOfTokens`/`detectOutcome`'s existing cases move to a
  `claude.mjs` test, unchanged in substance.
- **Kept:** `fillTemplate` tests stay in `runtime.test.mjs`.
- Full suite must stay green (currently 88 tests across the app).

## Non-goals

- No second real adapter.
- No change to prompt templates, tool grammar, skills, or the security model.
- No change to the `{ outOfTokens, resetsAt, failed }` contract or caller
  behavior beyond the import rename.
```
