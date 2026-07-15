#!/bin/sh
# codapi runs this as the sandbox's `run` command: `emit-artifacts.sh <interp> main.<ext>`.
# It runs the program, then base64-emits any files the program wrote to
# /tmp/artifacts, framed by the random boundary the trusted caller (code-cli)
# supplied in /sandbox/.artifact_boundary. The program never sees the boundary,
# so it cannot forge a frame. Per-artifact and cumulative size caps prevent a
# run from overflowing codapi's stdout cap (noutput) into truncated base64.
set -u
ART=/tmp/artifacts
mkdir -p "$ART" 2>/dev/null || true
"$@"                       # run the program verbatim; preserve its stdout/stderr
status=$?
B=$(cat /sandbox/.artifact_boundary 2>/dev/null || true)
[ -n "$B" ] || exit $status
MAX=${MAX_ARTIFACT_BYTES:-8388608}      # 8 MB per artifact
BUDGET=${MAX_TOTAL_BYTES:-10485760}     # 10 MB cumulative
used=0
printf '\n'                             # guarantee frames start on a fresh line
for f in "$ART"/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  size=$(wc -c < "$f" | tr -d ' ')
  used=$((used + size))
  if [ "$size" -gt "$MAX" ] || [ "$used" -gt "$BUDGET" ]; then
    printf '%s TOOBIG %s %s\n' "$B" "$size" "$name"
    continue
  fi
  printf '%s ARTIFACT %s %s\n' "$B" "$size" "$name"
  base64 -w0 "$f"
  printf '\n%s END\n' "$B"
done
exit $status
