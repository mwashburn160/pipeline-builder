#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - EC2 Minikube Startup Script
# =============================================================================
# Adapted from deploy/minikube/bin/startup.sh for EC2 deployment.
#
# Changes from minikube version:
#   1. Dynamic resource allocation (reads CPU/memory from system)
#   2. GHCR token from env var (not ~/.npmrc)
#   3. Let's Encrypt certs (falls back to self-signed)
#   4. nginx-ec2.conf (no port suffix in redirect)
#   5. Access URLs use $DOMAIN instead of minikube IP
# =============================================================================

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
DOMAIN="${DOMAIN:-}"

# -----------------------------------------------------------------------
# When run as root, minikube/kubectl/docker must execute as the minikube
# user (the docker driver rejects root). Wrap them so the rest of the
# script works identically regardless of who invokes it.
# -----------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
  MK_USER="minikube"
  run_as_mk() { sudo -u "$MK_USER" -- "$@"; }
else
  run_as_mk() { "$@"; }
fi

# -----------------------------------------------------------------------
# Load environment variables from .env
# -----------------------------------------------------------------------
ENV_FILE=""
if [ -f "$DEPLOY_DIR/.env" ]; then
  ENV_FILE="$DEPLOY_DIR/.env"
fi

if [ -n "$ENV_FILE" ]; then
  echo "=== Loading environment from $ENV_FILE ==="
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "ERROR: No .env file found at $DEPLOY_DIR/.env"
  echo "  Run bootstrap.sh first to generate .env from .env.example"
  exit 1
fi

# Ensure data directory exists and is accessible
mkdir -p "$DATA_DIR" 2>/dev/null || true
if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  echo "ERROR: Cannot write to $DATA_DIR — check mount and permissions" >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-test"

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
# If the minikube container references a deleted network, Docker refuses to
# start it ("network … not found"). Disconnect the container from any missing
# networks, then remove orphaned networks so minikube can recreate cleanly.
if run_as_mk docker inspect "$PROFILE" >/dev/null 2>&1; then
  for net_id in $(run_as_mk docker inspect "$PROFILE" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null); do
    if ! run_as_mk docker network inspect "$net_id" >/dev/null 2>&1; then
      echo "  Disconnecting container from missing network $net_id"
      run_as_mk docker network disconnect -f "$net_id" "$PROFILE" 2>/dev/null || true
    fi
  done
fi
run_as_mk docker network rm "$PROFILE" 2>/dev/null || true

# -----------------------------------------------------------------------
# Dynamic resource allocation based on EC2 instance size
# Allocates ~75% of system resources to minikube
# -----------------------------------------------------------------------
echo ""
echo "=== Detecting system resources ==="
TOTAL_CPU=$(nproc)
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_MEM_MB=$((TOTAL_MEM_KB / 1024))

# Reserve 1 CPU for host (min 2 for minikube)
MK_CPUS=$((TOTAL_CPU > 2 ? TOTAL_CPU - 1 : 2))
# Allocate 75% of memory to minikube
MK_MEMORY=$((TOTAL_MEM_MB * 75 / 100))
MK_DISK="40g"

echo "  System: ${TOTAL_CPU} CPUs, ${TOTAL_MEM_MB} MiB RAM"
echo "  Minikube: ${MK_CPUS} CPUs, ${MK_MEMORY} MiB RAM, ${MK_DISK} disk"

echo ""
echo "=== Starting Minikube ==="
echo "  Mounting $DATA_DIR -> /mnt/data"
if ! run_as_mk minikube start \
  --profile="$PROFILE" \
  --cpus="$MK_CPUS" \
  --memory="$MK_MEMORY" \
  --disk-size="$MK_DISK" \
  --driver=docker \
  --mount --mount-string="$DATA_DIR:/mnt/data"; then

  echo ""
  echo "  Start failed — removing stale container and retrying..."
  run_as_mk docker rm -f "$PROFILE" 2>/dev/null || true
  run_as_mk docker network rm "$PROFILE" 2>/dev/null || true

  run_as_mk minikube start \
    --profile="$PROFILE" \
    --cpus="$MK_CPUS" \
    --memory="$MK_MEMORY" \
    --disk-size="$MK_DISK" \
    --driver=docker \
    --mount --mount-string="$DATA_DIR:/mnt/data"
