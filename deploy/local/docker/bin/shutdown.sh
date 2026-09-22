#!/usr/bin/env bash
set -euo pipefail

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$DEPLOY_DIR"

# Compose V2 only — see the note in bin/setup.sh: docker-compose v1 cannot read
# this stack's file.
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: requires the 'docker compose' V2 plugin" >&2
  exit 1
fi

echo "=== Stopping Docker Compose services ==="
docker compose down "$@"

echo ""
echo "=== Shutdown complete ==="
echo ""
echo "  Data preserved in: $DEPLOY_DIR/data/"
echo "  To remove all data: rm -rf $DEPLOY_DIR/data/"
echo "  To remove volumes:  docker compose down -v"
