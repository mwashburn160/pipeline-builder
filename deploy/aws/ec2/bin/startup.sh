#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - EC2 Minikube Startup Script
# =============================================================================
# Can be run as root (sudo) or as the minikube user directly.
# When run as root: minikube/kubectl/docker run as minikube user, iptables as root.
# When run as minikube user: iptables section is skipped.
# =============================================================================

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
DOMAIN="${DOMAIN:-}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# When run as root, wrap minikube/kubectl/docker to run as minikube user
if [ "$(id -u)" = "0" ]; then
  run_as_mk() { sudo -u minikube -- "$@"; }
else
  run_as_mk() { "$@"; }
fi

# Idempotent kubectl apply: generate YAML client-side, pipe to apply
kube_apply() { run_as_mk kubectl "$@" --dry-run=client -o yaml | run_as_mk kubectl apply -f -; }

# ---------------------------------------------------------------------------
# Load .env
# ---------------------------------------------------------------------------
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "ERROR: No .env file found at $DEPLOY_DIR/.env — run bootstrap.sh first" >&2
  exit 1
fi
ENV_FILE="$DEPLOY_DIR/.env"
echo "=== Loading environment from $ENV_FILE ==="
set -a; . "$ENV_FILE"; set +a

# When running as root, ensure minikube user can read deploy files
if [ "$(id -u)" = "0" ]; then
  chmod -R o+rX "$DEPLOY_DIR" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Ensure MongoDB keyfile has correct permissions
# ---------------------------------------------------------------------------
KEYFILE="$DEPLOY_DIR/mongodb-keyfile"
if [ -f "$KEYFILE" ]; then
  chmod 400 "$KEYFILE"
fi

# ---------------------------------------------------------------------------
# Ensure data directories exist
# ---------------------------------------------------------------------------
mkdir -p "$DATA_DIR" 2>/dev/null || true
mkdir -p "$DATA_DIR/db-data/postgres" "$DATA_DIR/db-data/mongodb" \
         "$DATA_DIR/db-data/grafana" "$DATA_DIR/db-data/loki" \
         "$DATA_DIR/db-data/prometheus" "$DATA_DIR/db-data/ollama" \
         "$DATA_DIR/registry-data" "$DATA_DIR/pgadmin-data" "$DATA_DIR/tmp"
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-/mnt/data/tmp}"

# ---------------------------------------------------------------------------
# Clean up stale Docker state
# ---------------------------------------------------------------------------
echo ""
echo "=== Cleaning up stale Docker state (if any) ==="
if run_as_mk docker inspect "$PROFILE" >/dev/null 2>&1; then
  # Check if the container references networks that no longer exist
  _has_stale_net=false
  for net_id in $(run_as_mk docker inspect "$PROFILE" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null); do
    if ! run_as_mk docker network inspect "$net_id" >/dev/null 2>&1; then
      _has_stale_net=true
      echo "  Container references missing network $net_id"
    fi
  done
  # If stale networks are embedded in the container config, the container is
  # unrecoverable — remove it so minikube can recreate it cleanly.
  if $_has_stale_net; then
    echo "  Removing container with stale network references..."
    run_as_mk docker rm -f "$PROFILE" 2>/dev/null || true
  fi
fi
run_as_mk docker network rm "$PROFILE" 2>/dev/null || true
run_as_mk docker network prune -f >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Start Minikube (dynamic resource allocation)
# ---------------------------------------------------------------------------
echo ""
echo "=== Detecting system resources ==="
TOTAL_CPU=$(nproc)
TOTAL_MEM_MB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 ))
MK_CPUS=$((TOTAL_CPU > 2 ? TOTAL_CPU - 1 : 2))
MK_MEMORY=$((TOTAL_MEM_MB * 75 / 100))
MK_DISK="40g"
echo "  System: ${TOTAL_CPU} CPUs, ${TOTAL_MEM_MB} MiB RAM"
echo "  Minikube: ${MK_CPUS} CPUs, ${MK_MEMORY} MiB RAM, ${MK_DISK} disk"

MK_START_ARGS=(
  --profile="$PROFILE"
  --cpus="$MK_CPUS"
  --memory="$MK_MEMORY"
  --disk-size="$MK_DISK"
  --driver=docker
  --mount --mount-string="$DATA_DIR:/mnt/data"
)

