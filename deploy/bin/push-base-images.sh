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
# We sign a short-lived ES256 JWT with the deploy's OWN `deploy-bootstrap`
# service key and feed it to crane as `_token:<jwt>`. The image-registry
# service resolves the key by `kid`, checks that the token's subject names it,
# and mints a registry-scoped bearer token.
#
# Deploy targets:
#   local            — push via crane in a docker sidecar on backend-network
#                      (signs with deploy/local/docker/certs/service-keys/)
#   minikube|ec2|eks — push via crane in a one-shot kubectl-run pod inside
#                      the cluster (reads the deploy-bootstrap key and the
#                      public bundle from the `service-key-deploy-bootstrap` /
#                      `service-key-bundle` Secrets in the pipeline-builder
#                      namespace). All three use the in-cluster registry at
#                      registry:5000.
#
# Selected via DEPLOY_TARGET env var (default: docker). init-platform.sh
# exports this when invoking build-plugin-images.sh.
#
# Requires: docker CLI, openssl. The k8s targets (minikube/ec2/eks) need kubectl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
DEPLOY_TARGET="${DEPLOY_TARGET:-docker}"
NAMESPACE="${NAMESPACE:-pipeline-builder}"
# crane is handed a live deploy-bootstrap JWT and push access to the in-cluster
# registry, so it is pinned BY DIGEST like every other third-party image in this
# repo (deploy/README.md) — a floating `:debug` tag would change underneath a
# re-provision. The digest is the multi-arch INDEX, so it still resolves per
# architecture. Bump: `docker buildx imagetools inspect gcr.io/go-containerregistry/crane:debug`.
# `:debug` (not `:latest`) is required: the push/check paths run `sh -c` in it.
CRANE_IMAGE="${CRANE_IMAGE:-gcr.io/go-containerregistry/crane@sha256:e78770b31258a3846f878036d9c1f63fbe4c871f9f56990bf77fd95c013e3c1b}"  # gcr.io/go-containerregistry/crane:debug

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
  if [ "$DEPLOY_TARGET" = "docker" ]; then
    kubectl "$@"
  else
    kubectl --context="$KUBECTL_CONTEXT" "$@"
  fi
}

# -----------------------------------------------------------------------
# Per-target setup: locate the deploy-bootstrap signing key and the registry
# -----------------------------------------------------------------------
case "$DEPLOY_TARGET" in
  docker)
    # `_target_dir`, NOT DEPLOY_DIR: common.sh owns DEPLOY_DIR as the `deploy/`
    # root and other sourced helpers read it. Reassigning it to one TARGET's
    # directory made the two names mean different trees in the same shell.
    # (build-plugin-images.sh calls the same thing `_pb_target_dir`.)
    _target_dir="$(cd "$SCRIPT_DIR/../local/docker" && pwd)"
    if [ ! -f "$_target_dir/.env" ]; then
      echo "ERROR: $_target_dir/.env not found" >&2
      exit 1
    fi
    set -a; . "$_target_dir/.env"; set +a
    # The deploy's own signing key + the public bundle, generated next to the
    # other key material by deploy/bin/service-signing-keys.sh.
    BOOTSTRAP_KEY_FILE="$_target_dir/certs/service-keys/deploy-bootstrap.key"
    BOOTSTRAP_BUNDLE_FILE="$_target_dir/certs/service-keys/bundle.json"
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
    # The deploy-bootstrap signing key and the public bundle live in k8s Secrets
    # created by startup.sh. Crane runs inside the cluster, so the registry/realm
    # hostnames it sees are the standard ClusterIP DNS names — same form the
    # in-cluster plugin service uses at runtime. Signing happens HERE, on the
    # host, so the key is read out and written to a temp file for openssl.
    # `openssl base64 -d` decodes portably — GNU `base64 -d` vs BSD/macOS `base64 -D`
    # differ, and this push path may be driven from a Mac.
    BOOTSTRAP_KEY_FILE="$(mktemp)"; BOOTSTRAP_BUNDLE_FILE="$(mktemp)"
    # EXIT INT TERM, not EXIT alone: an untrapped SIGINT/SIGTERM kills the shell
    # WITHOUT running the EXIT trap, and this temp file is the deploy-bootstrap
    # PRIVATE signing key. Ctrl-C during a long push must not leave it in /tmp.
    trap 'rm -f "$BOOTSTRAP_KEY_FILE" "$BOOTSTRAP_BUNDLE_FILE"' EXIT INT TERM
    kubectl_ctx -n "$NAMESPACE" get secret service-key-deploy-bootstrap -o jsonpath='{.data.service\.key}' 2>/dev/null \
      | openssl base64 -d -A > "$BOOTSTRAP_KEY_FILE" || true
    kubectl_ctx -n "$NAMESPACE" get secret service-key-bundle -o jsonpath='{.data.bundle\.json}' 2>/dev/null \
      | openssl base64 -d -A > "$BOOTSTRAP_BUNDLE_FILE" || true
    if [ ! -s "$BOOTSTRAP_KEY_FILE" ] || [ ! -s "$BOOTSTRAP_BUNDLE_FILE" ]; then
      echo "ERROR: the deploy-bootstrap service key was not found (namespace: $NAMESPACE, context: $KUBECTL_CONTEXT)" >&2
      echo "" >&2
      echo "  Verify with:" >&2
      echo "    kubectl --context=$KUBECTL_CONTEXT -n $NAMESPACE get secret service-key-deploy-bootstrap service-key-bundle" >&2
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
    echo "ERROR: unsupported DEPLOY_TARGET='$DEPLOY_TARGET' (expected: docker, minikube, ec2, eks)" >&2
    exit 1
    ;;
