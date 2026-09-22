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
# NOTE: no host DATA_DIR here — with the minikube docker driver the cluster's
# persistent data lives INSIDE the VM at VM_DATA_DIR (/data), not under the host
# deploy dir. See the VM_DATA_DIR mounts below.
# Kubernetes version for the cluster. PIN it rather than letting minikube pick
# its built-in default: that default moves with every minikube release (upgrading
# minikube silently jumps the local cluster a minor or two), which both breaks
# reproducibility against the EKS target and widens the skew from the host
# kubectl. Mirrors deploy/aws/eks's `--eks-version` pin. Applied at cluster
# CREATE only — an existing cluster keeps the version it was created with.
# Bounded above by what the installed minikube supports (`minikube config
# defaults kubernetes-version`).
K8S_VERSION="${K8S_VERSION:-v1.35.1}"
# LEAN=1 drops the optional observability + admin services (prometheus, thanos,
# loki, promtail, jaeger, alertmanager, mongo-express, pgadmin, grafana, kiali)
# from the apply so
# the core stack + Istio mesh fits on an ~8-core laptop. Core services + DBs are
# unaffected. Full stack is the default (LEAN=0) for larger machines.
LEAN="${LEAN:-0}"
# ASK_MODEL=1 additionally deploys the self-hosted Ask model (k8s/ask-model.yaml,
# Ollama) and points the ask service at it. OFF by default because it is the one
# workload that may not fit: it asks for 2Gi on a VM that is already tight (see
# the sizing warning below). The AWS targets ship it enabled — only minikube
# makes it a choice.
#
# Without it (and with no cloud provider key in .env) the Ask assistant has NO
# provider and every turn fails with "AI is not configured" — which is correct,
# just not useful for local testing. NOT folded into LEAN: that flag SUBTRACTS
# optional workloads, so a "LEAN=2" that added one would invert its meaning.
ASK_MODEL="${ASK_MODEL:-0}"
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
#   common.sh          → preflight, ensure_istioctl, ensure_kubectl
#   gen-env-secrets.sh → pb_gen_env_secrets (fill CHANGE_ME secrets in .env)
#   mongo-keyfile.sh   → pb_ensure_mongo_keyfile (per-deploy replica-set keyfile)
#   k8s-resources.sh   → the Secret/ConfigMap creators, add-on installs (KEDA,
#                        Istio ambient) and the manifest apply phase — the same
#                        functions ec2 and eks run, with plain kubectl here.
# common.sh cd's to /tmp on source; every path below is absolute so that's safe.
. "$BIN_DIR/common.sh"
. "$BIN_DIR/gen-env-secrets.sh"
. "$BIN_DIR/mongo-keyfile.sh"
# PB_KUBECTL/PB_NAMESPACE are consumed by the sourced k8s-resources.sh.
# shellcheck disable=SC2034
PB_KUBECTL="kubectl"
# shellcheck disable=SC2034
PB_NAMESPACE="$NAMESPACE"
. "$BIN_DIR/k8s-resources.sh"

# Fail fast with ONE actionable error if a required CLI tool is missing.
preflight kubectl minikube openssl envsubst
# istioctl is NOT preflighted — ensure_istioctl (below, before the mesh install)
# auto-installs the right version if it's missing. Same handling on every target.

# -- Helpers ------------------------------------------------------------------

log()  { echo ""; echo "=== $1 ==="; }

cleanup_docker() {
  docker rm -f "$PROFILE" 2>/dev/null || true
  docker network rm "$PROFILE" 2>/dev/null || true
  docker network prune -f >/dev/null 2>&1 || true
}

# -- Load .env ----------------------------------------------------------------

# minikube reads ONLY its own .env. Borrowing another target's (the docker one)
# would hand the cluster that target's settings — DEPLOY_TARGET=docker, the
# compose-network quarantine buildkit address — and then pb_sync_env_keys below
# would rewrite the other target's file with minikube's keys.
ENV_FILE=""
[ -f "$DEPLOY_DIR/.env" ] && ENV_FILE="$DEPLOY_DIR/.env"
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

