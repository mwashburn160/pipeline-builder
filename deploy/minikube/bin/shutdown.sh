#!/bin/sh
set -eu

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K8S_DIR="$DEPLOY_DIR/k8s"
NAMESPACE="pipeline-builder"
PROFILE="pipeline-builder"

echo "=== Removing Kubernetes resources ==="
kubectl delete -k "$K8S_DIR" --ignore-not-found 2>/dev/null || true

# Clean up dynamically-created resources not managed by kustomize
echo ""
echo "=== Removing dynamically-created resources ==="
kubectl delete configmap app-env postgres-init mongodb-init nginx-config nginx-njs \
  loki-config prometheus-config promtail-config \
  grafana-datasources grafana-dashboards-provisioning grafana-dashboards \
  -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
kubectl delete secret jwt-secret postgres-secret mongodb-secret mongodb-keyfile \
  registry-secret mongo-express-secret pgadmin-secret grafana-secret ghcr-secret \
  nginx-tls-secret registry-tls-secret registry-auth-secret \
  -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
echo "  ConfigMaps and Secrets removed"

echo ""
echo "=== Removing namespace ==="
kubectl delete namespace "$NAMESPACE" --ignore-not-found 2>/dev/null || true

echo ""
echo "=== Stopping Minikube (profile: $PROFILE) ==="
minikube stop --profile="$PROFILE"

echo ""
echo "=== Deleting Minikube cluster (profile: $PROFILE) ==="
minikube delete --profile="$PROFILE" --purge

echo ""
echo "=== Removing Docker network ==="
docker network rm "$PROFILE" 2>/dev/null || true

echo ""
echo "=== Shutdown complete ==="
