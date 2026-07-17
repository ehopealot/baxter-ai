#!/usr/bin/env bash
# git post-commit hook: fires an unattended `claude -p` review of HEAD in the
# background so `git commit` returns immediately. Findings land in
# .claude/reviews/<short-hash>.md -- .claude/reviews/ is carved out of the
# .claude/ gitignore so reviews *can* be committed, but they're local by default.
#
# Skip for a single commit with:  SKIP_CLAUDE_REVIEW=1 git commit ...
set -euo pipefail

if [[ -n "${SKIP_CLAUDE_REVIEW:-}" ]]; then
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
# Not derived from BASH_SOURCE: git invokes this via the .git/hooks/post-commit
# symlink, and `dirname` on that doesn't follow the link to its real location.
SCRIPT_DIR="$REPO_ROOT/tools/claude-review"
REVIEW_DIR="$REPO_ROOT/.claude/reviews"
mkdir -p "$REVIEW_DIR"

COMMIT_HASH="$(git rev-parse HEAD)"
SHORT_HASH="$(git rev-parse --short HEAD)"
OUTPUT_FILE="$REVIEW_DIR/$SHORT_HASH.md"
LOG_FILE="$REVIEW_DIR/$SHORT_HASH.log"

PROMPT="$(sed "s/{{COMMIT_HASH}}/$COMMIT_HASH/g" "$SCRIPT_DIR/prompt.md")"

(
  cd "$REPO_ROOT"
  # Write to temp files and mv into place atomically once claude -p is fully
  # done, so wait-for-review.sh never sees a partial/interim log or output
  # file while the review is still running.
  TMP_OUTPUT="$REVIEW_DIR/.$SHORT_HASH.$$.tmp.md"
  TMP_LOG="$REVIEW_DIR/.$SHORT_HASH.$$.tmp.log"
  if claude -p "$PROMPT" \
      --model fable \
      --allowedTools "Bash(git show*) Bash(git log*) Bash(git diff*) Read Grep Glob" \
      --output-format text \
      > "$TMP_OUTPUT" 2> "$TMP_LOG"; then
    mv "$TMP_OUTPUT" "$OUTPUT_FILE"
    rm -f "$TMP_LOG"
  else
    mv "$TMP_LOG" "$LOG_FILE"
    rm -f "$TMP_OUTPUT"
  fi
) < /dev/null > /dev/null 2>&1 &
disown

exit 0
