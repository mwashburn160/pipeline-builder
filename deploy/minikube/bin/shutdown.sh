#!/bin/sh
set -e

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEPLOY_DIR/config"
PROFILE="pipeline-builder"

echo "=== Removing Kubernetes resources ==="
kubectl delete -k "$CONFIG_DIR" --ignore-not-found 2>/dev/null || true

echo ""
echo "=== Stopping Minikube (profile: $PROFILE) ==="
minikube stop --profile="$PROFILE"

echo ""
echo "=== Deleting Minikube cluster (profile: $PROFILE) ==="
minikube delete --profile="$PROFILE" --purge

echo ""
echo "=== Shutdown complete ==="