echo ""
echo "=== Starting Minikube ==="
echo "  Mounting $DATA_DIR -> /mnt/data"
if ! run_as_mk minikube start "${MK_START_ARGS[@]}"; then
  echo "  Start failed — deleting stale profile and retrying..."
  run_as_mk minikube delete --profile="$PROFILE" 2>/dev/null || true
  run_as_mk docker rm -f "$PROFILE" 2>/dev/null || true
  run_as_mk docker network rm "$PROFILE" 2>/dev/null || true
  run_as_mk docker network prune -f >/dev/null 2>&1 || true
  run_as_mk minikube start "${MK_START_ARGS[@]}"
fi

# ---------------------------------------------------------------------------
# Wait for cluster
# ---------------------------------------------------------------------------
echo ""
echo "=== Waiting for API server ==="
for i in $(seq 1 30); do
  run_as_mk kubectl cluster-info >/dev/null 2>&1 && echo "  API server is ready" && break
  [ "$i" = "30" ] && echo "  ERROR: API server not reachable after 30s" >&2 && exit 1
  sleep 1
done

echo ""
echo "=== Waiting for node ==="
run_as_mk kubectl wait --for=condition=Ready node/"$PROFILE" --timeout=120s

# ---------------------------------------------------------------------------
# Addons & KEDA
# ---------------------------------------------------------------------------
echo ""
echo "=== Enabling addons ==="
# Re-enable storage addons in case they failed during minikube start
# (race condition: API server may not be ready when minikube applies them)
run_as_mk minikube addons enable default-storageclass --profile="$PROFILE"
run_as_mk minikube addons enable storage-provisioner --profile="$PROFILE"
run_as_mk minikube addons enable metrics-server --profile="$PROFILE"

echo ""
echo "=== Installing KEDA ==="
run_as_mk kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.16.1/keda-2.16.1.yaml
run_as_mk kubectl wait --for=condition=Available deployment/keda-operator -n keda --timeout=120s 2>/dev/null || echo "  WARNING: KEDA operator not ready yet"
echo "  KEDA installed"

# ---------------------------------------------------------------------------
# Namespace
# ---------------------------------------------------------------------------
echo ""
echo "=== Ensuring namespace ==="
kube_apply create namespace "$NAMESPACE"

# ---------------------------------------------------------------------------
# ConfigMap from .env
# ---------------------------------------------------------------------------
echo ""
echo "=== Creating app-env ConfigMap ==="
CLEAN_ENV=$(mktemp)
trap 'rm -f "$CLEAN_ENV"' EXIT
grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | while IFS='=' read -r key value; do
  eval "printf '%s=%s\n' \"\$key\" \"\${$key}\""
done > "$CLEAN_ENV"
chmod 644 "$CLEAN_ENV"
kube_apply create configmap app-env --from-env-file="$CLEAN_ENV" -n "$NAMESPACE"
rm -f "$CLEAN_ENV"
echo "  app-env created/updated"

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
echo ""
echo "=== Creating secrets ==="

kube_apply create secret generic jwt-secret \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET" \
  -n "$NAMESPACE"
echo "  jwt-secret"

kube_apply create secret generic postgres-secret \
  --from-literal=POSTGRES_USER="$POSTGRES_USER" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=DB_USER="$DB_USER" \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  -n "$NAMESPACE"
echo "  postgres-secret"

kube_apply create secret generic mongodb-secret \
  --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" \
  --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" \
  --from-literal=MONGODB_URI="$MONGODB_URI" \
  -n "$NAMESPACE"
echo "  mongodb-secret"

kube_apply create secret generic registry-secret \
  --from-literal=IMAGE_REGISTRY_USER="$IMAGE_REGISTRY_USER" \
  --from-literal=IMAGE_REGISTRY_TOKEN="$IMAGE_REGISTRY_TOKEN" \
  -n "$NAMESPACE"
echo "  registry-secret"

kube_apply create secret generic mongo-express-secret \
  --from-literal=ME_CONFIG_BASICAUTH_USERNAME="$ME_CONFIG_BASICAUTH_USERNAME" \
  --from-literal=ME_CONFIG_BASICAUTH_PASSWORD="$ME_CONFIG_BASICAUTH_PASSWORD" \
  -n "$NAMESPACE"
echo "  mongo-express-secret"

kube_apply create secret generic pgadmin-secret \
  --from-literal=PGADMIN_DEFAULT_EMAIL="$PGADMIN_DEFAULT_EMAIL" \
  --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_DEFAULT_PASSWORD" \
  -n "$NAMESPACE"
echo "  pgadmin-secret"

