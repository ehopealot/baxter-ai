# Repo layout standardization

**Date:** 2026-07-17
**Status:** approved (design), pending implementation

## Context

The repo has two parts that its READMEs must explain at length: the root, framed
as "a generic Claude Code dev sandbox with an automated post-commit review hook,"
and `app/`, the actual Baxter agent. The root also holds the shared `Makefile`
and `compose.yaml` that *are* the agent's orchestration, so the "root is an
unrelated dev sandbox" framing is muddy and every reader has to be told about it.

Goal: make the layout standard enough that the docs no longer explain an outer
dev-sandbox dir. Chosen scope (of three considered): **relocate the dev scaffold,
keep the project in `app/`, and change no Docker resource names** — so the live
agent's `…-app-config` volume, tokens, and running containers are untouched (zero
migration). The project staying in `app/` is an accepted tradeoff for zero risk to
the running fleet.

## Target layout

```
<repo>/
├── .devcontainer/          # the optional dev container ONLY
│   ├── Dockerfile          # was ./Dockerfile (generic Claude Code sandbox)
│   ├── .env.example        # was ./.env.example (dev-container env)
│   └── .dockerignore       # was ./.dockerignore (dev build context)
├── tools/
│   └── claude-review/      # the post-commit review scaffold
│       ├── post-commit-review.sh   # was scripts/claude-review/
│       ├── prompt.md               # was scripts/claude-review/
│       └── wait-for-review.sh      # was scripts/hooks/
├── app/                    # the Baxter project — UNCHANGED
│   └── scripts/
│       └── set-env-var.sh  # was ./scripts/set-env-var.sh (app tooling)
├── docs/  backups/
├── Makefile  compose.yaml  README.md  CLAUDE.md  .gitignore
```

The root `scripts/` directory disappears entirely. Nothing inside `app/` moves
except gaining `set-env-var.sh`. No Docker image/volume/network/container names
change.

## Changes

**File moves (all `git mv`, history preserved):**
- `Dockerfile` → `.devcontainer/Dockerfile`
- `.env.example` → `.devcontainer/.env.example`
- `.dockerignore` → `.devcontainer/.dockerignore`
- `scripts/claude-review/{post-commit-review.sh,prompt.md}` → `tools/claude-review/`
- `scripts/hooks/wait-for-review.sh` → `tools/claude-review/wait-for-review.sh`
- `scripts/set-env-var.sh` → `app/scripts/set-env-var.sh`

**Edits to moved scripts (their own hardcoded paths):**
- `tools/claude-review/post-commit-review.sh`: `SCRIPT_DIR="$REPO_ROOT/scripts/claude-review"` → `"$REPO_ROOT/tools/claude-review"`
- `tools/claude-review/wait-for-review.sh`: the message text citing `scripts/claude-review/post-commit-review.sh` → `tools/claude-review/post-commit-review.sh`

**Makefile:**
- `build-dev`: build from the `.devcontainer` context (`docker build -t $(IMAGE) .devcontainer`)
- `dev`: read the dev env from `.devcontainer/.env` (`ENV_FILE := $(if $(wildcard .devcontainer/.env),--env-file .devcontainer/.env,)`); still mounts the repo root at `/app`
- `use-claude`/`use-openrouter`/`use-local`: call `app/scripts/set-env-var.sh`
- `compose.yaml` needs no change (already `app/`-rooted; only runs images)

**Local wiring (untracked; this clone / dev environment):**
- Re-point the `.git/hooks/post-commit` symlink → `../../tools/claude-review/post-commit-review.sh`
- `.claude/settings.json` Stop hook command → `tools/claude-review/wait-for-review.sh`
- These are set up per-clone by hand today (no tracked installer); document the
  one-time setup in `tools/claude-review/` so a fresh clone can reproduce it.

**Docs:**
- Root `README.md` / `CLAUDE.md`: drop the "root is a generic dev sandbox unrelated
  to the agent" framing. New framing: this repo is the Baxter project — source in
  `app/`, run via the `Makefile`; `.devcontainer/` is an optional dev container and
  `tools/claude-review/` is the post-commit review hook (with its one-time setup).

## Non-goals
- No Docker resource renames (that was the rejected "flatten + clean rename" option).
- No changes to anything inside `app/` beyond receiving `set-env-var.sh`.
- No behavior change to the agent, the fleet, or the review hook itself.

## Verification
- `make -n build-dev dev use-openrouter MODEL=x` show the new paths.
- `make build-dev` builds the dev image from `.devcontainer`; `make build-app`
  still builds; the `app/` suite is still 177/177 (sanity — `app/` is untouched).
- After committing the reorg, confirm the post-commit review hook still fires
  (a review lands in `.claude/reviews/<sha>.md`) — this exercises the re-pointed
  symlink, the updated `.claude/settings.json`, and the scripts' edited paths
  end-to-end.
