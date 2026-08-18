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
BIN_DIR="$(cd "$SCRIPT_DIR/../../../bin" && pwd)"   # deploy/bin (shared cert/key helpers)
NAMESPACE="pipeline-builder"
PROFILE="pipeline-builder"
DATA_DIR="$DEPLOY_DIR/data"
# Istio ambient mesh version. Must be ambient-GA (>= 1.24). Overridable; bump to
# the current stable at deploy time. The installed `istioctl` binary drives the
# install — keep it on the same minor.
ISTIO_VERSION="${ISTIO_VERSION:-1.30.3}"
# LEAN=1 drops the optional observability + admin services (prometheus, thanos,
# loki, promtail, jaeger, alertmanager, mongo-express, pgadmin) from the apply so
# the core stack + Istio mesh fits on an ~8-core laptop. Core services + DBs are
# unaffected. Full stack is the default (LEAN=0) for larger machines.
LEAN="${LEAN:-0}"
# Minikube VM disk size. Applied only at cluster CREATE — to grow an existing
# cluster you must `minikube delete --profile=pipeline-builder` and re-run.
# On the docker driver it's bounded by Docker Desktop's virtual-disk limit.
DISK_SIZE="${DISK_SIZE:-30g}"
# RECREATE: when an existing cluster is found, whether to WIPE it and start fresh.
# Unset + a TTY → the script prompts (default: keep data). RECREATE=y wipes /data
# and recreates (also lets sizing overrides like DISK_SIZE take effect); RECREATE=n
# (or unset on a non-interactive run) resumes and preserves data.
# In-VM data path for the k8s hostPath manifests. This is minikube's OWN
# persistent disk (/data) — data survives stop/start but is NOT mirrored to the
# host `data/` folder (minikube's /data shadows any host mount there, and DB data
# on a 9p mount is unreliable anyway). ec2's manifests use
# /opt/pipeline/pipeline-data (its EBS mount). See docs/deploy-operations.md.
VM_DATA_DIR="/data"

# -- Shared deploy helpers ----------------------------------------------------
# Sourced from deploy/bin so every target shares one implementation:
#   common.sh          → preflight (assert required tools up front)
#   gen-env-secrets.sh → pb_gen_env_secrets (fill CHANGE_ME secrets in .env)
#   mongo-keyfile.sh   → pb_ensure_mongo_keyfile (per-deploy replica-set keyfile)
# common.sh cd's to /tmp on source; every path below is absolute so that's safe.
. "$BIN_DIR/common.sh"
. "$BIN_DIR/gen-env-secrets.sh"
. "$BIN_DIR/mongo-keyfile.sh"

# Fail fast with ONE actionable error if a required CLI tool is missing.
preflight kubectl minikube openssl envsubst istioctl

# -- Helpers ------------------------------------------------------------------

kube() { kubectl "$@" --dry-run=client -o yaml | kubectl apply -f -; }
log()  { echo ""; echo "=== $1 ==="; }

# lean_filter — with LEAN=1, drop the optional observability/admin workloads from
# the kustomize stream (their Deployment/StatefulSet/DaemonSet/Service/PV/PVC/HPA/
# PDB/ServiceAccount/ConfigMap docs) so no pods schedule for them. Kept: everything
# else, incl. AuthZ/NetworkPolicy docs that merely reference them (harmless, no pod).
# With LEAN=0 it's a pass-through (cat).
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
  # ^ also collapse every workload/HPA/ScaledObject to a single replica: on an
  #   ~8-core laptop the core stack + mesh already fills the node, so 2nd replicas
  #   just sit Pending. (spec-level fields are 2-space; the ScaledObject `fallback`
  #   replicas is deeper-indented and intentionally left alone.)
}

secret() {
  local name="$1"; shift
  kube create secret generic "$name" "$@" -n "$NAMESPACE"
  echo "  $name"
}

configmap() {
  local name="$1"; shift
  kube create configmap "$name" "$@" -n "$NAMESPACE"
  echo "  $name"
}

cleanup_docker() {
  docker rm -f "$PROFILE" 2>/dev/null || true
  docker network rm "$PROFILE" 2>/dev/null || true
  docker network prune -f >/dev/null 2>&1 || true
}

