#!/bin/sh
set -eu

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

# Ensure MongoDB keyfile has correct permissions
KEYFILE="$DEPLOY_DIR/mongodb-keyfile"
if [ -f "$KEYFILE" ]; then
  chmod 400 "$KEYFILE"
fi

# Ensure local data directories exist (host-side mount source)
mkdir -p "$DATA_DIR/db-data/postgres" "$DATA_DIR/db-data/mongodb" \
         "$DATA_DIR/db-data/grafana" "$DATA_DIR/db-data/loki" \
         "$DATA_DIR/db-data/prometheus" \
         "$DATA_DIR/registry-data" "$DATA_DIR/pgadmin-data"

# Docker build temp dir — must be under /mnt/data so both the pod
# and BuildKit (on the minikube node) can access the same path.
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-/mnt/data/tmp}"
mkdir -p "$DATA_DIR/tmp"

echo ""
echo "=== Cleaning up stale Docker state (if any) ==="
if docker inspect "$PROFILE" >/dev/null 2>&1; then
  # Check if the container references networks that no longer exist
  _has_stale_net=false
  for net_id in $(docker inspect "$PROFILE" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null); do
    if ! docker network inspect "$net_id" >/dev/null 2>&1; then
      _has_stale_net=true
      echo "  Container references missing network $net_id"
    fi
  done
  # If stale networks are embedded in the container config, the container is
  # unrecoverable — remove it so minikube can recreate it cleanly.
  if $_has_stale_net; then
    echo "  Removing container with stale network references..."
    docker rm -f "$PROFILE" 2>/dev/null || true
  fi
fi
docker network rm "$PROFILE" 2>/dev/null || true
docker network prune -f >/dev/null 2>&1 || true

echo ""
echo "=== Starting Minikube ==="
echo "  Mounting $DATA_DIR -> /mnt/data"
if ! minikube start \
  --profile="$PROFILE" \
  --cpus=6 \
  --memory=7839 \
  --disk-size=30g \
  --driver=docker \
  --mount --mount-string="$DATA_DIR:/mnt/data"; then

  echo ""
  echo "  Start failed — deleting stale profile and retrying..."
  minikube delete --profile="$PROFILE" 2>/dev/null || true
  docker rm -f "$PROFILE" 2>/dev/null || true
  docker network rm "$PROFILE" 2>/dev/null || true
  docker network prune -f >/dev/null 2>&1 || true

  minikube start \
    --profile="$PROFILE" \
    --cpus=6 \
    --memory=7839 \
    --disk-size=30g \
    --driver=docker \
    --mount --mount-string="$DATA_DIR:/mnt/data"
fi

echo ""
echo "=== Waiting for API server to be reachable ==="
_api_retries=0
_api_max=30
while [ "$_api_retries" -lt "$_api_max" ]; do
  if kubectl cluster-info >/dev/null 2>&1; then
    echo "  API server is ready"
    break
  fi
  _api_retries=$((_api_retries + 1))
  if [ "$_api_retries" = "$_api_max" ]; then
    echo "  ERROR: API server not reachable after ${_api_max}s" >&2
    exit 1
  fi
  sleep 1
done

echo ""
echo "=== Waiting for node to be ready ==="
kubectl wait --for=condition=Ready node/"$PROFILE" --timeout=120s

echo ""
echo "=== Enabling addons ==="
# default-storageclass and storage-provisioner are enabled by default in minikube
minikube addons enable metrics-server --profile="$PROFILE"

echo ""
echo "=== Installing KEDA (queue-based autoscaling) ==="
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.16.1/keda-2.16.1.yaml
kubectl wait --for=condition=Available deployment/keda-operator -n keda --timeout=120s 2>/dev/null || echo "  WARNING: KEDA operator not ready yet (will retry in background)"
echo "  KEDA installed"

echo ""
echo "=== Ensuring namespace exists ==="
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "=== Creating app-env ConfigMap from .env ==="
# Process .env: remove comments/empty lines, expand variable references
CLEAN_ENV=$(mktemp -t "app-env.XXXXXX")
FILTERED=$(mktemp -t "filtered.XXXXXX")
trap 'rm -f "$CLEAN_ENV" "$FILTERED"' EXIT
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
# Resolve token from ~/.npmrc (npm.pkg.github.com authToken)
GHCR_TOKEN=""
if [ -f "$HOME/.npmrc" ]; then
  GHCR_TOKEN=$(grep '//npm.pkg.github.com/:_authToken=' "$HOME/.npmrc" 2>/dev/null | sed 's/.*_authToken=//' || true)
fi
GHCR_USER="${GHCR_USER:-mwashburn160}"
if [ -n "$GHCR_TOKEN" ]; then
  kubectl create secret docker-registry ghcr-secret \
    --docker-server=ghcr.io \
    --docker-username="$GHCR_USER" \
    --docker-password="$GHCR_TOKEN" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl patch sa default -n "$NAMESPACE" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  echo "  ghcr-secret created/updated (default SA patched)"
