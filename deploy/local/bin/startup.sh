#!/usr/bin/env bash
set -euo pipefail

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$DEPLOY_DIR"

# -----------------------------------------------------------------------
# Verify prerequisites
# -----------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not in PATH" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running" >&2
  exit 1
fi

# Prefer Compose v2 (the `docker compose` plugin); fall back to legacy
# `docker-compose` (v1), still common on older Linux. Use "${DC[@]}" below.
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "ERROR: requires 'docker compose' (v2 plugin) or 'docker-compose' (v1)" >&2
  exit 1
fi

# yq — required by build-plugin-images.sh and generate-plugins.sh. Check
# only (don't auto-install) so we don't silently mutate the user's brew state.
if ! command -v yq >/dev/null 2>&1; then
  echo "ERROR: yq is not installed (required for plugin builds)" >&2
  echo "  macOS: brew install yq" >&2
  echo "  Linux: https://github.com/mikefarah/yq#install" >&2
  exit 1
fi

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "ERROR: .env file not found at $DEPLOY_DIR/.env" >&2
  echo "  Copy .env.example to .env and update with your values" >&2
  exit 1
fi

# -----------------------------------------------------------------------
# Ensure TLS certificates exist
# -----------------------------------------------------------------------
CERT_DIR="$DEPLOY_DIR/certs"
AUTH_DIR="$DEPLOY_DIR/auth"

if [ ! -f "$CERT_DIR/nginx-tls.crt" ] || [ ! -f "$CERT_DIR/nginx-tls.key" ]; then
  echo "=== Generating self-signed nginx TLS certificate ==="
  mkdir -p "$CERT_DIR"
  # Generate the SAN via a temp config so this works on both OpenSSL and the
  # LibreSSL shipped by older macOS (which lacks `req -addext`).
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
SANEOF
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/nginx-tls.key" -out "$CERT_DIR/nginx-tls.crt" \
    -config "$_sancnf"
  rm -f "$_sancnf"
  chmod 644 "$CERT_DIR/nginx-tls.key"
fi

if [ ! -f "$CERT_DIR/image-registry-jwt.key" ] || [ ! -f "$CERT_DIR/image-registry-jwt.crt" ]; then
  echo "=== Generating image-registry JWT signing keypair ==="
  "$SCRIPT_DIR/gen-image-registry-jwt-keys.sh"
fi

if [ ! -f "$AUTH_DIR/registry.passwd" ]; then
  echo "=== Generating registry htpasswd ==="
  mkdir -p "$AUTH_DIR"
  # Load env vars for registry credentials
  set -a; . "$DEPLOY_DIR/.env"; set +a
  if command -v htpasswd >/dev/null 2>&1; then
    htpasswd -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
  else
    docker run --rm --entrypoint htpasswd httpd:2 -Bbn "$IMAGE_REGISTRY_USER" "$IMAGE_REGISTRY_TOKEN" > "$AUTH_DIR/registry.passwd"
  fi
fi

# -----------------------------------------------------------------------
# Ensure MongoDB keyfile has correct permissions
# -----------------------------------------------------------------------
KEYFILE="$DEPLOY_DIR/mongodb-keyfile"
if [ ! -f "$KEYFILE" ]; then
  echo "=== Generating MongoDB keyfile ==="
  openssl rand -base64 756 > "$KEYFILE"
fi
chmod 400 "$KEYFILE"

# -----------------------------------------------------------------------
# Ensure data directories exist
# -----------------------------------------------------------------------
echo "=== Ensuring data directories exist ==="
mkdir -p "$DEPLOY_DIR/data/db-data/mongodb" \
         "$DEPLOY_DIR/data/db-data/postgres" \
         "$DEPLOY_DIR/data/db-data/redis" \
         "$DEPLOY_DIR/data/db-data/loki" \
         "$DEPLOY_DIR/data/db-data/prometheus" \
         "$DEPLOY_DIR/data/registry-data" \
         "$DEPLOY_DIR/data/pgadmin-data" \
         "$DEPLOY_DIR/data/uploads" \
         "$DEPLOY_DIR/data/cache" \
         "$DEPLOY_DIR/data/buildkit-cache" \
         "$DEPLOY_DIR/data/promtail-positions"

# Docker build temp dir. Two paths in play:
#   - Host: where docker-compose binds the volume from (created + chmod'd here)
#   - Container: laptop-style /data/plugins-data/* inside the plugin
#     container, matching the volumeMount in docker-compose.yml. The plugin
#     code reads DOCKER_BUILD_TEMP_ROOT to find the build dir, so the env
#     value must equal the container-side bind target.
# k8s/fargate deploys keep host=container path at /opt/pipeline/pipeline-data/*
# (k8s hostPath + EFS access points mount the same absolute path on both sides).
PLUGIN_BUILDS_HOST="$DEPLOY_DIR/data/plugins-data/builds"
PLUGIN_UPLOADS_HOST="$DEPLOY_DIR/data/plugins-data/uploads"
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-/data/plugins-data/builds}"
mkdir -p "$PLUGIN_BUILDS_HOST" "$PLUGIN_UPLOADS_HOST"

# Plugin container runs as node (UID 1000) — ensure writable volume mounts
chmod 1777 "$PLUGIN_BUILDS_HOST" "$PLUGIN_UPLOADS_HOST"

# Plugin builds run via a rootless buildkitd sidecar — no strategy choice,
# no dind, no certs to generate. See deploy/local/docker-compose.yml.

# -----------------------------------------------------------------------
# Start services
# -----------------------------------------------------------------------
echo "=== Starting Docker Compose ==="
"${DC[@]}" up --remove-orphans "$@"
