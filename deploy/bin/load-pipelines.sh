#!/usr/bin/env bash
set -euo pipefail

# Load all sample pipelines from deploy/samples into the platform.
#
# Uses bulk create endpoint to upload all pipelines in a single request.
#
# Usage:
#   ./load-pipelines.sh                                        # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-pipelines.sh         # custom platform URL
#   ./load-pipelines.sh --dry-run                              # validate only, no upload
#   ./load-pipelines.sh --single                               # use single-create endpoint (legacy)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

PIPELINES_DIR="$DEPLOY_DIR/samples/pipelines"
UPLOAD_RETRIES=${UPLOAD_RETRIES:-3}
UPLOAD_RETRY_DELAY=${UPLOAD_RETRY_DELAY:-30}
DRY_RUN=false
SINGLE_MODE=false
SUCCEEDED=0
FAILED=0
SKIPPED=0
TOTAL=0

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --single)  SINGLE_MODE=true; shift ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run   Validate pipeline files, but skip upload"
      echo "  --single    Use single-create endpoint instead of bulk (legacy mode)"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN         JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL      Platform API URL (default: https://localhost:8443)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---- Helper functions ----

upload_pipeline_single() {
  local pipeline_dir="$1"
  local dir_name="$(basename "$pipeline_dir")"

  local BODY
  BODY=$(jq '.accessModifier = "public"' "${pipeline_dir}/pipeline.json") || {
    echo "    FAIL (invalid JSON)"; FAILED=$((FAILED + 1)); return
  }

  curl_with_retry "$dir_name" \
    -X POST "${PLATFORM_BASE_URL}/api/pipeline" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "x-org-id: system" \
    -H "x-internal-service: true" \
    -d "$BODY"
  local _rc=$?
  case "$_rc" in
    0) SUCCEEDED=$((SUCCEEDED + 1)) ;;
    2) SKIPPED=$((SKIPPED + 1)) ;;
    *) FAILED=$((FAILED + 1)) ;;
  esac
}

upload_pipelines_bulk() {
  echo "  Building bulk payload..."

  command -v jq >/dev/null 2>&1 || { echo "  ERROR: jq not found in PATH" >&2; exit 1; }

  # Validate each pipeline.json individually so a single bad file doesn't kill the whole run silently
  _files=()
  while IFS= read -r f; do _files+=("$f"); done < <(find "$PIPELINES_DIR" -maxdepth 2 -name "pipeline.json" | sort)
  if [ "${#_files[@]}" -eq 0 ]; then
    echo "  No pipeline.json files found under $PIPELINES_DIR"
    return
  fi

  _items=()
  for f in "${_files[@]}"; do
    if ! _item=$(jq -c '.accessModifier = "public"' "$f" 2>&1); then
      echo "  ERROR: failed to parse $f: $_item" >&2
      FAILED=$((FAILED + 1))
      continue
    fi
    _items+=("$_item")
  done

  if [ "${#_items[@]}" -eq 0 ]; then
    echo "  No valid pipelines to upload"
    return
  fi

  BULK_PAYLOAD=$(printf '%s\n' "${_items[@]}" | jq -s '.')
  _count="${#_items[@]}"

  echo "  Uploading ${_count} pipeline(s) in single bulk request..."

  _attempt=1
  while [ "$_attempt" -le "$UPLOAD_RETRIES" ]; do
    response=$(curl -X POST "${PLATFORM_BASE_URL}/api/pipelines/bulk/create" \
      -s -w "\n%{http_code}" \
      -H "Authorization: Bearer ${JWT_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "x-org-id: system" \
      -H "x-internal-service: true" \
      -d "{\"pipelines\": ${BULK_PAYLOAD}}" \
      --insecure 2>/dev/null || echo -e "\n000")

    status=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')

    _result="$(classify_status "$status")"

    if [ "$_result" = "fail" ] && is_retryable_status "$status" && [ "$_attempt" -lt "$UPLOAD_RETRIES" ]; then
      echo "    RETRY (HTTP ${status}) attempt ${_attempt}/${UPLOAD_RETRIES} — waiting ${UPLOAD_RETRY_DELAY}s"
      sleep "$UPLOAD_RETRY_DELAY"
      _attempt=$((_attempt + 1))
      continue
    fi

    if [ "$_result" = "ok" ]; then
      created=$(echo "$body" | jq -r '.data.created // 0' 2>/dev/null || echo "0")
      failed=$(echo "$body" | jq -r '.data.failed // 0' 2>/dev/null || echo "0")
      SUCCEEDED=$((SUCCEEDED + created))
      FAILED=$((FAILED + failed))
      echo "    OK (HTTP ${status}) — created: ${created}, failed: ${failed}"

      # Show individual errors if any
      errors=$(echo "$body" | jq -r '.data.errors[]? | "    ERROR [\(.index)]: \(.error)"' 2>/dev/null || true)
      [ -n "$errors" ] && echo "$errors"
    else
      echo "    FAIL (HTTP ${status})"
      FAILED=$((FAILED + _count))
    fi
    break
  done
}

# ---- Main ----

echo "=== Pipeline Loader ==="
echo "  URL:     $PLATFORM_BASE_URL"
echo "  Mode:    $([ "$SINGLE_MODE" = true ] && echo "single" || echo "bulk")"
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

if [ "$DRY_RUN" = true ]; then
  PROCESSED=0
  for pipeline_dir in "$PIPELINES_DIR"/*/; do
    [ -d "$pipeline_dir" ] || continue
    [ -f "${pipeline_dir}/pipeline.json" ] || continue
    PROCESSED=$((PROCESSED + 1))
    echo "  [$PROCESSED/$TOTAL] $(basename "$pipeline_dir") — OK (dry-run)"
    SUCCEEDED=$((SUCCEEDED + 1))
  done
elif [ "$SINGLE_MODE" = true ]; then
  PROCESSED=0
  UPLOAD_DELAY=${UPLOAD_DELAY:-3}
  for pipeline_dir in "$PIPELINES_DIR"/*/; do
    [ -d "$pipeline_dir" ] || continue
    [ -f "${pipeline_dir}/pipeline.json" ] || continue
    PROCESSED=$((PROCESSED + 1))
    echo "  [$PROCESSED/$TOTAL] $(basename "$pipeline_dir")"
    upload_pipeline_single "$pipeline_dir"
    remaining=$((TOTAL - PROCESSED))
    [ "$UPLOAD_DELAY" -gt 0 ] 2>/dev/null && [ "$remaining" -gt 0 ] && sleep "$UPLOAD_DELAY"
  done
else
  upload_pipelines_bulk
fi

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="
