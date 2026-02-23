#!/bin/sh
set -e

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEPLOY_DIR/config"
CERT_DIR="$DEPLOY_DIR/certs"
NAMESPACE="pipeline-builder"
PROFILE="pipeline-builder"

if [ ! -d ./db-data/mongodb ]; then
  mkdir -p ./db-data/mongodb/  
fi
if [ ! -d ./db-data/postgres ]; then
  mkdir -p ./db-data/postgres/  
fi
if [ ! -d ./registry-data ]; then
  mkdir -p ./registry-data   
fi
if [ ! -d ./pgadmin-data ]; then
  mkdir -p ./pgadmin-data   
fi

echo "=== Starting Minikube ==="
minikube start \
  --profile="$PROFILE" \
  --cpus=6 \
  --memory=7839 \
  --disk-size=30g \
  --driver=docker \
  --addons=default-storageclass,storage-provisioner,metrics-server

echo ""
echo "=== Waiting for cluster to be ready ==="
kubectl wait --for=condition=Ready node/"$PROFILE" --timeout=120s

echo ""
echo "=== Ensuring namespace exists ==="
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "=== Generating TLS certificates (if needed) ==="
mkdir -p "$CERT_DIR"

# Nginx TLS
if ! kubectl get secret nginx-tls-secret -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "  Generating self-signed nginx TLS certificate..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/nginx.key" -out "$CERT_DIR/nginx.crt" \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
  kubectl create secret tls nginx-tls-secret \
    --cert="$CERT_DIR/nginx.crt" --key="$CERT_DIR/nginx.key" \
    -n "$NAMESPACE"
  echo "  nginx TLS certificate created"
else
  echo "  nginx TLS certificate already exists"
fi

# Registry TLS
if ! kubectl get secret registry-tls-secret -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "  Generating self-signed registry TLS certificate..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/registry.key" -out "$CERT_DIR/registry.crt" \
    -subj "/CN=registry" -addext "subjectAltName=DNS:registry,DNS:localhost" 2>/dev/null
  kubectl create secret tls registry-tls-secret \
    --cert="$CERT_DIR/registry.crt" --key="$CERT_DIR/registry.key" \
    -n "$NAMESPACE"
  echo "  registry TLS certificate created"
else
  echo "  registry TLS certificate already exists"
fi

# Registry htpasswd auth
if ! kubectl get secret registry-auth-secret -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "  Generating registry htpasswd..."
  if command -v htpasswd >/dev/null 2>&1; then
    htpasswd -Bbn admin password > "$CERT_DIR/registry.passwd"
  else
    docker run --rm --entrypoint htpasswd httpd:2 -Bbn admin password > "$CERT_DIR/registry.passwd"
  fi
  kubectl create secret generic registry-auth-secret \
    --from-file=registry.passwd="$CERT_DIR/registry.passwd" \
    -n "$NAMESPACE"
  echo "  registry auth secret created"
else
  echo "  registry auth secret already exists"
fi

echo ""
echo "=== Creating data directories on minikube node ==="
minikube ssh --profile="$PROFILE" -- "sudo mkdir -p /mnt/data/postgres /mnt/data/mongodb /mnt/data/grafana /mnt/data/loki /mnt/data/prometheus /mnt/data/registry /mnt/data/pgadmin && sudo chmod 777 /mnt/data/postgres /mnt/data/mongodb /mnt/data/grafana /mnt/data/loki /mnt/data/prometheus /mnt/data/registry /mnt/data/pgadmin"

echo ""
echo "=== Applying Kubernetes manifests ==="
kubectl apply -k "$CONFIG_DIR"

echo ""
echo "=== Waiting for databases to be ready (up to 3 min) ==="
kubectl wait --for=condition=Ready pod -l app=postgres -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  postgres not ready yet"
kubectl wait --for=condition=Ready pod -l app=mongodb -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  mongodb not ready yet"

echo ""
echo "=== Waiting for application pods (up to 5 min) ==="
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/part-of=pipeline-builder -n "$NAMESPACE" --timeout=300s 2>/dev/null || true

echo ""
echo "=== Pod Status ==="
kubectl get pods -n "$NAMESPACE" -o wide

echo ""
echo "=== Services ==="
kubectl get svc -n "$NAMESPACE"

echo ""
echo "=== Access URLs ==="
MINIKUBE_IP=$(minikube ip --profile="$PROFILE")
echo "  API Gateway (HTTPS): https://$MINIKUBE_IP:30443"
echo "  API Gateway (HTTP):  http://$MINIKUBE_IP:30080"
echo "  Grafana:             http://$MINIKUBE_IP:30200"
echo "  Mongo Express:       http://$MINIKUBE_IP:30081"
echo "  pgAdmin:             http://$MINIKUBE_IP:30480"
echo "  Registry UI:         http://$MINIKUBE_IP:30580"
