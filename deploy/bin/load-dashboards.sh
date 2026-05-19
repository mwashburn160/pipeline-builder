#!/usr/bin/env bash
set -euo pipefail

# Load the default observability dashboards from deploy/seeds/dashboards/*.json
# into the platform via POST /api/dashboards.
#
# Idempotent: skips dashboards whose `(orgId='system', name)` already exists
# in the DB. Used both as a one-shot bootstrap step (called from
# init-platform.sh after the sysadmin user is created) and as a re-seed lever
# when curated defaults change.
#
# The platform service also runs an in-process seeder at cold start
# (platform/src/services/dashboard-seeder.ts) — this script is the
# externalized / operator-driven equivalent and is the canonical source of
# truth for what defaults ship in a fresh deploy.
#
# Usage:
#   ./load-dashboards.sh                                        # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-dashboards.sh         # custom platform URL
#   ./load-dashboards.sh --dry-run                              # validate only, no upload

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

DASHBOARDS_DIR="$DEPLOY_DIR/seeds/dashboards"
DRY_RUN=false
SUCCEEDED=0
FAILED=0
SKIPPED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--dry-run]"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN     JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL  Platform API URL (default: https://localhost:8443)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "=== Dashboard Loader ==="
echo "  URL:     $PLATFORM_BASE_URL"
echo "  Dir:     $DASHBOARDS_DIR"
echo "  Dry-run: $DRY_RUN"
echo ""

if [ ! -d "$DASHBOARDS_DIR" ]; then
  echo "No dashboards dir at $DASHBOARDS_DIR — nothing to load."
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found in PATH" >&2; exit 1; }

# Ensure we have a JWT (common.sh sets PLATFORM_TOKEN or prompts for login)
require_auth

# Cache the existing system-org dashboards once so we can do a name-collision
# skip without round-tripping to the API for each seed file.
existing_json=$(curl -s -X GET "${PLATFORM_BASE_URL}/api/dashboards" \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "x-org-id: system" \
  --insecure 2>/dev/null || echo '{}')
existing_names=$(echo "$existing_json" \
  | jq -r '.data.dashboards[]? | select(.orgId == "system") | .name' 2>/dev/null || echo '')

for f in "$DASHBOARDS_DIR"/*.json; do
  [ -f "$f" ] || continue
  fname=$(basename "$f")

  # Parse + extract dashboard name for the duplicate check.
  if ! parsed=$(jq -c '.' "$f" 2>&1); then
    echo "  [$fname] FAIL — invalid JSON: $parsed"
    FAILED=$((FAILED + 1))
    continue
  fi
  name=$(echo "$parsed" | jq -r '.name // empty')
  if [ -z "$name" ]; then
    echo "  [$fname] FAIL — missing required field 'name'"
    FAILED=$((FAILED + 1))
    continue
  fi

  if echo "$existing_names" | grep -Fxq "$name"; then
    echo "  [$fname] SKIP — already present (name='$name')"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "  [$fname] DRY — would POST: name='$name'"
    continue
  fi

  status=$(curl -s -o /tmp/load-dashboards-resp.$$ -w "%{http_code}" \
    -X POST "${PLATFORM_BASE_URL}/api/dashboards" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "x-org-id: system" \
    -H "x-internal-service: true" \
    -d "$parsed" \
    --insecure 2>/dev/null || echo "000")

  case "$status" in
    20*)
      echo "  [$fname] OK  (HTTP $status) — name='$name'"
      SUCCEEDED=$((SUCCEEDED + 1))
      ;;
    409)
      # Race vs the in-process seeder: another path beat us to it. Treat as
      # success-equivalent — the dashboard exists either way.
      echo "  [$fname] SKIP (HTTP 409 already-exists)"
      SKIPPED=$((SKIPPED + 1))
      ;;
    *)
      msg=$(cat /tmp/load-dashboards-resp.$$ 2>/dev/null | jq -r '.message // .' 2>/dev/null || echo "")
      echo "  [$fname] FAIL (HTTP $status) — $msg"
      FAILED=$((FAILED + 1))
      ;;
  esac
  rm -f /tmp/load-dashboards-resp.$$
done

echo ""
echo "=== Done ==="
echo "  Created: $SUCCEEDED"
echo "  Skipped: $SKIPPED"
echo "  Failed:  $FAILED"

[ "$FAILED" -eq 0 ]