else
  echo "  WARNING: No GHCR token found (set GHCR_TOKEN or configure ~/.npmrc)"
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
  --from-file=init.sql="$DEPLOY_DIR/postgres-init.sql" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  postgres-init ConfigMap created/updated"

echo ""
echo "=== Creating MongoDB init ConfigMap & keyfile Secret ==="
kubectl create configmap mongodb-init \
  --from-file=mongo-init.js="$DEPLOY_DIR/mongodb-init.js" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  mongodb-init ConfigMap created/updated"

kubectl create secret generic mongodb-keyfile \
  --from-file=mongodb-keyfile="$DEPLOY_DIR/mongodb-keyfile" \
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
       echo '"$REGISTRY_IP"' registry | sudo tee -a /etc/hosts > /dev/null"
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
echo "=== Waiting for nginx gateway (up to 3 min) ==="
kubectl wait --for=condition=Ready pod -l app=nginx -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  WARNING: nginx not ready yet"

echo ""
echo "=== Starting port-forward (background) ==="
# Kill any existing port-forwards for this namespace
pkill -f "kubectl port-forward.*-n $NAMESPACE" 2>/dev/null || true
sleep 1

# Helper: start a port-forward and verify it's working
start_port_forward() {
  local name="$1" svc="$2" ports="$3"
  kubectl port-forward "svc/$svc" $ports -n "$NAMESPACE" >/dev/null 2>&1 &
  local pid=$!
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $name: port-forward started (PID $pid)"
  else
    echo "  WARNING: $name port-forward failed — retrying..."
    kubectl port-forward "svc/$svc" $ports -n "$NAMESPACE" >/dev/null 2>&1 &
    pid=$!
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      echo "  $name: port-forward started on retry (PID $pid)"
    else
      echo "  ERROR: $name port-forward failed"
    fi
  fi
  eval "PF_${name}=$pid"
}

# API Gateway (nginx) — forwards localhost:8443 → nginx:8443 and localhost:8080 → nginx:8080
start_port_forward NGINX nginx "8443:8443 8080:8080"

# Grafana
start_port_forward GRAFANA grafana "3200:3000"

# Mongo Express
start_port_forward MONGO_EXPRESS mongo-express "8081:8081"

# pgAdmin
start_port_forward PGADMIN pgadmin "5480:80"

# Registry UI
start_port_forward REGISTRY_UI registry-express "5580:80"

# Verify gateway is reachable
echo ""
echo "  Verifying gateway..."
RETRIES=0
while [ $RETRIES -lt 5 ]; do
  if curl -sk -o /dev/null -w '' https://localhost:8443/health 2>/dev/null; then
    echo "  Gateway is reachable at https://localhost:8443"
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 2
done
if [ $RETRIES -eq 5 ]; then
  echo "  WARNING: Gateway not reachable at https://localhost:8443 — check port-forward"
fi

echo ""
echo "=== Access URLs ==="
MINIKUBE_IP=$(minikube ip --profile="$PROFILE")
echo ""
echo "  Via port-forward (localhost):"
echo "    API Gateway (HTTPS): https://localhost:8443"
echo "    API Gateway (HTTP):  http://localhost:8080"
echo "    Grafana:             http://localhost:3200"
echo "    Mongo Express:       http://localhost:8081"
echo "    pgAdmin:             http://localhost:5480"
echo "    Registry UI:         http://localhost:5580"
echo ""
echo "  Via NodePort (minikube IP):"
echo "    API Gateway (HTTPS): https://$MINIKUBE_IP:30443"
echo "    API Gateway (HTTP):  http://$MINIKUBE_IP:30080"
echo "    Grafana:             http://$MINIKUBE_IP:30200"
echo "    Mongo Express:       http://$MINIKUBE_IP:30081"
echo "    pgAdmin:             http://$MINIKUBE_IP:30480"
echo "    Registry UI:         http://$MINIKUBE_IP:30580"

echo ""
echo "=== Credentials (from .env) ==="
echo "  PostgreSQL:    $POSTGRES_USER / $POSTGRES_PASSWORD"
echo "  MongoDB:       $MONGO_INITDB_ROOT_USERNAME / $MONGO_INITDB_ROOT_PASSWORD"
echo "  Grafana:       admin / $GRAFANA_ADMIN_PASSWORD"
echo "  Mongo Express: $ME_CONFIG_BASICAUTH_USERNAME / $ME_CONFIG_BASICAUTH_PASSWORD"
echo "  pgAdmin:       $PGADMIN_DEFAULT_EMAIL / $PGADMIN_DEFAULT_PASSWORD"
echo "  Registry:      $IMAGE_REGISTRY_USER / $IMAGE_REGISTRY_TOKEN"

echo ""
echo "  To stop port-forwards: pkill -f 'kubectl port-forward.*-n $NAMESPACE'"
