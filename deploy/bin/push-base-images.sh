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
#   local        — push via crane in a docker sidecar on backend-network
#                  (reads JWT_SECRET from deploy/local/.env)
#   minikube|ec2 — push via crane in a one-shot kubectl-run pod inside
#                  the cluster (reads JWT_SECRET from the jwt-secret
#                  Secret in the pipeline-builder namespace)
#
# Selected via DEPLOY_TARGET env var (default: local). init-platform.sh
# exports this when invoking build-plugin-images.sh.
#
# Requires: docker CLI, openssl. k8s targets also need kubectl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_TARGET="${DEPLOY_TARGET:-local}"
NAMESPACE="${NAMESPACE:-pipeline-builder}"
CRANE_IMAGE="${CRANE_IMAGE:-gcr.io/go-containerregistry/crane:debug}"

# -----------------------------------------------------------------------
# Per-target setup: locate JWT_SECRET and the registry coordinates
# -----------------------------------------------------------------------
case "$DEPLOY_TARGET" in
  local)
    DEPLOY_DIR="$(cd "$SCRIPT_DIR/../local" && pwd)"
    if [ ! -f "$DEPLOY_DIR/.env" ]; then
      echo "ERROR: $DEPLOY_DIR/.env not found" >&2
      exit 1
    fi
    set -a; . "$DEPLOY_DIR/.env"; set +a
    # In-cluster service-discovery name used both by the registry and
    # by the token realm sent in WWW-Authenticate. We push from a
    # sidecar on backend-network so DNS resolves correctly.
    REGISTRY_HOST="registry:5000"
    BACKEND_NETWORK="${BACKEND_NETWORK:-backend-network}"
    if ! docker network inspect "$BACKEND_NETWORK" >/dev/null 2>&1; then
      echo "ERROR: docker network '$BACKEND_NETWORK' not found." >&2
      echo "  Set BACKEND_NETWORK=<name> if your compose network is named differently." >&2
      exit 1
    fi
    ;;
  minikube|ec2)
    if ! command -v kubectl >/dev/null 2>&1; then
      echo "ERROR: kubectl not found in PATH (required for DEPLOY_TARGET=$DEPLOY_TARGET)" >&2
      exit 1
    fi
    # JWT_SECRET lives in a k8s Secret created by startup.sh. Crane runs
    # inside the cluster, so the registry/realm hostnames it sees are
    # the standard ClusterIP DNS names — same form the in-cluster
    # plugin service uses at runtime.
    JWT_SECRET="$(kubectl -n "$NAMESPACE" get secret jwt-secret -o jsonpath='{.data.JWT_SECRET}' 2>/dev/null | base64 -d || true)"
    if [ -z "$JWT_SECRET" ]; then
      echo "ERROR: JWT_SECRET not found in Secret 'jwt-secret' (namespace: $NAMESPACE)" >&2
      echo "  Has startup.sh been run? Verify with:" >&2
      echo "    kubectl -n $NAMESPACE get secret jwt-secret" >&2
      exit 1
    fi
    REGISTRY_HOST="registry:5000"
    ;;
  *)
    echo "ERROR: unsupported DEPLOY_TARGET='$DEPLOY_TARGET' (expected: local, minikube, ec2)" >&2
    exit 1
    ;;
esac

# -----------------------------------------------------------------------
# JWT signing — shared across targets
# -----------------------------------------------------------------------
# Mint an HS256 JWT signed with JWT_SECRET, no Node deps required.
# Image-registry's /token endpoint validates this as platform-JWT-as-
# password — same trick the plugin service uses for runtime builds.
_b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}
_sign_platform_jwt() {
  local _now _exp _header _payload _signing _sig
  _now=$(date +%s)
  _exp=$((_now + 300))
  _header='{"alg":"HS256","typ":"JWT"}'
  # image-registry/services/auth-resolver.ts verifyPlatformJwt requires
  # `organizationId` (not `orgId`) and returns null otherwise. `isAdmin`
  # gates access to library/* and system/* via the admin-priority rule
  # in token-service.ts authorizeScope.
  _payload=$(printf '{"sub":"bootstrap-push","organizationId":"system","isAdmin":true,"isSuperAdmin":true,"iat":%s,"exp":%s}' "$_now" "$_exp")
  _signing="$(printf %s "$_header" | _b64url).$(printf %s "$_payload" | _b64url)"
  _sig=$(printf %s "$_signing" | openssl dgst -binary -sha256 -hmac "$JWT_SECRET" | _b64url)
  printf '%s.%s\n' "$_signing" "$_sig"
}

