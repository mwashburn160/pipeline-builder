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
# ASK_MODEL=1 — enable the self-hosted Ask model on an ALREADY-PROVISIONED
# cluster, without a full re-provision. Additive and idempotent: it applies
# k8s/ask-model.yaml, adds the OPENAI_COMPATIBLE_* keys to the app-env ConfigMap
# the ask service already reads, and restarts ask to pick them up.
#
# (LEAN is a PROVISION-time choice — what setup.sh applied — so it has no effect
# here; a warning below says so rather than letting it look honoured.)
ASK_MODEL="${ASK_MODEL:-0}"

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

# Re-apply the inotify limits (sysctl -w doesn't survive `minikube stop`). Without
# this, promtail fails on resume with "too many open files" once the pod count
# rebuilds. Mirrors the setup.sh block.
minikube ssh --profile="$PROFILE" -- "sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288" >/dev/null 2>&1 || true

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
# Mirrors the hardened wait in setup.sh: `-l app` is an EXISTENCE selector, so it
# also matches one-shot Job pods (minio-init), whose Ready condition stays
# False/PodCompleted forever — without the phase filter this could never be
# satisfied and always burned the full 300s, silently, because `|| true` swallowed
# it. ask-model is excluded too: its startupProbe holds the pod NotReady until the
# model is pulled (~1GB on first run), which nothing else here depends on.
kubectl wait --for=condition=Ready pod -l 'app,app!=ask-model' -n "$NAMESPACE" \
  --field-selector=status.phase!=Succeeded --timeout=300s 2>/dev/null || true
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

# -- Optional: self-hosted Ask model ------------------------------------------
# Placed AFTER the port-forwards, and gated on istiod, for two reasons learned
# the hard way: `ask-model.yaml` contains an Istio AuthorizationPolicy, whose
# CREATE calls istiod's validating webhook — on a fresh resume istiod is not
# listening yet, so an earlier apply died with
#   failed calling webhook "validation.istio.io" ... connection refused
# and, under `set -e`, took the rest of startup (including the port-forwards)
# with it. Running last means a failure here costs only this feature.
if [ "$ASK_MODEL" = "1" ]; then
  log "Enabling the self-hosted Ask model (ASK_MODEL=1)"
  echo "  waiting for istiod (its webhook validates the AuthorizationPolicy)..."
  if ! kubectl wait --for=condition=Available deployment/istiod -n istio-system --timeout=180s >/dev/null 2>&1; then
    echo "  ERROR: istiod did not become Available; ask-model NOT enabled." >&2
    echo "         Re-run once the mesh is up: ASK_MODEL=1 $0" >&2
    exit 1
  fi
  kubectl apply -n "$NAMESPACE" -f "$DEPLOY_DIR/k8s/ask-model.yaml"
  # `ask` reads app-env via envFrom, so patching the ConfigMap is all the
  # service needs — no manifest edit. Merge-patch keeps every other key.
  kubectl patch configmap app-env -n "$NAMESPACE" --type merge -p \
    '{"data":{"OPENAI_COMPATIBLE_BASE_URL":"http://ask-model:11434/v1","OPENAI_COMPATIBLE_MODELS":"qwen2.5-coder:1.5b|Qwen 2.5 Coder"}}' >/dev/null
  # envFrom values are injected at pod START — an existing ask pod keeps the old
  # (absent) env until it is replaced.
  kubectl rollout restart deployment/ask -n "$NAMESPACE" >/dev/null
  echo "  ask-model applied; ask restarted. First start pulls the model (~1GB);"
  echo "  the pod stays NotReady until the model is actually present (startupProbe)."
fi
if [ "${LEAN:-}" = "1" ]; then
  echo "  NOTE: LEAN only applies at provision time (setup.sh) — ignoring it here."
fi

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
