#!/bin/sh
set -eu

# Load all plugins from deploy/plugins into the platform.
#
# Features:
#   - Validates manifests before uploading
#   - Rebuilds plugin.zip if Dockerfile or manifest.yaml is newer
#   - Uploads plugins by category with progress tracking
#   - Supports dry-run mode, category filtering, and parallel uploads
#   - Reports success/failure summary with timing
#
# Usage:
#   ./load-plugins.sh                                        # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-plugins.sh         # custom platform URL
#   ./load-plugins.sh --dry-run                              # validate only, no upload
#   ./load-plugins.sh --category language                    # upload only language plugins
#   ./load-plugins.sh --category security,quality             # upload multiple categories
#   ./load-plugins.sh --rebuild                              # force rebuild all plugin.zip
#   ./load-plugins.sh --parallel 4                           # upload 4 plugins concurrently
#   UPLOAD_DELAY=2 ./load-plugins.sh                         # 2s delay between uploads

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

PLUGINS_DIR="$DEPLOY_DIR/plugins"
UPLOAD_DELAY=${UPLOAD_DELAY:-5}

# Defaults
DRY_RUN=false
REBUILD=false
CATEGORY_FILTER=""
PARALLEL=1
UPLOAD_TIMEOUT=900
QUEUE_POLL_INTERVAL=${QUEUE_POLL_INTERVAL:-5}
QUEUE_POLL_TIMEOUT=${QUEUE_POLL_TIMEOUT:-1800}
SUCCEEDED=0
FAILED=0
SKIPPED=0
TOTAL=0
QUEUED=0

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --rebuild) REBUILD=true; shift ;;
    --category) CATEGORY_FILTER="$2"; shift 2 ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --timeout) UPLOAD_TIMEOUT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run              Validate manifests and rebuild zips, but skip upload"
      echo "  --rebuild              Force rebuild all plugin.zip files"
      echo "  --category CATEGORIES  Comma-separated categories to upload (e.g., language,security)"
      echo "  --parallel N           Upload N plugins concurrently (default: 1)"
      echo "  --timeout SECONDS      Upload timeout in seconds (default: 900)"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN         JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL      Platform API URL (default: https://localhost:8443)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Validate manifest schema (lightweight check)
validate_manifest() {
  manifest="$1"
  plugin_path="$2"
  plugin_name="$(basename "$plugin_path")"
  errors=""

  plugin_type=$(grep "^pluginType:" "$manifest" 2>/dev/null | head -1 | sed 's/pluginType: *//')

  for field in name description version pluginType computeType; do
    if ! grep -q "^${field}:" "$manifest" 2>/dev/null; then
      errors="${errors}  Missing field: ${field}\n"
    fi
  done

  if [ "$plugin_type" != "ManualApprovalStep" ]; then
    for field in primaryOutputDirectory dockerfile installCommands commands; do
      if ! grep -q "^${field}:" "$manifest" 2>/dev/null; then
        errors="${errors}  Missing field: ${field}\n"
      fi
    done
  fi

  manifest_name=$(grep "^name:" "$manifest" 2>/dev/null | head -1 | sed 's/name: *//')
  if [ "$manifest_name" != "$plugin_name" ]; then
    errors="${errors}  Name mismatch: manifest='${manifest_name}' dir='${plugin_name}'\n"
  fi

  if [ "$plugin_type" != "CodeBuildStep" ] && [ "$plugin_type" != "ManualApprovalStep" ]; then
    errors="${errors}  Invalid pluginType: ${plugin_type}\n"
  fi

  if [ -n "$errors" ]; then
    printf "    INVALID manifest:\n%b" "$errors" >&2
    return 1
  fi
  return 0
}

# Rebuild plugin.zip if sources are newer
maybe_rebuild_zip() {
  plugin_path="$1"
  zip_file="${plugin_path}/plugin.zip"
  dockerfile="${plugin_path}/Dockerfile"
  manifest="${plugin_path}/manifest.yaml"

  zip_files="manifest.yaml"
  if [ -f "$dockerfile" ]; then
    zip_files="Dockerfile manifest.yaml"
  fi

  if [ "$REBUILD" = true ] || [ ! -f "$zip_file" ]; then
    (cd "$plugin_path" && zip -q plugin.zip $zip_files)
    echo "    Rebuilt plugin.zip"
    return
  fi

  needs_rebuild=false
  if [ "$manifest" -nt "$zip_file" ]; then
    needs_rebuild=true
  fi
  if [ -f "$dockerfile" ] && [ "$dockerfile" -nt "$zip_file" ]; then
    needs_rebuild=true
  fi

  if [ "$needs_rebuild" = true ]; then
    (cd "$plugin_path" && zip -q plugin.zip $zip_files)
    echo "    Rebuilt plugin.zip (sources changed)"
  fi
}

# Upload a single plugin
upload_plugin() {
  zip_file="$1"
  plugin_path="$(dirname "$zip_file")"
  plugin_name="$(basename "$plugin_path")"
  category="$(basename "$(dirname "$plugin_path")")"

  QUEUED=$((QUEUED + 1))
  REMAINING=$((TOTAL - QUEUED))

  echo "  [$QUEUED/$TOTAL] ${category}/${plugin_name}  (remaining: $REMAINING)"

  manifest="${plugin_path}/manifest.yaml"
  if [ ! -f "$manifest" ]; then
    echo "    SKIP: No manifest.yaml"
    SKIPPED=$((SKIPPED + 1))
    return
  fi

  if ! validate_manifest "$manifest" "$plugin_path"; then
    FAILED=$((FAILED + 1))
    return
  fi

  maybe_rebuild_zip "$plugin_path"

  if [ "$DRY_RUN" = true ]; then
    echo "    OK (dry-run, skipping upload)"
    SUCCEEDED=$((SUCCEEDED + 1))
    return
  fi

  UPLOAD_STATUS=$(curl -X POST "${PLATFORM_BASE_URL}/api/plugin/upload" \
    -s -o /dev/null -w "%{http_code}" --max-time "$UPLOAD_TIMEOUT" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "x-org-id: system" \
    -F "plugin=@${zip_file}" \
    -F "accessModifier=public" \
    --insecure 2>/dev/null || echo "000")

  _result=$(classify_status "$UPLOAD_STATUS")
  case "$_result" in
    ok)     echo "    OK (HTTP ${UPLOAD_STATUS})";             SUCCEEDED=$((SUCCEEDED + 1)) ;;
    exists) echo "    SKIP (HTTP 409 - already exists)";       SKIPPED=$((SKIPPED + 1)) ;;
    fail)   echo "    FAIL (HTTP ${UPLOAD_STATUS})";           FAILED=$((FAILED + 1)) ;;
  esac
}

