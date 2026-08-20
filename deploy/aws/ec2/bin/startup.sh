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
# Istio ambient mesh version (ambient-GA >= 1.24). istioctl must be installed on
# the instance and on the minikube user's PATH (it runs via the `mk` wrapper).
ISTIO_VERSION="${ISTIO_VERSION:-1.30.3}"
# LEAN=1 drops the optional observability + admin services (prometheus, thanos,
# loki, promtail, jaeger, alertmanager, mongo-express, pgadmin) from the apply and
# collapses workloads to a single replica, so the core stack + Istio mesh fits a
# SMALLER instance (t3.xlarge / 4 vCPU) instead of needing t3.2xlarge. Core services
# + DBs are unaffected. Full stack is the default (LEAN=0) for t3.2xlarge+.
# Accept the CFN/boolean spellings too (the `Lean` stack param passes true/false).
LEAN="${LEAN:-0}"
case "$LEAN" in 1|true|TRUE|True|yes|y) LEAN=1 ;; *) LEAN=0 ;; esac
# Minikube VM disk size. Applied only at cluster CREATE — grow it by re-running
# after a delete. Keep it within the instance's EBS data volume (500Gi default).
# 80g leaves ~2x headroom over the steady node footprint (buildkit cache bounded
# to ~16Gi by the buildkitd GC policy + container images + OS ≈ 35-40Gi); the
# buildkit GC in plugin.yaml is what prevents unbounded growth, this is cushion.
DISK_SIZE="${DISK_SIZE:-80g}"
# RECREATE: when an existing cluster is found, whether to rebuild it. Unset + a TTY
# → prompt (default: resume). RECREATE=y rebuilds the cluster; RECREATE=n (or unset
# on the usual headless run) resumes. Data lives on the host $DATA_DIR and is kept
# either way — to truly wipe, clear $DATA_DIR on the host before re-running.
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

# lean_filter — with LEAN=1, drop the optional observability/admin workloads from
# the kustomize stream (their Deployment/StatefulSet/DaemonSet/Service/PV/PVC/HPA/
# PDB/ServiceAccount/ConfigMap docs) so no pods schedule for them. Kept: everything
# else, incl. AuthZ/NetworkPolicy docs that merely reference them (harmless, no pod).
# With LEAN=0 it's a pass-through (cat). Pure awk/sed — runs on the host side of the
# apply pipe (the apply itself still goes through `mk kubectl`).
lean_filter() {
  if [ "$LEAN" != "1" ]; then cat; return; fi
  awk '
    function emit(  o,d) {
      o = (nm ~ /^(prometheus|loki|thanos-query|thanos-store-gateway|alertmanager|promtail|jaeger|mongo-express|pgadmin)(-.*)?$/)
      d = (kd ~ /^(Deployment|StatefulSet|DaemonSet|Service|PersistentVolume|PersistentVolumeClaim|HorizontalPodAutoscaler|PodDisruptionBudget|ServiceAccount|ConfigMap|ClusterRole|ClusterRoleBinding|Role|RoleBinding)$/)
      if (buf != "" && !(o && d)) printf "---\n%s", buf
      buf=""; kd=""; nm=""
    }
    /^---$/ { emit(); next }
    { buf = buf $0 "\n"; if ($1=="kind:") kd=$2; if ($0 ~ /^  name: / && nm=="") nm=$2 }
    END { emit() }
  ' | sed -E 's/^(  replicas:) [0-9]+/\1 1/; s/^(  (min|max)Replicas:) [0-9]+/\1 1/; s/^(  (min|max)ReplicaCount:) [0-9]+/\1 1/'
  # ^ also collapse every workload/HPA/ScaledObject to a single replica: on a lean
  #   (smaller) instance the core stack + mesh already fills the node, so 2nd replicas
  #   just sit Pending. (spec-level fields are 2-space; the ScaledObject `fallback`
  #   replicas is deeper-indented and intentionally left alone.)
}

# Shared helpers (preflight, ensure_istioctl). Sourcing common.sh cd's to /tmp —
# every path here is absolute, so that's safe.
# shellcheck source=../../../bin/common.sh
. "$BIN_DIR/common.sh"

