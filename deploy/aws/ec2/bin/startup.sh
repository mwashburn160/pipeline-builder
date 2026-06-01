#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - EC2 Minikube Startup
# =============================================================================
# Runs as root (sudo) or minikube user directly.
# Root: minikube/kubectl/docker run as minikube user, iptables as root.
# Non-root: iptables section skipped.
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
# Persistent-storage layout. Honors PIPELINE_ROOT from the host (set by
# UserData / bootstrap.sh) but defaults to /opt/pipeline for standalone
# script invocations. The minikube VM mounts $DATA_DIR at the SAME path
# inside the VM, so k8s hostPath manifests can reference one canonical
# location regardless of which side of the boundary they describe.
PIPELINE_ROOT="${PIPELINE_ROOT:-/opt/pipeline}"
DATA_DIR="$PIPELINE_ROOT/pipeline-data"
DOMAIN="${DOMAIN:-}"

# -- Helpers ------------------------------------------------------------------

if [ "$(id -u)" = "0" ]; then
  mk() { sudo -u minikube -- "$@"; }
else
  mk() { "$@"; }
fi

kube() { mk kubectl "$@" --dry-run=client -o yaml | mk kubectl apply -f -; }

log() { echo ""; echo "=== $1 ==="; }

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
  mk docker rm -f "$PROFILE" 2>/dev/null || true
  mk docker network rm "$PROFILE" 2>/dev/null || true
  mk docker network prune -f >/dev/null 2>&1 || true
}

# -- Load .env ----------------------------------------------------------------

[ -f "$DEPLOY_DIR/.env" ] || { echo "ERROR: No .env — run bootstrap.sh first" >&2; exit 1; }
ENV_FILE="$DEPLOY_DIR/.env"
log "Loading environment"
set -a; . "$ENV_FILE"; set +a

# Grant minikube user read access to deploy assets (manifests, configs, nginx)
# Exclude .env and auth dirs which contain secrets
if [ "$(id -u)" = "0" ]; then
  chmod -R o+rX "$DEPLOY_DIR/k8s" "$DEPLOY_DIR/config" "$DEPLOY_DIR/nginx" 2>/dev/null || true
  chmod o-rwx "$DEPLOY_DIR/.env" 2>/dev/null || true
fi
[ -f "$DEPLOY_DIR/mongodb-keyfile" ] && chmod 400 "$DEPLOY_DIR/mongodb-keyfile"

# -- Data directories ---------------------------------------------------------

mkdir -p "$DATA_DIR"/{db-data/{postgres,mongodb,loki,prometheus},registry-data,pgadmin-data,tmp} 2>/dev/null || true
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-$DATA_DIR/plugins-data/builds}"

# -- Clean stale Docker state ------------------------------------------------

log "Cleaning Docker state"
if mk docker inspect "$PROFILE" >/dev/null 2>&1; then
  for net in $(mk docker inspect "$PROFILE" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null); do
    mk docker network inspect "$net" >/dev/null 2>&1 || { echo "  Removing container with stale network"; cleanup_docker; break; }
  done
fi
mk docker network rm "$PROFILE" 2>/dev/null || true

# -- Start Minikube -----------------------------------------------------------

