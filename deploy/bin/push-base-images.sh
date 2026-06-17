#!/usr/bin/env bash
# Push locally-built plugin base images into the in-cluster registry.
#
# Why this exists:
#   - `build-plugin-images.sh` builds bases via the host docker daemon —
#     they land in the host image cache (e.g. `pipeline-plugin-base:24.04`).
#   - Plugin builds run through buildkitd in its own container with a
#     separate image cache.
#   - When a plugin Dockerfile has `FROM pipeline-plugin-base:24.04`,
#     buildkit defaults the bare name to docker.io/library and 403s.
#
# Fix: push each base to `<registry>/library/<name>:<tag>`. Combined
# with the docker.io → registry mirror in buildkitd's config, bare FROM
# lines resolve transparently.
#
# Auth: the in-cluster registry uses token auth (REGISTRY_AUTH=token).
# We sign a short-lived HS256 JWT with the platform's JWT_SECRET and
# feed it to crane as `_token:<jwt>`. The image-registry service
# verifies the JWT and mints a registry-scoped bearer token.
#
# Deploy targets:
#   local            — push via crane in a docker sidecar on backend-network
#                      (reads JWT_SECRET from deploy/local/docker/.env)
#   minikube|ec2|eks — push via crane in a one-shot kubectl-run pod inside
#                      the cluster (reads JWT_SECRET from the jwt-secret
#                      Secret in the pipeline-builder namespace). All three
#                      use the in-cluster registry at registry:5000.
#
# Selected via DEPLOY_TARGET env var (default: local). init-platform.sh
# exports this when invoking build-plugin-images.sh.
#
# Requires: docker CLI, openssl. The k8s targets (minikube/ec2/eks) need kubectl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
DEPLOY_TARGET="${DEPLOY_TARGET:-local}"
NAMESPACE="${NAMESPACE:-pipeline-builder}"
CRANE_IMAGE="${CRANE_IMAGE:-gcr.io/go-containerregistry/crane:debug}"

# Minikube installs by default use a kubeconfig context named after the
# minikube profile (`pipeline-builder` per startup.sh). The minikube user
# on EC2 has this configured, but the running user's *default* kubeconfig
# context may not be set — bare `kubectl` then talks to the wrong cluster
# (or no cluster) and looks like a missing secret. So pin a context.
#
# Default to the operator's CURRENT context: for ec2/minikube that IS the
# `pipeline-builder` minikube profile, and for eks it's whatever
# `aws eks update-kubeconfig` / eksctl wrote (e.g. arn:aws:eks:...:cluster/pipeline-builder
# or developer@pipeline-builder.<region>.eksctl.io) — NOT literally "pipeline-builder",
# which is why the old hardcoded default failed on eks. Fall back to the legacy name
# only when there's no current context. Override via KUBECTL_CONTEXT.
KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-$(kubectl config current-context 2>/dev/null || echo pipeline-builder)}"
kubectl_ctx() {
  if [ "$DEPLOY_TARGET" = "local" ]; then
    kubectl "$@"
  else
    kubectl --context="$KUBECTL_CONTEXT" "$@"
  fi
}

