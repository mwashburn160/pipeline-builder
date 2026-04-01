#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - Minikube Startup (local development)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$DEPLOY_DIR/config"
K8S_DIR="$DEPLOY_DIR/k8s"
NGINX_DIR="$DEPLOY_DIR/nginx"
CERT_DIR="$DEPLOY_DIR/certs"
AUTH_DIR="$DEPLOY_DIR/auth"
NS="pipeline-builder"
PROFILE="pipeline-builder"
DATA_DIR="$DEPLOY_DIR/data"

# -- Helpers ------------------------------------------------------------------

kube() { kubectl "$@" --dry-run=client -o yaml | kubectl apply -f -; }
log()  { echo ""; echo "=== $1 ==="; }

secret() {
  local name="$1"; shift
  kube create secret generic "$name" "$@" -n "$NS"
  echo "  $name"
}

configmap() {
  local name="$1"; shift
  kube create configmap "$name" "$@" -n "$NS"
  echo "  $name"
}

cleanup_docker() {
  docker rm -f "$PROFILE" 2>/dev/null || true
  docker network rm "$PROFILE" 2>/dev/null || true
  docker network prune -f >/dev/null 2>&1 || true
}

port_forward() {
  local name="$1" svc="$2" ports="$3"
  kubectl port-forward "svc/$svc" $ports -n "$NS" >/dev/null 2>&1 &
  local pid=$!; sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $name → $ports (PID $pid)"
  else
    echo "  WARNING: $name port-forward failed"
  fi
}

# -- Load .env ----------------------------------------------------------------

ENV_FILE=""
[ -f "$DEPLOY_DIR/.env" ] && ENV_FILE="$DEPLOY_DIR/.env"
[ -z "$ENV_FILE" ] && [ -f "$DEPLOY_DIR/../local/.env" ] && ENV_FILE="$(cd "$DEPLOY_DIR/../local" && pwd)/.env"
[ -z "$ENV_FILE" ] && { echo "ERROR: No .env found" >&2; exit 1; }

log "Loading environment from $ENV_FILE"
set -a; . "$ENV_FILE"; set +a

[ -f "$DEPLOY_DIR/mongodb-keyfile" ] && chmod 400 "$DEPLOY_DIR/mongodb-keyfile"
mkdir -p "$DATA_DIR"/{db-data/{postgres,mongodb,grafana,loki,prometheus,ollama},registry-data,pgadmin-data,tmp} 2>/dev/null || true
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-/mnt/data/tmp}"

# -- Clean stale Docker state ------------------------------------------------

log "Cleaning Docker state"
if docker inspect "$PROFILE" >/dev/null 2>&1; then
  for net in $(docker inspect "$PROFILE" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null); do
    docker network inspect "$net" >/dev/null 2>&1 || { echo "  Stale network — removing container"; cleanup_docker; break; }
  done
fi
docker network rm "$PROFILE" 2>/dev/null || true

# -- Start Minikube -----------------------------------------------------------

