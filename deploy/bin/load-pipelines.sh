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
UPLOAD_DELAY=${UPLOAD_DELAY:-3}
[[ "$UPLOAD_DELAY" =~ ^[0-9]+$ ]] || { echo "ERROR: UPLOAD_DELAY must be a non-negative integer (got: '$UPLOAD_DELAY')" >&2; exit 1; }
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

  # `|| _rc=$?`: curl_with_retry returns 1/2; a bare call under `set -e` would
  # abort before the dispatch below, losing the FAILED/SKIPPED accounting.
  local _rc=0
  curl_with_retry "$dir_name" \
    -X POST "${PLATFORM_BASE_URL}/api/pipeline" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "x-org-id: system" \
    -H "x-internal-service: true" \
    -d "$BODY" || _rc=$?
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
  # cd first so find doesn't fail to restore cwd when run via sudo -u from
  # a dir the target user can't read (typical EC2 case from /home/ec2-user).
  while IFS= read -r f; do _files+=("$f"); done < <(cd "$PIPELINES_DIR" && find . -maxdepth 2 -name "pipeline.json" | sort | sed "s|^\./|$PIPELINES_DIR/|")
  if [ "${#_files[@]}" -eq 0 ]; then
    echo "  No pipeline.json files found under $PIPELINES_DIR"
    return
  fi

  _items=()
  for f in "${_files[@]}"; do
    _name=$(basename "$(dirname "$f")")
    if ! _item=$(jq -c '.accessModifier = "public"' "$f" 2>&1); then
      echo "  ERROR: failed to parse $_name ($f): $_item" >&2
      FAILED=$((FAILED + 1))
      continue
    fi
    echo "    + $_name"
    _items+=("$_item")
  done

  if [ "${#_items[@]}" -eq 0 ]; then
    echo "  No valid pipelines to upload"
    return
  fi

  _count="${#_items[@]}"
  _body_file=$(mktemp)
  # Build {"pipelines":[...]} into a file and POST it via -d @file. The payload
  # can be large (many sample pipelines); passing it on the argv risks ARG_MAX
  # ("Argument list too long").
  _payload_file=$(mktemp)
  printf '%s\n' "${_items[@]}" | jq -s '{pipelines: .}' > "$_payload_file"
  trap 'rm -f "$_body_file" "$_payload_file"' RETURN

  echo "  Uploading ${_count} pipeline(s) in single bulk request..."

  # Retry on transient HTTP via the shared helper. CURL_BODY_FILE tells
  # curl_with_retry where to write the response body — passing `-o` in the
  # arg list would be silently ignored (curl only honors one `-o` per URL,
  # and the helper's own `-o` wins).
  local _rc=0
  CURL_BODY_FILE="$_body_file" curl_with_retry "bulk(${_count})" \
    -X POST "${PLATFORM_BASE_URL}/api/pipelines/bulk/create" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "x-org-id: system" \
    -H "x-internal-service: true" \
    -d @"$_payload_file" || _rc=$?

  if [ "$_rc" = 0 ]; then
    local body created updated failed errors
    body="$(cat "$_body_file" 2>/dev/null)"
    # Empty input makes jq exit 0 with no output (not 0); coerce via :- to keep numeric arithmetic safe.
    created=$(echo "$body" | jq -r '(.data.created // 0) | tostring' 2>/dev/null)
    updated=$(echo "$body" | jq -r '(.data.updated // 0) | tostring' 2>/dev/null)
    failed=$(echo "$body" | jq -r '(.data.failed // 0)  | tostring' 2>/dev/null)
    created="${created:-0}"
    updated="${updated:-0}"
    failed="${failed:-0}"
    # The bulk endpoint upserts: an item matching an existing pipeline comes
    # back as `updated`, not `created`. Both are successful outcomes. Counting
    # only `created` made a re-run over already-loaded samples report
    # "Succeeded: 0" (created:0/failed:0, nothing in any bucket) — a
    # false-negative that hid whether the upload actually worked.
    SUCCEEDED=$((SUCCEEDED + created + updated))
    FAILED=$((FAILED + failed))
    echo "    created: ${created}, updated: ${updated}, failed: ${failed}"
    if [ -z "$body" ]; then
      echo "    WARNING: empty response body — server returned HTTP 2xx but no JSON" >&2
    fi
    errors=$(echo "$body" | jq -r '.data.errors[]? | "    ERROR [\(.index)]: \(.error)"' 2>/dev/null || true)
    # `[ -n "$x" ] && cmd` as the function's last statement returns 1 when $x
    # is empty, which under `set -e` kills the script before print_summary —
    # and cascades into init-platform.sh's compliance/dashboard prompts.
    if [ -n "$errors" ]; then
      echo "$errors"
    fi
  else
    FAILED=$((FAILED + _count))
  fi
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
  for pipeline_dir in "$PIPELINES_DIR"/*/; do
    [ -d "$pipeline_dir" ] || continue
    [ -f "${pipeline_dir}/pipeline.json" ] || continue
    PROCESSED=$((PROCESSED + 1))
    echo "  [$PROCESSED/$TOTAL] $(basename "$pipeline_dir")"
    upload_pipeline_single "$pipeline_dir"
    remaining=$((TOTAL - PROCESSED))
    [ "$UPLOAD_DELAY" -gt 0 ] && [ "$remaining" -gt 0 ] && sleep "$UPLOAD_DELAY"
  done
else
  upload_pipelines_bulk
fi

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="

# Propagate failure to exit code so CI/init catches partial-failure runs
# (bulk mode's HTTP 200 with `failed: N` was previously masked).
[ "$FAILED" -gt 0 ] && exit 1
exit 0
