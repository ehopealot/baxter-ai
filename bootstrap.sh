#!/bin/sh
# Baxter remote installer -- the `curl | bash` bootstrap hosted at https://bax.bot.
#
#   curl -fsSL https://bax.bot/install.sh | bash
#
# It checks prerequisites, clones Baxter, puts the `baxter` CLI on your PATH, and
# scaffolds app/.env -- then hands off. It does NOT start Baxter (he needs a Discord
# token + a model key you supply) and does NOT install Docker (it checks + points
# you at the docs). Safe to re-run: an existing Baxter checkout is updated in place,
# and a filled-in app/.env is never overwritten.
#
# Install into a custom directory (default ~/baxter):
#   curl -fsSL https://bax.bot/install.sh | bash -s -- /opt/baxter
#   BAXTER_DIR=/opt/baxter  curl -fsSL https://bax.bot/install.sh | bash
#
# NOTE: this file is `bootstrap.sh` in the repo; bax.bot serves its contents at
# /install.sh -- re-upload after editing. (The repo's own `install.sh` is a
# different, post-clone helper that only symlinks the CLI onto PATH.)
#
# POSIX sh -- runs the same piped to `bash` or `sh`.
set -eu

REPO_URL="https://github.com/ehopealot/baxter-ai.git"
DEST="${1:-${BAXTER_DIR:-$HOME/baxter}}"

# Never let git block on a credential prompt (a private/typo'd repo would hang a
# `curl | bash` forever). Fail fast instead, so the die messages below fire.
export GIT_TERMINAL_PROMPT=0

# Colors only when stdout is a terminal (true under `curl | bash`; a pipe/file
# isn't). Real ESC bytes (via printf) so they render in both printf and the
# heredoc below -- a literal '\033' string would print raw through `cat`.
if [ -t 1 ]; then
  B=$(printf '\033[1m'); G=$(printf '\033[32m'); R=$(printf '\033[31m'); Y=$(printf '\033[33m'); Z=$(printf '\033[0m')
else
  B=''; G=''; R=''; Y=''; Z=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s\n' "${B}==>${Z} $*"; }
ok()   { printf '%s\n' "${G}ok${Z}  $*"; }
warn() { printf '%s\n' "${Y}note:${Z} $*"; }
die()  { printf '%s\n' "${R}error:${Z} $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- 1. prerequisites (check + instruct; never auto-install) -----------------
step "Checking prerequisites"
missing=''
have git    || missing="$missing git"
have docker || missing="$missing docker"
have make   || missing="$missing make"
if [ -n "$missing" ]; then
  die "missing:${missing}. Install them, then re-run. Docker: https://docs.docker.com/engine/install/"
fi
docker compose version >/dev/null 2>&1 \
  || die "the 'docker compose' v2 plugin is required (found docker, but not compose v2). See https://docs.docker.com/compose/install/"
ok "docker, docker compose v2, git, make"
# The daemon isn't needed to INSTALL (clone/CLI/scaffold), only to `baxter up` --
# so warn, don't block, if it isn't reachable right now.
docker info >/dev/null 2>&1 \
  || warn "the docker daemon isn't reachable right now -- start it (or 'colima start', or add your user to the 'docker' group) before 'baxter up'."

# --- 2. clone (or update an existing Baxter checkout; never clobber) ----------
if [ -e "$DEST" ]; then
  if [ -d "$DEST/.git" ] && git -C "$DEST" remote get-url origin 2>/dev/null | grep -qi 'baxter-ai'; then
    step "Updating the existing checkout at $DEST"
    git -C "$DEST" pull --ff-only \
      || die "git pull failed in $DEST (local changes, or the branch diverged). Resolve it there, or move $DEST aside and re-run."
  else
    die "$DEST already exists and isn't a Baxter checkout -- move it aside, or install elsewhere: curl -fsSL https://bax.bot/install.sh | bash -s -- /some/other/dir"
  fi
else
  step "Cloning Baxter into $DEST"
  git clone --depth 1 "$REPO_URL" "$DEST" \
    || die "git clone failed -- is $REPO_URL public and reachable?"
fi
ok "source at $DEST"

# --- 3. put the `baxter` CLI on PATH (the repo's own install.sh) --------------
step "Installing the baxter CLI"
( cd "$DEST" && ./install.sh ) || die "installing the baxter CLI failed (see the output above)."

# --- 4. scaffold app/.env (never overwrite a filled-in one) -------------------
if [ -f "$DEST/app/.env" ]; then
  ok "keeping your existing app/.env"
else
  cp "$DEST/app/.env.example" "$DEST/app/.env"
  chmod 600 "$DEST/app/.env"
  ok "scaffolded app/.env from the example"
fi

# --- 5. next steps -----------------------------------------------------------
say ""
step "Baxter is installed at $DEST"
cat <<EOF

${B}Next steps${Z} -- Baxter needs a Discord bot and a model key (he can't guess those):

  1. Create a Discord application/bot and copy its ${B}token${Z}.
  2. Get an ${B}OpenRouter API key${Z} (https://openrouter.ai) -- Baxter's default brain.
  3. Edit ${B}$DEST/app/.env${Z}: set DISCORD_BOT_TOKEN and OPENROUTER_API_KEY.
  4. Start him:   ${B}baxter up${Z}       (then: ${B}baxter logs discord${Z})

If 'baxter' isn't found, add its bin dir to PATH (the CLI installer noted it above).
Full setup -- inviting the bot, the optional mail/voice surfaces, other model
backends -- is in $DEST/README.md.
EOF