# Bring an existing .env up to date with keys added to .env.example since it was
# seeded (additive only — existing values are never touched). Without this a new
# required key reaches the scripts as an `unbound variable` abort under `set -u`.
pb_sync_env_keys "$ENV_FILE" "$DEPLOY_DIR/.env.example"

log "Loading environment from $ENV_FILE"
set -a
# shellcheck source=/dev/null  # ENV_FILE is a runtime path, not statically analyzable
. "$ENV_FILE"
set +a
# buildkitd sidecar memory limit (the build cgroup). Set in .env to override;
# default 3072Mi — lower than the AWS tiers since this runs on a laptop.
# envsubst has no `:-default`, so the fallback lives here.
: "${BUILDKIT_MEMORY_LIMIT:=3072Mi}"; export BUILDKIT_MEMORY_LIMIT

# ALERT DELIVERY PRE-FLIGHT. Fails the deploy while a Slack webhook URL is still
# a placeholder — alerting that 404s into nothing is indistinguishable from
# healthy alerting. Set both SLACK_*_WEBHOOK_URL empty in .env to run without it.
pb_check_alert_delivery "$ENV_FILE" "$(pb_shared_dir)/config/alertmanager/alertmanager.yml" || exit 1

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

# The docker driver needs a reachable daemon for every step below — including
# the `minikube delete` on the recreate path. Without this preflight a stopped
# Docker Desktop still lets the "WIPES ALL DATA" prompt run and the delete
# succeed (it only removes host-side profile metadata), then `minikube start`
# aborts with PROVIDER_DOCKER_NOT_RUNNING — leaving no cluster and no data.
# Fail before asking, not after wiping.
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: the Docker daemon is not reachable — start Docker Desktop and re-run." >&2
  echo "       (minikube's docker driver needs it to create, delete, or resume '$PROFILE'.)" >&2
  exit 1
fi

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
  # `docker info --format` can emit a zero-valued field AND exit non-zero when the
  # daemon is unhealthy, so `cmd || echo 0` yields the two-line value "0\n0" —
  # which makes the $(( )) below a hard arithmetic syntax error. `set -e` does NOT
  # abort on that: the assignment keeps its old value and the clamp is silently
  # skipped, so minikube gets sized against HOST memory instead of the Docker
  # envelope — the exact MK_USAGE trap this block exists to avoid. Take the first
  # line and keep digits only.
  int_or_zero() { printf '%s' "${1%%$'\n'*}" | tr -cd '0-9'; }
  DOCKER_CPU=$(int_or_zero "$(docker info --format '{{.NCPU}}' 2>/dev/null || echo 0)")
  DOCKER_MEM=$(int_or_zero "$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)")
  DOCKER_CPU=${DOCKER_CPU:-0}
  DOCKER_MEM=${DOCKER_MEM:-0}
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
echo "  System: ${TOTAL_CPU} CPUs, ${TOTAL_MEM}M → Minikube: ${MK_CPUS} CPUs, ${MK_MEM}M, ${DISK_SIZE} disk"

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
MK_ARGS=(--profile="$PROFILE" --cpus="$MK_CPUS" --memory="$MK_MEM" --disk-size="$DISK_SIZE" \
         --driver=docker --kubernetes-version="$K8S_VERSION")

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

# Fresh cluster create, with one retry. `minikube start` on a brand-new cluster
# fails transiently more often than it should — a just-restarted Docker daemon
# still settling, or a container/network left behind by a previous half-delete.
# Used by BOTH the create and the recreate paths: a recreate has already wiped
# /data, so there is nothing left to protect and a transient failure should be
# retried rather than left as a dead, half-created cluster the next run then
# offers to "resume".
mk_start_fresh() {
  if ! minikube start "${MK_ARGS[@]}"; then
    echo "  Retrying after cleanup..."
    minikube delete --profile="$PROFILE" 2>/dev/null || true
    cleanup_docker
    minikube start "${MK_ARGS[@]}"
  fi
}

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
      mk_start_fresh
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
  mk_start_fresh
fi

