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

- **`open <slug>`** — does **one** `readFileSync` into a buffer, emits
  `version: <8hex>` (the hash of *that buffer*) to **stderr FIRST**, then writes the
  same buffer to **stdout**. stdout stays pure file content (nothing that consumes
  it breaks; if the model pipes it back into `save` it's the clean body). The
  single read is load-bearing (finding #2): hashing a *re-read* of the file would
  vend v2's token attached to v1's printed body if a save landed between the two
  reads — a lost update with the mechanism "working". One buffer, printed and
  hashed, closes that.
- **`make <name>`** — creates the seed file (`wx`), then emits `version: <8hex>`
  (hash of the exact seed bytes it wrote) to stderr, so the first `save` after a
  `make` has a token without a separate `open`.
- **`save <slug> --expect <8hex>`** — **requires** `--expect`. Under the lock (see
  below) it reads the current file, computes its token, and:
  - token missing / malformed (`!^[0-9a-f]{8}$`) → error telling the run to `open`
    first and pass the version;
  - token ≠ current file's token → **reject**, echoing only the *supplied* (stale)
    token, **never the current one**: *"`<slug>` changed since you read it (your
    version `<supplied>` is stale) — re-open, reapply your edit, and save with the
    new version."* (finding #1: printing the current token would hand the model a
    valid token it could replay with its stale body — a one-step bypass of the whole
    mechanism.)
  - token = current → write (temp + rename), then emit `version: <newhex>` (hash of
    the bytes just written) to **stderr** on success, so a second save in the same
    run needs no re-read (finding #3 — CAS-correct: the token is bound to the state
    this save created).
- **The whole `save` critical section runs under one brief `proper-lockfile` lock**
  on the project file — **read current → compute token → compare → temp-write →
  rename** — mirroring `schedule-store.mutate`'s options (`realpath:false`,
  `stale:10000`, bounded retries). The *read for the hash must be inside the same
  lock as the rename*, or a writer slips in between and the loser's stale write
  passes. `open` and `make` take **no** lock (an atomic read and a `wx` create,
  respectively — a reader never sees a torn file). It is a millisecond lock around
  the write, nothing like a think-time lease.

### Token

`versionToken(buf) = sha256(buf).hex().slice(0, 8)` — a single shared helper over a
**raw `Buffer`**, used identically on every side (open, make, save-verify,
save-vend). 8 lowercase hex chars (32 bits). Exact string compare; the supplied
token is trimmed and validated as `^[0-9a-f]{8}$` before compare.