log "Detecting resources"
TOTAL_CPU=$(nproc)
TOTAL_MEM=$(($(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024))
MK_CPUS=$((TOTAL_CPU > 2 ? TOTAL_CPU - 1 : 2))
MK_MEM=$((TOTAL_MEM * 75 / 100))
echo "  System: ${TOTAL_CPU} CPUs, ${TOTAL_MEM}M → Minikube: ${MK_CPUS} CPUs, ${MK_MEM}M, 30g disk"

MK_ARGS=(--profile="$PROFILE" --cpus="$MK_CPUS" --memory="$MK_MEM" --disk-size=30g --driver=docker --mount --mount-string="$DATA_DIR:/mnt/data")

log "Starting Minikube"
if ! minikube start "${MK_ARGS[@]}"; then
  echo "  Retrying after cleanup..."
  minikube delete --profile="$PROFILE" 2>/dev/null || true
  cleanup_docker
  minikube start "${MK_ARGS[@]}"
fi

# -- Wait for cluster ---------------------------------------------------------

log "Waiting for cluster"
for i in $(seq 1 30); do
  kubectl cluster-info >/dev/null 2>&1 && break
  [ "$i" = "30" ] && { echo "ERROR: API server not reachable" >&2; exit 1; }
  sleep 1
done
kubectl wait --for=condition=Ready node/"$PROFILE" --timeout=120s
echo "  Cluster ready"

# -- Configure VM + addons ---------------------------------------------------

log "Enabling addons"
for addon in default-storageclass storage-provisioner metrics-server; do
  minikube addons enable "$addon" --profile="$PROFILE"
done

kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.16.1/keda-2.16.1.yaml
kubectl wait --for=condition=Available deployment/keda-operator -n keda --timeout=120s 2>/dev/null || echo "  KEDA not ready yet"
echo "  Addons + KEDA installed"

# -- Namespace + Secrets + ConfigMaps -----------------------------------------

log "Creating namespace + secrets + configmaps"
kube create namespace "$NS"

# app-env ConfigMap
CLEAN_ENV=$(mktemp); trap 'rm -f "$CLEAN_ENV"' EXIT
grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | while IFS='=' read -r key value; do
  eval "printf '%s=%s\n' \"\$key\" \"\${$key}\""
done > "$CLEAN_ENV"
configmap app-env --from-env-file="$CLEAN_ENV"
rm -f "$CLEAN_ENV"

# Secrets
secret jwt-secret        --from-literal=JWT_SECRET="$JWT_SECRET" --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET"
secret postgres-secret   --from-literal=POSTGRES_USER="$POSTGRES_USER" --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" --from-literal=DB_USER="$DB_USER" --from-literal=DB_PASSWORD="$DB_PASSWORD"
secret mongodb-secret    --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" --from-literal=MONGODB_URI="$MONGODB_URI"
secret registry-secret   --from-literal=IMAGE_REGISTRY_USER="$IMAGE_REGISTRY_USER" --from-literal=IMAGE_REGISTRY_TOKEN="$IMAGE_REGISTRY_TOKEN"
secret mongo-express-secret --from-literal=ME_CONFIG_BASICAUTH_USERNAME="$ME_CONFIG_BASICAUTH_USERNAME" --from-literal=ME_CONFIG_BASICAUTH_PASSWORD="$ME_CONFIG_BASICAUTH_PASSWORD"
secret pgadmin-secret    --from-literal=PGADMIN_DEFAULT_EMAIL="$PGADMIN_DEFAULT_EMAIL" --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_DEFAULT_PASSWORD"
secret grafana-secret    --from-literal=GF_SECURITY_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD"

# GHCR pull secret
GHCR_TOKEN="${GHCR_TOKEN:-}"
[ -z "$GHCR_TOKEN" ] && [ -f "$HOME/.npmrc" ] && GHCR_TOKEN=$(grep '//npm.pkg.github.com/:_authToken=' "$HOME/.npmrc" 2>/dev/null | sed 's/.*_authToken=//' || true)
if [ -n "$GHCR_TOKEN" ]; then
  GHCR_USER="${GHCR_USER:-mwashburn160}"
  kube create secret docker-registry ghcr-secret --docker-server=ghcr.io --docker-username="$GHCR_USER" --docker-password="$GHCR_TOKEN" -n "$NS"
  kubectl patch sa default -n "$NS" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  echo "  ghcr-secret"
fi

# -- TLS certificates --------------------------------------------------------

log "Creating TLS certificates"
mkdir -p "$CERT_DIR" "$AUTH_DIR"

openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout "$CERT_DIR/nginx.key" -out "$CERT_DIR/nginx.crt" \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>&1
kube create secret tls nginx-tls-secret --cert="$CERT_DIR/nginx.crt" --key="$CERT_DIR/nginx.key" -n "$NS"

openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout "$CERT_DIR/registry.key" -out "$CERT_DIR/registry.crt" \
  -subj "/CN=registry" -addext "subjectAltName=DNS:registry,DNS:localhost" 2>&1
kube create secret tls registry-tls-secret --cert="$CERT_DIR/registry.crt" --key="$CERT_DIR/registry.key" -n "$NS"

if command -v htpasswd >/dev/null 2>&1; then
  htpasswd -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
else
  docker run --rm --entrypoint htpasswd httpd:2 -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
fi
secret registry-auth-secret --from-file=registry.passwd="$AUTH_DIR/registry.passwd"
echo "  TLS + registry auth done"

# -- ConfigMaps ---------------------------------------------------------------

log "Creating ConfigMaps"
configmap postgres-init   --from-file=init.sql="$DEPLOY_DIR/postgres-init.sql"
configmap mongodb-init    --from-file=mongo-init.js="$DEPLOY_DIR/mongodb-init.js"
secret   mongodb-keyfile  --from-file=mongodb-keyfile="$DEPLOY_DIR/mongodb-keyfile"
configmap nginx-config    --from-file=nginx.conf="$NGINX_DIR/nginx.conf"
configmap nginx-njs       --from-file=jwt.js="$NGINX_DIR/jwt.js" --from-file=metrics.js="$NGINX_DIR/metrics.js"
configmap loki-config     --from-file=loki-config.yml="$CONFIG_DIR/loki/loki-config.yml"
configmap prometheus-config --from-file=prometheus.yml="$CONFIG_DIR/prometheus/prometheus.yml"
configmap promtail-config --from-file=promtail-config.yml="$CONFIG_DIR/promtail/promtail-config.yml"
configmap grafana-datasources --from-file=loki.yml="$CONFIG_DIR/grafana/loki.yml" --from-file=prometheus.yml="$CONFIG_DIR/grafana/prometheus.yml"
configmap grafana-dashboards-provisioning --from-file=dashboards.yml="$CONFIG_DIR/grafana/dashboards.yml"
configmap grafana-dashboards --from-file=service-logs.json="$CONFIG_DIR/grafana/service-logs.json" --from-file=api-metrics.json="$CONFIG_DIR/grafana/api-metrics.json" \
  --from-file=database-health.json="$CONFIG_DIR/grafana/database-health.json" --from-file=plugin-builds.json="$CONFIG_DIR/grafana/plugin-builds.json" \
  --from-file=business-metrics.json="$CONFIG_DIR/grafana/business-metrics.json" --from-file=compliance-metrics.json="$CONFIG_DIR/grafana/compliance-metrics.json" \
  --from-file=infrastructure.json="$CONFIG_DIR/grafana/infrastructure.json"

# -- Build strategy -----------------------------------------------------------

CURRENT_STRATEGY="${DOCKER_BUILD_STRATEGY:-docker}"
log "Plugin Build Strategy: $CURRENT_STRATEGY"
if [ -t 0 ]; then
  echo "  1) docker — dind sidecar (default)   2) podman — daemonless"
  read -rp "  Select [1-2] or Enter to keep '$CURRENT_STRATEGY': " choice
  case "$choice" in
    1) SELECTED="docker" ;; 2) SELECTED="podman" ;; *) SELECTED="$CURRENT_STRATEGY" ;;
  esac
  [ "$SELECTED" != "$CURRENT_STRATEGY" ] && sed -i "s/^DOCKER_BUILD_STRATEGY=.*/DOCKER_BUILD_STRATEGY=$SELECTED/" "$DEPLOY_DIR/.env" && echo "  Updated to $SELECTED"