fi

echo ""
echo "=== Waiting for API server to be reachable ==="
_api_retries=0
_api_max=30
while [ "$_api_retries" -lt "$_api_max" ]; do
  if run_as_mk kubectl cluster-info >/dev/null 2>&1; then
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
run_as_mk kubectl wait --for=condition=Ready node/"$PROFILE" --timeout=120s

echo ""
echo "=== Enabling addons ==="
# default-storageclass and storage-provisioner are enabled by default in minikube
run_as_mk minikube addons enable metrics-server --profile="$PROFILE"

echo ""
echo "=== Installing KEDA (queue-based autoscaling) ==="
run_as_mk kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.16.1/keda-2.16.1.yaml
run_as_mk kubectl wait --for=condition=Available deployment/keda-operator -n keda --timeout=120s 2>/dev/null || echo "  WARNING: KEDA operator not ready yet (will retry in background)"
echo "  KEDA installed"

echo ""
echo "=== Ensuring namespace exists ==="
run_as_mk kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | run_as_mk kubectl apply -f -

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
run_as_mk kubectl create configmap app-env \
  --from-env-file="$CLEAN_ENV" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
rm -f "$CLEAN_ENV"
echo "  app-env ConfigMap created/updated"

echo ""
echo "=== Creating secrets from .env values ==="

# JWT secrets
run_as_mk kubectl create secret generic jwt-secret \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  jwt-secret created/updated"

# PostgreSQL secrets
run_as_mk kubectl create secret generic postgres-secret \
  --from-literal=POSTGRES_USER="$POSTGRES_USER" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=DB_USER="$DB_USER" \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  postgres-secret created/updated"

# MongoDB secrets
run_as_mk kubectl create secret generic mongodb-secret \
  --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" \
  --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" \
  --from-literal=MONGODB_URI="$MONGODB_URI" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  mongodb-secret created/updated"

# Registry secrets
run_as_mk kubectl create secret generic registry-secret \
  --from-literal=IMAGE_REGISTRY_USER="$IMAGE_REGISTRY_USER" \
  --from-literal=IMAGE_REGISTRY_TOKEN="$IMAGE_REGISTRY_TOKEN" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  registry-secret created/updated"

# Mongo Express secrets
run_as_mk kubectl create secret generic mongo-express-secret \
  --from-literal=ME_CONFIG_BASICAUTH_USERNAME="$ME_CONFIG_BASICAUTH_USERNAME" \
  --from-literal=ME_CONFIG_BASICAUTH_PASSWORD="$ME_CONFIG_BASICAUTH_PASSWORD" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  mongo-express-secret created/updated"

# pgAdmin secrets
run_as_mk kubectl create secret generic pgadmin-secret \
  --from-literal=PGADMIN_DEFAULT_EMAIL="$PGADMIN_DEFAULT_EMAIL" \
  --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_DEFAULT_PASSWORD" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  pgadmin-secret created/updated"

# Grafana secrets
run_as_mk kubectl create secret generic grafana-secret \
  --from-literal=GF_SECURITY_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  grafana-secret created/updated"

# GHCR image pull secret (for pulling app images from ghcr.io)
# EC2: token comes from env var set by CloudFormation/bootstrap
GHCR_TOKEN="${GHCR_TOKEN:-}"
GHCR_USER="${GHCR_USER:-mwashburn160}"
if [ -n "$GHCR_TOKEN" ]; then
  run_as_mk kubectl create secret docker-registry ghcr-secret \
    --docker-server=ghcr.io \
    --docker-username="$GHCR_USER" \
    --docker-password="$GHCR_TOKEN" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | run_as_mk kubectl apply -f -
  run_as_mk kubectl patch sa default -n "$NAMESPACE" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  # Validate token works (inside minikube where image pulls actually happen)
  if ! run_as_mk minikube ssh --profile="$PROFILE" -- "echo '$GHCR_TOKEN' | docker login ghcr.io -u '$GHCR_USER' --password-stdin" >/dev/null 2>&1; then
    echo "  WARNING: GHCR token validation failed — image pulls may fail"
  fi
  echo "  ghcr-secret created/updated (default SA patched)"