# Shared Secret/ConfigMap creators (deploy/bin/k8s-resources.sh). PB_KUBECTL runs kubectl as
# the minikube user via the `mk` function above, so applies happen as the cluster owner.
# PB_KUBECTL/PB_NAMESPACE are consumed by the sourced k8s-resources.sh (shellcheck
# can't see the cross-file use).
# shellcheck disable=SC2034
PB_KUBECTL="mk kubectl"
# shellcheck disable=SC2034
PB_NAMESPACE="$NAMESPACE"
. "$BIN_DIR/k8s-resources.sh"

# Fail fast if a core tool is missing. bootstrap.sh installs these on first boot;
# a standalone re-run on a fresh box then gets ONE clear error instead of failing
# deep in the bring-up. (istioctl is handled separately by ensure_istioctl.)
preflight kubectl minikube docker openssl

cleanup_docker() {
  mk docker rm -f "$PROFILE" 2>/dev/null || true
  mk docker network rm "$PROFILE" 2>/dev/null || true
  mk docker network prune -f >/dev/null 2>&1 || true
}

# -- Load .env ----------------------------------------------------------------

[ -f "$DEPLOY_DIR/.env" ] || { echo "ERROR: No .env — run bootstrap.sh first" >&2; exit 1; }
ENV_FILE="$DEPLOY_DIR/.env"
log "Loading environment"
set -a
# shellcheck source=/dev/null  # ENV_FILE is a runtime path, not statically analyzable
. "$ENV_FILE"
set +a
# buildkitd sidecar memory limit (the build cgroup). Set in .env to override;
# default 3Gi — fits every allowed instance (t3.xlarge 16G/~12G minikube up to
# m5.4xlarge), leaving room for the rest of the single-node stack. envsubst has
# no `:-default`, so the fallback lives here.
: "${BUILDKIT_MEMORY_LIMIT:=3072Mi}"; export BUILDKIT_MEMORY_LIMIT

# Grant minikube user read access to deploy assets (manifests, configs, nginx)
# Exclude .env and auth dirs which contain secrets
if [ "$(id -u)" = "0" ]; then
  # DIRECTORIES must stay TRAVERSABLE (execute bit) for the minikube-user reader
  # (`mk kubectl`). A recursive `chmod 644` over the deploy tree — or a checkout
  # that lost dir x-bits — leaves directories at 0644, which cannot be traversed
  # even by their owner, so a later read of a ConfigMap/cert *source file* dies
  # with "permission denied" ("no objects passed to apply") even though the FILE
  # itself is 0644-readable. Restore dir execute bits WITHOUT touching file modes
  # (the 644 TLS/JWT key files stay 644): `+X` adds x only to directories (and
  # already-executable files). Covers the full deploy path the reader traverses.
  find "$DEPLOY_DIR" -type d -exec chmod a+rX {} + 2>/dev/null || true
  chmod -R o+rX "$DEPLOY_DIR/k8s" "$DEPLOY_DIR/config" "$DEPLOY_DIR/nginx" 2>/dev/null || true
  # Give .env to the minikube user (who owns and runs the stack) and keep it
  # READABLE (0644) so `startup.sh` re-run as ANY login user — root, minikube,
  # or the default ec2-user/ssm-user — can source it at `. "$ENV_FILE"`. On this
  # single-node box the whole deploy tree (incl. TLS/JWT keys) is intentionally
  # 644; locking .env to 0600/root left non-owner re-runs dying with
  # "Permission denied" at line 56.
  chown minikube:minikube "$DEPLOY_DIR/.env" 2>/dev/null || true
  chmod 644 "$DEPLOY_DIR/.env" 2>/dev/null || true