log "Detecting resources"
TOTAL_CPU=$(nproc)
TOTAL_MEM=$(($(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024))
MK_CPUS=$((TOTAL_CPU > 2 ? TOTAL_CPU - 1 : 2))
# Memory: reserve 4 GiB for host (kernel + docker daemon + ssh/cron +
# burst headroom) and give the rest to minikube — but never less than
# 75% on small instances where 4 GiB would over-reserve.
#   t3.large   (8G)   → max(6G,    8-4=4G)  = 6G   minikube,  2G  host
#   t3.xlarge  (16G)  → max(12G,   16-4=12G) = 12G minikube,  4G  host
#   t3.2xlarge (32G)  → max(24G,   32-4=28G) = 28G minikube,  4G  host  ← was 24G
#   m5.4xlarge (64G)  → max(48G,   64-4=60G) = 60G minikube,  4G  host  ← was 48G
MK_MEM_BY_RATIO=$((TOTAL_MEM * 75 / 100))
MK_MEM_BY_RESERVE=$((TOTAL_MEM - 4096))
MK_MEM=$(( MK_MEM_BY_RATIO > MK_MEM_BY_RESERVE ? MK_MEM_BY_RATIO : MK_MEM_BY_RESERVE ))
echo "  System: ${TOTAL_CPU} CPUs, ${TOTAL_MEM}M RAM → Minikube: ${MK_CPUS} CPUs, ${MK_MEM}M"

MK_ARGS=(--profile="$PROFILE" --cpus="$MK_CPUS" --memory="$MK_MEM" --disk-size=40g --driver=docker --mount --mount-string="$DATA_DIR:$DATA_DIR")

log "Starting Minikube"
if ! mk minikube start "${MK_ARGS[@]}"; then
  echo "  Retrying after cleanup..."
  mk minikube delete --profile="$PROFILE" 2>/dev/null || true
  cleanup_docker
  mk minikube start "${MK_ARGS[@]}"
fi

# -- Wait for cluster ---------------------------------------------------------

log "Waiting for cluster"
for i in $(seq 1 30); do
  mk kubectl cluster-info >/dev/null 2>&1 && break
  [ "$i" = "30" ] && { echo "ERROR: API server not reachable" >&2; exit 1; }
  sleep 1
done
mk kubectl wait --for=condition=Ready node/"$PROFILE" --timeout=120s
echo "  Cluster ready"

# -- Configure VM + addons ---------------------------------------------------

log "Enabling addons"
for addon in default-storageclass storage-provisioner metrics-server; do
  mk minikube addons enable "$addon" --profile="$PROFILE"
done

# The minikube-bundled metrics-server doesn't set --kubelet-insecure-tls,
# but the minikube node uses a self-signed kubelet cert. Without the
# flag every scrape fails silently with "x509: cannot validate certificate"
# and every HPA logs FailedGetResourceMetric. Patch the deployment so the
# flag is appended; idempotent (re-running on an already-patched deploy
# just appends a duplicate, which is harmless and clobbered on rollout).
mk kubectl -n kube-system patch deploy metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
  2>/dev/null || echo "  metrics-server patch skipped (already patched or not yet rolled out)"

mk kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.16.1/keda-2.16.1.yaml
mk kubectl wait --for=condition=Available deployment/keda-operator -n keda --timeout=120s 2>/dev/null || echo "  KEDA not ready yet"
echo "  Addons + KEDA installed"

# -- Namespace + ConfigMap + Secrets ------------------------------------------

log "Creating namespace + secrets + configmaps"
kube create namespace "$NS"

# app-env ConfigMap from .env. The plugin service uses a rootless buildkitd
# sidecar (single build path — no strategy switch).
# Use envsubst to safely expand variables without eval
CLEAN_ENV=$(mktemp); trap 'rm -f "$CLEAN_ENV"' EXIT
grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | envsubst > "$CLEAN_ENV"
chmod 644 "$CLEAN_ENV"
configmap app-env --from-env-file="$CLEAN_ENV"
rm -f "$CLEAN_ENV"

# Secrets
secret jwt-secret        --from-literal=JWT_SECRET="$JWT_SECRET" --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET"
secret postgres-secret   --from-literal=POSTGRES_USER="$POSTGRES_USER" --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" --from-literal=DB_USER="$DB_USER" --from-literal=DB_PASSWORD="$DB_PASSWORD"
secret mongodb-secret    --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" --from-literal=MONGODB_URI="$MONGODB_URI"
secret mongo-express-secret --from-literal=ME_CONFIG_BASICAUTH_USERNAME="$ME_CONFIG_BASICAUTH_USERNAME" --from-literal=ME_CONFIG_BASICAUTH_PASSWORD="$ME_CONFIG_BASICAUTH_PASSWORD"
secret pgadmin-secret    --from-literal=PGADMIN_DEFAULT_EMAIL="$PGADMIN_DEFAULT_EMAIL" --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_DEFAULT_PASSWORD"

# GHCR pull secret (optional)
if [ -n "${GHCR_TOKEN:-}" ]; then
  GHCR_USER="${GHCR_USER:-mwashburn160}"
  kube create secret docker-registry ghcr-secret --docker-server=ghcr.io --docker-username="$GHCR_USER" --docker-password="$GHCR_TOKEN" -n "$NS"
  mk kubectl patch sa default -n "$NS" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  echo "  ghcr-secret"
fi

# -- TLS certificates --------------------------------------------------------

log "Creating TLS certificates"
mkdir -p "$CERT_DIR" "$AUTH_DIR"
chown root:minikube "$CERT_DIR"

LE_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [ -n "$DOMAIN" ] && [ -d "$LE_DIR" ]; then
  echo "  Using Let's Encrypt for ${DOMAIN}"
  kube create secret tls nginx-tls-secret --cert="$LE_DIR/fullchain.pem" --key="$LE_DIR/privkey.pem" -n "$NS"
else
  CN="${DOMAIN:-localhost}"
  # OpenSSL/RFC 6125: when the connection target is an IP literal, the cert
  # MUST present an `IP:` SAN. A `DNS:` SAN with the same IP string is NOT
  # accepted — verify will fail with "certificate verify failed" even though
  # the CN matches. Emit the right SAN type based on whether CN is an IPv4
  # literal.
  if printf '%s' "$CN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    CN_SAN="IP:${CN}"
  else
    CN_SAN="DNS:${CN}"
  fi
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout "$CERT_DIR/nginx-tls.key" -out "$CERT_DIR/nginx-tls.crt" \
    -subj "/CN=${CN}" -addext "subjectAltName=${CN_SAN},DNS:localhost,IP:127.0.0.1" 2>&1
  chmod 644 "$CERT_DIR/nginx-tls.key" "$CERT_DIR/nginx-tls.crt"
  kube create secret tls nginx-tls-secret --cert="$CERT_DIR/nginx-tls.crt" --key="$CERT_DIR/nginx-tls.key" -n "$NS"
fi

# JWT signing keypair for image-registry's token-auth endpoint. Mounted by
# both the underlying registry (as the trusted public cert) and the
# image-registry proxy (which signs tokens with the private key).
openssl genrsa -out "$CERT_DIR/image-registry-jwt.key" 2048 2>&1
openssl req -x509 -new -key "$CERT_DIR/image-registry-jwt.key" -days 3650 \
  -subj "/CN=pipeline-image-registry-token-issuer" -out "$CERT_DIR/image-registry-jwt.crt" 2>&1
chmod 644 "$CERT_DIR/image-registry-jwt.key" "$CERT_DIR/image-registry-jwt.crt"
secret registry-token-secret \
  --from-file=jwt-private.pem="$CERT_DIR/image-registry-jwt.key" \
  --from-file=jwt-public.pem="$CERT_DIR/image-registry-jwt.crt"

# Build-side credentials consumed by the image-registry proxy:
#   IMAGE_REGISTRY_*  — Basic auth used when talking to the underlying registry.
secret image-registry-build-svc-secret \
  --from-literal=IMAGE_REGISTRY_USERNAME="$IMAGE_REGISTRY_USER" \
  --from-literal=IMAGE_REGISTRY_PASSWORD="$IMAGE_REGISTRY_TOKEN"

if command -v htpasswd >/dev/null 2>&1; then
  htpasswd -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
else
  mk docker run --rm --entrypoint htpasswd httpd:2 -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
fi
chmod 644 "$AUTH_DIR/registry.passwd"
secret registry-auth-secret --from-file=registry.passwd="$AUTH_DIR/registry.passwd"
echo "  TLS + registry auth done"

# -- ConfigMaps ---------------------------------------------------------------

log "Creating ConfigMaps"
configmap postgres-init   --from-file=init.sql="$DEPLOY_DIR/postgres-init.sql"
configmap mongodb-init    --from-file=mongo-init.js="$DEPLOY_DIR/mongodb-init.js"
secret   mongodb-keyfile  --from-file=mongodb-keyfile="$DEPLOY_DIR/mongodb-keyfile"
configmap nginx-config    --from-file=nginx.conf="$NGINX_DIR/nginx-ec2.conf"
configmap nginx-njs       --from-file=jwt.js="$NGINX_DIR/jwt.js" --from-file=metrics.js="$NGINX_DIR/metrics.js"
configmap loki-config     --from-file=loki-config.yml="$CONFIG_DIR/loki/loki-config.yml"
configmap prometheus-config \
  --from-file=prometheus.yml="$CONFIG_DIR/prometheus/prometheus.yml" \
  --from-file=alert-rules.yml="$CONFIG_DIR/prometheus/alert-rules.yml"
configmap alertmanager-config --from-file=alertmanager.yml="$CONFIG_DIR/alertmanager/alertmanager.yml"
configmap promtail-config --from-file=promtail-config.yml="$CONFIG_DIR/promtail/promtail-config.yml"

# -- Deploy -------------------------------------------------------------------

# Ensure plugin hostPath directories exist on data volume. The minikube
# mount-string maps $DATA_DIR onto itself, so the path is identical on
# both sides — feeding it through with quotes (single-quoted command
# template, then expanded shellword) keeps the var available inside the VM.
mk minikube ssh --profile="$PROFILE" -- "sudo mkdir -p ${DATA_DIR}/plugins-data/builds ${DATA_DIR}/plugins-data/uploads && sudo chown -R 1000:1000 ${DATA_DIR}/plugins-data"

log "Applying Kubernetes manifests"
mk kubectl apply -k "$K8S_DIR"

log "Post-deploy fixups"
mk minikube ssh --profile="$PROFILE" -- "sudo chown -R 1000:1000 ${DATA_DIR}/registry-data"
REGISTRY_IP=$(mk kubectl get svc registry -n "$NS" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
[ -n "$REGISTRY_IP" ] && mk minikube ssh --profile="$PROFILE" -- \
  "T=\$(mktemp); grep -q '\\sregistry\$' /etc/hosts && { grep -v '\\sregistry\$' /etc/hosts > \"\$T\"; echo '$REGISTRY_IP registry' >> \"\$T\"; sudo cp \"\$T\" /etc/hosts; rm -f \"\$T\"; } || echo '$REGISTRY_IP registry' | sudo tee -a /etc/hosts >/dev/null"
echo "  registry -> ${REGISTRY_IP:-unknown}"

# -- Wait for pods ------------------------------------------------------------

log "Waiting for pods"
mk kubectl wait --for=condition=Ready pod -l app=postgres -n "$NS" --timeout=180s 2>/dev/null || echo "  postgres not ready"
mk kubectl wait --for=condition=Ready pod -l app=mongodb  -n "$NS" --timeout=180s 2>/dev/null || echo "  mongodb not ready"
mk kubectl wait --for=condition=Ready pod -l app -n "$NS" --timeout=300s 2>/dev/null || true

echo ""
mk kubectl get pods -n "$NS" -o wide

# -- iptables (root only) ----------------------------------------------------

if [ "$(id -u)" = "0" ]; then
  log "Setting up iptables"
  MINIKUBE_IP=$(mk minikube ip --profile="$PROFILE" 2>/dev/null || true)
  if [ -n "$MINIKUBE_IP" ]; then
    IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p')
    IF="${IF:-eth0}"
    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

    for port_pair in "443:30443" "80:30080"; do
      EXT="${port_pair%%:*}"; INT="${port_pair##*:}"
      iptables -t nat -D PREROUTING -i "$IF" -p tcp --dport "$EXT" -j DNAT --to-destination "${MINIKUBE_IP}:${INT}" 2>/dev/null || true
      iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport "$INT" -j ACCEPT 2>/dev/null || true
      iptables -t nat -A PREROUTING -i "$IF" -p tcp --dport "$EXT" -j DNAT --to-destination "${MINIKUBE_IP}:${INT}"
      iptables -I FORWARD 1 -d "$MINIKUBE_IP" -p tcp --dport "$INT" -j ACCEPT
    done
    iptables -t nat -C POSTROUTING -o "$IF" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o "$IF" -j MASQUERADE
    iptables-save > /etc/sysconfig/iptables 2>/dev/null || true
    echo "  ${IF}: 443→${MINIKUBE_IP}:30443, 80→${MINIKUBE_IP}:30080"
  fi
fi

# -- Summary ------------------------------------------------------------------

log "Access URLs"
if [ -n "$DOMAIN" ]; then
  echo "  Application:   https://${DOMAIN}"
  echo "  Mongo Express: https://${DOMAIN}/mongo-express/"
  echo "  pgAdmin:       https://${DOMAIN}/pgadmin/"
else
  IP=$(mk minikube ip --profile="$PROFILE" 2>/dev/null || echo "unknown")
  echo "  HTTPS: https://$IP:30443   HTTP: http://$IP:30080"
fi
echo "  Credentials: see $ENV_FILE"