**Hash raw bytes, never a UTF-8 round-trip** (finding #4). If one side hashed a
decoded-then-re-encoded string and another hashed raw file bytes, any invalid-UTF-8
byte would make the two tokens permanently disagree → open vends T, nothing changes,
save computes T′≠T → reject → re-open vends T again → **spurious-reject livelock**.
Reading the file as a Buffer and writing `Buffer.from(body, "utf8")` on save keeps
the bytes hashed identical on both sides (a `writeFileSync(string)` writes UTF-8,
and a later `readFileSync` Buffer reads those exact bytes back).

**Why 8 chars.** The compare is always two versions of the *same* file (a 2-way
collision, not a birthday problem across many files), further gated behind the rare
event of two runs racing the same file. Accidental-collision odds are ~2⁻³² per
conflicting save — negligible regardless of conflict volume. 8 hex chars is still
trivially carried verbatim by the model (its whole reason for being short), so the
extra margin over a 4–6 char token is free; a collision's failure mode is a *silent*
lost update, exactly what this mechanism prevents, so we spend it. (12–16 hex would
additionally make a deliberate collision *grind* infeasible and is still trivially
carried — optional; 8 is the chosen length for the accidental case, which is the
real risk here.)

## Interface changes

- `save` gains a **required** `--expect <8hex>` flag. A bare `save <slug>` now
  errors (this is the point: it structurally enforces read-before-write).
- `open`, `make`, **and a successful `save`** emit a `version: <8hex>` line on
  **stderr** (emitted before any stdout body, so a head-truncated tool result under
  the claude harness never loses it). stdout is unchanged.
- `skills/projects/SKILL.md` + the per-surface prompts' projects guidance document:
  the open→(edit)→save-with-version loop; the "changed under you → re-open"
  recovery; that the `version:` line is **CLI metadata, never part of the file**
  (so the model never pastes it back into a saved body); and — a zero-code partial
  mitigation for the deferred files (finding #7) — **prefer native `Edit` over a
  whole-file `Write` for `memory.md` and channel notes** (Edit applies against the
  file's current state, so non-overlapping concurrent changes both land and an
  overlapping one surfaces as an `old_string` mismatch rather than a silent
  overwrite).

No other CLI, daemon, or harness code changes. The consumers are the model's own
`open`/`make`/`save` calls; nothing parses `save`'s output structurally. I verified
the openrouter/local harness surfaces `stderr` as a separate, independently-capped
field (`spawnCli` in `harnesses/openrouter-tools.mjs`), so a large truncated body
can't swallow the token there; the stderr-first ordering covers the claude harness's
combined-and-head-truncated case.

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

## Implementation notes (finding #8)

- **`save` operation order (all inside the lock):** acquire lock → `readFileSync`
  current file as a Buffer (its `ENOENT` becomes the existing "make it first" error,
  subsuming the current pre-lock `statSync`) → compute + compare token → write temp
  → rename → release; vend the new token after release. The byte-cap check on the
  incoming body can stay *before* the lock (it needs no file state).
- **`make`/`open` take no lock** — `wx` create and single atomic read respectively.
- **Lock file naming:** `proper-lockfile` creates `<slug>.md.lock` next to the
  project. `listProjects` already filters on `.endsWith(".md")`, so lock artifacts
  never leak into `list` or the preamble — worth a one-line comment at the filter so
  a future edit doesn't break that.
- One shared `versionToken(buf: Buffer)` helper, exported for tests, used on all four
  sides.

## Testing (TDD, RED first)

Pure/unit (structure the CAS check + hashing to be lock-free; the lock wraps
orchestration):

- `versionToken(buf)` → known sha256-prefix for a fixed `Buffer`; deterministic; and
  a byte-for-byte case (a non-UTF-8 byte hashes the same on read-back — no round-trip
  drift, finding #4).
- `save` with a matching token → writes, returns new bytes **and the new token**.
- `save` with a **mismatched** token → throws the CAS error, file **unchanged**, and
  the error text **does NOT contain the current token** (finding #1) — only the
  supplied stale one.
- `save` with a **missing** token → throws the "open first / pass the version" error.
- `save` with a **malformed** token (not `^[0-9a-f]{8}$`) → clear validation error.
- CAS sequence: token(v1) captured; file mutated to v2 out of band; `save --expect
  token(v1)` → rejected (the core lost-update case); then `save --expect token(v2)`
  → succeeds.
- `save` success **vends the new token** = `versionToken(bytes written)` (finding #3).
- `open`/`make` emit `version:` matching `versionToken(current bytes)`, and `open`'s
  stdout is byte-identical to the file body — both derived from **one** read
  (finding #2).

Manual/live before deploy: build the image, exec projects-cli inside it, run the
open→save-with-version loop and a forced-mismatch, confirm the reject message and
that a real concurrent double-save now loses nothing (one side rejects).

## Security notes

- Token is content-derived, not a secret; no new secret-handling.
- `--expect` is model-supplied (attacker-influenceable via channel/web content that
  lands in a project body). It cannot cause a **lost update** by forging a token:
  the compare is against the *current on-disk* hash, so a forged/replayed token
  only ever yields a rejection (safe) unless it genuinely equals current (in which
  case nothing was lost). What gates a *deliberate* collision attack is **content
  control, not compute**: 2³² SHA-256 evaluations is only minutes of grinding, but
  to benefit the attacker would have to control the *exact final bytes* Baxter
  writes in a racing save (models paraphrase/reformat, so the attacker doesn't) AND
  line that up with a concurrent stale save — for the payoff of dropping one of
  Baxter's own memory notes. Infeasible in practice and near-zero value. (The reject
  message also never emits the current token — finding #1 — so the mechanism doesn't
  hand out the one value that would let a stale body pass.)
- No change to `projects-cli`'s confinement (`slugify` + `basename`, PROJECTS_DIR).

## Operator decisions (2026-07-22, signed off)

- Approach **B** (vend token + require on write), not the CLI-managed per-run hash
  file — chosen for statelessness and interface simplicity; the model already
  reliably carries slugs and multi-KB bodies, so echoing one 8-char token is within
  reach, and the mandatory flag caps the downside at a safe re-open.
- Token length **8 hex chars**.
- Scope **projects-cli only**; `memory.md`/channel-file CAS deferred to a future
  `memory-cli` (with a same-change `Edit`-over-`Write` prompt nudge to shrink that
  residual now).

## Revision history

- **2026-07-22 (rev 2):** folded in the fable spec review — reject message must not
  leak the current token (#1); `open` hashes the single buffer it prints (#2);
  successful `save` vends the new token (#3); hash raw bytes via a shared
  `versionToken(buf)` to avoid a UTF-8-round-trip livelock (#4); `version:` emitted
  stderr-first + documented as non-file metadata (#5); collision rationale reworded
  to lean on content-control not compute (#6); `Edit`-over-`Write` nudge for the
  deferred files (#7); implementation notes for op order + lock-file naming (#8).
