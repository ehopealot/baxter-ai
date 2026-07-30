# memory-cli — CAS-protected shared memory writes

**Status:** approved-to-build 2026-07-30 (reviewer vets this spec). **Goal:** close
the lost-update window on Baxter's SHARED memory files (`memory.md`,
`CREDENTIALS.md`) by giving the agent a CAS-protected CLI to write them, reusing
projects-cli's compare-and-swap pattern. The docs already anticipate this: "a
future `memory-cli` would reuse this exact pattern" (`tool-clis.md`).

## Problem

`memory.md` and `CREDENTIALS.md` live in the shared `MEMORY_DIR` and are written by
**every surface's run** (mail/discord/heartbeat/voice) via native `Write`/`Edit`.
No coordination: two runs that each read, then whole-file `Write`, silently clobber
each other (last-write-wins). The prompts today only *nudge* "prefer `Edit` over
`Write`" — a mitigation, not a fix. Only the agent writes these files (no daemon
does), so a lock among runs is the correct boundary.

## Approach

A new `memory-cli` (PATH shim → `scripts/memory-cli.ts`), granted to every surface,
that owns writes to the shared memory files. Three verbs:

- **`memory-cli read [target]`** — print the file to stdout, vend its `version:`
  token on **stderr** (stderr first, so a head-truncated tool result never drops the
  token — same trick as projects-cli `open`). A missing file reads as empty with the
  empty-buffer token (memory is create-on-first-write). `target` default `memory`.
- **`memory-cli write <target> --expect <V>`** — replace the WHOLE file from stdin,
  atomically, iff the current version == `V`; else reject loudly (never echoing the
  current token, so a stale body can't replay). For full rewrites/reorganizations.
- **`memory-cli append <target>`** — append stdin to the file, lock-serialized and
  atomic, **no `--expect`**. This is the dominant memory op ("record a new fact",
  "add a login"): because the append re-reads the current bytes *inside the lock*,
  two concurrent appends both survive — lossless, no CAS reject/retry. It inserts a
  single `\n` boundary when the existing content is non-empty and doesn't already end
  in one, so two "record a fact" appends never glue onto one line. A missing file is
  created (create-on-first-write). This replaces the native-`Edit`-on-stale-read
  nudge for additive writes.

`target` is a fixed allowlist — `memory` → `MEMORY_PATH`, `credentials` →
`CREDENTIALS_PATH` — never an arbitrary path, so there is no traversal and the tool
can't reach the sibling key files (same confinement posture as files-cli/projects-cli;
the run cwd is already `MEMORY_DIR`).

**Modify-in-place** (correct/replace an existing fact) uses `read` → edit → `write
--expect`; a reject means a concurrent change landed, so re-read and reapply. Between
`append` (additive) and `read`→`write --expect` (in-place), the agent covers every
`Edit` use case without the clobber window.

### Reuse, not copy: shared CAS helper

projects-cli's `versionToken` + the lock→re-read→compare→atomic-temp+rename core is
the subtle concurrency code we must not duplicate. Extract it into a new
`scripts/cas-file.ts`:

- `versionToken(buf): string` and `VERSION_RE` (moved from projects-cli).
- `casSave(path, body, expected, opts?)` — validates the token format, takes a
  `proper-lockfile` lock (`realpath:false`, same stale/retry opts), re-reads current
  bytes *inside the lock* (ENOENT → empty buffer, so create-on-write works), compares
  `expected` against the current token, writes `body` via a pid-named temp sibling +
  `renameSync` (unlink temp on error), releases in `finally`, and vends the new token.
- `casAppend(path, body)` — same lock + atomic-rewrite, reads-then-appends with no
  compare (ENOENT → empty buffer, same create-on-write as `casSave`); inserts a
  single `\n` boundary when the current content is non-empty and lacks a trailing
  newline.

`projects-cli.saveProject` is refactored to call `casSave` (keeping its own size-cap
+ "make it first" existence check + slug concerns); its behavior is unchanged and its
existing tests (CAS reject, cross-process lock, no-temp-left) protect the refactor.
memory-cli uses `casSave`/`casAppend` directly.

### Wiring

- `grants.ts`: add `Bash(memory-cli *)` to `CORE_TOOLS`; append `"memory"` to
  `SKILL_NAMES` (exclusions + `BAKED_SKILL_NAMES` auto-cover). Update `grants.test.ts`
  expectations.
- `Dockerfile`: a `/usr/local/bin/memory-cli` shim, mirroring projects-cli's.
- `skills/memory/SKILL.md`: document the three verbs + the version/`--expect` model +
  append.
- **Prompt rewording** — the "prefer `Edit` over `Write`" nudges at `prompt.md:17`,
  `discord-prompt.md:27`, `heartbeat-prompt.md:19`, `tui-prompt.md:39-40`, and the
  inline pointers in `voice-bot.ts:707-709` are replaced with: add a fact →
  `… | memory-cli append memory`; revise → `memory-cli read memory` (note the
  version), edit, `… | memory-cli write memory --expect <version>` (re-read + reapply
  on reject). **Preserve the curation half** of those existing lines ("keep it
  organized; fold appended facts into the right section rather than letting it become
  an append log") — since `append` is the zero-friction path while revision costs a
  read→write→maybe-reject loop, dropping that guidance would steer toward unbounded
  append-only growth, and `memory.md` is injected into every run. Native `Write`/
  `Edit` remain available but memory writes should go through the CLI so the lock is
  meaningful (a stray native write bypasses it — an accepted, documented residual,
  strictly better than today).

## Scope / non-goals

- **In:** the two clearly-shared files (`memory.md`, `CREDENTIALS.md`).
- **Deferred:** per-channel Discord memory (`discordChannelMemoryPath`). It's
  per-channel (the dispatcher largely serializes it) — lower contention. The discord
  prompt's *channel*-memory line stays native-`Edit`; only its *shared*-memory line is
  rerouted. Adding `memory-cli … channel <id>` later is a target-resolver addition.
- **Residual:** the lock only coordinates memory-cli-vs-memory-cli; a native
  `Write`/`Edit` on a memory file still bypasses it. Mitigated by steering all memory
  writes through the CLI in the prompts.

## Test plan

Mirror `projects-cli.test.ts` (functions take an explicit dir/path so tests never
touch the real workspace):
- `cas-file.test.ts`: `casSave` CAS reject (stale token rejected, current token NOT
  leaked, file unchanged) + create-on-write (ENOENT current) + no-temp-left;
  `casAppend` create-on-write + single-newline boundary; `normalizeExpected` format
  errors. (Cross-process append losslessness is covered by memory-cli's lock test.)
- `memory-cli.test.ts`: `read` vends the version (stderr) and reads-missing-as-empty;
  `write --expect` round-trips + rejects a stale token; `append` adds without a token;
  target allowlist (unknown target rejected); the **cross-process lock** test (spawn
  two child `node -e` processes racing a write on the same base token → exactly one
  exit-0 winner + one CAS reject, file holds the winner's whole body) — the only way
  to actually prove the lock, per projects-cli.test.ts.
- `projects-cli.test.ts` stays green through the `casSave` refactor.
- `make check` (tsc strict + `node --test`) green.
