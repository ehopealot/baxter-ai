#!/usr/bin/env bash
# Claude Code PostToolUse hook (Bash, gated to `git commit*` via the "if"
# clause in .claude/settings.json). Registered as asyncRewake, so this runs
# in the background without blocking the turn, and its stdout is injected
# back into the agent's context if it exits 2.
#
# Polls for the review that scripts/claude-review/post-commit-review.sh
# writes asynchronously after every commit, and surfaces it once ready.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
SHORT_HASH="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null)" || exit 0
REVIEW_FILE="$REPO_ROOT/.claude/reviews/$SHORT_HASH.md"
LOG_FILE="$REPO_ROOT/.claude/reviews/$SHORT_HASH.log"

for _ in $(seq 1 60); do
  if [[ -s "$REVIEW_FILE" ]]; then
    cat "$REVIEW_FILE"
    exit 2
  fi
  if [[ -s "$LOG_FILE" ]]; then
    echo "The automated review for $SHORT_HASH failed to run. Last lines of its log:"
    tail -n 20 "$LOG_FILE"
    exit 2
  fi
  sleep 1
done

echo "No automated review appeared for commit $SHORT_HASH within 60s (scripts/claude-review/post-commit-review.sh may not be installed, or claude -p is still running -- check .claude/reviews/$SHORT_HASH.md later)."
exit 2