echo "=== Plugin Loader ==="
echo "  URL:        $PLATFORM_BASE_URL"
echo "  Dry-run:    $DRY_RUN"
echo "  Rebuild:    $REBUILD"
echo "  Categories: ${CATEGORY_FILTER:-all}"
echo "  Parallel:   $PARALLEL"
echo ""

# Authenticate
JWT_TOKEN=""
if [ "$DRY_RUN" = false ]; then
  require_auth
fi

if [ ! -d "$PLUGINS_DIR" ]; then
    echo "No plugins directory found at $PLUGINS_DIR" >&2
    exit 1
fi

START_TIME=$(date +%s)

echo "=== Processing plugins ==="

# Build list of categories
if [ -n "$CATEGORY_FILTER" ]; then
  CATEGORIES=$(echo "$CATEGORY_FILTER" | tr ',' ' ')
else
  CATEGORIES=$(find "$PLUGINS_DIR" -mindepth 1 -maxdepth 1 -type d | sort | xargs -I{} basename {})
fi

# Pre-count total eligible plugins
for category in $CATEGORIES; do
  category_dir="${PLUGINS_DIR}/${category}"
  [ -d "$category_dir" ] || continue
  for plugin_dir in "${category_dir}"/*/; do
    [ -d "$plugin_dir" ] || continue
    [ -f "${plugin_dir}/manifest.yaml" ] || continue
    plugin_type=$(grep "^pluginType:" "${plugin_dir}/manifest.yaml" 2>/dev/null | head -1 | sed 's/pluginType: *//')
    if [ "$plugin_type" != "ManualApprovalStep" ] && [ ! -f "${plugin_dir}/Dockerfile" ]; then
      continue
    fi
    TOTAL=$((TOTAL + 1))
  done
done

echo "  Found $TOTAL plugin(s) to process"
echo ""