port_forward() {
  local name="$1" svc="$2" ports="$3"
  kubectl port-forward "svc/$svc" "$ports" -n "$NAMESPACE" >/dev/null 2>&1 &
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
[ -z "$ENV_FILE" ] && [ -f "$DEPLOY_DIR/../docker/.env" ] && ENV_FILE="$(cd "$DEPLOY_DIR/../docker" && pwd)/.env"
# Auto-seed from the example on first run instead of hard-failing (matches the
# docker target). The example ships working local defaults; only optional keys
# (e.g. AI provider keys) need filling in.
if [ -z "$ENV_FILE" ]; then
  if [ -f "$DEPLOY_DIR/.env.example" ]; then
    cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
    ENV_FILE="$DEPLOY_DIR/.env"
    # Replace the CHANGE_ME secret placeholders with fresh random values right
    # away, so local never boots with literal CHANGE_ME credentials. Asserts
    # none remain (fails loudly if a placeholder drifted from the sed patterns).
    pb_gen_env_secrets "$DEPLOY_DIR/.env"
    # Local plugin images run on THIS host, so build for the host arch — the
    # shipped PUBLISH_PLATFORM default (linux/amd64) forces QEMU emulation on
    # Apple Silicon, where the Rust toolchain segfaults building the base image.
    case "$(uname -m)" in
      arm64|aarch64) echo "PUBLISH_PLATFORM=linux/arm64" >> "$DEPLOY_DIR/.env" ;;
      *)             echo "PUBLISH_PLATFORM=linux/amd64" >> "$DEPLOY_DIR/.env" ;;
    esac
    echo "No .env found — created $DEPLOY_DIR/.env from .env.example (local defaults, PUBLISH_PLATFORM pinned to host arch)." >&2
    echo "  Review it and set any optional keys (e.g. AI provider keys) before relying on those features." >&2
  else
    echo "ERROR: No .env found and no .env.example to seed from at $DEPLOY_DIR" >&2
    exit 1
  fi
fi

log "Loading environment from $ENV_FILE"
set -a; . "$ENV_FILE"; set +a
# buildkitd sidecar memory limit (the build cgroup). Set in .env to override;
# default 3072Mi — lower than the AWS tiers since this runs on a laptop.
# envsubst has no `:-default`, so the fallback lives here.
: "${BUILDKIT_MEMORY_LIMIT:=3072Mi}"; export BUILDKIT_MEMORY_LIMIT

# Generate the MongoDB replica-set keyfile per-deploy if absent (idempotent —
# skips if present). It's no longer committed, so a fresh checkout has none;
# the mongodb-keyfile Secret below is created from it, and the mongodb pod's
# init-container tightens perms to 400 at start.
pb_ensure_mongo_keyfile "$DEPLOY_DIR/mongodb-keyfile"
# Data lives on the minikube VM's own persistent /data disk — created by the
# hostPath `DirectoryOrCreate` mounts + the chown'd ssh mkdirs below — NOT on the
# host `data/` folder. minikube reserves /data for that persistent disk, which
# shadows any host 9p mount there, so we don't attempt one (see MK_ARGS). Data
# survives `minikube stop/start`; `minikube delete` wipes it. For host-side copies
# use `deploy/local/minikube/bin/backup.sh` (dumps via kubectl port-forward).
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-$VM_DATA_DIR/plugins-data}"

# -- Start Minikube -----------------------------------------------------------
# NOTE: docker cleanup (removing a stale container/network) is deferred to the
# create/recreate paths below — it must NEVER run before a RESUME. Removing the
# `pipeline-builder` docker network here (as an earlier unconditional
# `docker network rm` did) orphans the running cluster's container, so the resume
# then fails with "failed to set up container networking: network … not found".

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
  echo "  WARNING: the Istio ambient mesh adds ~0.3-0.7G (istiod + ztunnel in"
  echo "  WARNING: istio-system, outside the namespace ResourceQuota)."
fi

