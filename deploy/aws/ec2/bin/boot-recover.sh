#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - EC2 Boot Recovery (bring the cluster back after a stop)
# =============================================================================
# ExecStart of pipeline-minikube.service (installed by bootstrap.sh Phase 12).
# Its counterpart is bin/shutdown.sh, the unit's ExecStop.
#
# WHY THIS EXISTS: `aws ec2 stop-instances` / `start-instances` leaves the box
# with a minikube profile whose node VM is Stopped. Nothing else brings it back,
# so the ALB target stays 503 until someone SSHes in and runs startup.sh. This
# closes that loop.
#
# WHY IT IS A WRAPPER AND NOT JUST `ExecStart=startup.sh`: the unit has to be
# ACTIVE for its ExecStop to fire at halt, so it is started on the provisioning
# boot too — at which point Phase 9 has ALREADY run startup.sh and the cluster is
# up. Running it again there would be minutes of redundant work. The three states
# below are the whole job.
#
# Re-running startup.sh is SAFE by design: it resumes an existing profile rather
# than recreating it (and, with no tty, never prompts), jwt-keys.sh skips an
# existing keypair so registry tokens are not invalidated, and the manifests are
# declarative. It also re-derives the iptables DNAT bridge, which MUST happen —
# the minikube node's IP is not guaranteed to be the same after a restart, so the
# rule restored from /etc/sysconfig/iptables can point at an address nothing
# answers on.
# =============================================================================

PROFILE="pipeline-builder"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

[ "$(id -u)" = "0" ] || { echo "ERROR: run as root (sudo)" >&2; exit 1; }

echo "=== Pipeline Builder EC2 Boot Recovery ==="

# -- State 1: nothing provisioned yet ----------------------------------------
# A profile that does not exist is a fresh instance whose bootstrap has not
# finished (or failed). Creating a cluster here would race UserData and is not
# this unit's job — provisioning belongs to bootstrap.sh.
if ! sudo -u minikube minikube profile list 2>/dev/null | grep -q "$PROFILE"; then
  echo "  No '$PROFILE' profile — nothing to recover (bootstrap.sh owns provisioning)."
  exit 0
fi

# -- State 2: already running -------------------------------------------------
# The provisioning boot, or a `systemctl restart` of the unit. Gate on the HOST
# field rather than `minikube status`'s exit code: that code is non-zero whenever
# ANY component is unhealthy, so a wedged apiserver on a running node would look
# like "stopped" and send us into a redundant startup.sh.
MK_HOST=$(sudo -u minikube minikube status --profile="$PROFILE" --format='{{.Host}}' 2>/dev/null || true)
MK_HOST="$(printf '%s' "$MK_HOST" | tr -d '[:space:]')"
if [ "$MK_HOST" = "Running" ]; then
  echo "  Node VM already running — nothing to recover."
  exit 0
fi

# -- State 3: stopped, so resume ----------------------------------------------
# LEAN is read from .env (bootstrap.sh Phase 9 persists it there) — startup.sh
# sources that file itself, so the deployment keeps the shape it was provisioned
# with instead of silently widening to the full manifest set on a lean box.
echo "  Node VM is '${MK_HOST:-unknown}' — resuming via startup.sh…"
exec bash "${DEPLOY_DIR}/bin/startup.sh"
