#!/usr/bin/env bash
set -euo pipefail

# Load all plugins from deploy/plugins into the platform.
#
# By default uses parallel uploads (4 concurrent) with no delay for speed.
# Use --serial for legacy one-at-a-time mode with delays.
#
# Usage:
#   ./load-plugins.sh                                        # parallel mode (default)
#   ./load-plugins.sh --serial                               # legacy serial mode with delays
#   ./load-plugins.sh --parallel 8                           # 8 concurrent uploads
#   PLATFORM_BASE_URL=https://host ./load-plugins.sh         # custom platform URL
#   ./load-plugins.sh --dry-run                              # validate only, no upload
#   ./load-plugins.sh --category language                    # upload only language plugins
#   ./load-plugins.sh --category security,quality            # upload multiple categories
#   ./load-plugins.sh --rebuild                              # force rebuild all plugin.zip

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

PLUGINS_DIR="$DEPLOY_DIR/plugins"
UPLOAD_TIMEOUT=900
UPLOAD_RETRIES=${UPLOAD_RETRIES:-3}
UPLOAD_RETRY_DELAY=${UPLOAD_RETRY_DELAY:-30}
PARALLEL_JOBS=${PARALLEL_JOBS:-4}
SERIAL_MODE=false
DRY_RUN=false
REBUILD=false
CATEGORY_FILTER=""
TOTAL=0

