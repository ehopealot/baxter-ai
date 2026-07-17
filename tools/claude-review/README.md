# Automated post-commit review hook

An optional developer tool: after every commit, it fires an unattended
`claude -p` review of `HEAD` in the background and writes the findings to
`.claude/reviews/<short-hash>.md` (that one path under `.claude/` is tracked in
git; the rest is gitignored). A Claude Code `PostToolUse` hook then surfaces the
review back into the session once it's ready. Nothing here affects the Baxter
agent or the runtime fleet — it only runs at `git commit` time in a clone that
has opted in.

## Files
- `post-commit-review.sh` — the git `post-commit` hook body. Runs `claude -p`
  detached so `git commit` returns immediately.
- `prompt.md` — the review prompt (`{{COMMIT_HASH}}` is substituted per commit).
- `wait-for-review.sh` — the Claude Code `PostToolUse` hook that polls for the
  review file and injects it back into the agent's context.

## One-time setup (per clone)

Neither the git hook nor the Claude Code hook is installed automatically — wire
them up once after cloning:

1. **git hook** — symlink `post-commit` to this script:
   ```sh
   ln -sf ../../tools/claude-review/post-commit-review.sh .git/hooks/post-commit
   ```
2. **Claude Code hook** — point a `PostToolUse` (Bash, gated to `git commit*`)
   hook at `wait-for-review.sh` in `.claude/settings.json`. See this repo's
   `.claude/settings.json` for the exact block.

Requires the `claude` CLI on `PATH`. Skip a single commit's review with
`SKIP_CLAUDE_REVIEW=1 git commit …`.
