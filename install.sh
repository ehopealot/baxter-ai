#!/bin/sh
# install.sh -- put the `baxter` management CLI on your PATH.
#
# Symlinks bin/baxter (in this repo) into a bin dir on your PATH, so `git pull`
# keeps the installed command current with no reinstall. This installs only the
# OPERATOR front-end; the Makefile stays the source of truth for dev/build.
#
#   ./install.sh                 # auto-pick /usr/local/bin or ~/.local/bin
#   ./install.sh /opt/bin        # install into a specific dir
#   BINDIR=~/bin ./install.sh    # same, via env
set -eu

REPO=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SRC="$REPO/bin/baxter"
test -f "$SRC" || { echo "error: $SRC not found -- run install.sh from the repo it ships in" >&2; exit 1; }
chmod +x "$SRC"

# Choose the install dir: explicit arg/env wins; else /usr/local/bin if we can
# write it, else the no-sudo default ~/.local/bin.
BINDIR=${1:-${BINDIR:-}}
if [ -z "$BINDIR" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then
    BINDIR=/usr/local/bin
  else
    BINDIR="$HOME/.local/bin"
  fi
fi
mkdir -p "$BINDIR"

DEST="$BINDIR/baxter"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "warning: $DEST exists and is not a symlink -- replacing it" >&2
fi
ln -sf "$SRC" "$DEST"
echo "installed: $DEST -> $SRC"

# PATH hint: only if BINDIR isn't already on PATH.
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) cat <<EOF

note: $BINDIR is not on your PATH. Add it, e.g.:
  echo 'export PATH="$BINDIR:\$PATH"' >> ~/.profile && . ~/.profile
EOF
  ;;
esac

echo
echo "done. Try:  baxter help"