else
  echo "  WARNING: No GHCR token found (set GHCR_TOKEN env var)"
fi

echo ""
echo "=== Creating TLS certificates ==="
mkdir -p "$CERT_DIR"
mkdir -p "$AUTH_DIR"

# EC2: Use Let's Encrypt certs if available, fall back to self-signed
LE_CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [ -n "$DOMAIN" ] && [ -d "$LE_CERT_DIR" ]; then
  echo "  Using Let's Encrypt certificate for ${DOMAIN}"
  run_as_mk kubectl create secret tls nginx-tls-secret \
    --cert="$LE_CERT_DIR/fullchain.pem" \
    --key="$LE_CERT_DIR/privkey.pem" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | run_as_mk kubectl apply -f -
  echo "  nginx-tls-secret created from Let's Encrypt"
else
  echo "  Let's Encrypt certs not found, generating self-signed nginx TLS certificate..."
  CERT_CN="${DOMAIN:-localhost}"
  CERT_SAN="DNS:${CERT_CN},DNS:localhost,IP:127.0.0.1"
  if ! openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/nginx.key" -out "$CERT_DIR/nginx.crt" \
    -subj "/CN=${CERT_CN}" -addext "subjectAltName=${CERT_SAN}" 2>&1; then
    echo "ERROR: Failed to generate nginx TLS certificate" >&2
    exit 1
  fi
  run_as_mk kubectl create secret tls nginx-tls-secret \
    --cert="$CERT_DIR/nginx.crt" --key="$CERT_DIR/nginx.key" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | run_as_mk kubectl apply -f -
  echo "  nginx-tls-secret created (self-signed)"
fi

# Registry TLS (always self-signed — internal only)
echo "  Generating self-signed registry TLS certificate..."
if ! openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "$CERT_DIR/registry.key" -out "$CERT_DIR/registry.crt" \
  -subj "/CN=registry" -addext "subjectAltName=DNS:registry,DNS:localhost" 2>&1; then
  echo "ERROR: Failed to generate registry TLS certificate" >&2
  exit 1
fi
run_as_mk kubectl create secret tls registry-tls-secret \
  --cert="$CERT_DIR/registry.crt" --key="$CERT_DIR/registry.key" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  registry-tls-secret created/updated"

# Registry htpasswd auth
echo "  Generating registry htpasswd..."
if command -v htpasswd >/dev/null 2>&1; then
  htpasswd -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
else
  run_as_mk docker run --rm --entrypoint htpasswd httpd:2 -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
fi
run_as_mk kubectl create secret generic registry-auth-secret \
  --from-file=registry.passwd="$AUTH_DIR/registry.passwd" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  registry-auth-secret created/updated"

echo ""
echo "=== Creating PostgreSQL init ConfigMap ==="
run_as_mk kubectl create configmap postgres-init \
  --from-file=init.sql="$DEPLOY_DIR/postgres-init.sql" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  postgres-init ConfigMap created/updated"

echo ""
echo "=== Creating MongoDB init ConfigMap & keyfile Secret ==="
run_as_mk kubectl create configmap mongodb-init \
  --from-file=mongo-init.js="$DEPLOY_DIR/mongodb-init.js" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  mongodb-init ConfigMap created/updated"

run_as_mk kubectl create secret generic mongodb-keyfile \
  --from-file=mongodb-keyfile="$DEPLOY_DIR/mongodb-keyfile" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  mongodb-keyfile Secret created/updated"

echo ""
echo "=== Creating Nginx ConfigMaps ==="
# EC2: Use nginx-ec2.conf (no port suffix in redirect, catch-all server_name)
run_as_mk kubectl create configmap nginx-config \
  --from-file=nginx.conf="$NGINX_DIR/nginx-ec2.conf" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  nginx-config ConfigMap created/updated (EC2 variant)"

run_as_mk kubectl create configmap nginx-njs \
  --from-file=jwt.js="$NGINX_DIR/jwt.js" \
  --from-file=metrics.js="$NGINX_DIR/metrics.js" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  nginx-njs ConfigMap created/updated"