fi
# Generate the MongoDB replica-set keyfile per-deploy (idempotent; a fresh
# checkout no longer ships one). pb_create_config_maps below reads it directly.
# shellcheck source=/dev/null
. "$BIN_DIR/mongo-keyfile.sh"
pb_ensure_mongo_keyfile "$DEPLOY_DIR/mongodb-keyfile"
if [ -f "$DEPLOY_DIR/mongodb-keyfile" ]; then
  chmod 400 "$DEPLOY_DIR/mongodb-keyfile"
  # pb_create_config_maps slurps this file into the `mongodb-keyfile` Secret by
  # running kubectl AS the minikube user (mk = `sudo -u minikube`). A root-owned
  # 0400 keyfile is unreadable by minikube → "open …: permission denied" → the
  # secret gets no input ("no objects passed to apply"). Hand the file to
  # minikube so its owner-only read still applies to the kubectl reader. The
  # keyfile stays 0400 (never loosened to 0644 like the TLS/JWT keys), and the
  # container's mounted copy is independently chmod 400 + chown 999 in
  # mongodb.yaml, so host ownership doesn't weaken Mongo's keyfile security.
  [ "$(id -u)" = "0" ] && chown minikube "$DEPLOY_DIR/mongodb-keyfile" 2>/dev/null || true
fi

# -- istioctl (Istio ambient mesh) --------------------------------------------
# Guarantee istioctl the SAME way as the eks/minikube targets: the shared
# ensure_istioctl auto-installs $ISTIO_VERSION to /usr/local/bin if the box has
# none (or too old). This runs as root on first boot (no sudo needed), and the
# mesh install below runs it via `mk` (minikube user), which shares that PATH.
ensure_istioctl "$ISTIO_VERSION"

# -- Data directories ---------------------------------------------------------

# Pre-seed the hostPath dirs the manifests mount (all DirectoryOrCreate, so this
# is a convenience). alertmanager IS mounted; minio runs a 4-drive erasure-set.
# (No db-data/loki — Loki uses object storage + an in-pod emptyDir WAL.)
mkdir -p "$DATA_DIR"/{db-data/{postgres,mongodb,prometheus,alertmanager},minio-data/{1,2,3,4},pgadmin-data,tmp} 2>/dev/null || true
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-$DATA_DIR/plugins-data}"

# -- Start Minikube -----------------------------------------------------------
# NOTE: docker cleanup (removing a stale container/network) is deferred to the
# create/recreate paths below — it must NEVER run before a RESUME. Removing the
# `pipeline-builder` docker network here orphans the running cluster's container,
# so the resume then fails with "failed to set up container networking:
# network … not found".

log "Detecting resources"
TOTAL_CPU=$(nproc)
TOTAL_MEM=$(($(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024))
MK_CPUS=$((TOTAL_CPU > 2 ? TOTAL_CPU - 1 : 2))
# Memory: reserve 4 GiB for host (kernel + docker daemon + ssh/cron +
# burst headroom) and give the rest to minikube — but never less than
# 75% on small instances where 4 GiB would over-reserve. The Istio ambient
# mesh (istiod + ztunnel) adds ~0.3-0.7G in istio-system, so t3.xlarge is the
# recommended minimum with the mesh enabled; t3.large is tight.
#   t3.large   (8G)   → max(6G,    8-4=4G)  = 6G   minikube,  2G  host
#   t3.xlarge  (16G)  → max(12G,   16-4=12G) = 12G minikube,  4G  host
#   t3.2xlarge (32G)  → max(24G,   32-4=28G) = 28G minikube,  4G  host  ← was 24G
#   m5.4xlarge (64G)  → max(48G,   64-4=60G) = 60G minikube,  4G  host  ← was 48G
MK_MEM_BY_RATIO=$((TOTAL_MEM * 75 / 100))
MK_MEM_BY_RESERVE=$((TOTAL_MEM - 4096))
MK_MEM=$(( MK_MEM_BY_RATIO > MK_MEM_BY_RESERVE ? MK_MEM_BY_RATIO : MK_MEM_BY_RESERVE ))
echo "  System: ${TOTAL_CPU} CPUs, ${TOTAL_MEM}M RAM → Minikube: ${MK_CPUS} CPUs, ${MK_MEM}M"

# The host-data MOUNT must be re-established on EVERY start (it's how the node sees
# the EC2 host's $DATA_DIR, where all DB/minio data lives); the sizing flags are
# CREATE-ONLY.
MK_MOUNT_ARGS=(--mount --mount-string="$DATA_DIR:$DATA_DIR")
MK_ARGS=(--profile="$PROFILE" --cpus="$MK_CPUS" --memory="$MK_MEM" --disk-size="$DISK_SIZE" --driver=docker "${MK_MOUNT_ARGS[@]}")

# RESUME an existing cluster with just the mount (no create-only sizing flags —
# those can exit non-zero on an existing cluster and trip a delete/recreate). A
# fresh cluster gets the full flags + fallback.
#
# RECREATE controls the existing-cluster path (parity with the minikube target):
#   unset + interactive TTY → prompt (default: resume); RECREATE=y|yes|true →
#   rebuild the cluster; RECREATE=n (or unset, non-interactive — the usual headless
#   bootstrap case) → resume. NOTE: $DATA_DIR lives on the EC2 HOST, so even a
#   recreate re-mounts the SAME data — to truly wipe, clear $DATA_DIR on the host.
RECREATE="${RECREATE:-}"

log "Starting Minikube"
if mk minikube profile list 2>/dev/null | grep -q "$PROFILE"; then
  if [ -z "$RECREATE" ] && [ -t 0 ]; then
    printf "An existing '%s' cluster was found. Recreate it (rebuild cluster; host data at %s is kept)? [y/N] " "$PROFILE" "$DATA_DIR"
    read -r RECREATE
  fi
  case "$RECREATE" in
    y|Y|yes|YES|true)
      log "Recreating Minikube cluster (host data at $DATA_DIR is preserved)"
      mk minikube delete --profile="$PROFILE" 2>/dev/null || true
      cleanup_docker
      mk minikube start "${MK_ARGS[@]}"
      ;;
    *)
      echo "  Resuming existing cluster (host data at $DATA_DIR preserved)"
      mk minikube start --profile="$PROFILE" "${MK_MOUNT_ARGS[@]}"
      ;;
  esac
