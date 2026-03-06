#!/bin/sh
set -eu

# Load all plugins from deploy/plugins into the platform.
#
# Usage:
#   ./load-plugins.sh                                        # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-plugins.sh         # custom platform URL
#   ./load-plugins.sh --dry-run                              # validate only, no upload
#   ./load-plugins.sh --category language                    # upload only language plugins
#   ./load-plugins.sh --category security,quality            # upload multiple categories
#   ./load-plugins.sh --rebuild                              # force rebuild all plugin.zip
#   UPLOAD_DELAY=2 ./load-plugins.sh                         # 2s delay between uploads

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

PLUGINS_DIR="$DEPLOY_DIR/plugins"
UPLOAD_DELAY=${UPLOAD_DELAY:-5}
UPLOAD_TIMEOUT=900
DRY_RUN=false
REBUILD=false
CATEGORY_FILTER=""
SUCCEEDED=0
FAILED=0
SKIPPED=0
TOTAL=0
PROCESSED=0

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY_RUN=true; shift ;;
    --rebuild)  REBUILD=true; shift ;;
    --category) CATEGORY_FILTER="$2"; shift 2 ;;
    --timeout)  UPLOAD_TIMEOUT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run              Validate manifests and rebuild zips, but skip upload"
      echo "  --rebuild              Force rebuild all plugin.zip files"
      echo "  --category CATEGORIES  Comma-separated categories to upload (e.g., language,security)"
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

# ---- Helper functions ----

is_eligible_plugin() {
  [ -f "$1/manifest.yaml" ] || return 1
  _pt=$(get_manifest_field pluginType "$1/manifest.yaml")
  [ "$_pt" = "ManualApprovalStep" ] || [ -f "$1/Dockerfile" ]
}

validate_manifest() {
  manifest="$1"
  plugin_name="$(basename "$2")"
  errors=""
  _pt=$(get_manifest_field pluginType "$manifest")

  for field in name description version pluginType computeType; do
    grep -q "^${field}:" "$manifest" 2>/dev/null || errors="${errors}  Missing: ${field}\n"
  done

  if [ "$_pt" != "ManualApprovalStep" ]; then
    for field in primaryOutputDirectory dockerfile installCommands commands; do
      grep -q "^${field}:" "$manifest" 2>/dev/null || errors="${errors}  Missing: ${field}\n"
    done
  fi

  _mn=$(get_manifest_field name "$manifest")
  [ "$_mn" = "$plugin_name" ] || errors="${errors}  Name mismatch: manifest='${_mn}' dir='${plugin_name}'\n"

  [ "$_pt" = "CodeBuildStep" ] || [ "$_pt" = "ManualApprovalStep" ] || \
    errors="${errors}  Invalid pluginType: ${_pt}\n"

  if [ -n "$errors" ]; then
    printf "    INVALID manifest:\n%b" "$errors" >&2
    return 1
  fi
}

maybe_rebuild_zip() {
  plugin_path="$1"
  zip_file="${plugin_path}/plugin.zip"
  manifest="${plugin_path}/manifest.yaml"
  dockerfile="${plugin_path}/Dockerfile"

  zip_files="manifest.yaml"
  [ -f "$dockerfile" ] && zip_files="Dockerfile manifest.yaml"

  if [ "$REBUILD" = true ] || [ ! -f "$zip_file" ]; then
    reason="Rebuilt plugin.zip"
  elif [ "$manifest" -nt "$zip_file" ]; then
    reason="Rebuilt plugin.zip (manifest changed)"
  elif [ -f "$dockerfile" ] && [ "$dockerfile" -nt "$zip_file" ]; then
    reason="Rebuilt plugin.zip (Dockerfile changed)"
  else
    return 0
  fi

  (cd "$plugin_path" && zip -q plugin.zip $zip_files)  # word-split intentional: 1-2 known filenames
  echo "    $reason"
}