echo ""
echo "=== Creating Observability ConfigMaps ==="
run_as_mk kubectl create configmap loki-config \
  --from-file=loki-config.yml="$CONFIG_DIR/loki/loki-config.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  loki-config ConfigMap created/updated"

run_as_mk kubectl create configmap prometheus-config \
  --from-file=prometheus.yml="$CONFIG_DIR/prometheus/prometheus.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  prometheus-config ConfigMap created/updated"

run_as_mk kubectl create configmap promtail-config \
  --from-file=promtail-config.yml="$CONFIG_DIR/promtail/promtail-config.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  promtail-config ConfigMap created/updated"

echo ""
echo "=== Creating Grafana ConfigMaps ==="
run_as_mk kubectl create configmap grafana-datasources \
  --from-file=loki.yml="$CONFIG_DIR/grafana/loki.yml" \
  --from-file=prometheus.yml="$CONFIG_DIR/grafana/prometheus.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  grafana-datasources ConfigMap created/updated"

run_as_mk kubectl create configmap grafana-dashboards-provisioning \
  --from-file=dashboards.yml="$CONFIG_DIR/grafana/dashboards.yml" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  grafana-dashboards-provisioning ConfigMap created/updated"

run_as_mk kubectl create configmap grafana-dashboards \
  --from-file=service-logs.json="$CONFIG_DIR/grafana/service-logs.json" \
  --from-file=api-metrics.json="$CONFIG_DIR/grafana/api-metrics.json" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | run_as_mk kubectl apply -f -
echo "  grafana-dashboards ConfigMap created/updated"

echo ""
echo "=== Pre-pulling container images ==="
run_as_mk minikube ssh --profile="$PROFILE" -- 'docker pull docker:27.5.1-dind' 2>/dev/null && echo "  docker:27.5.1-dind pulled" || echo "  WARNING: Could not pre-pull docker:27.5.1-dind"

echo ""
echo "=== Applying Kubernetes manifests ==="
run_as_mk kubectl apply -k "$K8S_DIR"

echo ""
echo "=== Fixing data directory permissions ==="
run_as_mk minikube ssh --profile="$PROFILE" -- 'sudo chown -R 1000:1000 /mnt/data/registry-data'
echo "  registry-data -> 1000:1000"

