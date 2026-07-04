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

# yq — required by build-plugin-images.sh. Check
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
BIN_DIR="$(cd "$SCRIPT_DIR/../../../bin" && pwd)"   # deploy/bin (shared helpers)

# nginx gateway TLS + image-registry token-signing keypair — shared, idempotent
# generators (see deploy/bin/{nginx-tls,jwt-keys}.sh). Both skip when the files
# already exist, so re-running setup is cheap and doesn't rotate keys.
bash "$BIN_DIR/nginx-tls.sh" "$CERT_DIR"
# image-registry token-signing keypair → certs/image-registry-jwt.{key,crt},
# bind-mounted as /etc/registry/jwt-{private,public}.pem by the registry +
# image-registry containers. MUST exist before `compose up`, otherwise Docker
# creates the mount paths as empty DIRECTORIES and both containers crash-loop
# ("is a directory" / EISDIR reading the PEM). Idempotent (skips if present).
bash "$BIN_DIR/jwt-keys.sh" "$CERT_DIR"
# (No registry htpasswd: the registry uses token auth — REGISTRY_AUTH: token in
# docker-compose.yml; nothing mounts registry.passwd.)

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
# the ec2 deploy keeps host=container path at /opt/pipeline/pipeline-data/*
# (its k8s hostPath mounts the same absolute path on both sides).
PLUGIN_BUILDS_HOST="$DEPLOY_DIR/data/plugins-data/builds"
PLUGIN_UPLOADS_HOST="$DEPLOY_DIR/data/plugins-data/uploads"
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-/data/plugins-data/builds}"
mkdir -p "$PLUGIN_BUILDS_HOST" "$PLUGIN_UPLOADS_HOST"

# Plugin container runs as node (UID 1000) — ensure writable volume mounts
chmod 1777 "$PLUGIN_BUILDS_HOST" "$PLUGIN_UPLOADS_HOST"

# Plugin builds run via a rootless buildkitd sidecar — no strategy choice,
# no dind, no certs to generate. See deploy/local/docker/docker-compose.yml.

# Register QEMU/binfmt when the build target arch differs from the host (e.g.
# building linux/amd64 plugin images on an arm64 box) — rootless buildkit can't
# do it itself. No-op on Docker Desktop (QEMU pre-registered) and on same-arch.
# PUBLISH_PLATFORM is read from .env (compose's default is linux/amd64).
PUBLISH_PLATFORM="$(grep -E '^PUBLISH_PLATFORM=' "$DEPLOY_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
bash "$BIN_DIR/ensure-binfmt.sh" "${PUBLISH_PLATFORM:-linux/amd64}"

# -----------------------------------------------------------------------
# Start services
# -----------------------------------------------------------------------
echo "=== Starting Docker Compose ==="
# Detached: start the stack and RETURN (so an orchestrator like
# `pipeline-manager provision` can proceed to health checks + init-platform, and
# a direct run doesn't block on streamed container logs). Matches the README
# quick-start. Watch logs any time with: docker compose logs -f
"${DC[@]}" up -d --remove-orphans "$@"
echo "Stack started (detached). Follow logs with: ${DC[*]} logs -f"

# Access summary (mirrors the AWS targets' "Deployment Complete" output).
echo ""
echo "========================================"
echo "Deployment Complete — Local (Docker Compose)"
echo "========================================"
echo ""
echo "  Platform UI / API : https://localhost:8443"
echo "  Default admin     : admin@internal  (default password & overrides in docs/README.md — set PLATFORM_PASSWORD to change)"
echo ""
echo "  Dev tools:"
echo "    pgAdmin (Postgres UI)    : http://localhost:5480"
echo "    Mongo Express (Mongo UI) : http://localhost:27081"
echo "    Jaeger (tracing)         : http://localhost:16686"
echo "    Docker registry          : localhost:5000"
echo ""
echo "  Databases (postgres / mongodb / redis) run inside the compose network —"
echo "  reach them via the dev tools above, not a host port. Credentials live in"
echo "  ${DEPLOY_DIR}/.env."
echo ""
echo "  Next : ./deploy/bin/init-platform.sh docker        # register admin + (opt-in) load plugins/samples/compliance"
echo "  Stop : ${DC[*]} down                              # data persists in ${DEPLOY_DIR}/data"
echo "  Reset: ${DC[*]} down && rm -rf ${DEPLOY_DIR}/data  # wipe DBs for a clean re-init"
echo ""
