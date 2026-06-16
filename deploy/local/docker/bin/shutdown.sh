#!/usr/bin/env bash
set -euo pipefail

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$DEPLOY_DIR"

# Set DOCKER_BUILD_TEMP_ROOT so docker-compose.yml references resolve
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-$DEPLOY_DIR/data/tmp}"

# Prefer Compose v2; fall back to legacy docker-compose v1.
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "ERROR: requires 'docker compose' (v2 plugin) or 'docker-compose' (v1)" >&2
  exit 1
fi

echo "=== Stopping Docker Compose services ==="
"${DC[@]}" down "$@"

echo ""
echo "=== Shutdown complete ==="
echo ""
echo "  Data preserved in: $DEPLOY_DIR/data/"
echo "  To remove all data: rm -rf $DEPLOY_DIR/data/"
echo "  To remove volumes:  docker compose down -v"
