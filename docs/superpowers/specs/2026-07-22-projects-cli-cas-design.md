# projects-cli optimistic concurrency (compare-and-swap) — design

**Date:** 2026-07-22
**Status:** approved design, pre-implementation
**Component:** `app/scripts/projects-cli.mjs` (+ `skills/projects/SKILL.md`, `skills/data`-style docs, prompts)

## Problem

`projects-cli save <slug>` replaces the whole project file from stdin. The write
itself is safe (temp + rename, no torn reads), but there is a **lost-update**
window across the model's think-time:

1. Discord run: `open erik-job-search` → reads v1
2. Heartbeat run: `open erik-job-search` → reads v1
3. Discord reasons ~30s, adds lead A, `save` → v2 (v1 + A)
4. Heartbeat reasons, adds lead B, `save` → v3 (v1 + B) — **lead A silently gone**

Both surfaces share `MEMORY_DIR`, so this is a real (if infrequent) multi-writer
race. It is currently documented as an accepted residual ("last-write-wins, not
corruption"). The risotto investigation and the 44-channel reorg made clear the
memory layer is load-bearing enough to harden.

## Why the obvious fixes don't work

- **Locking `save`** (a `proper-lockfile` around the write, like the schedule
  store) does NOT fix it. The lock serializes steps 3 and 4, but each `save` is a
  whole-file replace of a *stale base* — Heartbeat still overwrites v2 with its
  own v1-derived copy. The dangerous window is `open → think → save`, spanning two
  separate CLI invocations and the model's reasoning, which a per-write lock can't
  cover without a lease across think-time (stale-lock and throughput problems).
  The schedule store's lock works only because its read-modify-write happens
  in-process inside one locked `mutate()`, with no model reasoning in between.
- **A single shared hash sidecar** does NOT fix it either: whichever run saves
  first updates the very hash the other run checks against, so the stale write
  passes undetected. The expected hash must be bound to the *specific read* the
  edit is based on.

## Design: optimistic concurrency (compare-and-swap), stateless

Bind the expected version to the read by **vending a version token on read and
requiring it on write** — classic CAS, kept stateless (no token store, no run-id,
no GC). The token is derived on demand from the file both times.

- **`open <slug>`** — prints the file body to **stdout** (unchanged), and the
  version token to **stderr** as `version: <8hex>`. stdout stays pure file content
  (nothing that consumes it breaks; if the model pipes it back into `save` it's the
  clean body, not polluted with a header).
- **`make <name>`** — same: creates the seed file, prints the seed's
  `version: <8hex>` to stderr, so the first `save` after a `make` has a token
  without a separate `open`.
- **`save <slug> --expect <8hex>`** — **requires** `--expect`. It recomputes the
  current file's token and:
  - token missing / malformed → error telling the run to `open` first and pass the
    version;
  - token ≠ current file's token → **reject**: *"`<slug>` changed since you read it
    (version X, now Y) — re-open, reapply your edit, and save with the new
    version."*
  - token = current → write (temp + rename).
- **The verify + rename run under one brief `proper-lockfile` lock** on the project
  file (mirrors `schedule-store.mutate`'s options: `realpath:false`, `stale:10000`,
  bounded retries). This closes the check-to-write TOCTOU (a writer slipping in
  between the hash read and the rename). It is a millisecond lock around the write
  itself — nothing like a think-time lease.

### Token

`version(body) = sha256(body).hex().slice(0, 8)` — 8 lowercase hex chars (32 bits).
Exact string compare; the supplied token is trimmed and validated as `^[0-9a-f]{8}$`
before compare (a wobble in case/length yields a clear error, not a false match).

**Why 8 chars.** The compare is always two versions of the *same* file (a 2-way
collision, not a birthday problem across many files), further gated behind the rare
event of two runs racing the same file. Collision odds are ~2⁻³² per conflicting
save — negligible regardless of conflict volume. 8 hex chars is still trivially
carried verbatim by the model (its whole reason for being short), so there is no
reliability cost to the extra margin over a 4–6 char token. A collision's failure
mode is a *silent* lost update — exactly what this mechanism prevents — so we spend
the free margin.

## Interface changes

- `save` gains a **required** `--expect <8hex>` flag. A bare `save <slug>` now
  errors (this is the point: it structurally enforces read-before-write).
- `open`/`make` emit an extra `version: <8hex>` line on **stderr**. stdout is
  unchanged.
- `skills/projects/SKILL.md` + the per-surface prompts' projects guidance document
  the open→(edit)→save-with-version loop and the "changed under you → re-open"
  recovery.

No other CLI, daemon, or harness code changes. The four consumers are the model's
own `open`/`make`/`save` calls; nothing parses `save`'s output structurally.

## Failure modes

- **Concurrent conflict** → the losing `save` is **rejected loudly** and the run
  re-opens and reapplies. A silent lost update becomes a safe, recoverable retry.
- **Model omits/garbles the token** → `save` rejects (bad/missing `--expect`); worst
  case a spurious re-open, **never data loss**. Making `--expect` mandatory means the
  model can't silently skip the check.
- **Model supplies a stale-but-still-valid token** (nothing changed since a much
  earlier open) → matches current → save proceeds. Correct: nothing was lost.
- **Out-of-band edit** (a native `Write`/`Edit` to the file, bypassing the CLI) →
  next `save`'s token won't match → rejected. A useful bonus, not a guarantee (the
  bypass path itself is unchanged and pre-existing).
- **Process SIGKILLed mid-save** → temp+rename is atomic, so the file is wholly old
  or wholly new; no token store to leave inconsistent (statelessness).

## Scope

**In scope: `projects-cli` only.** It has the exact `open`/`save`-through-a-CLI
shape CAS needs.

**Out of scope: `memory.md` and the per-channel Discord memory files.** Those are
read/written with the run's **native** `Read`/`Write`/`Edit` (paths injected into
the prompt), not through a CLI — there is no `open`/`save` verb to hang a token on.
Applying CAS there would require routing them through a new `memory-cli` (a larger
change to how the run reads/writes memory, plus prompt/skill rework). The same
lost-update residual they have today is unchanged by this work; a `memory-cli` CAS
is a natural follow-up that reuses this exact token/verify pattern.

