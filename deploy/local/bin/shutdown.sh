#!/bin/sh
set -e

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$DEPLOY_DIR"

echo "=== Stopping Docker Compose services ==="
docker compose down "$@"

echo ""
echo "=== Shutdown complete ==="
echo ""
echo "  Data preserved in: $DEPLOY_DIR/data/"
echo "  To remove all data: rm -rf $DEPLOY_DIR/data/"
echo "  To remove volumes:  docker compose down -v"