# Align the client BEFORE the first real kubectl work below. The host kubectl is
# typically Docker Desktop's symlink, which lags its bundled k8s (v1.32 against a
# v1.35 cluster here) — outside the supported +/-1 minor skew, which breaks
# `apply --server-side` and the CRD applies further down. Read the version the
# cluster ACTUALLY runs rather than $K8S_VERSION: the pin only applies to a fresh
# create, while a resumed cluster keeps whatever it was created with.
K8S_ACTUAL="$(sed -n 's/.*"KubernetesVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
              "$MK_PROFILE_DIR/config.json" 2>/dev/null | head -1)"
ensure_kubectl "${K8S_ACTUAL:-$K8S_VERSION}"

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

pb_install_keda
echo "  Addons + KEDA installed"

# -- Istio ambient service mesh ----------------------------------------------
# See pb_install_istio_ambient (deploy/bin/k8s-resources.sh) for why the mesh goes
# in before the manifests. The `minikube addons enable istio` addon is stale
# 1.5-era sidecar mode, so istioctl with the ambient profile is used instead.
log "Installing Istio ambient mesh ($ISTIO_VERSION)"
# Auto-installs exactly $ISTIO_VERSION if the host has none or another version.
ensure_istioctl "$ISTIO_VERSION"
# istiod's production default request (500m CPU / 2Gi memory) reserves a fifth of
# a laptop node for a control plane that idles at ~5m / ~60Mi here; trim the
# REQUEST (no limit is set, so it can still burst) so the app stack schedules.
pb_install_istio_ambient \
  --set values.pilot.resources.requests.cpu=100m \
  --set values.pilot.resources.requests.memory=256Mi
echo "  Istio ambient installed (istiod + ztunnel + istio-cni in istio-system)"

# -- Namespace + Secrets + ConfigMaps -----------------------------------------

log "Creating namespace + secrets + configmaps"
pb_kube_apply create namespace "$NAMESPACE"

# RESTRICTED expansion: ONLY ${PLATFORM_FRONTEND_URL} (the sole intentional
# reference, in OAUTH_CALLBACK_BASE_URL). An unrestricted envsubst would treat a
# literal `$` in any secret (a bcrypt hash `$2b$10$…`, a password with `$`) as a
# variable and silently blank/corrupt it — and since the same keys are ALSO
# written to Secrets from the sourced env, the ConfigMap and Secret copies would
# then diverge. `grep -E '^[[:space:]]*(#|$)'` is POSIX (`\s` is a GNU extension).
CLEAN_ENV=$(mktemp); trap 'rm -f "$CLEAN_ENV"' EXIT
grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" | sed "s|[\$]{PLATFORM_FRONTEND_URL}|${PLATFORM_FRONTEND_URL}|g" > "$CLEAN_ENV"
# ASK_MODEL=1: point the ask service at the self-hosted model. Appended to the
# app-env source rather than edited into k8s/ask.yaml because `ask` already
# consumes app-env via `envFrom`, so one knob covers both the manifest and the
# ConfigMap. A cloud key in .env still wins — the registry lists key-based
# providers first, and this only ADDS the local one.
if [ "$ASK_MODEL" = "1" ]; then
  {
    echo "OPENAI_COMPATIBLE_BASE_URL=http://ask-model:11434/v1"
    echo "OPENAI_COMPATIBLE_MODELS=qwen2.5-coder:1.5b|Qwen 2.5 Coder"
  } >> "$CLEAN_ENV"
fi
# Split into the app-env ConfigMap (settings) + app-secrets Secret (credentials);
# superuser/admin creds go to neither (see pb_split_app_env).
pb_app_env_resources "$CLEAN_ENV"
rm -f "$CLEAN_ENV"

# Application secrets + optional GHCR pull secret (shared creators — the same
# Secret set, keys included, that ec2 and eks create).
pb_create_app_secrets
pb_create_ghcr_secret

# -- TLS certificates --------------------------------------------------------

