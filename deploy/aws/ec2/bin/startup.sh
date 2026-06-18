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
BIN_DIR="$(cd "$SCRIPT_DIR/../../../bin" && pwd)"   # deploy/bin (shared cert/key helpers)
NAMESPACE="pipeline-builder"
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

log() { echo ""; echo "=== $1 ==="; }

# Shared Secret/ConfigMap creators (deploy/bin/k8s-resources.sh). PB_KUBECTL runs kubectl as
# the minikube user via the `mk` function above, so applies happen as the cluster owner.
PB_KUBECTL="mk kubectl"; PB_NAMESPACE="$NAMESPACE"
. "$BIN_DIR/k8s-resources.sh"

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
# buildkitd sidecar memory limit (the build cgroup). Set in .env to override;
# default 3Gi — fits every allowed instance (t3.xlarge 16G/~12G minikube up to
# m5.4xlarge), leaving room for the rest of the single-node stack. envsubst has
# no `:-default`, so the fallback lives here.
: "${BUILDKIT_MEMORY_LIMIT:=3072Mi}"; export BUILDKIT_MEMORY_LIMIT

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
pb_kube_apply create namespace "$NAMESPACE"

# app-env ConfigMap from .env. The plugin service uses a rootless buildkitd
# sidecar (single build path — no strategy switch).
# Use envsubst to safely expand variables without eval
CLEAN_ENV=$(mktemp); trap 'rm -f "$CLEAN_ENV"' EXIT
grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | envsubst > "$CLEAN_ENV"
chmod 644 "$CLEAN_ENV"
pb_app_env_configmap "$CLEAN_ENV"
rm -f "$CLEAN_ENV"

# Application secrets + optional GHCR pull secret (shared creators).
pb_create_app_secrets
pb_create_ghcr_secret

# -- Registry token-signing keypair ------------------------------------------
# The gateway no longer terminates TLS — the ALB does, with an ACM cert — so
# there is NO nginx-tls-secret and no gateway cert on the box. nginx serves
# plain HTTP on the NodePort; the ALB forwards to it. Only the image-registry
# token-signing keypair (unrelated to gateway TLS) is created here.

log "Creating registry token-signing keypair"
mkdir -p "$CERT_DIR"
chown root:minikube "$CERT_DIR"

# JWT signing keypair for image-registry's token-auth endpoint (shared generator), then the
# registry secrets (token keypair + build-svc Basic-auth creds). No htpasswd/registry-auth-secret
# — the registry uses token auth (REGISTRY_AUTH=token); nothing mounts registry.passwd.
bash "$BIN_DIR/jwt-keys.sh" "$CERT_DIR"
pb_create_registry_secrets "$CERT_DIR/image-registry-jwt.key" "$CERT_DIR/image-registry-jwt.crt"
echo "  registry token-signing keypair done"

# -- ConfigMaps ---------------------------------------------------------------

log "Creating ConfigMaps"
pb_create_config_maps "$DEPLOY_DIR" "$CONFIG_DIR" "$NGINX_DIR"

# -- Deploy -------------------------------------------------------------------

# Ensure plugin hostPath directories exist on data volume. The minikube
# mount-string maps $DATA_DIR onto itself, so the path is identical on
# both sides — feeding it through with quotes (single-quoted command
# template, then expanded shellword) keeps the var available inside the VM.
mk minikube ssh --profile="$PROFILE" -- "sudo mkdir -p ${DATA_DIR}/plugins-data/builds ${DATA_DIR}/plugins-data/uploads && sudo chown -R 1000:1000 ${DATA_DIR}/plugins-data"

log "Applying Kubernetes manifests"
# Restricted envsubst: ONLY ${BUILDKIT_MEMORY_LIMIT} is expanded, so runtime
# shell tokens in inline configmaps (nginx ${NS}/$s, etc.) are left intact.
mk kubectl kustomize "$K8S_DIR" | envsubst '${BUILDKIT_MEMORY_LIMIT}' | mk kubectl apply -f -

log "Post-deploy fixups"
mk minikube ssh --profile="$PROFILE" -- "sudo chown -R 1000:1000 ${DATA_DIR}/registry-data"
REGISTRY_IP=$(mk kubectl get svc registry -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
[ -n "$REGISTRY_IP" ] && mk minikube ssh --profile="$PROFILE" -- \
  "T=\$(mktemp); grep -q '\\sregistry\$' /etc/hosts && { grep -v '\\sregistry\$' /etc/hosts > \"\$T\"; echo '$REGISTRY_IP registry' >> \"\$T\"; sudo cp \"\$T\" /etc/hosts; rm -f \"\$T\"; } || echo '$REGISTRY_IP registry' | sudo tee -a /etc/hosts >/dev/null"
echo "  registry -> ${REGISTRY_IP:-unknown}"

# -- Wait for pods ------------------------------------------------------------

log "Waiting for pods"
mk kubectl wait --for=condition=Ready pod -l app=postgres -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  postgres not ready"
mk kubectl wait --for=condition=Ready pod -l app=mongodb  -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  mongodb not ready"
mk kubectl wait --for=condition=Ready pod -l app -n "$NAMESPACE" --timeout=300s 2>/dev/null || true

echo ""
mk kubectl get pods -n "$NAMESPACE" -o wide

# -- iptables (root only) ----------------------------------------------------

if [ "$(id -u)" = "0" ]; then
  log "Setting up iptables"
  MINIKUBE_IP=$(mk minikube ip --profile="$PROFILE" 2>/dev/null || true)
  if [ -n "$MINIKUBE_IP" ]; then
    IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p')
    IF="${IF:-eth0}"
    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

    # Single HTTP bridge: the ALB connects to this instance's primary IP on
    # 30080 (the nginx NodePort); DNAT it to the minikube node IP:30080. No
    # TLS/443 rule — the ALB terminates TLS and only ever forwards plain HTTP
    # to 30080. Identity port (30080→30080) so the ALB health check and real
    # traffic traverse the same path.
    iptables -t nat -D PREROUTING -i "$IF" -p tcp --dport 30080 -j DNAT --to-destination "${MINIKUBE_IP}:30080" 2>/dev/null || true
    iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30080 -j ACCEPT 2>/dev/null || true
    iptables -t nat -A PREROUTING -i "$IF" -p tcp --dport 30080 -j DNAT --to-destination "${MINIKUBE_IP}:30080"
    iptables -I FORWARD 1 -d "$MINIKUBE_IP" -p tcp --dport 30080 -j ACCEPT
    iptables -t nat -C POSTROUTING -o "$IF" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o "$IF" -j MASQUERADE
    iptables-save > /etc/sysconfig/iptables 2>/dev/null || true
    echo "  ${IF}: 30080→${MINIKUBE_IP}:30080 (ALB target bridge)"
  fi
fi

# -- Summary ------------------------------------------------------------------

log "Access URLs (via the ALB — TLS terminated there with the ACM cert)"
echo "  Application:   https://${DOMAIN}"
echo "  Mongo Express: https://${DOMAIN}/mongo-express/"
echo "  pgAdmin:       https://${DOMAIN}/pgadmin/"
echo "  Credentials: see $ENV_FILE"