# -----------------------------------------------------------------------
# Per-target setup: locate JWT_SECRET and the registry coordinates
# -----------------------------------------------------------------------
case "$DEPLOY_TARGET" in
  local)
    DEPLOY_DIR="$(cd "$SCRIPT_DIR/../local/docker" && pwd)"
    if [ ! -f "$DEPLOY_DIR/.env" ]; then
      echo "ERROR: $DEPLOY_DIR/.env not found" >&2
      exit 1
    fi
    set -a; . "$DEPLOY_DIR/.env"; set +a
    # In-cluster service-discovery name used both by the registry and
    # by the token realm sent in WWW-Authenticate. We push from a
    # sidecar on backend-network so DNS resolves correctly.
    REGISTRY_HOST="${REGISTRY_HOST:-registry:5000}"
    BACKEND_NETWORK="${BACKEND_NETWORK:-backend-network}"
    if ! docker network inspect "$BACKEND_NETWORK" >/dev/null 2>&1; then
      echo "ERROR: docker network '$BACKEND_NETWORK' not found." >&2
      echo "  Set BACKEND_NETWORK=<name> if your compose network is named differently." >&2
      exit 1
    fi
    ;;
  minikube|ec2|eks)
    if ! command -v kubectl >/dev/null 2>&1; then
      echo "ERROR: kubectl not found in PATH (required for DEPLOY_TARGET=$DEPLOY_TARGET)" >&2
      exit 1
    fi
    # JWT_SECRET lives in a k8s Secret created by startup.sh. Crane runs
    # inside the cluster, so the registry/realm hostnames it sees are
    # the standard ClusterIP DNS names — same form the in-cluster
    # plugin service uses at runtime.
    JWT_SECRET="$(kubectl_ctx -n "$NAMESPACE" get secret jwt-secret -o jsonpath='{.data.JWT_SECRET}' 2>/dev/null | base64 -d || true)"
    if [ -z "$JWT_SECRET" ]; then
      echo "ERROR: JWT_SECRET not found in Secret 'jwt-secret' (namespace: $NAMESPACE, context: $KUBECTL_CONTEXT)" >&2
      echo "" >&2
      echo "  Verify with:" >&2
      echo "    kubectl --context=$KUBECTL_CONTEXT -n $NAMESPACE get secret jwt-secret" >&2
      echo "" >&2
      echo "  Available contexts on this machine:" >&2
      kubectl config get-contexts -o name 2>/dev/null | sed 's/^/    /' >&2 || echo "    (kubectl not configured)" >&2
      echo "" >&2
      echo "  Common causes:" >&2
      echo "    • Running from a laptop without the EC2 cluster's kubeconfig" >&2
      echo "      → SSH the cluster's /home/minikube/.kube/config to your laptop" >&2
      echo "        and set KUBECTL_CONTEXT to its context name." >&2
      echo "    • Wrong context name (default: pipeline-builder)" >&2
      echo "      → export KUBECTL_CONTEXT=<your-context> and retry." >&2
      echo "    • startup.sh hasn't run yet on the target cluster" >&2
      echo "      → run it before init-platform.sh." >&2
      exit 1
    fi
    REGISTRY_HOST="${REGISTRY_HOST:-registry:5000}"
    ;;
  *)
    echo "ERROR: unsupported DEPLOY_TARGET='$DEPLOY_TARGET' (expected: local, minikube, ec2, eks)" >&2
    exit 1
    ;;
esac

# -----------------------------------------------------------------------
# JWT signing — shared across targets via common.sh `sign_platform_jwt`.
# Smoke-test once before the loop so a missing JWT_SECRET fails loudly
# here rather than per-image.
# -----------------------------------------------------------------------
_sign_platform_jwt() { sign_platform_jwt "$JWT_SECRET"; }
if [ -z "$(_sign_platform_jwt)" ]; then
  echo "ERROR: failed to sign platform JWT (JWT_SECRET missing?)" >&2
  exit 1
fi

# -----------------------------------------------------------------------
# Image discovery — same across targets
# -----------------------------------------------------------------------
# Matches both the root base (`pipeline-plugin-base:24.04`) and family
# bases (`pipeline-<name>-base:1.0`) produced by build-plugin-images.sh.
#
# Operator override: setting `PUSH_TAGS` (space-separated) bypasses
# discovery and pushes exactly that list. Used by
# `build-codebuild-bootstrap.sh` to publish `pipeline-bootstrap:1.0`
# through the same multi-target push pipeline without conflating it with
# the plugin-base regex.
BASE_TAGS=()
if [ -n "${PUSH_TAGS:-}" ]; then
  # shellcheck disable=SC2206
  BASE_TAGS=($PUSH_TAGS)
else
  while IFS= read -r _tag; do
    [ -n "$_tag" ] && BASE_TAGS+=("$_tag")
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | \
           grep -E '^(pipeline-plugin-base:24\.04|pipeline-[a-z0-9-]+-base:1\.0)$')
fi

if [ "${#BASE_TAGS[@]}" -eq 0 ]; then
  echo "ERROR: no base images found in local docker cache." >&2
  echo "  Run deploy/bin/build-plugin-images.sh first." >&2
  exit 1
fi