# Counters file for parallel mode (temp file for cross-process communication)
COUNTER_DIR=""

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=true; shift ;;
    --rebuild)   REBUILD=true; shift ;;
    --serial)    SERIAL_MODE=true; shift ;;
    --parallel)  PARALLEL_JOBS="$2"; PARALLEL_JOBS_EXPLICIT=true; [[ "$PARALLEL_JOBS" =~ ^[0-9]+$ ]] || { echo "ERROR: --parallel requires a positive integer" >&2; exit 1; }; shift 2 ;;
    --category)  CATEGORY_FILTER="$2"; shift 2 ;;
    --timeout)   UPLOAD_TIMEOUT="$2"; [[ "$UPLOAD_TIMEOUT" =~ ^[0-9]+$ ]] || { echo "ERROR: --timeout requires a positive integer" >&2; exit 1; }; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run              Validate specs and rebuild zips, but skip upload"
      echo "  --rebuild              Force rebuild all plugin.zip files"
      echo "  --serial               Upload one at a time with delays (legacy mode)"
      echo "  --parallel N           Number of concurrent uploads (default: 4)"
      echo "  --category CATEGORIES  Comma-separated categories to upload (e.g., language,security)"
      echo "  --timeout SECONDS      Upload timeout in seconds (default: 900)"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN         JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL      Platform API URL (default: https://localhost:8443)"
      echo "  UPLOAD_RETRIES         Max retries on 503/connection failure (default: 3)"
      echo "  UPLOAD_RETRY_DELAY     Seconds to wait between retries (default: 30)"
      echo "  PARALLEL_JOBS          Concurrent uploads (default: 4)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---- Helper functions ----

is_eligible_plugin() {
  [ -f "$1/plugin-spec.yaml" ] || return 1
  local _pt
  _pt=$(get_spec_field pluginType "$1/plugin-spec.yaml")
  [ "$_pt" = "ManualApprovalStep" ] && return 0
  [ -f "$1/Dockerfile" ] && return 0
  # Accept prebuilt plugins with image.tar (no Dockerfile needed)
  local _bt
  _bt=$(grep '^buildType:' "$1/config.yaml" 2>/dev/null | sed 's/^buildType: *//')
  [ "$_bt" = "prebuilt" ] && return 0
  return 1
}

validate_spec() {
  local specfile="$1"
  local plugin_name="$(basename "$2")"
  local errors=""
  local _pt
  _pt=$(get_spec_field pluginType "$specfile")

  for field in name description version pluginType computeType; do
    grep -q "^${field}:" "$specfile" 2>/dev/null || errors="${errors}  Missing: ${field}\n"
  done

  if [ "$_pt" != "ManualApprovalStep" ]; then
    for field in primaryOutputDirectory dockerfile installCommands commands; do
      grep -q "^${field}:" "$specfile" 2>/dev/null || errors="${errors}  Missing: ${field}\n"
    done
  fi

  _mn=$(get_spec_field name "$specfile")
  [ "$_mn" = "$plugin_name" ] || errors="${errors}  Name mismatch: spec='${_mn}' dir='${plugin_name}'\n"

  [ "$_pt" = "CodeBuildStep" ] || [ "$_pt" = "ManualApprovalStep" ] || \
    errors="${errors}  Invalid pluginType: ${_pt}\n"

  if [ -n "$errors" ]; then
    printf "    INVALID spec:\n%b" "$errors" >&2
    return 1
  fi
}

WORKER_SCRIPT="$SCRIPT_DIR/load-plugin-worker.sh"

resolve_category() {
  local _target=$1 _idx=0 _cat
  for _cat in $CATEGORIES; do
    _idx=$((_idx + 1))
    [ "$_idx" -eq "$_target" ] 2>/dev/null && echo "$_cat" && return
  done
}

prompt_categories() {
  echo ""
  echo "  Available categories:"
  local _i=0 category count
  for category in $CATEGORIES; do
    _i=$((_i + 1))
    count=$(find "${PLUGINS_DIR}/${category}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    echo "    ${_i}) ${category} (${count} plugins)"
  done

  echo ""
  local _answer
  printf "  Load all categories? [Y/n]: "
  read -r _answer
  [ "$_answer" = "n" ] || [ "$_answer" = "N" ] || return 0

  local _selected
  printf "  Enter category numbers (comma-separated, e.g. 1,3,4): "
  read -r _selected
  local SELECTED="" num resolved
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
echo "  Mode:       $([ "$SERIAL_MODE" = true ] && echo "serial" || echo "parallel (${PARALLEL_JOBS} workers)")"
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

# Auto-lower parallelism if any plugins are prebuilt with large image.tar files.
# Prebuilt zips are CPU/memory-heavy to parse server-side and parallel uploads
# can collide on the single-threaded zip parser, causing 503 retries.
# Override with --parallel N to force higher concurrency.
if [ -z "${PARALLEL_JOBS_EXPLICIT:-}" ]; then
  for category in $CATEGORIES; do
    for plugin_dir in "${PLUGINS_DIR}/${category}"/*/; do
      [ -f "$plugin_dir/image.tar" ] || continue
      _bt=$(grep '^buildType:' "$plugin_dir/config.yaml" 2>/dev/null | sed 's/^buildType: *//')
      if [ "$_bt" = "prebuilt" ]; then
        if [ "$PARALLEL_JOBS" -gt 1 ]; then
          echo "  NOTE: prebuilt plugins detected, lowering parallelism to 1 (override with --parallel N)"
          PARALLEL_JOBS=1
        fi
        break 2
      fi
    done
  done
fi

START_TIME=$(date +%s)
echo ""
echo "=== Processing $TOTAL plugin(s) ==="

# Build list of eligible plugin directories
PLUGIN_LIST=""
for category in $CATEGORIES; do
  category_dir="${PLUGINS_DIR}/${category}"
  [ -d "$category_dir" ] || continue
  for plugin_dir in "${category_dir}"/*/; do
    is_eligible_plugin "$plugin_dir" || continue
    PLUGIN_LIST="${PLUGIN_LIST}${plugin_dir}\n"
  done
done

# Set up counter dir (parallel mode writes counts to files; serial mode does too for consistency)
COUNTER_DIR=$(mktemp -d)
[ -n "$COUNTER_DIR" ] && [ -d "$COUNTER_DIR" ] || { echo "ERROR: failed to create temp directory" >&2; exit 1; }
trap 'rm -rf "$COUNTER_DIR"' EXIT INT TERM
touch "$COUNTER_DIR/succeeded" "$COUNTER_DIR/skipped" "$COUNTER_DIR/failed"

export PLATFORM_BASE_URL JWT_TOKEN UPLOAD_TIMEOUT UPLOAD_RETRIES UPLOAD_RETRY_DELAY
export DRY_RUN REBUILD COUNTER_DIR PLUGINS_DIR DEPLOY_DIR SCRIPT_DIR

if [ "$SERIAL_MODE" = true ]; then
  UPLOAD_DELAY=${UPLOAD_DELAY:-5}
  PROCESSED=0

  for category in $CATEGORIES; do
    category_dir="${PLUGINS_DIR}/${category}"
    [ -d "$category_dir" ] || continue
    echo ""
    echo "--- ${category} ---"
    for plugin_dir in "${category_dir}"/*/; do
      is_eligible_plugin "$plugin_dir" || continue
      PROCESSED=$((PROCESSED + 1))
      echo "  [$PROCESSED/$TOTAL] $(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"
      "$WORKER_SCRIPT" "$plugin_dir" || true
      remaining=$((TOTAL - PROCESSED))
      [ "$DRY_RUN" = false ] && [ "$UPLOAD_DELAY" -gt 0 ] 2>/dev/null && [ "$remaining" -gt 0 ] && sleep "$UPLOAD_DELAY"
    done
  done
else
  printf '%b' "$PLUGIN_LIST" | xargs -P "$PARALLEL_JOBS" -I{} "$WORKER_SCRIPT" "{}"
fi

SUCCEEDED=$(wc -l < "$COUNTER_DIR/succeeded" | tr -d ' ')
SKIPPED=$(wc -l < "$COUNTER_DIR/skipped" | tr -d ' ')
FAILED=$(wc -l < "$COUNTER_DIR/failed" | tr -d ' ')

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="
