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
# Fix: push each base to `registry:5000/library/<name>:<tag>`. Combined
# with the docker.io → registry:5000 mirror in
# `deploy/local/config/buildkitd/buildkitd.toml`, bare FROM lines now
# resolve transparently.
#
# Auth: the in-cluster registry uses token auth (REGISTRY_AUTH=token).
# We sign a short-lived JWT with JWT_SECRET (same approach the plugin
# service uses in helpers/docker-build.ts:writeAuthConfig) and feed it
# to docker login as `_token:<jwt>`.
#
# Requires: docker CLI, jq, node (for jwt signing).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/../local" && pwd)"

# Load .env so we have JWT_SECRET + registry coords
if [ -f "$DEPLOY_DIR/.env" ]; then
  set -a; . "$DEPLOY_DIR/.env"; set +a
else
  echo "ERROR: $DEPLOY_DIR/.env not found" >&2
  exit 1
fi

# In-cluster docker-network hostname for the registry. We push from a
# sidecar container running on the backend-network, so we use the
# service-discovery name (`registry:5000`) — NOT a host-mapped port —
# which means the token-realm URL (`http://image-registry:3000/token`)
# is also resolvable by the sidecar's HTTP client.
REGISTRY_HOST="registry:5000"
# The compose file declares `backend-network` with an explicit `name:`
# field, so it's NOT project-prefixed. Override only if you renamed it.
BACKEND_NETWORK="${BACKEND_NETWORK:-backend-network}"

if ! docker network inspect "$BACKEND_NETWORK" >/dev/null 2>&1; then
  echo "ERROR: docker network '$BACKEND_NETWORK' not found." >&2
  echo "  Set BACKEND_NETWORK=<name> if your compose network is named differently." >&2
  exit 1
fi

# Discover all base tags from the host docker image cache. Matches both
# the root base (`pipeline-plugin-base:24.04`) and family bases
# (`pipeline-<name>-base:1.0`) produced by build-plugin-images.sh.
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

# Mint an HS256 JWT signed with JWT_SECRET, no Node deps required.
# (jsonwebtoken would be cleaner but global install isn't guaranteed on
# operator workstations.) Image-registry's /token endpoint validates
# this as platform-JWT-as-password — same trick the plugin service uses.
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
  # determines whether the issued registry token can access org-scoped
  # repos beyond the caller's own org.
  _payload=$(printf '{"sub":"bootstrap-push","organizationId":"system","isAdmin":true,"isSuperAdmin":true,"iat":%s,"exp":%s}' "$_now" "$_exp")
  _signing="$(printf %s "$_header" | _b64url).$(printf %s "$_payload" | _b64url)"
  _sig=$(printf %s "$_signing" | openssl dgst -binary -sha256 -hmac "$JWT_SECRET" | _b64url)
  printf '%s.%s\n' "$_signing" "$_sig"
}

PLATFORM_JWT="$(_sign_platform_jwt)"
if [ -z "$PLATFORM_JWT" ]; then
  echo "ERROR: failed to sign platform JWT (JWT_SECRET missing?)" >&2
  exit 1
fi

# Build the auth header crane will use: `Authorization: Bearer <jwt>`.
# crane accepts platform-JWT-as-password through the standard
# Basic-auth-on-realm flow that image-registry/routes/token honors.
AUTH_B64=$(printf '_token:%s' "$PLATFORM_JWT" | base64 | tr -d '\n')

echo "=== Pushing base images to ${REGISTRY_HOST}/library/ (via sidecar) ==="
# Build a single sidecar invocation that:
#   1. Receives the image tarball on stdin (docker save piped in)
#   2. Pushes it via crane to registry:5000/library/<tag>
#   3. Uses Basic auth so the registry's token-realm dance succeeds with
#      our platform JWT as the password (Image-registry validates this
#      via JWT_SECRET — same path the plugin service uses).
#
# crane is in gcr.io/go-containerregistry/crane:debug; the :debug variant
# includes a shell so we can chain commands.
CRANE_IMAGE="${CRANE_IMAGE:-gcr.io/go-containerregistry/crane:debug}"
for _tag in "${BASE_TAGS[@]}"; do
  if ! docker image inspect "$_tag" >/dev/null 2>&1; then
    echo "  ⚠ $_tag not in local image cache — skipping (run build-plugin-images.sh first)"
    continue
  fi
  _remote="${REGISTRY_HOST}/library/${_tag}"
  # Stream `docker save` into the sidecar via stdin, dump to a file
  # inside the container (crane push needs a real path, not stdin),
  # then push that file. The sidecar's filesystem is ephemeral so no
  # cleanup is needed.
  _cmd="cat > /tmp/img.tar && crane --insecure auth login '${REGISTRY_HOST}' --username _token --password '${PLATFORM_JWT}' >/dev/null && crane --insecure push /tmp/img.tar '${_remote}'"
  if docker save "$_tag" | docker run --rm -i \
       --network "$BACKEND_NETWORK" \
       --entrypoint sh \
       "$CRANE_IMAGE" -c "$_cmd" >/dev/null 2>&1; then
    echo "  ↑ pushed $_tag → $_remote"
  else
    echo "  ✗ push FAILED for $_tag → $_remote (re-running with output):" >&2
    docker save "$_tag" | docker run --rm -i \
       --network "$BACKEND_NETWORK" \
       --entrypoint sh \
       "$CRANE_IMAGE" -c "$_cmd" 2>&1 | tail -15 | sed 's/^/    /' >&2
    exit 1
  fi
done
echo "  Done"
