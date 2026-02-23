#!/bin/sh
set -e

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEPLOY_DIR/config"
K8S_DIR="$DEPLOY_DIR/k8s"
NGINX_DIR="$DEPLOY_DIR/nginx"
CERT_DIR="$DEPLOY_DIR/certs"
AUTH_DIR="$DEPLOY_DIR/auth"
NAMESPACE="pipeline-builder"
PROFILE="pipeline-builder"
DATA_DIR="$DEPLOY_DIR/data"

# -----------------------------------------------------------------------
# Load environment variables from .env
# Precedence: deploy/minikube/.env > deploy/local/.env
# -----------------------------------------------------------------------
ENV_FILE=""
if [ -f "$DEPLOY_DIR/.env" ]; then
  ENV_FILE="$DEPLOY_DIR/.env"
elif [ -f "$DEPLOY_DIR/../local/.env" ]; then
  ENV_FILE="$(cd "$DEPLOY_DIR/../local" && pwd)/.env"
fi

if [ -n "$ENV_FILE" ]; then
  echo "=== Loading environment from $ENV_FILE ==="
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "ERROR: No .env file found at $DEPLOY_DIR/.env or deploy/local/.env"
  exit 1
fi

# Ensure local data directories exist (host-side mount source)
mkdir -p "$DATA_DIR/db-data/postgres" "$DATA_DIR/db-data/mongodb" \
         "$DATA_DIR/db-data/grafana" "$DATA_DIR/db-data/loki" \
         "$DATA_DIR/db-data/prometheus" \
         "$DATA_DIR/registry-data" "$DATA_DIR/pgadmin-data"

echo ""
echo "=== Cleaning up stale Docker network (if any) ==="
docker network rm "$PROFILE" 2>/dev/null || true

echo ""
echo "=== Starting Minikube ==="
echo "  Mounting $DATA_DIR -> /mnt/data"
minikube start \
  --profile="$PROFILE" \
  --cpus=6 \
  --memory=7839 \
  --disk-size=30g \
  --driver=docker \
  --mount --mount-string="$DATA_DIR:/mnt/data"

echo ""
echo "=== Waiting for cluster to be ready ==="
kubectl wait --for=condition=Ready node/"$PROFILE" --timeout=120s

echo ""
echo "=== Enabling addons ==="
# default-storageclass and storage-provisioner are enabled by default in minikube
minikube addons enable metrics-server --profile="$PROFILE"

echo ""
echo "=== Ensuring namespace exists ==="
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "=== Creating app-env ConfigMap from .env ==="
# Process .env: remove comments/empty lines, expand variable references
CLEAN_ENV=$(mktemp -t "app-env.XXXXXX")
FILTERED=$(mktemp -t "filtered.XXXXXX")
grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' > "$FILTERED"
while IFS='=' read -r key value; do
  # Use the shell-expanded value (already sourced via set -a)
  eval "expanded=\${$key}"
  printf '%s=%s\n' "$key" "$expanded"
done < "$FILTERED" > "$CLEAN_ENV"
rm -f "$FILTERED"
kubectl create configmap app-env \
  --from-env-file="$CLEAN_ENV" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
rm -f "$CLEAN_ENV"
echo "  app-env ConfigMap created/updated"

echo ""
echo "=== Creating secrets from .env values ==="

# JWT secrets
kubectl create secret generic jwt-secret \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  jwt-secret created/updated"

# PostgreSQL secrets
kubectl create secret generic postgres-secret \
  --from-literal=POSTGRES_USER="$POSTGRES_USER" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=DB_USER="$DB_USER" \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  postgres-secret created/updated"

# MongoDB secrets
kubectl create secret generic mongodb-secret \
  --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" \
  --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" \
  --from-literal=MONGODB_URI="$MONGODB_URI" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  mongodb-secret created/updated"