esac

# -----------------------------------------------------------------------
# JWT signing — shared across targets via common.sh `sign_service_jwt`.
# Smoke-test once before the loop so a missing key fails loudly here rather
# than per-image.
#
# TTL default 900s (was the sign helper's 300s): the token is signed on the
# host, but crane runs in a one-shot kubectl pod that must schedule + pull its
# image before presenting the token. Under node memory pressure that startup
# can eat a 300s window, so a fresh-but-slow-to-arrive token gets rejected as
# expired (401 "Invalid credentials" at /token) mid-run — which previously
# aborted the base push partway (e.g. after rust-base, before ruby-base).
# Override with PUSH_JWT_TTL.
# -----------------------------------------------------------------------
_sign_platform_jwt() { sign_service_jwt "$BOOTSTRAP_KEY_FILE" "$BOOTSTRAP_BUNDLE_FILE" "${PUSH_JWT_TTL:-900}"; }
if [ -z "$(_sign_platform_jwt)" ]; then
  echo "ERROR: failed to sign the deploy-bootstrap service token (run deploy/bin/service-signing-keys.sh?)" >&2
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
# _push_verdict <rc> <captured output> — the shared verdict of a RETRY attempt,
# for both transports.
#
# Prints the tail of the run so an operator sees the real error, then honours
# crane's "existing manifest" line: crane logs it (with the resolved tag@digest)
# when the image is ALREADY present at the remote, which is a definitive
# idempotent success even if the docker-run / kubectl-run wrapper around it then
# exits non-zero (observed on arm64 hosts: crane confirms the manifest yet the
# run exits 1). Without this a redundant re-push of an already-present base or
# bootstrap image fails the whole publish.
_push_verdict() {
  local _rc="$1" _out="$2"
  printf '%s\n' "$_out" | tail -15 | sed 's/^/    /' >&2
  if [ "$_rc" -ne 0 ] && printf '%s' "$_out" | grep -q 'existing manifest'; then
    echo "    (manifest already present at remote — treating as pushed)" >&2
    return 0
  fi
  return "$_rc"
}

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
  # REAL exit code (not the exit of the tail/sed pipe): a transient first-attempt
  # hiccup often clears, and _push_verdict tells that apart from a hard failure.
  local _out _rc
  _out="$(docker save "$_tag" | PLATFORM_JWT="$_jwt" docker run --rm -i \
            --network "$BACKEND_NETWORK" \
            -e PLATFORM_JWT \
            --entrypoint sh \
            "$CRANE_IMAGE" -c "$_cmd" 2>&1)"
  _rc=$?
  _push_verdict "$_rc" "$_out"
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
  local _podname
  _podname="crane-push-$(date +%s)-$$"
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
  # REAL exit code (not the exit of the tail/sed pipe); _push_verdict tells a
  # transient hiccup and an already-present manifest apart from a hard failure.
  # Pod name suffixed so there is no collision against the prior --rm cleanup.
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
  _push_verdict "$_rc" "$_out"
}

# -----------------------------------------------------------------------
# Pre-push: discover which remote tags already exist
# -----------------------------------------------------------------------
# Batches all manifest-existence checks into one pod (or one docker
# sidecar for docker), so re-runs against an already-populated registry
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
    docker)
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
      local _podname
      _podname="crane-check-$(date +%s)-$$"
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
  # A tag we were asked to push but cannot find is a hard failure, not a skip.
  # Warn-and-continue would publish nothing on the PUSH_TAGS path
  # (build-codebuild-bootstrap.sh) and still exit 0, leaving
  # CODEBUILD_DEFAULT_IMAGE absent and every CodeBuild run dying later with
  # BUILD_CONTAINER_UNABLE_TO_PULL_IMAGE.
  if ! docker image inspect "$_tag" >/dev/null 2>&1; then
    echo "ERROR: $_tag is not in the local image cache — cannot push it." >&2
    echo "  Build it first (deploy/bin/build-plugin-images.sh), or correct PUSH_TAGS." >&2
    exit 1
  fi
  _remote="${REGISTRY_HOST}/library/${_tag}"

  # Idempotency short-circuit: skip if the tag already exists at the
  # remote. Set FORCE_PUSH=true to re-push (e.g. after rebuilding the
  # base image without bumping its tag).
  if _already_exists "$_remote"; then
    echo "  = $_tag already in registry (skipping; FORCE_PUSH=true to override)"
    continue
  fi

  # Sign a fresh JWT per image — the platform token TTL (PUSH_JWT_TTL, default
  # 900s) can still be exceeded across a long multi-image push run (the slowest
  # base, sonarcloud + JDK, is minutes on its own), so a single loop-wide JWT
  # could expire mid-run and 401 the later images. Re-signing per image is cheap.
  _jwt="$(_sign_platform_jwt)"

  case "$DEPLOY_TARGET" in
    docker)            _push_fn=_push_local ;;   # crane in a docker sidecar on backend-network
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
