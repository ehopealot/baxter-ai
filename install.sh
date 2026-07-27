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

# BuildKit warning (non-fatal -- this only installs the CLI). Baxter's image build needs a
# working BuildKit; the common gotcha is a missing `buildx` plugin (Colima ships Docker
# without it). Probe a trivial BuildKit build only if Docker is up, and yell so the operator
# fixes it before `baxter build` instead of hitting Docker's opaque error mid-build.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if ! printf 'FROM scratch\n' | DOCKER_BUILDKIT=1 docker build -q - >/dev/null 2>&1; then
    cat >&2 <<EOF

warning: Docker BuildKit isn't working -- 'baxter build' will fail until it's fixed.
  Almost always a missing 'buildx' plugin. On Colima / Docker CLI on macOS:
    brew install docker-buildx \\
      && mkdir -p ~/.docker/cli-plugins \\
      && ln -sfn \$(brew --prefix)/opt/docker-buildx/bin/docker-buildx ~/.docker/cli-plugins/docker-buildx
  Fedora/RHEL: sudo dnf install docker-buildx-plugin
  Debian/Ubuntu: sudo apt-get install docker-buildx-plugin
  docs: https://docs.docker.com/go/buildx/
EOF
  fi
fi

echo
echo "done. Try:  baxter help"
