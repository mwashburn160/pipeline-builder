#!/bin/sh
set -e

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEPLOY_DIR/config"

echo "=== Starting Minikube ==="
minikube start \
  --cpus=6 \
  --memory=10240 \
  --disk-size=30g \
  --driver=docker \
  --addons=default-storageclass,storage-provisioner,metrics-server

echo ""
echo "=== Waiting for cluster to be ready ==="
kubectl wait --for=condition=Ready node/minikube --timeout=120s

echo ""
echo "=== Applying Kubernetes manifests ==="
kubectl apply -k "$CONFIG_DIR"

echo ""
echo "=== Waiting for databases to be ready (up to 3 min) ==="
kubectl wait --for=condition=Ready pod -l app=postgres -n pipeline-builder --timeout=180s 2>/dev/null || echo "  postgres not ready yet"
kubectl wait --for=condition=Ready pod -l app=mongodb -n pipeline-builder --timeout=180s 2>/dev/null || echo "  mongodb not ready yet"

echo ""
echo "=== Waiting for application pods (up to 5 min) ==="
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/part-of=pipeline-builder -n pipeline-builder --timeout=300s 2>/dev/null || true

echo ""
echo "=== Pod Status ==="
kubectl get pods -n pipeline-builder -o wide

echo ""
echo "=== Services ==="
kubectl get svc -n pipeline-builder

echo ""
echo "=== Access URLs ==="
MINIKUBE_IP=$(minikube ip)
echo "  API Gateway (HTTPS): https://$MINIKUBE_IP:30443"
echo "  API Gateway (HTTP):  http://$MINIKUBE_IP:30080"
echo "  Grafana:             http://$MINIKUBE_IP:30200"
echo "  Mongo Express:       http://$MINIKUBE_IP:30081"
echo "  pgAdmin:             http://$MINIKUBE_IP:30480"
echo "  Registry UI:         http://$MINIKUBE_IP:30580"