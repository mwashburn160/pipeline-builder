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
# VM-side mount target. Laptop-style /data/* to mirror local docker-compose
# (host ./data/* → container /data/*). The minikube k8s hostPath manifests
# use this same path. ec2's manifests use /opt/pipeline/pipeline-data
# because that's the canonical EBS mount on a production-style host.
VM_DATA_DIR="/data"

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
mkdir -p "$DATA_DIR"/{db-data/{postgres,mongodb,loki,prometheus},registry-data,pgadmin-data,tmp} 2>/dev/null || true
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-$VM_DATA_DIR/plugins-data/builds}"

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
# Detect CPU and memory independently: `nproc` can be present on macOS via
# Homebrew coreutils, so don't infer the OS from it — probe /proc/meminfo
# (Linux) vs hw.memsize (darwin) for memory separately.
if command -v nproc >/dev/null 2>&1; then
  TOTAL_CPU=$(nproc)
else
  TOTAL_CPU=$(sysctl -n hw.ncpu)
fi
if [ -r /proc/meminfo ]; then
  TOTAL_MEM=$(($(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024))
else
  TOTAL_MEM=$(($(sysctl -n hw.memsize) / 1024 / 1024))
fi
# The docker driver runs minikube inside the Docker VM, whose envelope
# (Docker Desktop on macOS, cgroup limits on Linux) is often smaller than
# the host — e.g. a 16G Mac with Docker Desktop capped at ~8G. Clamp to
# what `docker info` exposes so we never request more memory/CPU than the
# VM has and trip minikube's MK_USAGE guard.
if command -v docker >/dev/null 2>&1; then
  DOCKER_CPU=$(docker info --format '{{.NCPU}}' 2>/dev/null || echo 0)
  DOCKER_MEM=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  DOCKER_MEM=$((DOCKER_MEM / 1024 / 1024))  # bytes -> MiB
  if [ "$DOCKER_CPU" -gt 0 ] && [ "$DOCKER_CPU" -lt "$TOTAL_CPU" ]; then
    TOTAL_CPU=$DOCKER_CPU
  fi
  if [ "$DOCKER_MEM" -gt 0 ] && [ "$DOCKER_MEM" -lt "$TOTAL_MEM" ]; then
    TOTAL_MEM=$DOCKER_MEM
  fi
fi
MK_CPUS=$((TOTAL_CPU > 2 ? TOTAL_CPU - 1 : 2))
# Memory: reserve 4 GiB for host (kernel + docker daemon + monitoring +
# burst headroom) and give the rest to minikube — but never less than
# 75% on small laptops where 4 GiB would over-reserve. See the EC2
# startup.sh for the per-instance breakdown.
MK_MEM_BY_RATIO=$((TOTAL_MEM * 75 / 100))
MK_MEM_BY_RESERVE=$((TOTAL_MEM - 4096))
MK_MEM=$(( MK_MEM_BY_RATIO > MK_MEM_BY_RESERVE ? MK_MEM_BY_RATIO : MK_MEM_BY_RESERVE ))
echo "  System: ${TOTAL_CPU} CPUs, ${TOTAL_MEM}M → Minikube: ${MK_CPUS} CPUs, ${MK_MEM}M, 30g disk"

# The full namespace (~3.3 cores of services) plus build pods is tight
# under 8 GiB. Warn early with an actionable message rather than letting a
# pod OOM or a build stall mid-run. On the docker driver this envelope is
# the Docker VM, not the host — raise it in Docker Desktop → Resources.
RECOMMENDED_MEM=8192
if [ "$TOTAL_MEM" -lt "$RECOMMENDED_MEM" ]; then
  echo "  WARNING: only ${TOTAL_MEM}M available (recommended >= ${RECOMMENDED_MEM}M)."
  echo "  WARNING: the stack will run but builds may be slow and a 2nd plugin"
  echo "  WARNING: replica may not fit. Raise Docker Desktop memory (Settings ->"
  echo "  WARNING: Resources) to give minikube more headroom."
fi

MK_ARGS=(--profile="$PROFILE" --cpus="$MK_CPUS" --memory="$MK_MEM" --disk-size=30g --driver=docker --mount --mount-string="$DATA_DIR:$VM_DATA_DIR")

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

# The minikube-bundled metrics-server doesn't set --kubelet-insecure-tls,
# but the minikube node uses a self-signed kubelet cert. Without the
# flag every scrape fails silently with "x509: cannot validate certificate"
# and every HPA logs FailedGetResourceMetric. Patch the deployment so the
# flag is appended; idempotent (re-running on an already-patched deploy
# just appends a duplicate, which is harmless and clobbered on rollout).
kubectl -n kube-system patch deploy metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
  2>/dev/null || echo "  metrics-server patch skipped (already patched or not yet rolled out)"

kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.16.1/keda-2.16.1.yaml
kubectl wait --for=condition=Available deployment/keda-operator -n keda --timeout=120s 2>/dev/null || echo "  KEDA not ready yet"
echo "  Addons + KEDA installed"

# -- Namespace + Secrets + ConfigMaps -----------------------------------------

log "Creating namespace + secrets + configmaps"
kube create namespace "$NS"

# app-env ConfigMap from .env. The plugin service uses a rootless buildkitd
# sidecar (single build path — no strategy switch).
# Use envsubst to safely expand variables without eval
CLEAN_ENV=$(mktemp); trap 'rm -f "$CLEAN_ENV"' EXIT
grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | envsubst > "$CLEAN_ENV"
configmap app-env --from-env-file="$CLEAN_ENV"
rm -f "$CLEAN_ENV"

# Secrets
secret jwt-secret        --from-literal=JWT_SECRET="$JWT_SECRET" --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET"
secret postgres-secret   --from-literal=POSTGRES_USER="$POSTGRES_USER" --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" --from-literal=DB_USER="$DB_USER" --from-literal=DB_PASSWORD="$DB_PASSWORD"
secret mongodb-secret    --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" --from-literal=MONGODB_URI="$MONGODB_URI"
secret mongo-express-secret --from-literal=ME_CONFIG_BASICAUTH_USERNAME="$ME_CONFIG_BASICAUTH_USERNAME" --from-literal=ME_CONFIG_BASICAUTH_PASSWORD="$ME_CONFIG_BASICAUTH_PASSWORD"
secret pgadmin-secret    --from-literal=PGADMIN_DEFAULT_EMAIL="$PGADMIN_DEFAULT_EMAIL" --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_DEFAULT_PASSWORD"

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

# Prefer mkcert: it issues a browser-trusted leaf via a local CA it installs
# into the OS/browser trust stores, so https on localhost has no cert warnings
# (no ERR_CERT_AUTHORITY_INVALID on the JS chunks). Falls back to a hardened
# self-signed cert — `extendedKeyUsage=serverAuth` + `basicConstraints` let it
# be trusted once imported. See deploy/local/README Troubleshooting.
if command -v mkcert >/dev/null 2>&1; then
  mkcert -install >/dev/null 2>&1 || true
  mkcert -cert-file "$CERT_DIR/nginx-tls.crt" -key-file "$CERT_DIR/nginx-tls.key" \
    localhost 127.0.0.1 ::1 2>&1
else
  # SAN/EKU via a temp config so this works on both OpenSSL and the LibreSSL
  # shipped by older macOS (which lacks `req -addext`).
  _sancnf=$(mktemp)
  cat > "$_sancnf" <<'SANEOF'
[req]
distinguished_name = dn
x509_extensions = v3ext
prompt = no
[dn]
CN = localhost
[v3ext]
subjectAltName = DNS:localhost,IP:127.0.0.1
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
SANEOF
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout "$CERT_DIR/nginx-tls.key" -out "$CERT_DIR/nginx-tls.crt" \
    -config "$_sancnf" 2>&1
  rm -f "$_sancnf"
fi
chmod 644 "$CERT_DIR/nginx-tls.key"
kube create secret tls nginx-tls-secret --cert="$CERT_DIR/nginx-tls.crt" --key="$CERT_DIR/nginx-tls.key" -n "$NS"

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
configmap prometheus-config \
  --from-file=prometheus.yml="$CONFIG_DIR/prometheus/prometheus.yml" \
  --from-file=alert-rules.yml="$CONFIG_DIR/prometheus/alert-rules.yml"
configmap alertmanager-config --from-file=alertmanager.yml="$CONFIG_DIR/alertmanager/alertmanager.yml"
configmap promtail-config --from-file=promtail-config.yml="$CONFIG_DIR/promtail/promtail-config.yml"

# -- Deploy -------------------------------------------------------------------

# Ensure plugin hostPath directories exist on data volume.
minikube ssh --profile="$PROFILE" -- "sudo mkdir -p ${VM_DATA_DIR}/plugins-data/builds ${VM_DATA_DIR}/plugins-data/uploads && sudo chown -R 1000:1000 ${VM_DATA_DIR}/plugins-data"

log "Applying Kubernetes manifests"
kubectl apply -k "$K8S_DIR"

log "Post-deploy fixups"
REGISTRY_IP=$(kubectl get svc registry -n "$NS" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
[ -n "$REGISTRY_IP" ] && minikube ssh --profile="$PROFILE" -- \
  "T=\$(mktemp); grep -q '\\sregistry\$' /etc/hosts && { grep -v '\\sregistry\$' /etc/hosts > \"\$T\"; echo '$REGISTRY_IP registry' >> \"\$T\"; sudo cp \"\$T\" /etc/hosts; rm -f \"\$T\"; } || echo '$REGISTRY_IP registry' | sudo tee -a /etc/hosts >/dev/null"
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

# Gateway: forward 8443 (HTTPS) ONLY. Binding 8080 too made the WHOLE forward
# fail whenever either port was busy (e.g. a leftover bind from a local stack on
# 8443/8080), silently killing the gateway while the single-port forwards below
# survived — leaving https://localhost:8443 unreachable. The HTTP→HTTPS redirect
# on 8080 isn't needed for the API/UI (use the NodePort if you want it).
port_forward "Nginx"          nginx            "8443:8443"
port_forward "Mongo Express"  mongo-express    "8081:8081"
port_forward "pgAdmin"        pgadmin          "5480:80"
# Registry UI is served via the platform frontend at /dashboard/registry
# (sysadmin only) — no separate joxit/registry-express port-forward.

# Verify gateway
for i in $(seq 1 5); do
  curl -sk -o /dev/null https://localhost:8443/health 2>/dev/null && { echo "  Gateway reachable"; break; }
  [ "$i" = "5" ] && echo "  WARNING: Gateway not reachable"
  sleep 2
done

# -- Summary ------------------------------------------------------------------

MK_IP=$(minikube ip --profile="$PROFILE" 2>/dev/null || echo "unknown")

log "Deployment Complete — Minikube"
echo ""
echo "  Platform UI / API : https://localhost:8443       (NodePort: https://$MK_IP:30443)"
echo "  Default admin     : admin@internal  (set the password during init-platform)"
echo ""
echo "  Dev tools           port-forward (localhost)      NodePort (minikube):"
echo "    Mongo Express   : http://localhost:8081         http://$MK_IP:30081"
echo "    pgAdmin         : http://localhost:5480         http://$MK_IP:30480"
echo "    Registry browser: https://localhost:8443/dashboard/registry  (sysadmin)"
echo ""
echo "  Databases (postgres / mongodb / redis) run in-cluster — reach them via the"
echo "  dev tools above. Credentials live in $ENV_FILE."
echo ""
echo "  Next : ./deploy/bin/init-platform.sh minikube   # register admin + (opt-in) load plugins/samples/compliance"
echo "  Stop port-forwards : pkill -f 'kubectl port-forward.*-n $NS'"