# No --mount: /data is minikube's reserved persistent disk, which shadows a host
# 9p mount there (it silently did nothing), and DB data on 9p is unreliable.
# Data stays on the VM disk (persists across stop/start). See the DOCKER_BUILD note above.
MK_ARGS=(--profile="$PROFILE" --cpus="$MK_CPUS" --memory="$MK_MEM" --disk-size="$DISK_SIZE" --driver=docker)

# RESUME an existing cluster vs CREATE a fresh one. The sizing flags
# (--cpus/--memory/--disk-size) are CREATE-TIME only — passing them to
# `minikube start` on an EXISTING cluster can exit non-zero (e.g. "cannot change
# the disk size of an existing cluster"), which would trip a delete-and-recreate
# and WIPE the persistent /data disk. So an existing profile is RESUMED with just
# the profile (preserving all DB/minio data across setup↔shutdown cycles), unless
# the operator explicitly asks to recreate.
#
# RECREATE controls the existing-cluster path:
#   unset + interactive TTY → prompt (default: resume/keep data)
#   RECREATE=y|yes|true     → delete the cluster + WIPE /data, then create fresh
#   RECREATE=n (or unset, non-interactive) → resume, keep data (safe default)
MK_PROFILE_DIR="${MINIKUBE_HOME:-$HOME/.minikube}/profiles/$PROFILE"
RECREATE="${RECREATE:-}"

if [ -f "$MK_PROFILE_DIR/config.json" ]; then
  # An existing cluster is present. Ask before doing anything destructive.
  if [ -z "$RECREATE" ] && [ -t 0 ]; then
    printf "An existing '%s' cluster was found. Recreate it (WIPES ALL DATA)? [y/N] " "$PROFILE"
    read -r RECREATE
  fi
  case "$RECREATE" in
    y|Y|yes|YES|true)
      log "Recreating Minikube cluster (deleting existing + ALL data)"
      minikube delete --profile="$PROFILE" 2>/dev/null || true
      cleanup_docker
      minikube start "${MK_ARGS[@]}"
      ;;
    *)
      log "Resuming existing Minikube cluster (preserving /data)"
      minikube start --profile="$PROFILE"
      ;;
  esac
else
  log "Creating Minikube cluster"
  # Clear any orphaned container/network from a prior half-deleted run before the
  # fresh create (there is no existing cluster to preserve on this path).
  cleanup_docker
  if ! minikube start "${MK_ARGS[@]}"; then
    echo "  Retrying after cleanup..."
    minikube delete --profile="$PROFILE" 2>/dev/null || true
    cleanup_docker
    minikube start "${MK_ARGS[@]}"
  fi
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

# -- Istio ambient service mesh ----------------------------------------------
# Installed BEFORE the app manifests so istio-cni + ztunnel are ready when pods
# start (ambient enrollment is dynamic, but starting pods after the CNI is up
# avoids a "not captured until restart" edge case). The namespace is enrolled
# via the `istio.io/dataplane-mode: ambient` label on namespace.yaml; STRICT
# mTLS + AuthorizationPolicies live in k8s/istio.yaml. Sidecar-less: no per-pod
# proxy, no changes to the hardened pod securityContexts. See docs/service-mesh.md.
# NOTE: the `minikube addons enable istio` addon is stale 1.5-era sidecar mode —
# we use istioctl with the ambient profile instead. The Jaeger extensionProvider
# is pre-wired (inert at L4) so a future waypoint can emit mesh traces.
log "Installing Istio ambient mesh ($ISTIO_VERSION)"
# Ambient needs istioctl >= 1.24 (the `ambient` profile ships in the binary).
# The preflight only checks presence, so verify the version here — an old binary
# otherwise dies with a cryptic "Asset profiles/ambient.yaml not found".
_ic_ver="$(istioctl version --remote=false 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)"
if [ -z "$_ic_ver" ] || [ "${_ic_ver%%.*}" -lt 1 ] || { [ "${_ic_ver%%.*}" -eq 1 ] && [ "${_ic_ver#*.}" -lt 24 ]; }; then
  echo "ERROR: istioctl '${_ic_ver:-unknown}' is too old for ambient — need >= 1.24 (ISTIO_VERSION=$ISTIO_VERSION)." >&2
  echo "       Upgrade: curl -L https://istio.io/downloadIstio | ISTIO_VERSION=$ISTIO_VERSION sh -" >&2
  echo "                sudo mv istio-$ISTIO_VERSION/bin/istioctl /usr/local/bin/istioctl" >&2
  exit 1