# -----------------------------------------------------------------------
# Per-target push functions
# -----------------------------------------------------------------------
# Push via a docker sidecar on backend-network (local docker-compose).
# Reads the image tarball on stdin, materializes it inside the sidecar
# (crane push needs a real path, not stdin), then pushes.
_push_local() {
  local _tag="$1" _remote="$2" _jwt="$3"
  # The JWT is passed to the sidecar via env (`-e PLATFORM_JWT` copies it from
  # THIS process's environment), never interpolated into the `sh -c` argv — argv
  # is world-visible in the host `ps`, the process environment is not. The
  # container's shell expands "$PLATFORM_JWT" at runtime (mirrors the k8s path).
  local _cmd="cat > /tmp/img.tar && crane --insecure auth login '${REGISTRY_HOST}' --username _token --password \"\$PLATFORM_JWT\" >/dev/null && crane --insecure push /tmp/img.tar '${_remote}'"
  if docker save "$_tag" | PLATFORM_JWT="$_jwt" docker run --rm -i \
       --network "$BACKEND_NETWORK" \
       -e PLATFORM_JWT \
       --entrypoint sh \
       "$CRANE_IMAGE" -c "$_cmd" >/dev/null 2>&1; then
    return 0
  fi
  # First attempt reported non-zero. Re-run once as a RETRY, capturing crane's
  # REAL exit code (not the exit of the tail/sed pipe) and honoring it. A crane
  # push against an already-present manifest is an idempotent success ("existing
  # manifest", exit 0); a transient first-attempt hiccup often clears on retry.
  # Unconditionally returning 1 here mis-reported both as a hard "push FAILED".
  local _out _rc
  _out="$(docker save "$_tag" | PLATFORM_JWT="$_jwt" docker run --rm -i \
            --network "$BACKEND_NETWORK" \
            -e PLATFORM_JWT \
            --entrypoint sh \
            "$CRANE_IMAGE" -c "$_cmd" 2>&1)"
  _rc=$?
  printf '%s\n' "$_out" | tail -15 | sed 's/^/    /' >&2
  # crane logs "existing manifest" (+ the resolved tag@digest) when the image is
  # ALREADY present at the remote — a definitive idempotent success. Honor that
  # even if the docker-run/crane wrapper then exits non-zero (observed on arm64
  # hosts: crane confirms the manifest yet the run exits 1), so a redundant
  # re-push of an already-present base/bootstrap image doesn't fail the publish.
  if [ "$_rc" -ne 0 ] && printf '%s' "$_out" | grep -q 'existing manifest'; then
    echo "    (manifest already present at remote — treating as pushed)" >&2
    return 0
  fi
  return "$_rc"
}

# Build the JSON `--overrides` for a one-shot crane pod. Shared by both
# the push and existence-check paths. Container name MUST match the pod
# name (kubectl uses pod name as the implicit container name) — otherwise
# strategic merge appends a second container. Caller picks stdin/env via
# the args; resource sizing is fixed since crane is I/O-bound.
#
#   $1 podname    $2 escaped sh-c command    $3 enable_stdin (true|false)
#   $4 PLATFORM_JWT    $5 REGISTRY_HOST    $6? REMOTE (push only)
_pod_overrides() {
  local _name="$1" _cmd_json="$2" _stdin="$3" _jwt="$4" _host="$5" _remote="${6:-}"
  local _stdin_block=""
  [ "$_stdin" = "true" ] && _stdin_block='"stdin": true, "stdinOnce": true,'
  local _remote_env=""
  [ -n "$_remote" ] && _remote_env=$(printf ',\n        { "name": "REMOTE", "value": "%s" }' "$_remote")
  cat <<JSON
{
  "spec": {
    "containers": [{
      "name": "$_name",
      "image": "$CRANE_IMAGE",
      $_stdin_block
      "command": ["sh", "-c", "$_cmd_json"],
      "args": [],
      "env": [
        { "name": "PLATFORM_JWT",  "value": "$_jwt" },
        { "name": "REGISTRY_HOST", "value": "$_host" }${_remote_env}
      ],
      "resources": {
        "requests": { "cpu": "50m",  "memory": "128Mi" },
        "limits":   { "cpu": "200m", "memory": "512Mi" }
      }
    }]
  }
}
JSON
}