log "Creating TLS certificates"
# Shared, idempotent gateway-TLS generator (mkcert → self-signed fallback). Only
# minikube terminates TLS at nginx; the AWS targets terminate at the ALB.
bash "$BIN_DIR/nginx-tls.sh" "$CERT_DIR"
pb_kube_apply create secret tls nginx-tls-secret --cert="$CERT_DIR/nginx-tls.crt" --key="$CERT_DIR/nginx-tls.key" -n "$NAMESPACE"
# The CA that issued that cert (public half only) — the frontend server mounts
# it as NODE_EXTRA_CA_CERTS to verify https://nginx:8443 (no image trusts a dev CA).
pb_kube_apply create configmap dev-ca --from-file=dev-ca.crt="$CERT_DIR/dev-ca.crt" -n "$NAMESPACE"

# JWT signing keypair for image-registry's token-auth endpoint (shared generator),
# then the registry secrets (token keypair + build-svc Basic-auth creds).
bash "$BIN_DIR/jwt-keys.sh" "$CERT_DIR"
pb_create_registry_secrets "$CERT_DIR/image-registry-jwt.key" "$CERT_DIR/image-registry-jwt.crt"

# The ES256 user-token signing key (platform only). Idempotent: re-running setup
# never rotates it (that would log everyone out). Skipped under
# TOKEN_SIGNING_MODE=kms, where the private key never leaves AWS.
if [ "${TOKEN_SIGNING_MODE:-local}" = "local" ]; then
  bash "$BIN_DIR/token-signing-keys.sh" "$CERT_DIR"
fi
pb_create_token_signing_secret "$CERT_DIR/token-signing/token-signing.key" "$CERT_DIR/token-signing/token-signing-previous.key"

# The plugin-image signing keypair: the private half for image-registry only,
# the public half for plugin (see pb_create_plugin_signing_secrets). Honours
# PLUGIN_SIGNING_MODE from the sourced .env. Idempotent: re-running setup never
# regenerates the key (that orphans every signature).
bash "$BIN_DIR/plugin-signing-keys.sh" "$CERT_DIR"
pb_create_plugin_signing_secrets "$CERT_DIR/plugin-signing"

# PER-SERVICE ES256 keys for internal service-to-service tokens — one Secret per
# service plus the public bundle (see pb_create_service_key_secrets). Idempotent:
# re-running setup never rotates a key.
bash "$BIN_DIR/service-signing-keys.sh" "$CERT_DIR"
pb_create_service_key_secrets "$CERT_DIR/service-keys"
echo "  TLS + registry + user-token + plugin signing keys done"

# -- ConfigMaps ---------------------------------------------------------------

log "Creating ConfigMaps"
# Config-file ConfigMaps + the MongoDB keyfile Secret — the same set ec2/eks
# create; shared files come from deploy/shared, target files from this dir.
pb_create_config_maps "$DEPLOY_DIR" "$CONFIG_DIR" "$NGINX_DIR"

# -- Deploy -------------------------------------------------------------------

# Ensure plugin hostPath directories exist on data volume.
minikube ssh --profile="$PROFILE" -- "sudo mkdir -p ${VM_DATA_DIR}/plugins-data && sudo chown -R 1000:1000 ${VM_DATA_DIR}/plugins-data"
# MinIO's hostPath drive must be writable by the minio UID (1000); hostPath
# volumes aren't chowned by fsGroup on minikube. (Single-drive dev — no HA.)
minikube ssh --profile="$PROFILE" -- "sudo mkdir -p ${VM_DATA_DIR}/minio-data && sudo chown -R 1000:1000 ${VM_DATA_DIR}/minio-data"

# Raise inotify limits inside the node. promtail creates one inotify watch per
# tailed log file; the full stack's pod count exceeds the default
# max_user_instances=128 ("failed to make file target manager: too many open
# files"), and prometheus's TSDB is inotify/mmap-heavy too. Set on the node (the
# limit is user-namespace-scoped, so setting it inside the kicbase node is what
# reaches these pods). `sysctl -w` isn't persistent across `minikube stop`, so
# startup.sh re-applies it on resume.
minikube ssh --profile="$PROFILE" -- "sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288" >/dev/null 2>&1 || true

