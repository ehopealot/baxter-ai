#!/usr/bin/env sh
# Idempotently set KEY=VALUE in an env file, in place.
#
# Replaces the FIRST existing line for KEY -- whether active (`KEY=...`) or
# commented (`#KEY=...`) -- with an active `KEY=VALUE`, and drops any further
# lines for the same KEY so exactly one remains. Appends `KEY=VALUE` if KEY is
# absent. Everything else in the file is preserved verbatim.
#
# Used by the Makefile's `use-claude` / `use-openrouter` / `use-local` targets to
# flip Baxter's harness/model in app/.env without a hand-edit or a full rewrite
# (so the API keys and every other setting are left untouched).
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: set-env-var.sh <env-file> <KEY> <VALUE>" >&2
  exit 2
fi
file=$1
key=$2
val=$3

# Guard the key: it goes into an awk regex, and only a shell-env-var-shaped name
# is ever a legitimate target here. This keeps a caller from injecting regex.
case "$key" in
  "" | [!A-Za-z_]* | *[!A-Za-z0-9_]*)
    echo "set-env-var: invalid key: $key" >&2
    exit 2
    ;;
esac
[ -f "$file" ] || { echo "set-env-var: no such file: $file" >&2; exit 1; }

# awk inserts `val` literally (it's a plain string in the action, never a regex
# or a replacement template), so a value with /, :, &, etc. is safe. mktemp is
# 0600, so the rewritten file never widens the secrets file's permissions.
tmp=$(mktemp)
awk -v k="$key" -v v="$val" '
  $0 ~ ("^[#[:space:]]*" k "=") { if (!seen) { print k "=" v; seen = 1 } next }
  { print }
  END { if (!seen) print k "=" v }
' "$file" > "$tmp"
mv "$tmp" "$file"