# Push via a one-shot kubectl-run crane pod inside the cluster
# (minikube/ec2). Same auth dance, but DNS resolution happens inside the
# cluster so the registry + image-registry service names are reachable.
# JWT is passed via env (--env), not as a CLI arg, so it doesn't leak in
# the host's process list. The pod is auto-deleted on exit (--rm).
#
# We put command+args directly in the override (not via CLI `--command --`)
# because strategic merge with kubectl's --overrides on this version
# doesn't reliably pull command from CLI flags when the container is also
# defined in the patch — the merge resolves to the image's default
# entrypoint (which for crane:debug is `crane` with no args) and the pod
# just prints help and exits.
_push_k8s() {
  local _tag="$1" _remote="$2" _jwt="$3"
  local _podname="crane-push-$(date +%s)-$$"
  # The actual shell command the pod runs. Variables are expanded by
  # the *pod's* shell (not the host's), so they resolve against the env
  # block below at runtime. JSON-escape the double quotes so the cmd
  # survives embedding in the override JSON.
  local _cmd='cat > /tmp/img.tar && crane --insecure auth login "$REGISTRY_HOST" --username _token --password "$PLATFORM_JWT" >/dev/null && crane --insecure push /tmp/img.tar "$REMOTE"'
  local _cmd_json="${_cmd//\"/\\\"}"

  local _overrides
  _overrides=$(_pod_overrides "$_podname" "$_cmd_json" true "$_jwt" "$REGISTRY_HOST" "$_remote")
  if docker save "$_tag" | kubectl_ctx -n "$NAMESPACE" run "$_podname" \
       --rm -i --quiet \
       --restart=Never \
       --image="$CRANE_IMAGE" \
       --overrides="$_overrides" >/dev/null 2>&1; then
    return 0
  fi
  # First attempt reported non-zero. Re-run once as a RETRY, capturing the pod's
  # REAL exit code (not the exit of the tail/sed pipe) and honoring it — an
  # idempotent "existing manifest" push or a transient first-attempt hiccup must
  # not be mis-reported as a hard "push FAILED". Pod name reused with a suffix so
  # there's no name collision against the prior --rm cleanup.
  local _retry_podname="${_podname}-retry"
  local _retry_overrides
  _retry_overrides=$(_pod_overrides "$_retry_podname" "$_cmd_json" true "$_jwt" "$REGISTRY_HOST" "$_remote")
  local _out _rc
  _out="$(docker save "$_tag" | kubectl_ctx -n "$NAMESPACE" run "$_retry_podname" \
            --rm -i --quiet \
            --restart=Never \
            --image="$CRANE_IMAGE" \
            --overrides="$_retry_overrides" 2>&1)"
  _rc=$?
  printf '%s\n' "$_out" | tail -15 | sed 's/^/    /' >&2
  # See _push_local: "existing manifest" is a definitive idempotent-success
  # signal, honored even if the run wrapper exits non-zero.
  if [ "$_rc" -ne 0 ] && printf '%s' "$_out" | grep -q 'existing manifest'; then
    echo "    (manifest already present at remote — treating as pushed)" >&2
    return 0
  fi
  return "$_rc"
}

# -----------------------------------------------------------------------
# Pre-push: discover which remote tags already exist
# -----------------------------------------------------------------------
# Batches all manifest-existence checks into one pod (or one docker
# sidecar for local), so re-runs against an already-populated registry
# skip the per-image push entirely. Set FORCE_PUSH=true to bypass the
# check and re-push everything (useful after rebuilding a base image
# without bumping its tag).
FORCE_PUSH="${FORCE_PUSH:-false}"

# Compose the list of remotes we'd push so the check pod can iterate.
_remotes_to_check=()
for _tag in "${BASE_TAGS[@]}"; do
  _remotes_to_check+=("${REGISTRY_HOST}/library/${_tag}")
done

# Build the existence-check shell snippet — printed remote name on a
# line if `crane digest` succeeds, silent otherwise. Shared by both
# the local and k8s transports below.
_build_check_cmd() {
  # shellcheck disable=SC2016
  printf 'for img in %s; do crane --insecure digest "$img" >/dev/null 2>&1 && echo "$img"; done' \
    "$(printf '%s ' "${_remotes_to_check[@]}")"
}