else
  # Fresh create — clear any orphaned container/network from a prior half-deleted run.
  cleanup_docker
  if ! mk minikube start "${MK_ARGS[@]}"; then
    echo "  Retrying after cleanup..."
    mk minikube delete --profile="$PROFILE" 2>/dev/null || true
    cleanup_docker
    mk minikube start "${MK_ARGS[@]}"
  fi
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

# -- Istio ambient service mesh ----------------------------------------------
# Installed BEFORE the app manifests so istio-cni + ztunnel are ready when pods
# start. Single-node minikube (same substrate as local) — ambient installs
# trivially. STRICT mTLS + AuthorizationPolicies live in k8s/istio.yaml; the
# namespace is enrolled via the ambient label on namespace.yaml. Run as the
# minikube user (mk) like the rest of the cluster. See docs/service-mesh.md.
log "Installing Istio ambient mesh ($ISTIO_VERSION)"
# istioctl presence + version (>= 1.24) is already guaranteed by ensure_istioctl
# above (shared with the eks/minikube targets) — go straight to the install.
mk istioctl install --skip-confirmation \
  --set profile=ambient \
  --set "meshConfig.extensionProviders[0].name=jaeger" \
  --set "meshConfig.extensionProviders[0].opentelemetry.service=jaeger.${NAMESPACE}.svc.cluster.local" \
  --set "meshConfig.extensionProviders[0].opentelemetry.port=4317"
mk kubectl wait --for=condition=Available deployment/istiod -n istio-system --timeout=180s 2>/dev/null || echo "  istiod not ready yet"
mk kubectl rollout status daemonset/ztunnel -n istio-system --timeout=120s 2>/dev/null || echo "  ztunnel not ready yet"
mk kubectl rollout status daemonset/istio-cni-node -n istio-system --timeout=120s 2>/dev/null || echo "  istio-cni not ready yet"
echo "  Istio ambient installed (istiod + ztunnel + istio-cni). Recommend t3.xlarge+ with the mesh."

# -- Namespace + ConfigMap + Secrets ------------------------------------------

log "Creating namespace + secrets + configmaps"
pb_kube_apply create namespace "$NAMESPACE"

