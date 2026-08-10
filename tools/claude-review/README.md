# Automated post-commit review hook

This is an optional developer tool. After every commit, it runs an unattended
`claude -p` review of `HEAD` in the background. It writes the findings to
`.claude/reviews/<short-hash>.md`. All of `.claude/` is gitignored, so the
reviews stay local. They are transient files, not commits. A Claude Code
`PostToolUse` hook then surfaces the review back into the session when it is
ready. Nothing here affects the Baxter agent or the runtime fleet. It runs only
at `git commit` time, and only in a clone that opts in.

## Files

- `post-commit-review.sh`: the git `post-commit` hook body. It runs `claude -p`
  detached, so `git commit` returns at once.
- `prompt.md`: the review prompt. The hook substitutes `{{COMMIT_HASH}}` for
  each commit.
- `wait-for-review.sh`: the Claude Code `PostToolUse` hook. It polls for the
  review file and injects it back into the agent's context.

## Set up (once per clone)

The tool does not install either hook for you. Wire them up once after you
clone.

1. The git hook: symlink `post-commit` to this script.
   ```sh
   ln -sf ../../tools/claude-review/post-commit-review.sh .git/hooks/post-commit
   ```
2. The Claude Code hook: add this to `.claude/settings.json`. The file is
   untracked; create it if it is absent. It runs `wait-for-review.sh` after each
   `git commit` and surfaces the review back into the session when it is ready.
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

You need the `claude` CLI on the PATH. To skip one commit's review, run
`SKIP_CLAUDE_REVIEW=1 git commit ...`.