for category in $CATEGORIES; do
  category_dir="${PLUGINS_DIR}/${category}"
  if [ ! -d "$category_dir" ]; then
    echo "  WARNING: Category not found: ${category}"
    continue
  fi

  echo ""
  echo "--- ${category} ---"

  for plugin_dir in "${category_dir}"/*/; do
    [ -d "$plugin_dir" ] || continue

    if [ ! -f "${plugin_dir}/manifest.yaml" ]; then
      echo "  [$(basename "$plugin_dir")] SKIP: Missing manifest.yaml"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    plugin_type=$(grep "^pluginType:" "${plugin_dir}/manifest.yaml" 2>/dev/null | head -1 | sed 's/pluginType: *//')
    if [ "$plugin_type" != "ManualApprovalStep" ] && [ ! -f "${plugin_dir}/Dockerfile" ]; then
      echo "  [$(basename "$plugin_dir")] SKIP: Missing Dockerfile"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    zip_file="${plugin_dir}/plugin.zip"
    upload_plugin "$zip_file"

    REMAINING=$((TOTAL - QUEUED))
    if [ "$DRY_RUN" = false ] && [ "$UPLOAD_DELAY" -gt 0 ] 2>/dev/null && [ "$REMAINING" -gt 0 ]; then
      sleep "$UPLOAD_DELAY"
    fi
  done
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

# ---------------------------------------------------------------------------
# Poll BullMQ queue until all builds complete
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = false ] && [ "$SUCCEEDED" -gt 0 ]; then
  echo ""
  echo "=== Waiting for builds to complete ==="
  POLL_START=$(date +%s)

  while true; do
    QUEUE_RESP=$(curl -s --max-time 10 \
      -H "Authorization: Bearer ${JWT_TOKEN}" \
      -H "x-org-id: system" \
      "${PLATFORM_BASE_URL}/api/plugin/queue/status" \
      --insecure 2>/dev/null) || QUEUE_RESP='{}'

    Q_WAITING=$(printf '%s' "$QUEUE_RESP" | jq -r '.data.waiting // 0' 2>/dev/null) || Q_WAITING=0
    Q_ACTIVE=$(printf '%s' "$QUEUE_RESP" | jq -r '.data.active // 0' 2>/dev/null) || Q_ACTIVE=0
    Q_COMPLETED=$(printf '%s' "$QUEUE_RESP" | jq -r '.data.completed // 0' 2>/dev/null) || Q_COMPLETED=0
    Q_FAILED=$(printf '%s' "$QUEUE_RESP" | jq -r '.data.failed // 0' 2>/dev/null) || Q_FAILED=0

    ELAPSED=$(( $(date +%s) - POLL_START ))
    echo "  [${ELAPSED}s] waiting=$Q_WAITING  active=$Q_ACTIVE  completed=$Q_COMPLETED  failed=$Q_FAILED"

    PENDING=$((Q_WAITING + Q_ACTIVE))
    if [ "$PENDING" -eq 0 ]; then
      echo ""
      echo "  All builds finished."
      break
    fi

    if [ "$ELAPSED" -ge "$QUEUE_POLL_TIMEOUT" ]; then
      echo ""
      echo "  WARNING: Timed out after ${QUEUE_POLL_TIMEOUT}s with $PENDING job(s) still pending"
      break
    fi

    sleep "$QUEUE_POLL_INTERVAL"
  done

  BUILD_END=$(date +%s)
  BUILD_DURATION=$((BUILD_END - POLL_START))

  echo ""
  echo "=== Build Summary ==="
  echo "  Completed: $Q_COMPLETED"
  echo "  Failed:    $Q_FAILED"
  echo "  Duration:  ${BUILD_DURATION}s"

  if [ "$Q_FAILED" -gt 0 ]; then
    echo ""
    echo "=== Failed Build Details ==="
    FAILED_RESP=$(curl -s --max-time 10 \
      -H "Authorization: Bearer ${JWT_TOKEN}" \
      -H "x-org-id: system" \
      "${PLATFORM_BASE_URL}/api/plugin/queue/failed?limit=${Q_FAILED}" \
      --insecure 2>/dev/null) || FAILED_RESP='{}'

    FAILED_COUNT=$(printf '%s' "$FAILED_RESP" | jq -r '.data.total // 0' 2>/dev/null) || FAILED_COUNT=0

    if [ "$FAILED_COUNT" -gt 0 ]; then
      printf '%s' "$FAILED_RESP" | jq -r '.data.jobs[] | "  [\(.pluginName // .name)] \(.error // "unknown error" | split("\n")[0])"' 2>/dev/null || echo "  (could not parse failure details)"
    else
      echo "  (no details available — check plugin service logs)"
    fi
  fi
fi

echo ""
echo "=== Done ==="
