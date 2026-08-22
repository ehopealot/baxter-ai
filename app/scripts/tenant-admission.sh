#!/bin/sh
# Fail closed for canonical /agents tenant runtime seams.
set -eu

# Admission cannot depend on caller-selected sh, grep, or node executables.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

mode=${1:-}
case "$mode" in service|foreground) ;; *) echo "tenant-admission: internal mode error" >&2; exit 2;; esac

env_path=${TENANT_ENV:-app/.env}
state_path=${TENANT_STATE:-}
id=${BAXTER_TENANT_ID:-}

resolved_env=$(/usr/bin/realpath -m -- "$env_path") || {
  echo "tenant-admission: cannot safely resolve TENANT_ENV" >&2
  exit 1
}
# An empty TENANT_STATE selects the standalone named volume and is not a path.
# Every supplied state path is canonicalized before fleet classification.
if [ -n "$state_path" ]; then
  resolved_state=$(/usr/bin/realpath -m -- "$state_path") || {
    echo "tenant-admission: cannot safely resolve TENANT_STATE" >&2
    exit 1
  }
else
  resolved_state=
fi

# Standalone app/.env + named-volume development is intentionally outside the
# fleet contract. If either spelling or resolved target enters /agents, both
# seams must be the exact, unchanged canonical pair; aliases cannot inherit
# fleet admission from their targets.
fleet_managed=0
for seam in "$env_path" "$state_path" "$resolved_env" "$resolved_state"; do
  case "$seam" in /agents|/agents/*) fleet_managed=1;; esac
done
[ "$fleet_managed" -eq 1 ] || exit 0

case "$env_path:$state_path" in
  /agents/*/app.env:/agents/*/state) ;;
  *) echo "tenant-admission: refusing noncanonical writable /agents seam; use systemctl/baxctl" >&2; exit 1;;
esac
[ "$resolved_env" = "$env_path" ] && [ "$resolved_state" = "$state_path" ] || {
  echo "tenant-admission: refusing noncanonical writable /agents seam; use systemctl/baxctl" >&2
  exit 1
}

env_id=${env_path#/agents/}; env_id=${env_id%/app.env}
state_id=${state_path#/agents/}; state_id=${state_id%/state}
case "$env_id" in ""|*[!a-z0-9-]*|-*|*-) echo "tenant-admission: invalid canonical tenant id" >&2; exit 1;; esac
[ "$env_id" = "$state_id" ] && [ "$id" = "$env_id" ] || {
  echo "tenant-admission: BAXTER_TENANT_ID, TENANT_ENV, and TENANT_STATE disagree" >&2; exit 1;
}
[ "${PROJECT:-}" = "baxter-$id" ] || { echo "tenant-admission: canonical PROJECT mismatch" >&2; exit 1; }

if [ "$mode" = service ]; then
  grep -Eq "(^|/)baxter@${id}\\.service([/[:space:]]|$)" /proc/self/cgroup || {
    echo "tenant-admission: canonical detached runtime must run in baxter@${id}.service after quota preflight; use systemctl/baxctl" >&2
    exit 1
  }
  exit 0
fi

[ "${BAXTER_SHELL_OPERATION:-}" = shell ] || { echo "tenant-admission: canonical foreground target requires sudo baxctl shell" >&2; exit 1; }
transaction=${BAXTER_SHELL_TRANSACTION:-}
case "$transaction" in ""|*[!A-Za-z0-9._-]*) echo "tenant-admission: invalid shell transaction" >&2; exit 1;; esac
[ "${BAXTER_SHELL_CONTROL_ROOT:-}" = /var/lib/baxter-control/disk-quota ] || {
  echo "tenant-admission: noncanonical shell control root" >&2; exit 1;
}
fd=${BAXTER_OWNER_FENCE_FD:-}
case "$fd" in ""|*[!0-9]*) echo "tenant-admission: missing owner-fence descriptor" >&2; exit 1;; esac
[ -e "/proc/self/fd/$fd" ] || { echo "tenant-admission: owner-fence descriptor is closed" >&2; exit 1; }
metadata=$(/usr/bin/stat -Lc '%F:%u:%g:%a' "/proc/self/fd/$fd") || {
  echo "tenant-admission: owner-fence descriptor cannot be inspected" >&2; exit 1;
}
[ "$metadata" = "regular file:0:0:600" ] || {
  echo "tenant-admission: owner fence is not a regular root:root 0600 file" >&2; exit 1;
}

# Node is already required by every app target. Validate the actual inherited FD:
# regular root:root 0600, read-only, root-written identity, exact canonical seams
# and labels. An environment token or arbitrary/writable regular FD cannot pass.
node - "$fd" "$id" "$transaction" "$env_path" "$state_path" "${PROJECT:-}" <<'NODE'
const fs = require("node:fs");
const [fdText, tenant, transaction, envPath, statePath, project] = process.argv.slice(2);
const fd = Number(fdText);
const stat = fs.fstatSync(fd);
if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== 0o600) {
  throw new Error("owner fence is not a regular root:root 0600 file");
}
const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
const match = /^flags:\s+([0-7]+)$/m.exec(info);
if (!match || (parseInt(match[1], 8) & 3) !== 0) throw new Error("owner fence is not read-only");
const link = fs.readlinkSync(`/proc/self/fd/${fd}`);
if (!link.startsWith("/var/lib/baxter-control/disk-quota/fence-") || link.endsWith(" (deleted)")) {
  throw new Error("owner fence is outside the canonical control area");
}
const identity = JSON.parse(fs.readFileSync(fd, "utf8"));
if (identity.tenant !== tenant || identity.transactionId !== transaction || identity.operation !== "shell" ||
    identity.env !== envPath || identity.state !== statePath || identity.project !== project ||
    identity.labels?.["baxter.tenant"] !== tenant ||
    identity.labels?.["baxter.transaction"] !== transaction) {
  throw new Error("owner-fence identity does not match canonical shell handoff");
}
NODE