fi
istioctl install --skip-confirmation \
  --set profile=ambient \
  --set "meshConfig.extensionProviders[0].name=jaeger" \
  --set "meshConfig.extensionProviders[0].opentelemetry.service=jaeger.${NAMESPACE}.svc.cluster.local" \
  --set "meshConfig.extensionProviders[0].opentelemetry.port=4317"
kubectl wait --for=condition=Available deployment/istiod -n istio-system --timeout=180s 2>/dev/null || echo "  istiod not ready yet"
kubectl rollout status daemonset/ztunnel -n istio-system --timeout=120s 2>/dev/null || echo "  ztunnel not ready yet"
kubectl rollout status daemonset/istio-cni-node -n istio-system --timeout=120s 2>/dev/null || echo "  istio-cni not ready yet"
echo "  Istio ambient installed (istiod + ztunnel + istio-cni in istio-system)"

# -- Namespace + Secrets + ConfigMaps -----------------------------------------

log "Creating namespace + secrets + configmaps"
kube create namespace "$NAMESPACE"

# app-env ConfigMap from .env. The plugin service uses a rootless buildkitd
# sidecar (single build path — no strategy switch).
# RESTRICTED envsubst: expand ONLY ${PLATFORM_FRONTEND_URL} (the sole intentional
# reference, in OAUTH_CALLBACK_BASE_URL). An unrestricted envsubst would treat a
# literal `$` in any secret (a bcrypt hash `$2b$10$…`, a password with `$`) as a
# variable and silently blank/corrupt it — and since the same keys are ALSO
# written to Secrets from the sourced env, the ConfigMap and Secret copies would
# then diverge. Mirrors the restricted expansion at the kustomize step below.
# `grep -E '^[[:space:]]*(#|$)'` is POSIX (BSD/macOS-safe; `\s` is a GNU extension).
CLEAN_ENV=$(mktemp); trap 'rm -f "$CLEAN_ENV"' EXIT
grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" | sed "s|[\$]{PLATFORM_FRONTEND_URL}|${PLATFORM_FRONTEND_URL}|g" > "$CLEAN_ENV"
configmap app-env --from-env-file="$CLEAN_ENV"
rm -f "$CLEAN_ENV"

# Secrets
secret jwt-secret        --from-literal=JWT_SECRET="$JWT_SECRET" --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET"
secret postgres-secret   --from-literal=POSTGRES_USER="$POSTGRES_USER" --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" --from-literal=DB_USER="$DB_USER" --from-literal=DB_PASSWORD="$DB_PASSWORD"
secret mongodb-secret    --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" --from-literal=MONGODB_URI="$MONGODB_URI"
secret mongo-express-secret --from-literal=ME_CONFIG_BASICAUTH_USERNAME="$ME_CONFIG_BASICAUTH_USERNAME" --from-literal=ME_CONFIG_BASICAUTH_PASSWORD="$ME_CONFIG_BASICAUTH_PASSWORD"
secret pgadmin-secret    --from-literal=PGADMIN_DEFAULT_EMAIL="$PGADMIN_DEFAULT_EMAIL" --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_DEFAULT_PASSWORD"

# Optional alert-delivery secrets — alertmanager.yaml references these with
# optional:true. Create them (empty by default) so the refs resolve to a real
# Secret instead of dangling; set SLACK_WEBHOOK_URL_* / ALERT_WEBHOOK_* in .env
# to populate them. NOTE: the shipped alertmanager.yml hardcodes placeholders
# and does not read these env vars, so delivery no-ops until that config is
# updated with real values (see config/alertmanager/alertmanager.yml).
secret alertmanager-slack \
  --from-literal=SLACK_WEBHOOK_URL_CRITICAL="${SLACK_WEBHOOK_URL_CRITICAL:-}" \
  --from-literal=SLACK_WEBHOOK_URL_WARNING="${SLACK_WEBHOOK_URL_WARNING:-}"