kube_apply create secret generic grafana-secret \
  --from-literal=GF_SECURITY_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD" \
  -n "$NAMESPACE"
echo "  grafana-secret"

# GHCR image pull secret
GHCR_TOKEN="${GHCR_TOKEN:-}"
GHCR_USER="${GHCR_USER:-mwashburn160}"
if [ -n "$GHCR_TOKEN" ]; then
  kube_apply create secret docker-registry ghcr-secret \
    --docker-server=ghcr.io \
    --docker-username="$GHCR_USER" \
    --docker-password="$GHCR_TOKEN" \
    -n "$NAMESPACE"
  run_as_mk kubectl patch sa default -n "$NAMESPACE" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  run_as_mk minikube ssh --profile="$PROFILE" -- "echo '$GHCR_TOKEN' | docker login ghcr.io -u '$GHCR_USER' --password-stdin" >/dev/null 2>&1 \
    || echo "  WARNING: GHCR token validation failed — image pulls may fail"
  echo "  ghcr-secret (default SA patched)"
else
  echo "  WARNING: No GHCR token found (set GHCR_TOKEN env var)"
fi

# ---------------------------------------------------------------------------
# TLS certificates
# ---------------------------------------------------------------------------
echo ""
echo "=== Creating TLS certificates ==="
mkdir -p "$CERT_DIR" "$AUTH_DIR"

LE_CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [ -n "$DOMAIN" ] && [ -d "$LE_CERT_DIR" ]; then
  echo "  Using Let's Encrypt certificate for ${DOMAIN}"
  kube_apply create secret tls nginx-tls-secret \
    --cert="$LE_CERT_DIR/fullchain.pem" --key="$LE_CERT_DIR/privkey.pem" -n "$NAMESPACE"
else
  echo "  Generating self-signed nginx TLS certificate..."
  CERT_CN="${DOMAIN:-localhost}"
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/nginx.key" -out "$CERT_DIR/nginx.crt" \
    -subj "/CN=${CERT_CN}" -addext "subjectAltName=DNS:${CERT_CN},DNS:localhost,IP:127.0.0.1" 2>&1
  kube_apply create secret tls nginx-tls-secret \
    --cert="$CERT_DIR/nginx.crt" --key="$CERT_DIR/nginx.key" -n "$NAMESPACE"
fi
echo "  nginx-tls-secret"

echo "  Generating self-signed registry TLS certificate..."
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "$CERT_DIR/registry.key" -out "$CERT_DIR/registry.crt" \
  -subj "/CN=registry" -addext "subjectAltName=DNS:registry,DNS:localhost" 2>&1
kube_apply create secret tls registry-tls-secret \
  --cert="$CERT_DIR/registry.crt" --key="$CERT_DIR/registry.key" -n "$NAMESPACE"
echo "  registry-tls-secret"

# Registry htpasswd auth
echo "  Generating registry htpasswd..."
if command -v htpasswd >/dev/null 2>&1; then
  htpasswd -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
else
  run_as_mk docker run --rm --entrypoint htpasswd httpd:2 -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
fi
kube_apply create secret generic registry-auth-secret \
  --from-file=registry.passwd="$AUTH_DIR/registry.passwd" -n "$NAMESPACE"
echo "  registry-auth-secret"

# ---------------------------------------------------------------------------
# ConfigMaps
# ---------------------------------------------------------------------------
echo ""
echo "=== Creating ConfigMaps ==="

kube_apply create configmap postgres-init  --from-file=init.sql="$DEPLOY_DIR/postgres-init.sql" -n "$NAMESPACE"
echo "  postgres-init"

kube_apply create configmap mongodb-init   --from-file=mongo-init.js="$DEPLOY_DIR/mongodb-init.js" -n "$NAMESPACE"
kube_apply create secret generic mongodb-keyfile --from-file=mongodb-keyfile="$DEPLOY_DIR/mongodb-keyfile" -n "$NAMESPACE"
echo "  mongodb-init + keyfile"

kube_apply create configmap nginx-config   --from-file=nginx.conf="$NGINX_DIR/nginx-ec2.conf" -n "$NAMESPACE"
kube_apply create configmap nginx-njs      --from-file=jwt.js="$NGINX_DIR/jwt.js" --from-file=metrics.js="$NGINX_DIR/metrics.js" -n "$NAMESPACE"
echo "  nginx-config + njs"

