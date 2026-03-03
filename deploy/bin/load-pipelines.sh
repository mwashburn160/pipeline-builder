#!/bin/sh
set -eu

# Load all sample pipelines from deploy/samples into the platform.
#
# Features:
#   - Creates pipelines from pipeline.json files
#   - Supports dry-run mode for validation
#   - Reports success/failure summary with timing
#
# Usage:
#   ./load-pipelines.sh                                        # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-pipelines.sh         # custom platform URL
#   ./load-pipelines.sh --dry-run                              # validate only, no upload
#   UPLOAD_DELAY=2 ./load-pipelines.sh                         # 2s delay between uploads

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

SAMPLES_DIR="$DEPLOY_DIR/samples"
PIPELINES_DIR="$SAMPLES_DIR/pipelines"
UPLOAD_DELAY=${UPLOAD_DELAY:-3}

# Defaults
DRY_RUN=false
SUCCEEDED=0
FAILED=0
SKIPPED=0
TOTAL=0
QUEUED=0

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run              Validate pipeline files, but skip upload"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN         JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL      Platform API URL (default: https://localhost:8443)"
      echo "  UPLOAD_DELAY           Seconds between uploads (default: 3)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "=== Pipeline Loader ==="
echo "  URL:     $PLATFORM_BASE_URL"
echo "  Dry-run: $DRY_RUN"
echo ""

# Authenticate
JWT_TOKEN=""
if [ "$DRY_RUN" = false ]; then
  require_auth
fi

if [ ! -d "$PIPELINES_DIR" ]; then
    echo "No pipelines directory found at $PIPELINES_DIR" >&2
    exit 1
fi

START_TIME=$(date +%s)

echo "=== Creating sample pipelines ==="

# Pre-count total eligible pipelines
for pipeline_dir in "$PIPELINES_DIR"/*/; do
  [ -d "$pipeline_dir" ] || continue
  [ -f "${pipeline_dir}/pipeline.json" ] || continue
  TOTAL=$((TOTAL + 1))
done

echo "  Found $TOTAL pipeline(s) to process"
echo ""

for pipeline_dir in "$PIPELINES_DIR"/*/; do
  [ -d "$pipeline_dir" ] || continue

  pipeline_file="${pipeline_dir}/pipeline.json"
  dir_name=$(basename "$pipeline_dir")

  if [ ! -f "$pipeline_file" ]; then
    echo "  [$dir_name] SKIP: Missing pipeline.json"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  QUEUED=$((QUEUED + 1))
  REMAINING=$((TOTAL - QUEUED))

  echo "  [$QUEUED/$TOTAL] $dir_name  (remaining: $REMAINING)"

  if [ "$DRY_RUN" = true ]; then
    echo "    OK (dry-run, skipping upload)"
    SUCCEEDED=$((SUCCEEDED + 1))
    continue
  fi

  BODY=$(jq ".accessModifier = \"public\"" "$pipeline_file")
  CREATE_STATUS=$(curl -X POST "${PLATFORM_BASE_URL}/api/pipeline" \
    -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "x-org-id: system" \
    -d "$BODY" \
    --insecure 2>/dev/null || echo "000")

  _result=$(classify_status "$CREATE_STATUS")
  case "$_result" in
    ok)     echo "    OK (HTTP ${CREATE_STATUS})";             SUCCEEDED=$((SUCCEEDED + 1)) ;;
    exists) echo "    SKIP (HTTP 409 - already exists)";       SKIPPED=$((SKIPPED + 1)) ;;
    fail)   echo "    FAIL (HTTP ${CREATE_STATUS})";           FAILED=$((FAILED + 1)) ;;
  esac

  if [ "$UPLOAD_DELAY" -gt 0 ] 2>/dev/null && [ "$REMAINING" -gt 0 ]; then
    sleep "$UPLOAD_DELAY"
  fi
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="