## Testing (TDD, RED first)

Pure/unit (no lock needed — structure the CAS check + hashing to be lock-free, the
lock wraps orchestration):

- `versionToken(body)` → known sha256-prefix for a fixed input; stable/deterministic.
- `save` with a matching token → writes, returns new bytes.
- `save` with a **mismatched** token → throws the CAS "changed since you read it"
  error, file **unchanged**.
- `save` with a **missing** token → throws the "open first / pass the version" error.
- `save` with a **malformed** token (not `^[0-9a-f]{8}$`) → clear validation error.
- CAS sequence: token(v1) captured; file mutated to v2 out of band; `save --expect
  token(v1)` → rejected (the core lost-update case).
- `open`/`make` emit `version:` matching `versionToken(current body)`.
- Back-compat: `open` stdout is byte-identical to the file body (token only on stderr).

Manual/live before deploy: build the image, exec projects-cli inside it, run the
open→save-with-version loop and a forced-mismatch, confirm the reject message and
that a real concurrent double-save now loses nothing (one side rejects).

## Security notes

- Token is content-derived, not a secret; no new secret-handling.
- `--expect` is model-supplied (attacker-influenceable via channel/web content that
  lands in a project body). It cannot cause a **lost update** by forging a token:
  the compare is against the *current on-disk* hash, so a forged/replayed token
  only ever yields a rejection (safe) unless it genuinely equals current (in which
  case nothing was lost). Grinding an 8-char collision to force a specific silent
  drop is infeasible/low-value (attacker must control the racing run's saved content
  and grind 2³² candidates Baxter would actually write).
- No change to `projects-cli`'s confinement (`slugify` + `basename`, PROJECTS_DIR).

## Operator decisions (2026-07-22, signed off)

- Approach **B** (vend token + require on write), not the CLI-managed per-run hash
  file — chosen for statelessness and interface simplicity; the model already
  reliably carries slugs and multi-KB bodies, so echoing one 8-char token is within
  reach, and the mandatory flag caps the downside at a safe re-open.
- Token length **8 hex chars**.
- Scope **projects-cli only**; `memory.md`/channel-file CAS deferred to a future
  `memory-cli`.