secret alertmanager-relay \
  --from-literal=ALERT_WEBHOOK_INSTANCE_ID="${ALERT_WEBHOOK_INSTANCE_ID:-}" \
  --from-literal=ALERT_WEBHOOK_INSTANCE_TOKEN="${ALERT_WEBHOOK_INSTANCE_TOKEN:-}"

# GHCR pull secret
GHCR_TOKEN="${GHCR_TOKEN:-}"
[ -z "$GHCR_TOKEN" ] && [ -f "$HOME/.npmrc" ] && GHCR_TOKEN=$(grep '//npm.pkg.github.com/:_authToken=' "$HOME/.npmrc" 2>/dev/null | sed 's/.*_authToken=//' || true)
if [ -n "$GHCR_TOKEN" ]; then
  GHCR_USER="${GHCR_USER:-mwashburn160}"
  kube create secret docker-registry ghcr-secret --docker-server=ghcr.io --docker-username="$GHCR_USER" --docker-password="$GHCR_TOKEN" -n "$NAMESPACE"
  kubectl patch sa default -n "$NAMESPACE" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  echo "  ghcr-secret"
fi

# -- TLS certificates --------------------------------------------------------

log "Creating TLS certificates"
# Shared, idempotent gateway-TLS generator (mkcert → self-signed fallback).
bash "$BIN_DIR/nginx-tls.sh" "$CERT_DIR"
kube create secret tls nginx-tls-secret --cert="$CERT_DIR/nginx-tls.crt" --key="$CERT_DIR/nginx-tls.key" -n "$NAMESPACE"

# JWT signing keypair for image-registry's token-auth endpoint (shared generator).
bash "$BIN_DIR/jwt-keys.sh" "$CERT_DIR"
secret registry-token-secret \
  --from-file=jwt-private.pem="$CERT_DIR/image-registry-jwt.key" \
  --from-file=jwt-public.pem="$CERT_DIR/image-registry-jwt.crt"

# Build-side credentials consumed by the image-registry proxy:
#   IMAGE_REGISTRY_*  — Basic auth used when talking to the underlying registry.
secret image-registry-build-svc-secret \
  --from-literal=IMAGE_REGISTRY_USERNAME="$IMAGE_REGISTRY_USER" \
  --from-literal=IMAGE_REGISTRY_PASSWORD="$IMAGE_REGISTRY_TOKEN"

# (No registry htpasswd: the registry uses token auth — nothing mounts registry-auth-secret.)
echo "  TLS + registry token-signing done"

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
# Thanos object-store config, mounted by the prometheus thanos-sidecar and
# thanos-query (prometheus.yaml / thanos-query.yaml). Was missing here — those
# pods FailedMount on minikube — while ec2/eks create it via bin/k8s-resources.sh.
configmap thanos-objstore --from-file=objstore.yml="$CONFIG_DIR/thanos/objstore.yml"
configmap alertmanager-config --from-file=alertmanager.yml="$CONFIG_DIR/alertmanager/alertmanager.yml"
configmap promtail-config --from-file=promtail-config.yml="$CONFIG_DIR/promtail/promtail-config.yml"

# -- Deploy -------------------------------------------------------------------

# Ensure plugin hostPath directories exist on data volume.
minikube ssh --profile="$PROFILE" -- "sudo mkdir -p ${VM_DATA_DIR}/plugins-data && sudo chown -R 1000:1000 ${VM_DATA_DIR}/plugins-data"
# MinIO's hostPath drive must be writable by the minio UID (1000); hostPath
# volumes aren't chowned by fsGroup on minikube. (Single-drive dev — no HA.)
minikube ssh --profile="$PROFILE" -- "sudo mkdir -p ${VM_DATA_DIR}/minio-data && sudo chown -R 1000:1000 ${VM_DATA_DIR}/minio-data"

# Register QEMU/binfmt for cross-arch plugin builds (e.g. amd64 on an arm64 box).
# No-op on Docker Desktop / same-arch. The minikube node shares the host (VM)
# kernel's binfmt_misc, so registering it via host docker reaches the node too.
bash "$BIN_DIR/ensure-binfmt.sh" "${PUBLISH_PLATFORM:-linux/amd64}"