# Returns the set of remotes that already exist on stdout (one per line).
_discover_existing() {
  local _check_cmd
  _check_cmd="$(_build_check_cmd)"
  local _jwt
  _jwt="$(_sign_platform_jwt)"
  case "$DEPLOY_TARGET" in
    local)
      # `crane catalog`-style listing also works, but per-image digest
      # checks are simpler and don't depend on the registry exposing
      # the catalog API (Docker registry's catalog is admin-only in
      # some configs).
      # JWT via env (`-e PLATFORM_JWT`), not argv — see _push_local. The
      # container shell expands "$PLATFORM_JWT"; _check_cmd is non-secret.
      local _login="crane --insecure auth login '${REGISTRY_HOST}' --username _token --password \"\$PLATFORM_JWT\" >/dev/null"
      PLATFORM_JWT="$_jwt" docker run --rm \
        --network "$BACKEND_NETWORK" \
        -e PLATFORM_JWT \
        --entrypoint sh \
        "$CRANE_IMAGE" -c "$_login && $_check_cmd" 2>/dev/null \
        || true
      ;;
    minikube|ec2|eks)
      local _podname="crane-check-$(date +%s)-$$"
      # Inner shell command for the pod's `sh -c`. Must be JSON-escaped
      # before embedding in the override below — _check_cmd contains
      # literal `"` characters that would otherwise terminate the JSON
      # string and break the spec.
      local _full_cmd='crane --insecure auth login "$REGISTRY_HOST" --username _token --password "$PLATFORM_JWT" >/dev/null && '"$_check_cmd"
      local _full_cmd_json="${_full_cmd//\"/\\\"}"
      local _overrides
      _overrides=$(_pod_overrides "$_podname" "$_full_cmd_json" false "$_jwt" "$REGISTRY_HOST")
      # Do NOT capture via `kubectl run --attach`: when the images already exist,
      # `crane digest` returns almost instantly and the pod completes BEFORE the attach
      # stream connects, so its stdout (the existing tags) is silently lost — the check
      # then "finds" nothing and re-pushes every run. (It's racy: a slow run, e.g. an
      # empty registry doing the full 401→token→404 dance, can connect in time, which is
      # why it looked intermittent.) Run detached, wait for completion, then read logs —
      # logs are reliable once the pod has terminated.
      kubectl_ctx -n "$NAMESPACE" run "$_podname" \
        --restart=Never --quiet \
        --image="$CRANE_IMAGE" \
        --overrides="$_overrides" >/dev/null 2>&1 || true
      local _i=0 _phase=""
      while [ "$_i" -lt 30 ]; do
        _phase=$(kubectl_ctx -n "$NAMESPACE" get pod "$_podname" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
        case "$_phase" in Succeeded|Failed) break ;; esac
        sleep 2; _i=$((_i + 1))
      done
      kubectl_ctx -n "$NAMESPACE" logs "$_podname" 2>/dev/null || true
      kubectl_ctx -n "$NAMESPACE" delete pod "$_podname" --ignore-not-found >/dev/null 2>&1 || true
      ;;
  esac
}

EXISTING_REMOTES=""
if [ "$FORCE_PUSH" != "true" ]; then
  echo "=== Checking which base images are already in ${REGISTRY_HOST}/library/ ==="
  EXISTING_REMOTES="$(_discover_existing)"
fi

_already_exists() {
  [ -n "$EXISTING_REMOTES" ] && printf '%s\n' "$EXISTING_REMOTES" | grep -Fxq "$1"
}

# -----------------------------------------------------------------------
# Main push loop
# -----------------------------------------------------------------------
echo "=== Pushing base images to ${REGISTRY_HOST}/library/ ($DEPLOY_TARGET) ==="
for _tag in "${BASE_TAGS[@]}"; do
  if ! docker image inspect "$_tag" >/dev/null 2>&1; then
    echo "  ⚠ $_tag not in local image cache — skipping (run build-plugin-images.sh first)"
    continue
  fi
  _remote="${REGISTRY_HOST}/library/${_tag}"

  # Idempotency short-circuit: skip if the tag already exists at the
  # remote. Set FORCE_PUSH=true to re-push (e.g. after rebuilding the
  # base image without bumping its tag).
  if _already_exists "$_remote"; then
    echo "  = $_tag already in registry (skipping; FORCE_PUSH=true to override)"
    continue
  fi

  # Sign a fresh JWT per image — image-registry's token endpoint enforces
  # a 300s expiry, and the slowest base (sonarcloud + JDK) can take longer
  # than that on its own. A loop-wide JWT would work for the first image
  # and 401 on the rest.
  _jwt="$(_sign_platform_jwt)"

  case "$DEPLOY_TARGET" in
    local)            _push_fn=_push_local ;;   # crane in a docker sidecar on backend-network
    minikube|ec2|eks) _push_fn=_push_k8s ;;     # crane in a one-shot kubectl-run pod in-cluster
  esac

  if "$_push_fn" "$_tag" "$_remote" "$_jwt"; then
    echo "  ↑ pushed $_tag → $_remote"
  else
    echo "  ✗ push FAILED for $_tag → $_remote" >&2
    exit 1
  fi
done
echo "  Done"
