# Automated post-commit review hook

An optional developer tool: after every commit, it fires an unattended
`claude -p` review of `HEAD` in the background and writes the findings to
`.claude/reviews/<short-hash>.md` (all of `.claude/` is gitignored, so reviews
stay local — they're transient artifacts, not committed). A Claude Code
`PostToolUse` hook then surfaces the
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
2. **Claude Code hook** — add this to `.claude/settings.json` (untracked; create
   it if absent). It runs `wait-for-review.sh` after each `git commit` and
   surfaces the review back into the session when ready:
   ```json
   {
     "hooks": {
       "PostToolUse": [
         {
           "matcher": "Bash",
           "hooks": [
             {
               "type": "command",
               "command": "bash \"$(git rev-parse --show-toplevel)/tools/claude-review/wait-for-review.sh\"",
               "if": "Bash(git commit*)",
               "async": true,
               "asyncRewake": true,
               "rewakeMessage": "Automated post-commit review:",
               "rewakeSummary": "Commit review ready",
               "timeout": 130,
               "statusMessage": "Waiting for automated commit review..."
             }
           ]
         }
       ]
     }
   }
   ```

Requires the `claude` CLI on `PATH`. Skip a single commit's review with
`SKIP_CLAUDE_REVIEW=1 git commit …`.