upload_plugin() {
  plugin_dir="$1"
  plugin_name="$(basename "$plugin_dir")"
  category="$(basename "$(dirname "$plugin_dir")")"

  PROCESSED=$((PROCESSED + 1))
  echo "  [$PROCESSED/$TOTAL] ${category}/${plugin_name}"

  validate_manifest "$plugin_dir/manifest.yaml" "$plugin_dir" || { FAILED=$((FAILED + 1)); return; }
  maybe_rebuild_zip "$plugin_dir"

  if [ "$DRY_RUN" = true ]; then
    echo "    OK (dry-run)"
    SUCCEEDED=$((SUCCEEDED + 1))
    return
  fi

  status=$(curl -X POST "${PLATFORM_BASE_URL}/api/plugin/upload" \
    -s -o /dev/null -w "%{http_code}" --max-time "$UPLOAD_TIMEOUT" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "x-org-id: system" \
    -F "plugin=@${plugin_dir}/plugin.zip" \
    -F "accessModifier=public" \
    --insecure 2>/dev/null || echo "000")

  case "$(classify_status "$status")" in
    ok)     echo "    OK (HTTP ${status})";    SUCCEEDED=$((SUCCEEDED + 1)) ;;
    exists) echo "    SKIP (already exists)";  SKIPPED=$((SKIPPED + 1)) ;;
    fail)   echo "    FAIL (HTTP ${status})";  FAILED=$((FAILED + 1)) ;;
  esac
}

resolve_category() {
  _target=$1; _idx=0
  for _cat in $CATEGORIES; do
    _idx=$((_idx + 1))
    [ "$_idx" -eq "$_target" ] 2>/dev/null && echo "$_cat" && return
  done
}

prompt_categories() {
  echo ""
  echo "  Available categories:"
  _i=0
  for category in $CATEGORIES; do
    _i=$((_i + 1))
    count=$(find "${PLUGINS_DIR}/${category}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    echo "    ${_i}) ${category} (${count} plugins)"
  done

  echo ""
  printf "  Load all categories? [Y/n]: "
  read -r _answer
  [ "$_answer" = "n" ] || [ "$_answer" = "N" ] || return 0

  printf "  Enter category numbers (comma-separated, e.g. 1,3,4): "
  read -r _selected
  SELECTED=""
  for num in $(echo "$_selected" | tr ',' ' '); do
    resolved=$(resolve_category "$num")
    [ -n "$resolved" ] && SELECTED="${SELECTED} ${resolved}"
  done
  CATEGORIES=$(echo "$SELECTED" | xargs)
  if [ -z "$CATEGORIES" ]; then
    echo "  No valid categories selected. Exiting."
    exit 0
  fi
  echo "  Selected: $CATEGORIES"
}

count_eligible() {
  for category in $CATEGORIES; do
    category_dir="${PLUGINS_DIR}/${category}"
    [ -d "$category_dir" ] || continue
    for plugin_dir in "${category_dir}"/*/; do
      is_eligible_plugin "$plugin_dir" && TOTAL=$((TOTAL + 1))
    done
  done
}

# ---- Main ----

echo "=== Plugin Loader ==="
echo "  URL:        $PLATFORM_BASE_URL"
echo "  Dry-run:    $DRY_RUN"
echo "  Rebuild:    $REBUILD"
echo "  Categories: ${CATEGORY_FILTER:-all}"
echo ""

JWT_TOKEN=""
[ "$DRY_RUN" = false ] && require_auth

if [ ! -d "$PLUGINS_DIR" ]; then
  echo "No plugins directory found at $PLUGINS_DIR" >&2
  exit 1
fi

# Build category list
if [ -n "$CATEGORY_FILTER" ]; then
  CATEGORIES=$(echo "$CATEGORY_FILTER" | tr ',' ' ')
else
  CATEGORIES=$(find "$PLUGINS_DIR" -mindepth 1 -maxdepth 1 -type d | sort | xargs -I{} basename {})
  prompt_categories
fi

count_eligible

START_TIME=$(date +%s)
echo ""
echo "=== Processing $TOTAL plugin(s) ==="

for category in $CATEGORIES; do
  category_dir="${PLUGINS_DIR}/${category}"
  if [ ! -d "$category_dir" ]; then
    echo "  WARNING: Category not found: ${category}"
    continue
  fi

  echo ""
  echo "--- ${category} ---"

  for plugin_dir in "${category_dir}"/*/; do
    is_eligible_plugin "$plugin_dir" || continue

    upload_plugin "$plugin_dir"

    remaining=$((TOTAL - PROCESSED))
    if [ "$DRY_RUN" = false ] && [ "$UPLOAD_DELAY" -gt 0 ] 2>/dev/null && [ "$remaining" -gt 0 ]; then
      sleep "$UPLOAD_DELAY"
    fi
  done
done

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="