# Smoke-test signing before the loop — fail loudly here if JWT_SECRET is
# missing rather than per-image.
if [ -z "$(_sign_platform_jwt)" ]; then
  echo "ERROR: failed to sign platform JWT (JWT_SECRET missing?)" >&2
  exit 1
fi

# -----------------------------------------------------------------------
# Image discovery — same across targets
# -----------------------------------------------------------------------
# Matches both the root base (`pipeline-plugin-base:24.04`) and family
# bases (`pipeline-<name>-base:1.0`) produced by build-plugin-images.sh.
BASE_TAGS=()
while IFS= read -r _tag; do
  [ -n "$_tag" ] && BASE_TAGS+=("$_tag")
done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | \
         grep -E '^(pipeline-plugin-base:24\.04|pipeline-[a-z0-9-]+-base:1\.0)$')

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
  local _cmd="cat > /tmp/img.tar && crane --insecure auth login '${REGISTRY_HOST}' --username _token --password '${_jwt}' >/dev/null && crane --insecure push /tmp/img.tar '${_remote}'"
  if docker save "$_tag" | docker run --rm -i \
       --network "$BACKEND_NETWORK" \
       --entrypoint sh \
       "$CRANE_IMAGE" -c "$_cmd" >/dev/null 2>&1; then
    return 0
  fi
  # Re-run with output for diagnosis.
  docker save "$_tag" | docker run --rm -i \
     --network "$BACKEND_NETWORK" \
     --entrypoint sh \
     "$CRANE_IMAGE" -c "$_cmd" 2>&1 | tail -15 | sed 's/^/    /' >&2
  return 1
}

# Push via a one-shot kubectl-run crane pod inside the cluster
# (minikube/ec2). Same auth dance, but DNS resolution happens inside the
# cluster so the registry + image-registry service names are reachable.
# JWT is passed via env (--env), not as a CLI arg, so it doesn't leak in
# the host's process list. The pod is auto-deleted on exit (--rm).
_push_k8s() {
  local _tag="$1" _remote="$2" _jwt="$3"
  local _podname="crane-push-$(date +%s)-$$"
  local _cmd='cat > /tmp/img.tar && crane --insecure auth login "$REGISTRY_HOST" --username _token --password "$PLATFORM_JWT" >/dev/null && crane --insecure push /tmp/img.tar "$REMOTE"'
  if docker save "$_tag" | kubectl -n "$NAMESPACE" run "$_podname" \
       --rm -i --quiet \
       --restart=Never \
       --image="$CRANE_IMAGE" \
       --env="PLATFORM_JWT=$_jwt" \
       --env="REGISTRY_HOST=$REGISTRY_HOST" \
       --env="REMOTE=$_remote" \
       --overrides='{"spec":{"containers":[{"name":"crane-push","image":"'"$CRANE_IMAGE"'","stdin":true,"stdinOnce":true,"command":["sh","-c"]}]}}' \
       --command -- sh -c "$_cmd" >/dev/null 2>&1; then
    return 0
  fi
  # Re-run with output for diagnosis. Pod name reused with a suffix so
  # there's no name collision against the prior --rm cleanup.
  docker save "$_tag" | kubectl -n "$NAMESPACE" run "${_podname}-retry" \
     --rm -i --quiet \
     --restart=Never \
     --image="$CRANE_IMAGE" \
     --env="PLATFORM_JWT=$_jwt" \
     --env="REGISTRY_HOST=$REGISTRY_HOST" \
     --env="REMOTE=$_remote" \
     --command -- sh -c "$_cmd" 2>&1 | tail -15 | sed 's/^/    /' >&2
  return 1
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
  # Sign a fresh JWT per image — image-registry's token endpoint enforces
  # a 300s expiry, and the slowest base (sonarcloud + JDK) can take longer
  # than that on its own. A loop-wide JWT would work for the first image
  # and 401 on the rest.
  _jwt="$(_sign_platform_jwt)"

  case "$DEPLOY_TARGET" in
    local)          _push_fn=_push_local ;;
    minikube|ec2)   _push_fn=_push_k8s ;;
  esac

  if "$_push_fn" "$_tag" "$_remote" "$_jwt"; then
    echo "  ↑ pushed $_tag → $_remote"
  else
    echo "  ✗ push FAILED for $_tag → $_remote" >&2
    exit 1
  fi
done
echo "  Done"