log "Applying Kubernetes manifests"
[ "$LEAN" = "1" ] && echo "  LEAN=1 — omitting optional observability + admin services (prometheus/thanos/loki/promtail/jaeger/alertmanager/mongo-express/pgadmin)"
# Substitute ONLY ${BUILDKIT_MEMORY_LIMIT} (sed, not envsubst — some envsubst
# builds ignore the shell-format restriction and strip runtime $tokens like the
# minio-init `$b` loop). lean_filter drops optional workloads when LEAN=1.
kubectl kustomize "$K8S_DIR" | sed "s|[\$]{BUILDKIT_MEMORY_LIMIT}|${BUILDKIT_MEMORY_LIMIT}|g" | lean_filter | kubectl apply -f -

log "Post-deploy fixups"
REGISTRY_IP=$(kubectl get svc registry -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
[ -n "$REGISTRY_IP" ] && minikube ssh --profile="$PROFILE" -- \
  "T=\$(mktemp); grep -q '\\sregistry\$' /etc/hosts && { grep -v '\\sregistry\$' /etc/hosts > \"\$T\"; echo '$REGISTRY_IP registry' >> \"\$T\"; sudo cp \"\$T\" /etc/hosts; rm -f \"\$T\"; } || echo '$REGISTRY_IP registry' | sudo tee -a /etc/hosts >/dev/null"
echo "  registry -> ${REGISTRY_IP:-unknown}"

# -- Wait for pods ------------------------------------------------------------

log "Waiting for pods"
kubectl wait --for=condition=Ready pod -l app=postgres -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  postgres not ready"
kubectl wait --for=condition=Ready pod -l app=mongodb  -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  mongodb not ready"
kubectl wait --for=condition=Ready pod -l app -n "$NAMESPACE" --timeout=300s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=nginx -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  nginx not ready"

echo ""
kubectl get pods -n "$NAMESPACE" -o wide

# -- Port-forwards ------------------------------------------------------------

log "Starting port-forwards"
pkill -f "kubectl port-forward.*-n $NAMESPACE" 2>/dev/null || true
sleep 1

# Gateway: forward 8443 (HTTPS) ONLY. Binding 8080 too made the WHOLE forward
# fail whenever either port was busy (e.g. a leftover bind from a local stack on
# 8443/8080), silently killing the gateway while the single-port forwards below
# survived — leaving https://localhost:8443 unreachable. The HTTP→HTTPS redirect
# on 8080 isn't needed for the API/UI (use the NodePort if you want it).
port_forward "Nginx"          nginx            "8443:8443"
# mongo-express / pgAdmin are omitted under LEAN=1 (no service to forward to).
if [ "$LEAN" != "1" ]; then
  port_forward "Mongo Express"  mongo-express    "8081:8081"
  port_forward "pgAdmin"        pgadmin          "5480:80"
fi
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
echo "  Default admin     : admin@internal  (default password & overrides in docs/README.md — set PLATFORM_PASSWORD to change)"
echo ""
echo "  Dev tools           port-forward (localhost)      NodePort (minikube):"
echo "    Mongo Express   : http://localhost:8081         http://$MK_IP:30081"
echo "    pgAdmin         : http://localhost:5480         http://$MK_IP:30480"
echo "    Registry browser: https://localhost:8443/dashboard/registry  (sysadmin)"
echo ""
echo "  Databases (postgres / mongodb / redis) run in-cluster — reach them via the"
echo "  dev tools above. Credentials live in $ENV_FILE."
echo ""
echo "  Data persists on the minikube VM disk (survives 'minikube stop/start'; wiped"
echo "  by 'minikube delete') — it is NOT mirrored to the host ./data/ folder. Use"
echo "  'deploy/local/minikube/bin/backup.sh' for host-side copies (via port-forward)."
echo ""
echo "  Next : ./deploy/bin/init-platform.sh minikube   # register admin + (opt-in) load plugins/samples/compliance"
echo "  Stop port-forwards : pkill -f 'kubectl port-forward.*-n $NAMESPACE'"