else
  echo "  Using $CURRENT_STRATEGY (non-interactive)"
fi

# -- Deploy -------------------------------------------------------------------

log "Applying Kubernetes manifests"
kubectl apply -k "$K8S_DIR"

log "Post-deploy fixups"
REGISTRY_IP=$(kubectl get svc registry -n "$NS" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
[ -n "$REGISTRY_IP" ] && minikube ssh --profile="$PROFILE" -- \
  "grep -q '\\sregistry\$' /etc/hosts && { grep -v '\\sregistry\$' /etc/hosts > /tmp/hosts.tmp; echo '$REGISTRY_IP registry' >> /tmp/hosts.tmp; sudo cp /tmp/hosts.tmp /etc/hosts; rm /tmp/hosts.tmp; } || echo '$REGISTRY_IP registry' | sudo tee -a /etc/hosts >/dev/null"
echo "  registry -> ${REGISTRY_IP:-unknown}"

# -- Wait for pods ------------------------------------------------------------

log "Waiting for pods"
kubectl wait --for=condition=Ready pod -l app=postgres -n "$NS" --timeout=180s 2>/dev/null || echo "  postgres not ready"
kubectl wait --for=condition=Ready pod -l app=mongodb  -n "$NS" --timeout=180s 2>/dev/null || echo "  mongodb not ready"
kubectl wait --for=condition=Ready pod -l app -n "$NS" --timeout=300s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=nginx -n "$NS" --timeout=180s 2>/dev/null || echo "  nginx not ready"

echo ""
kubectl get pods -n "$NS" -o wide

# -- Port-forwards ------------------------------------------------------------

log "Starting port-forwards"
pkill -f "kubectl port-forward.*-n $NS" 2>/dev/null || true
sleep 1

port_forward "Nginx"          nginx            "8443:8443 8080:8080"
port_forward "Grafana"        grafana          "3200:3000"
port_forward "Mongo Express"  mongo-express    "8081:8081"
port_forward "pgAdmin"        pgadmin          "5480:80"
port_forward "Registry UI"    registry-express "5580:80"

# Verify gateway
for i in $(seq 1 5); do
  curl -sk -o /dev/null https://localhost:8443/health 2>/dev/null && { echo "  Gateway reachable"; break; }
  [ "$i" = "5" ] && echo "  WARNING: Gateway not reachable"
  sleep 2
done

# -- Summary ------------------------------------------------------------------

MK_IP=$(minikube ip --profile="$PROFILE" 2>/dev/null || echo "unknown")

log "Access URLs"
echo ""
echo "  Port-forward (localhost):          NodePort (minikube):"
echo "    https://localhost:8443             https://$MK_IP:30443"
echo "    http://localhost:8080              http://$MK_IP:30080"
echo "    http://localhost:3200  (Grafana)   http://$MK_IP:30200"
echo "    http://localhost:8081  (Mongo Ex)  http://$MK_IP:30081"
echo "    http://localhost:5480  (pgAdmin)   http://$MK_IP:30480"
echo "    http://localhost:5580  (Registry)  http://$MK_IP:30580"
echo ""
echo "  Credentials: see $ENV_FILE"
echo "  Stop port-forwards: pkill -f 'kubectl port-forward.*-n $NS'"