kube_apply create configmap loki-config       --from-file=loki-config.yml="$CONFIG_DIR/loki/loki-config.yml" -n "$NAMESPACE"
kube_apply create configmap prometheus-config  --from-file=prometheus.yml="$CONFIG_DIR/prometheus/prometheus.yml" -n "$NAMESPACE"
kube_apply create configmap promtail-config    --from-file=promtail-config.yml="$CONFIG_DIR/promtail/promtail-config.yml" -n "$NAMESPACE"
echo "  loki + prometheus + promtail"

kube_apply create configmap grafana-datasources             --from-file=loki.yml="$CONFIG_DIR/grafana/loki.yml" --from-file=prometheus.yml="$CONFIG_DIR/grafana/prometheus.yml" -n "$NAMESPACE"
kube_apply create configmap grafana-dashboards-provisioning --from-file=dashboards.yml="$CONFIG_DIR/grafana/dashboards.yml" -n "$NAMESPACE"
kube_apply create configmap grafana-dashboards              --from-file=service-logs.json="$CONFIG_DIR/grafana/service-logs.json" --from-file=api-metrics.json="$CONFIG_DIR/grafana/api-metrics.json" -n "$NAMESPACE"
echo "  grafana datasources + dashboards"

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
# -----------------------------------------------------------------------
# Plugin build target selection
# -----------------------------------------------------------------------
set -a; . "$DEPLOY_DIR/.env" 2>/dev/null; set +a
CURRENT_STRATEGY="${DOCKER_BUILD_STRATEGY:-podman}"

echo ""
echo "=== Plugin Build Strategy ==="
echo "  Current: $CURRENT_STRATEGY"
echo ""
echo "  1) podman  — Podman rootless (default for K8s)"
echo "  2) docker  — Docker daemon via dind sidecar"
echo "  3) kaniko  — Kaniko executor (daemonless)"
echo ""
read -rp "Select strategy [1-3] or press Enter to keep '$CURRENT_STRATEGY': " choice

case "$choice" in
  1) SELECTED_STRATEGY="podman" ;;
  2) SELECTED_STRATEGY="docker" ;;
  3) SELECTED_STRATEGY="kaniko" ;;
  *) SELECTED_STRATEGY="$CURRENT_STRATEGY" ;;
esac

if [ "$SELECTED_STRATEGY" != "$CURRENT_STRATEGY" ]; then
  sed -i "s/^DOCKER_BUILD_STRATEGY=.*/DOCKER_BUILD_STRATEGY=$SELECTED_STRATEGY/" "$DEPLOY_DIR/.env"
  echo "  Updated .env: DOCKER_BUILD_STRATEGY=$SELECTED_STRATEGY"
fi

# Update plugin image tag in K8s manifest to match selected strategy
PLUGIN_YAML="$K8S_DIR/plugin.yaml"
if [ -f "$PLUGIN_YAML" ]; then
  PLUGIN_VERSION=$(grep 'ghcr.io/mwashburn160/plugin:' "$PLUGIN_YAML" | head -1 | sed 's/.*plugin:\([0-9.]*\).*/\1/')
  if [ -n "$PLUGIN_VERSION" ]; then
    sed -i "s|ghcr.io/mwashburn160/plugin:[0-9.]*-[a-z]*|ghcr.io/mwashburn160/plugin:${PLUGIN_VERSION}-${SELECTED_STRATEGY}|" "$PLUGIN_YAML"
    echo "  Plugin image: plugin:${PLUGIN_VERSION}-${SELECTED_STRATEGY}"
  fi
  sed -i "s/value: \"podman\"/value: \"$SELECTED_STRATEGY\"/; s/value: \"docker\"/value: \"$SELECTED_STRATEGY\"/; s/value: \"kaniko\"/value: \"$SELECTED_STRATEGY\"/" "$PLUGIN_YAML"
fi

if [ "$SELECTED_STRATEGY" = "docker" ]; then
  echo "  Note: docker strategy requires Docker CLI inside the plugin container image"
fi
echo ""

echo ""
echo "=== Pre-pulling container images ==="
echo ""
echo "=== Applying Kubernetes manifests ==="
run_as_mk kubectl apply -k "$K8S_DIR"

echo ""
echo "=== Fixing data directory permissions ==="
run_as_mk minikube ssh --profile="$PROFILE" -- 'sudo chown -R 1000:1000 /mnt/data/registry-data'
echo "  registry-data -> 1000:1000"