# Register QEMU/binfmt for cross-arch plugin builds (e.g. amd64 on an arm64 box).
# No-op on Docker Desktop / same-arch. The minikube node shares the host (VM)
# kernel's binfmt_misc, so registering it via host docker reaches the node too.
bash "$BIN_DIR/ensure-binfmt.sh" "${PUBLISH_PLATFORM:-linux/amd64}"

log "Applying Kubernetes manifests"
# Only ${BUILDKIT_MEMORY_LIMIT} is expanded; istiod gate + apply + mesh
# re-enrollment restart are shared with ec2/eks (pb_apply_manifests).
pb_apply_manifests "$K8S_DIR" "s|[\$]{BUILDKIT_MEMORY_LIMIT}|${BUILDKIT_MEMORY_LIMIT}|g" "$LEAN"

# ASK_MODEL=1: the self-hosted Ask model. Applied separately (it is deliberately
# NOT in kustomization.yaml) because it is the one optional workload whose 2Gi
# request may not fit beside the core stack on a small VM. The file is
# self-contained — Deployment + Service + PVC + ServiceAccount + Istio AuthZ +
# NetworkPolicy — so a plain apply brings everything `ask` needs to reach it.
if [ "$ASK_MODEL" = "1" ]; then
  echo "  Deploying self-hosted Ask model (ASK_MODEL=1)..."
  kubectl apply -n "$NAMESPACE" -f "$K8S_DIR/ask-model.yaml"
  echo "  NOTE: first start pulls the model (~1GB); the ask pod answers once ask-model is Ready."
fi

log "Post-deploy fixups"
pb_registry_hosts_fixup "$PROFILE"

# -- Wait for pods ------------------------------------------------------------

log "Waiting for pods"
kubectl wait --for=condition=Ready pod -l app=postgres -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  postgres not ready"
kubectl wait --for=condition=Ready pod -l app=mongodb  -n "$NAMESPACE" --timeout=180s 2>/dev/null || echo "  mongodb not ready"
# `-l app` is an EXISTENCE selector, so it also matches the one-shot Job pods
# (minio-init carries `app: minio-init`). A Succeeded pod's Ready condition is
# False/PodCompleted forever, so without the phase filter this wait could never
# be satisfied and always burned the full 300s — silently, because `|| true`
# swallowed the timeout. Exclude finished pods, and say which pods are actually
# lagging instead of hiding the result.
#
# ask-model is excluded for a second reason: its startupProbe deliberately holds
# the pod NotReady until `ollama list` shows the model, and the first run pulls
# ~1GB — longer than this wait, and not something the rest of the stack depends on.
if ! kubectl wait --for=condition=Ready pod -l 'app,app!=ask-model' -n "$NAMESPACE" \
     --field-selector=status.phase!=Succeeded --timeout=300s >/dev/null 2>&1; then
  echo "  some pods are not ready yet:"
  kubectl get pods -n "$NAMESPACE" \
    --field-selector=status.phase!=Succeeded \
    -o 'jsonpath={range .items[?(@.status.conditions[?(@.type=="Ready")].status=="False")]}    {.metadata.name} ({.status.phase}){"\n"}{end}' 2>/dev/null || true
fi
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
pb_port_forward "Nginx"          nginx            "8443:8443"
# mongo-express / pgAdmin are omitted under LEAN=1 (no service to forward to).
if [ "$LEAN" != "1" ]; then
  pb_port_forward "Mongo Express"  mongo-express    "8081:8081"
  pb_port_forward "pgAdmin"        pgadmin          "5480:80"
fi
# Registry UI is served via the platform frontend at /dashboard/registry
# (sysadmin only) — no separate joxit/registry-express port-forward.

# Verify gateway
for i in $(seq 1 5); do
  curl -sk -o /dev/null https://localhost:8443/health 2>/dev/null && { echo "  Gateway reachable"; break; }
  [ "$i" = "5" ] && echo "  WARNING: Gateway not reachable"
  sleep 2
done

# -- Post-provision smoke checks (non-fatal) ----------------------------------
# Test alert -> Slack, test email, and a denied-connection probe (tells you
# whether this CNI enforces NetworkPolicy at all).
NAMESPACE="$NAMESPACE" bash "$BIN_DIR/post-provision-smoke.sh" k8s || true

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
