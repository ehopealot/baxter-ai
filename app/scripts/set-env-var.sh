#!/bin/sh
# Idempotently set KEY=VALUE in an env file, in place.
#
# Replaces the FIRST existing line for KEY -- whether active (`KEY=...`) or
# commented (`#KEY=...`) -- with an active `KEY=VALUE`, and drops any further
# lines for the same KEY so exactly one remains. Appends `KEY=VALUE` if KEY is
# absent. Everything else in the file is preserved verbatim.
#
# Used by the Makefile's `use-claude` / `use-openrouter` / `use-local` / `use-custom` targets to
# flip Baxter's harness/model in app/.env without a hand-edit or a full rewrite
# (so the API keys and every other setting are left untouched).
set -eu

# Do not let a caller substitute path-resolution or writer tools.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ "$#" -ne 3 ]; then
  echo "usage: set-env-var.sh <env-file> <KEY> <VALUE>" >&2
  exit 2
fi
file=$1
key=$2
val=$3

# Canonical fleet env files are control-plane state. Direct Core writers cannot
# manufacture admission, so they refuse before existence checks, mktemp, or awk.
# Check both the spelling supplied by the caller and its resolved target: the
# first catches a canonical pathname whose leaf is a symlink, while the second
# catches traversal, repeated separators, and symlinked parents.
reject_canonical_app_env() {
  candidate=$1
  case "$candidate" in
    /agents/*/app.env)
      tenant=${candidate#/agents/}; tenant=${tenant%/app.env}
      case "$tenant" in ""|*[!a-z0-9-]*|-*|*-) return 0 ;; esac
      echo "set-env-var: canonical tenant app.env must be changed with: baxctl setenv $tenant <key> <value>" >&2
      exit 1
      ;;
  esac
}

reject_canonical_app_env "$file"
resolved=$(/usr/bin/realpath -m -- "$file") || {
  echo "set-env-var: cannot safely resolve env file: $file" >&2
  exit 1
}
reject_canonical_app_env "$resolved"

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