echo ""
echo "=== Patching minikube /etc/hosts for registry ==="
REGISTRY_IP=$(run_as_mk kubectl get svc registry -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
if [ -n "$REGISTRY_IP" ]; then
  run_as_mk minikube ssh --profile="$PROFILE" -- \
    "grep -q '\\sregistry\$' /etc/hosts 2>/dev/null && \
       sudo sed -i 's/.*\\sregistry\$/'"$REGISTRY_IP"' registry/' /etc/hosts || \
       echo '"$REGISTRY_IP"' registry | sudo tee -a /etc/hosts > /dev/null"
  echo "  registry -> $REGISTRY_IP"
else
  echo "  WARNING: Could not get registry ClusterIP"
fi

# ---------------------------------------------------------------------------
# Wait for pods
# ---------------------------------------------------------------------------
echo ""
echo "=== Waiting for databases (up to 3 min) ==="
run_as_mk kubectl wait --for=condition=Ready pod -l app=postgres -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  WARNING: postgres not ready"
run_as_mk kubectl wait --for=condition=Ready pod -l app=mongodb  -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  WARNING: mongodb not ready"

echo ""
echo "=== Waiting for application pods (up to 5 min) ==="
run_as_mk kubectl wait --for=condition=Ready pod -l app.kubernetes.io/part-of=pipeline-builder -n "$NAMESPACE" --timeout=300s 2>/dev/null || true

echo ""
echo "=== Pod Status ==="
run_as_mk kubectl get pods -n "$NAMESPACE" -o wide

echo ""
echo "=== Services ==="
run_as_mk kubectl get svc -n "$NAMESPACE"

# ---------------------------------------------------------------------------
# iptables (root only)
# ---------------------------------------------------------------------------
echo ""
echo "=== Setting up iptables port forwarding ==="
if [ "$(id -u)" = "0" ]; then
  MINIKUBE_IP=$(run_as_mk minikube ip --profile="$PROFILE" 2>/dev/null || true)
  if [ -n "$MINIKUBE_IP" ]; then
    PRIMARY_IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p')
    PRIMARY_IF="${PRIMARY_IF:-eth0}"
    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

    # Remove stale rules
    iptables -t nat -D PREROUTING -i "$PRIMARY_IF" -p tcp --dport 443 -j DNAT --to-destination "${MINIKUBE_IP}:30443" 2>/dev/null || true
    iptables -t nat -D PREROUTING -i "$PRIMARY_IF" -p tcp --dport 80  -j DNAT --to-destination "${MINIKUBE_IP}:30080" 2>/dev/null || true
    iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30443 -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30080 -j ACCEPT 2>/dev/null || true

    # Add rules
    iptables -t nat -A PREROUTING -i "$PRIMARY_IF" -p tcp --dport 443 -j DNAT --to-destination "${MINIKUBE_IP}:30443"
    iptables -t nat -A PREROUTING -i "$PRIMARY_IF" -p tcp --dport 80  -j DNAT --to-destination "${MINIKUBE_IP}:30080"
    iptables -I FORWARD 1 -d "$MINIKUBE_IP" -p tcp --dport 30443 -j ACCEPT
    iptables -I FORWARD 1 -d "$MINIKUBE_IP" -p tcp --dport 30080 -j ACCEPT
    iptables -t nat -C POSTROUTING -o "$PRIMARY_IF" -j MASQUERADE 2>/dev/null \
      || iptables -t nat -A POSTROUTING -o "$PRIMARY_IF" -j MASQUERADE

    iptables-save > /etc/sysconfig/iptables 2>/dev/null || true
    echo "  ${PRIMARY_IF}: 443→${MINIKUBE_IP}:30443, 80→${MINIKUBE_IP}:30080"
  else
    echo "  WARNING: Could not determine minikube IP"
  fi
else
  echo "  Skipping (not root)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Access URLs ==="
if [ -n "$DOMAIN" ]; then
  echo "  Application:   https://${DOMAIN}"
  echo "  Grafana:       https://${DOMAIN}/grafana/"
  echo "  Mongo Express: https://${DOMAIN}/mongo-express/"
  echo "  pgAdmin:       https://${DOMAIN}/pgadmin/"
  echo "  Registry UI:   https://${DOMAIN}/registry-express/"
else
  MINIKUBE_IP=$(run_as_mk minikube ip --profile="$PROFILE" 2>/dev/null || echo "unknown")
  echo "  HTTPS: https://$MINIKUBE_IP:30443"
  echo "  HTTP:  http://$MINIKUBE_IP:30080"
fi

echo ""
echo "=== Credentials ==="
echo "  (see $ENV_FILE)"
