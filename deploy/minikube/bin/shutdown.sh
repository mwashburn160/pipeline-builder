#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - Minikube Shutdown
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K8S_DIR="$DEPLOY_DIR/k8s"
NS="pipeline-builder"
PROFILE="pipeline-builder"

log() { echo ""; echo "=== $1 ==="; }

log "Stopping port-forwards"
pkill -f "kubectl port-forward.*-n $NS" 2>/dev/null || true

log "Removing Kubernetes resources"
kubectl delete -k "$K8S_DIR" --ignore-not-found 2>/dev/null || true

# Dynamic resources not in kustomize
kubectl delete configmap app-env postgres-init mongodb-init nginx-config nginx-njs \
  loki-config prometheus-config promtail-config \
  grafana-datasources grafana-dashboards-provisioning grafana-dashboards \
  -n "$NS" --ignore-not-found 2>/dev/null || true
kubectl delete secret jwt-secret postgres-secret mongodb-secret mongodb-keyfile \
  registry-secret mongo-express-secret pgadmin-secret grafana-secret ghcr-secret \
  nginx-tls-secret registry-tls-secret registry-auth-secret \
  -n "$NS" --ignore-not-found 2>/dev/null || true

log "Removing namespace"
kubectl delete namespace "$NS" --ignore-not-found 2>/dev/null || true

log "Stopping Minikube"
minikube stop --profile="$PROFILE" || true
docker network rm "$PROFILE" 2>/dev/null || true

echo ""
echo "=== Shutdown complete ==="
echo "  Restart: bash deploy/minikube/bin/startup.sh"
