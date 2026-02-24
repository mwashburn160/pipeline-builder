#!/bin/sh
set -e

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
# Ensure data directories exist
# -----------------------------------------------------------------------
echo "=== Ensuring data directories exist ==="
mkdir -p "$DEPLOY_DIR/data/db-data/mongodb" \
         "$DEPLOY_DIR/data/db-data/postgres" \
         "$DEPLOY_DIR/data/db-data/grafana" \
         "$DEPLOY_DIR/data/db-data/loki" \
         "$DEPLOY_DIR/data/db-data/prometheus" \
         "$DEPLOY_DIR/data/registry-data" \
         "$DEPLOY_DIR/data/pgadmin-data"

# -----------------------------------------------------------------------
# Start services
# -----------------------------------------------------------------------
echo "=== Starting Docker Compose ==="
docker compose up --remove-orphans "$@"
