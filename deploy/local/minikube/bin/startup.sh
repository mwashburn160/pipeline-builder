#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - Minikube Startup (fast RESUME of a stopped cluster)
# =============================================================================
# Brings a previously-provisioned minikube cluster back up after `shutdown.sh`:
# resumes the VM (all /data preserved), waits for pods, and re-establishes the
# host port-forwards. It deliberately does NOT re-install the Istio mesh / KEDA
# or re-apply the k8s manifests — those persist across stop/start — so it's much
# faster than a full setup.
#
# The three lifecycle scripts (mirroring the aws/ec2 target):
#   setup.sh     — first-time provision: CREATE the cluster + install mesh/KEDA +
#                  apply manifests (also the RECREATE path; prompts before wiping)
#   startup.sh   — this: RESUME an existing (stopped) cluster + reconnect forwards
#   shutdown.sh  — graceful `minikube stop` (preserves data + cluster state)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$(cd "$SCRIPT_DIR/../../../bin" && pwd)"   # deploy/bin (shared helpers)
NAMESPACE="pipeline-builder"
PROFILE="pipeline-builder"
ENV_FILE="$DEPLOY_DIR/.env"
MK_PROFILE_DIR="${MINIKUBE_HOME:-$HOME/.minikube}/profiles/$PROFILE"

# Shared helpers (preflight). Sourcing common.sh cd's to /tmp — every path above
# is absolute, so that's safe.
# shellcheck source=../../../bin/common.sh
. "$BIN_DIR/common.sh"

log() { echo ""; echo "=== $1 ==="; }

preflight minikube kubectl

# No cluster yet → this is a first-time bring-up, not a resume. Point at setup.sh
# rather than silently creating one here (create belongs to setup, with its sizing
# flags + RECREATE prompt).
if [ ! -f "$MK_PROFILE_DIR/config.json" ]; then
  echo "ERROR: no '$PROFILE' minikube cluster found — nothing to resume." >&2
  echo "       Provision it first: deploy/local/minikube/bin/setup.sh" >&2
  exit 1
fi

port_forward() {
  local name="$1" svc="$2" ports="$3"
  kubectl port-forward "svc/$svc" "$ports" -n "$NAMESPACE" >/dev/null 2>&1 &
  local pid=$!; sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $name → $ports (PID $pid)"
  else
    echo "  WARNING: $name port-forward failed"
  fi
}

# -- Resume the cluster -------------------------------------------------------
# No sizing flags on a resume (create-only; passing them can force a rebuild that
# wipes /data — see setup.sh). This just restarts the stopped VM with its data.
log "Resuming Minikube (data preserved)"
minikube start --profile="$PROFILE"

log "Waiting for cluster"
for i in $(seq 1 30); do
  kubectl cluster-info >/dev/null 2>&1 && break
  [ "$i" = "30" ] && { echo "ERROR: API server not reachable" >&2; exit 1; }
  sleep 1
done

# -- Wait for pods ------------------------------------------------------------
log "Waiting for pods"
kubectl wait --for=condition=Ready pod -l app=postgres -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  postgres not ready"
kubectl wait --for=condition=Ready pod -l app=mongodb  -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  mongodb not ready"
kubectl wait --for=condition=Ready pod -l app -n "$NAMESPACE" --timeout=300s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=nginx -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  nginx not ready"

echo ""
kubectl get pods -n "$NAMESPACE" -o wide

# -- Port-forwards ------------------------------------------------------------
log "Starting port-forwards"
pkill -f "kubectl port-forward.*-n $NAMESPACE" 2>/dev/null || true
sleep 1

# Gateway: HTTPS 8443 only (see the setup.sh note on why 8080 isn't bound here).
port_forward "Nginx" nginx "8443:8443"
# Admin UIs only when actually deployed (skipped under a LEAN provision).
if kubectl get svc mongo-express -n "$NAMESPACE" >/dev/null 2>&1; then
  port_forward "Mongo Express" mongo-express "8081:8081"
fi
if kubectl get svc pgadmin -n "$NAMESPACE" >/dev/null 2>&1; then
  port_forward "pgAdmin" pgadmin "5480:80"
fi

# Verify gateway
for i in $(seq 1 5); do
  curl -sk -o /dev/null https://localhost:8443/health 2>/dev/null && { echo "  Gateway reachable"; break; }
  [ "$i" = "5" ] && echo "  WARNING: Gateway not reachable"
  sleep 2
done

# -- Summary ------------------------------------------------------------------
MK_IP=$(minikube ip --profile="$PROFILE" 2>/dev/null || echo "unknown")

log "Startup Complete — Minikube"
echo ""
echo "  Platform UI / API : https://localhost:8443       (NodePort: https://$MK_IP:30443)"
echo "  Credentials live in $ENV_FILE."
echo ""
echo "  Dev tools           port-forward (localhost)      NodePort (minikube):"
echo "    Mongo Express   : http://localhost:8081         http://$MK_IP:30081"
echo "    pgAdmin         : http://localhost:5480         http://$MK_IP:30480"
echo ""
echo "  Shutdown (preserve data): deploy/local/minikube/bin/shutdown.sh"
echo "  Stop port-forwards      : pkill -f 'kubectl port-forward.*-n $NAMESPACE'"