echo ""
echo "=== Patching minikube /etc/hosts for Docker registry access ==="
# Plugin builds run BuildKit inside a docker:dind sidecar container within the
# plugin pod. When the dind container uses host networking or needs to push to
# the in-cluster registry, it must resolve the 'registry' hostname. K8s DNS
# only serves pods, not the minikube node itself, so we add an /etc/hosts
# entry mapping the registry Service ClusterIP on the node.
REGISTRY_IP=$(run_as_mk kubectl get svc registry -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
if [ -n "$REGISTRY_IP" ]; then
  run_as_mk minikube ssh --profile="$PROFILE" -- \
    "grep -q '\\sregistry\$' /etc/hosts 2>/dev/null && \
       sudo sed -i 's/.*\\sregistry\$/'"$REGISTRY_IP"' registry/' /etc/hosts || \
       echo '"$REGISTRY_IP"' registry | sudo tee -a /etc/hosts > /dev/null"
  echo "  registry -> $REGISTRY_IP"
else
  echo "  WARNING: Could not get registry ClusterIP — plugin builds may fail"
fi

echo ""
echo "=== Waiting for databases to be ready (up to 3 min) ==="
run_as_mk kubectl wait --for=condition=Ready pod -l app=postgres -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  WARNING: postgres not ready yet"
run_as_mk kubectl wait --for=condition=Ready pod -l app=mongodb -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  WARNING: mongodb not ready yet"

echo ""
echo "=== Waiting for application pods (up to 5 min) ==="
run_as_mk kubectl wait --for=condition=Ready pod -l app.kubernetes.io/part-of=pipeline-builder -n "$NAMESPACE" --timeout=300s 2>/dev/null || true

echo ""
echo "=== Pod Status ==="
run_as_mk kubectl get pods -n "$NAMESPACE" -o wide

echo ""
echo "=== Services ==="
run_as_mk kubectl get svc -n "$NAMESPACE"

echo ""
echo "=== Setting up iptables port forwarding ==="
# iptables requires root — use run_as_mk only for minikube ip
if [ "$(id -u)" = "0" ]; then
  MINIKUBE_IP=$(run_as_mk minikube ip --profile="$PROFILE" 2>/dev/null || true)
  if [ -n "$MINIKUBE_IP" ]; then
    PRIMARY_IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p')
    PRIMARY_IF="${PRIMARY_IF:-eth0}"

    # Enable IP forwarding
    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

    # Remove stale rules (ignore errors if they don't exist)
    iptables -t nat -D PREROUTING -i "$PRIMARY_IF" -p tcp --dport 443 -j DNAT --to-destination "${MINIKUBE_IP}:30443" 2>/dev/null || true
    iptables -t nat -D PREROUTING -i "$PRIMARY_IF" -p tcp --dport 80 -j DNAT --to-destination "${MINIKUBE_IP}:30080" 2>/dev/null || true
    iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30443 -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30080 -j ACCEPT 2>/dev/null || true

    # PREROUTING: DNAT external traffic to minikube NodePorts
    iptables -t nat -A PREROUTING -i "$PRIMARY_IF" -p tcp --dport 443 -j DNAT --to-destination "${MINIKUBE_IP}:30443"
    iptables -t nat -A PREROUTING -i "$PRIMARY_IF" -p tcp --dport 80 -j DNAT --to-destination "${MINIKUBE_IP}:30080"

    # FORWARD: Allow DNAT'd packets through to minikube
    iptables -I FORWARD 1 -d "$MINIKUBE_IP" -p tcp --dport 30443 -j ACCEPT
    iptables -I FORWARD 1 -d "$MINIKUBE_IP" -p tcp --dport 30080 -j ACCEPT

    # POSTROUTING: Masquerade return traffic
    if ! iptables -t nat -C POSTROUTING -o "$PRIMARY_IF" -j MASQUERADE 2>/dev/null; then
      iptables -t nat -A POSTROUTING -o "$PRIMARY_IF" -j MASQUERADE
    fi

    # Persist rules
    iptables-save > /etc/sysconfig/iptables 2>/dev/null || true

    echo "  Interface: ${PRIMARY_IF}"
    echo "  443 → ${MINIKUBE_IP}:30443"
    echo "  80  → ${MINIKUBE_IP}:30080"
    echo "  FORWARD rules set, rules persisted"
  else
    echo "  WARNING: Could not determine minikube IP — iptables rules not set"
  fi
else
  echo "  Skipping (not root) — run as root or use bootstrap.sh for iptables setup"
fi

echo ""
echo "=== Access URLs ==="
if [ -n "$DOMAIN" ]; then
  echo "  Application:   https://${DOMAIN}"
  echo "  Grafana:       https://${DOMAIN}/grafana/"
  echo "  Mongo Express: https://${DOMAIN}/mongo-express/"
  echo "  pgAdmin:       https://${DOMAIN}/pgadmin/"
  echo "  Registry UI:   https://${DOMAIN}/registry-express/"
else
  MINIKUBE_IP=$(run_as_mk minikube ip --profile="$PROFILE")
  echo "  API Gateway (HTTPS): https://$MINIKUBE_IP:30443"
  echo "  API Gateway (HTTP):  http://$MINIKUBE_IP:30080"
  echo "  Grafana:             http://$MINIKUBE_IP:30200"
  echo "  Mongo Express:       http://$MINIKUBE_IP:30081"
  echo "  pgAdmin:             http://$MINIKUBE_IP:30480"
  echo "  Registry UI:         http://$MINIKUBE_IP:30580"
fi

echo ""
echo "=== Credentials ==="
echo "  (Stored in .env — use 'cat $ENV_FILE' to view)"
echo "  PostgreSQL:    $POSTGRES_USER / ****"
echo "  MongoDB:       $MONGO_INITDB_ROOT_USERNAME / ****"
echo "  Grafana:       admin / ****"
echo "  Mongo Express: $ME_CONFIG_BASICAUTH_USERNAME / ****"
echo "  pgAdmin:       $PGADMIN_DEFAULT_EMAIL / ****"
echo "  Registry:      $IMAGE_REGISTRY_USER / ****"