# Registry secrets
kubectl create secret generic registry-secret \
  --from-literal=IMAGE_REGISTRY_USER="$IMAGE_REGISTRY_USER" \
  --from-literal=IMAGE_REGISTRY_TOKEN="$IMAGE_REGISTRY_TOKEN" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  registry-secret created/updated"

# Mongo Express secrets
kubectl create secret generic mongo-express-secret \
  --from-literal=ME_CONFIG_BASICAUTH_USERNAME="$ME_CONFIG_BASICAUTH_USERNAME" \
  --from-literal=ME_CONFIG_BASICAUTH_PASSWORD="$ME_CONFIG_BASICAUTH_PASSWORD" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  mongo-express-secret created/updated"

# pgAdmin secrets
kubectl create secret generic pgadmin-secret \
  --from-literal=PGADMIN_DEFAULT_EMAIL="$PGADMIN_DEFAULT_EMAIL" \
  --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_DEFAULT_PASSWORD" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  pgadmin-secret created/updated"

# Grafana secrets
kubectl create secret generic grafana-secret \
  --from-literal=GF_SECURITY_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  grafana-secret created/updated"

# GHCR image pull secret (for pulling app images from ghcr.io)
if [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
  kubectl create secret docker-registry ghcr-secret \
    --docker-server=ghcr.io \
    --docker-username="$GHCR_USER" \
    --docker-password="$GHCR_TOKEN" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl patch sa default -n "$NAMESPACE" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  echo "  ghcr-secret created/updated (default SA patched)"
else
  echo "  GHCR_USER/GHCR_TOKEN not set — skipping ghcr-secret"
fi

echo ""
echo "=== Generating TLS certificates ==="
mkdir -p "$CERT_DIR"
mkdir -p "$AUTH_DIR"

# Nginx TLS
echo "  Generating self-signed nginx TLS certificate..."
if ! openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "$CERT_DIR/nginx.key" -out "$CERT_DIR/nginx.crt" \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>&1; then
  echo "ERROR: Failed to generate nginx TLS certificate" >&2
  exit 1
fi
kubectl create secret tls nginx-tls-secret \
  --cert="$CERT_DIR/nginx.crt" --key="$CERT_DIR/nginx.key" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  nginx-tls-secret created/updated"

# Registry TLS
echo "  Generating self-signed registry TLS certificate..."
if ! openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "$CERT_DIR/registry.key" -out "$CERT_DIR/registry.crt" \
  -subj "/CN=registry" -addext "subjectAltName=DNS:registry,DNS:localhost" 2>&1; then
  echo "ERROR: Failed to generate registry TLS certificate" >&2
  exit 1
fi
kubectl create secret tls registry-tls-secret \
  --cert="$CERT_DIR/registry.crt" --key="$CERT_DIR/registry.key" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  registry-tls-secret created/updated"

# Registry htpasswd auth
echo "  Generating registry htpasswd..."
if command -v htpasswd >/dev/null 2>&1; then
  htpasswd -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
else
  docker run --rm --entrypoint htpasswd httpd:2 -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
fi
kubectl create secret generic registry-auth-secret \
  --from-file=registry.passwd="$AUTH_DIR/registry.passwd" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  registry-auth-secret created/updated"

echo ""
echo "=== Creating PostgreSQL init ConfigMap ==="
kubectl create configmap postgres-init \
  --from-file=init.sql="$K8S_DIR/postgres-init.sql" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  postgres-init ConfigMap created/updated"

echo ""
echo "=== Creating MongoDB init ConfigMap & keyfile Secret ==="
kubectl create configmap mongodb-init \
  --from-file=mongo-init.js="$K8S_DIR/mongodb-init.js" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  mongodb-init ConfigMap created/updated"

kubectl create secret generic mongodb-keyfile \
  --from-file=mongodb-keyfile="$K8S_DIR/mongodb-keyfile" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  mongodb-keyfile Secret created/updated"

echo ""
echo "=== Creating Nginx ConfigMaps ==="
kubectl create configmap nginx-config \
  --from-file=nginx.conf="$NGINX_DIR/nginx.conf" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  nginx-config ConfigMap created/updated"

kubectl create configmap nginx-njs \
  --from-file=jwt.js="$NGINX_DIR/jwt.js" \
  --from-file=metrics.js="$NGINX_DIR/metrics.js" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  nginx-njs ConfigMap created/updated"

echo ""
echo "=== Creating Observability ConfigMaps ==="
kubectl create configmap loki-config \
  --from-file=loki-config.yml="$CONFIG_DIR/loki/loki-config.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  loki-config ConfigMap created/updated"

kubectl create configmap prometheus-config \
  --from-file=prometheus.yml="$CONFIG_DIR/prometheus/prometheus.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  prometheus-config ConfigMap created/updated"

kubectl create configmap promtail-config \
  --from-file=promtail-config.yml="$CONFIG_DIR/promtail/promtail-config.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  promtail-config ConfigMap created/updated"

echo ""
echo "=== Creating Grafana ConfigMaps ==="
kubectl create configmap grafana-datasources \
  --from-file=loki.yml="$CONFIG_DIR/grafana/loki.yml" \
  --from-file=prometheus.yml="$CONFIG_DIR/grafana/prometheus.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  grafana-datasources ConfigMap created/updated"

kubectl create configmap grafana-dashboards-provisioning \
  --from-file=dashboards.yml="$CONFIG_DIR/grafana/dashboards.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  grafana-dashboards-provisioning ConfigMap created/updated"

kubectl create configmap grafana-dashboards \
  --from-file=service-logs.json="$CONFIG_DIR/grafana/service-logs.json" \
  --from-file=api-metrics.json="$CONFIG_DIR/grafana/api-metrics.json" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  grafana-dashboards ConfigMap created/updated"

echo ""
echo "=== Applying Kubernetes manifests ==="
kubectl apply -k "$K8S_DIR"

echo ""
echo "=== Patching minikube /etc/hosts for Docker registry access ==="
# BuildKit (docker-container driver with host network) runs on the minikube
# node and needs to resolve the 'registry' hostname. K8s DNS only serves
# pods, not the node itself, so we add an /etc/hosts entry mapping the
# registry Service ClusterIP.
REGISTRY_IP=$(kubectl get svc registry -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
if [ -n "$REGISTRY_IP" ]; then
  minikube ssh --profile="$PROFILE" -- \
    "grep -q '\\sregistry\$' /etc/hosts 2>/dev/null && \
       sudo sed -i 's/.*\\sregistry\$/'"$REGISTRY_IP"' registry/' /etc/hosts || \
       echo '$REGISTRY_IP registry' | sudo tee -a /etc/hosts > /dev/null"
  echo "  registry -> $REGISTRY_IP"
else
  echo "  WARNING: Could not get registry ClusterIP — plugin builds may fail"
fi

echo ""
echo "=== Waiting for databases to be ready (up to 3 min) ==="
kubectl wait --for=condition=Ready pod -l app=postgres -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  WARNING: postgres not ready yet"
kubectl wait --for=condition=Ready pod -l app=mongodb -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  WARNING: mongodb not ready yet"

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

echo ""
echo "=== Credentials (from .env) ==="
echo "  PostgreSQL:    $POSTGRES_USER / $POSTGRES_PASSWORD"
echo "  MongoDB:       $MONGO_INITDB_ROOT_USERNAME / $MONGO_INITDB_ROOT_PASSWORD"
echo "  Grafana:       admin / $GRAFANA_ADMIN_PASSWORD"
echo "  Mongo Express: $ME_CONFIG_BASICAUTH_USERNAME / $ME_CONFIG_BASICAUTH_PASSWORD"
echo "  pgAdmin:       $PGADMIN_DEFAULT_EMAIL / $PGADMIN_DEFAULT_PASSWORD"
echo "  Registry:      $IMAGE_REGISTRY_USER / $IMAGE_REGISTRY_TOKEN"
