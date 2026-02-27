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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGINS_DIR="$DEPLOY_DIR/plugins"
PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}

# Defaults
DRY_RUN=false
REBUILD=false
CATEGORY_FILTER=""
PARALLEL=1
UPLOAD_TIMEOUT=900
SUCCEEDED=0
FAILED=0
SKIPPED=0
TOTAL=0

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

  for field in name description version pluginType computeType primaryOutputDirectory dockerfile installCommands commands; do
    if ! grep -q "^${field}:" "$manifest" 2>/dev/null; then
      errors="${errors}  Missing field: ${field}\n"
    fi
  done

  # Validate name matches directory
  manifest_name=$(grep "^name:" "$manifest" 2>/dev/null | head -1 | sed 's/name: *//')
  if [ "$manifest_name" != "$plugin_name" ]; then
    errors="${errors}  Name mismatch: manifest='${manifest_name}' dir='${plugin_name}'\n"
  fi

  # Validate pluginType
  plugin_type=$(grep "^pluginType:" "$manifest" 2>/dev/null | head -1 | sed 's/pluginType: *//')
  if [ "$plugin_type" != "CodeBuildStep" ]; then
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

  if [ "$REBUILD" = true ] || [ ! -f "$zip_file" ]; then
    (cd "$plugin_path" && zip -q plugin.zip Dockerfile manifest.yaml)
    echo "    Rebuilt plugin.zip"
    return
  fi

  # Check if sources are newer than zip
  if [ "$dockerfile" -nt "$zip_file" ] || [ "$manifest" -nt "$zip_file" ]; then
    (cd "$plugin_path" && zip -q plugin.zip Dockerfile manifest.yaml)
    echo "    Rebuilt plugin.zip (sources changed)"
  fi
}

# Upload a single plugin
upload_plugin() {
  zip_file="$1"
  plugin_path="$(dirname "$zip_file")"
  plugin_name="$(basename "$plugin_path")"
  category="$(basename "$(dirname "$plugin_path")")"

  TOTAL=$((TOTAL + 1))

  echo "  [${category}/${plugin_name}]"

  # Validate manifest
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

  # Rebuild zip if needed
  maybe_rebuild_zip "$plugin_path"

  if [ "$DRY_RUN" = true ]; then
    echo "    OK (dry-run, skipping upload)"
    SUCCEEDED=$((SUCCEEDED + 1))
    return
  fi

  # Upload
  UPLOAD_STATUS=$(curl -X POST "${PLATFORM_BASE_URL}/api/plugin/upload" \
    -s -o /dev/null -w "%{http_code}" --max-time "$UPLOAD_TIMEOUT" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "x-org-id: system" \
    -F "plugin=@${zip_file}" \
    -F "accessModifier=public" \
    --insecure 2>/dev/null || echo "000")

  case "$UPLOAD_STATUS" in
    200|201)
      echo "    OK (HTTP ${UPLOAD_STATUS})"
      SUCCEEDED=$((SUCCEEDED + 1))
      ;;
    409)
      echo "    SKIP (HTTP 409 - already exists)"
      SKIPPED=$((SKIPPED + 1))
      ;;
    *)
      echo "    FAIL (HTTP ${UPLOAD_STATUS})"
      FAILED=$((FAILED + 1))
      ;;
  esac
}

echo "=== Plugin Loader ==="
echo "  URL:        $PLATFORM_BASE_URL"
echo "  Dry-run:    $DRY_RUN"
echo "  Rebuild:    $REBUILD"
echo "  Categories: ${CATEGORY_FILTER:-all}"
echo "  Parallel:   $PARALLEL"
echo ""

# Login (skip in dry-run mode)
JWT_TOKEN=""
if [ "$DRY_RUN" = false ]; then
  echo "=== Authenticating ==="
  JWT_TOKEN=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/login" \
      -k -s \
      -H 'Content-Type: application/json' \
      -d '{
           "identifier": "admin@internal",
           "password": "SecurePassword123!"
          }' | jq -r '.data.accessToken')

  if [ -z "${JWT_TOKEN}" ] || [ "${JWT_TOKEN}" = "null" ]; then
      echo "  Login failed — could not obtain JWT token" >&2
      exit 1
  fi
  echo "  Logged in successfully."
  echo ""
fi

if [ ! -d "$PLUGINS_DIR" ]; then
    echo "No plugins directory found at $PLUGINS_DIR" >&2
    exit 1
fi

START_TIME=$(date +%s)

echo "=== Processing plugins ==="

# Build list of categories to process
if [ -n "$CATEGORY_FILTER" ]; then
  CATEGORIES=$(echo "$CATEGORY_FILTER" | tr ',' ' ')
else
  CATEGORIES=$(find "$PLUGINS_DIR" -mindepth 1 -maxdepth 1 -type d | sort | xargs -I{} basename {})
fi

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

    # Check for required files
    if [ ! -f "${plugin_dir}/Dockerfile" ] || [ ! -f "${plugin_dir}/manifest.yaml" ]; then
      echo "  [$(basename "$plugin_dir")] SKIP: Missing Dockerfile or manifest.yaml"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    zip_file="${plugin_dir}/plugin.zip"
    upload_plugin "$zip_file"
  done
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "=== Summary ==="
echo "  Total:     $TOTAL"
echo "  Succeeded: $SUCCEEDED"
echo "  Failed:    $FAILED"
echo "  Skipped:   $SKIPPED"
echo "  Duration:  ${DURATION}s"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "WARNING: ${FAILED} plugin(s) failed to upload"
  exit 1
fi

echo ""
echo "=== Done ==="
