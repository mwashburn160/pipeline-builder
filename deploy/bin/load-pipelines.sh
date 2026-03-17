#!/usr/bin/env bash
set -eu

# Load all sample pipelines from deploy/samples into the platform.
#
# Usage:
#   ./load-pipelines.sh                                        # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-pipelines.sh         # custom platform URL
#   ./load-pipelines.sh --dry-run                              # validate only, no upload
#   UPLOAD_DELAY=2 ./load-pipelines.sh                         # 2s delay between uploads

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

PIPELINES_DIR="$DEPLOY_DIR/samples/pipelines"
UPLOAD_DELAY=${UPLOAD_DELAY:-3}
UPLOAD_RETRIES=${UPLOAD_RETRIES:-3}
UPLOAD_RETRY_DELAY=${UPLOAD_RETRY_DELAY:-30}
DRY_RUN=false
SUCCEEDED=0
FAILED=0
SKIPPED=0
TOTAL=0
PROCESSED=0

# ---- Argument parsing ----

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

# ---- Helper functions ----

upload_pipeline() {
  pipeline_dir="$1"
  dir_name="$(basename "$pipeline_dir")"

  PROCESSED=$((PROCESSED + 1))
  echo "  [$PROCESSED/$TOTAL] $dir_name"

  if [ "$DRY_RUN" = true ]; then
    echo "    OK (dry-run)"
    SUCCEEDED=$((SUCCEEDED + 1))
    return
  fi

  BODY=$(jq ".accessModifier = \"public\"" "${pipeline_dir}/pipeline.json") || {
    echo "    FAIL (invalid JSON)"; FAILED=$((FAILED + 1)); return
  }

  _attempt=1
  while [ "$_attempt" -le "$UPLOAD_RETRIES" ]; do
    status=$(curl -X POST "${PLATFORM_BASE_URL}/api/pipeline" \
      -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer ${JWT_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "x-org-id: system" \
      -d "$BODY" \
      --insecure 2>/dev/null || echo "000")

    _result="$(classify_status "$status")"

    # Retry on transient errors: 429 (rate limit), 502/503/504 (server), 000 (connection failure)
    if [ "$_result" = "fail" ] && { [ "$status" = "429" ] || [ "$status" = "502" ] || [ "$status" = "503" ] || [ "$status" = "504" ] || [ "$status" = "000" ]; } && [ "$_attempt" -lt "$UPLOAD_RETRIES" ]; then
      echo "    RETRY (HTTP ${status}) attempt ${_attempt}/${UPLOAD_RETRIES} — waiting ${UPLOAD_RETRY_DELAY}s"
      sleep "$UPLOAD_RETRY_DELAY"
      _attempt=$((_attempt + 1))
      continue
    fi

    case "$_result" in
      ok)     echo "    OK (HTTP ${status})";    SUCCEEDED=$((SUCCEEDED + 1)) ;;
      exists) echo "    SKIP (already exists)";  SKIPPED=$((SKIPPED + 1)) ;;
      fail)   echo "    FAIL (HTTP ${status})";  FAILED=$((FAILED + 1)) ;;
    esac
    break
  done
}

# ---- Main ----

echo "=== Pipeline Loader ==="
echo "  URL:     $PLATFORM_BASE_URL"
echo "  Dry-run: $DRY_RUN"
echo ""

JWT_TOKEN=""
[ "$DRY_RUN" = false ] && require_auth

if [ ! -d "$PIPELINES_DIR" ]; then
  echo "No pipelines directory found at $PIPELINES_DIR" >&2
  exit 1
fi

# Pre-count eligible pipelines
for pipeline_dir in "$PIPELINES_DIR"/*/; do
  [ -d "$pipeline_dir" ] || continue
  [ -f "${pipeline_dir}/pipeline.json" ] || continue
  TOTAL=$((TOTAL + 1))
done

START_TIME=$(date +%s)
echo ""
echo "=== Processing $TOTAL pipeline(s) ==="

for pipeline_dir in "$PIPELINES_DIR"/*/; do
  [ -d "$pipeline_dir" ] || continue
  [ -f "${pipeline_dir}/pipeline.json" ] || continue

  upload_pipeline "$pipeline_dir"

  remaining=$((TOTAL - PROCESSED))
  if [ "$DRY_RUN" = false ] && [ "$UPLOAD_DELAY" -gt 0 ] 2>/dev/null && [ "$remaining" -gt 0 ]; then
    sleep "$UPLOAD_DELAY"
  fi
done

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="
