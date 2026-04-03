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

if [ ! -f "$CERT_DIR/nginx.crt" ] || [ ! -f "$CERT_DIR/nginx.key" ]; then
  echo "=== Generating self-signed nginx TLS certificate ==="
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/nginx.key" -out "$CERT_DIR/nginx.crt" \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
fi

if [ ! -f "$CERT_DIR/registry.crt" ] || [ ! -f "$CERT_DIR/registry.key" ]; then
  echo "=== Generating self-signed registry TLS certificate ==="
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/registry.key" -out "$CERT_DIR/registry.crt" \
    -subj "/CN=registry" -addext "subjectAltName=DNS:registry,DNS:localhost"
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
if [ -f "$KEYFILE" ]; then
  chmod 400 "$KEYFILE"
fi

# -----------------------------------------------------------------------
# Ensure data directories exist
# -----------------------------------------------------------------------
echo "=== Ensuring data directories exist ==="
mkdir -p "$DEPLOY_DIR/data/db-data/mongodb" \
         "$DEPLOY_DIR/data/db-data/postgres" \
         "$DEPLOY_DIR/data/db-data/redis" \
         "$DEPLOY_DIR/data/db-data/grafana" \
         "$DEPLOY_DIR/data/db-data/loki" \
         "$DEPLOY_DIR/data/db-data/prometheus" \
         "$DEPLOY_DIR/data/registry-data" \
         "$DEPLOY_DIR/data/pgadmin-data" \
         "$DEPLOY_DIR/data/uploads" \
         "$DEPLOY_DIR/data/cache"

# Docker build temp dir — must be the SAME absolute path on both host and
# container so buildkitd.toml bind mounts resolve correctly.
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-$DEPLOY_DIR/data/tmp}"
mkdir -p "$DOCKER_BUILD_TEMP_ROOT"

# Plugin container runs as node (UID 1000) — ensure writable volume mounts
chmod 777 "$DEPLOY_DIR/data/uploads" "$DOCKER_BUILD_TEMP_ROOT"

# Docker-in-Docker TLS certs (dind auto-generates certs on first start)
mkdir -p "$DEPLOY_DIR/certs/dind"

# -----------------------------------------------------------------------
# Plugin build target selection
# -----------------------------------------------------------------------
set -a; . "$DEPLOY_DIR/.env"; set +a
CURRENT_STRATEGY="${DOCKER_BUILD_STRATEGY:-docker}"

echo ""
echo "=== Plugin Build Strategy ==="
echo "  Current: $CURRENT_STRATEGY"
echo ""
echo "  1) docker  — Docker daemon via dind sidecar"
echo "  2) podman  — Podman standard"
echo ""
read -rp "Select strategy [1-2] or press Enter to keep '$CURRENT_STRATEGY': " choice

case "$choice" in
  1) SELECTED_STRATEGY="docker" ;;
  2) SELECTED_STRATEGY="podman" ;;
  *) SELECTED_STRATEGY="$CURRENT_STRATEGY" ;;
esac

if [ "$SELECTED_STRATEGY" != "$CURRENT_STRATEGY" ]; then
  sed -i '' "s/^DOCKER_BUILD_STRATEGY=.*/DOCKER_BUILD_STRATEGY=$SELECTED_STRATEGY/" "$DEPLOY_DIR/.env"
  # Update plugin image tag to match selected strategy
  PLUGIN_VERSION=$(grep 'ghcr.io/mwashburn160/plugin:' "$DEPLOY_DIR/docker-compose.yml" | head -1 | sed 's/.*plugin:\([0-9.]*\).*/\1/')
  if [ -n "$PLUGIN_VERSION" ]; then
    sed -i '' "s|ghcr.io/mwashburn160/plugin:[0-9.]*-[a-z]*|ghcr.io/mwashburn160/plugin:${PLUGIN_VERSION}-${SELECTED_STRATEGY}|" "$DEPLOY_DIR/docker-compose.yml"
  fi
  echo "  Updated: strategy=$SELECTED_STRATEGY, image=plugin:${PLUGIN_VERSION}-${SELECTED_STRATEGY}"
fi

if [ "$SELECTED_STRATEGY" = "docker" ]; then
  echo "  Using dind sidecar for isolated Docker builds"
else
  echo "  Using podman standard (requires SYS_ADMIN capability)"
fi
echo ""

# -----------------------------------------------------------------------
# Start services
# -----------------------------------------------------------------------
echo "=== Starting Docker Compose ==="
docker compose up --remove-orphans "$@"