# app-env ConfigMap from .env. The plugin service uses a rootless buildkitd
# sidecar (single build path — no strategy switch).
# Expand ONLY the two intended refs (matches the eks target). An unrestricted
# envsubst would treat a literal `$` in any secret (bcrypt hash, password) as a
# variable and silently blank/corrupt it in the ConfigMap. POSIX `[[:space:]]`
# (not GNU-only `\s`) keeps the filter correct regardless of grep flavor.
CLEAN_ENV=$(mktemp); trap 'rm -f "$CLEAN_ENV"' EXIT
grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" | sed "s|[\$]{PLATFORM_FRONTEND_URL}|${PLATFORM_FRONTEND_URL}|g; s|[\$]{DOMAIN}|${DOMAIN}|g" > "$CLEAN_ENV"
# This temp file holds every secret from .env. `mk kubectl` reads it as the
# minikube user, so make it readable by that user only — not world (mktemp is 600
# root, which the minikube-user kubectl couldn't read; 644 would expose secrets).
chown minikube:minikube "$CLEAN_ENV"; chmod 600 "$CLEAN_ENV"
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
# Group the cert dir to minikube so `mk kubectl` (the minikube-user reader) can
# traverse it. Root-only: a non-root (minikube) run can't chown to root and would
# abort under `set -e` — and it doesn't need to (it already owns what it created;
# the JWT keys are 0644 and the dir 0755, so they stay readable regardless).
[ "$(id -u)" = "0" ] && chown root:minikube "$CERT_DIR" 2>/dev/null || true

# JWT signing keypair for image-registry's token-auth endpoint (shared generator), then the
# registry secrets (token keypair + build-svc Basic-auth creds). No htpasswd/registry-auth-secret
# — the registry uses token auth (REGISTRY_AUTH=token); nothing mounts registry.passwd.
bash "$BIN_DIR/jwt-keys.sh" "$CERT_DIR"
# Guarantee the minikube-user reader (pb_create_registry_secrets → mk kubectl)
# can TRAVERSE cert dir + READ the freshly-written keypair, regardless of the
# umask jwt-keys.sh created them under. Dir gets traverse bits; the key/crt keep
# the intended 0644 (readable). This is the exact read that was failing with
# "permission denied → no objects passed to apply" when a dir lost its x-bit.
if [ "$(id -u)" = "0" ]; then
  chmod a+rX "$CERT_DIR" 2>/dev/null || true
  chmod 644 "$CERT_DIR/image-registry-jwt.key" "$CERT_DIR/image-registry-jwt.crt" 2>/dev/null || true
fi
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
mk minikube ssh --profile="$PROFILE" -- "sudo mkdir -p ${DATA_DIR}/plugins-data && sudo chown -R 1000:1000 ${DATA_DIR}/plugins-data"

log "Applying Kubernetes manifests"
[ "$LEAN" = "1" ] && echo "  LEAN=1 — omitting optional observability + admin services (prometheus/thanos/loki/promtail/jaeger/alertmanager/mongo-express/pgadmin)"
# Restricted envsubst: ONLY ${BUILDKIT_MEMORY_LIMIT} is expanded, so runtime
# shell tokens in inline configmaps (nginx ${NS}/$s, etc.) are left intact.
# lean_filter drops optional workloads when LEAN=1 (pass-through otherwise).
mk kubectl kustomize "$K8S_DIR" | sed "s|[\$]{BUILDKIT_MEMORY_LIMIT}|${BUILDKIT_MEMORY_LIMIT}|g" | lean_filter | mk kubectl apply -f -

log "Post-deploy fixups"
mk minikube ssh --profile="$PROFILE" -- "sudo chown -R 1000:1000 ${DATA_DIR}/minio-data"
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
    # `|| true`: under set -e+pipefail, a failing `ip` makes the pipeline non-zero
    # and the bare assignment would abort BEFORE the eth0 fallback can engage.
    IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' || true)
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
# mongo-express / pgAdmin are omitted under LEAN=1 (no service behind these paths).
if [ "$LEAN" != "1" ]; then
  echo "  Mongo Express: https://${DOMAIN}/mongo-express/"
  echo "  pgAdmin:       https://${DOMAIN}/pgadmin/"
fi
echo "  Credentials: see $ENV_FILE"
