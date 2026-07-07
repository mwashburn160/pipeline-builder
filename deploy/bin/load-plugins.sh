#!/usr/bin/env bash
set -euo pipefail

# Load all plugins from deploy/plugins into the platform.
#
# Usage:
#   ./load-plugins.sh                                        # parallel mode (default)
#   ./load-plugins.sh --serial                               # one at a time with delays
#   ./load-plugins.sh --parallel 8                           # 8 concurrent uploads
#   ./load-plugins.sh --dry-run                              # validate only, no upload
#   ./load-plugins.sh --category language,security           # filter by category
#   ./load-plugins.sh --rebuild                              # force rebuild all plugin.zip
#   ./load-plugins.sh --cleanup                              # remove plugin.zip + image.tar after upload

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

PLUGINS_DIR="$DEPLOY_DIR/plugins"
WORKER_SCRIPT="$SCRIPT_DIR/load-plugin-worker.sh"
UPLOAD_TIMEOUT=900
UPLOAD_RETRIES=${UPLOAD_RETRIES:-3}
UPLOAD_RETRY_DELAY=${UPLOAD_RETRY_DELAY:-30}
PARALLEL_JOBS=${PARALLEL_JOBS:-1}
UPLOAD_DELAY=${UPLOAD_DELAY:-5}
[[ "$UPLOAD_DELAY" =~ ^[0-9]+$ ]] || { echo "ERROR: UPLOAD_DELAY must be a non-negative integer (got: '$UPLOAD_DELAY')" >&2; exit 1; }
SERIAL_MODE=false
DRY_RUN=false
REBUILD=false
CLEANUP=false
CATEGORY_FILTER=""

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=true; shift ;;
    --rebuild|--force) REBUILD=true; shift ;;
    --cleanup)   CLEANUP=true; shift ;;
    --serial)    SERIAL_MODE=true; shift ;;
    --parallel)  PARALLEL_JOBS="$2"
                 [[ "$PARALLEL_JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: --parallel requires a positive integer" >&2; exit 1; }
                 shift 2 ;;
    # Accumulate across repeated flags AND accept a comma-separated value, so
    # both `--category a,b` and `--category a --category b` load a+b. Plain
    # assignment silently kept only the LAST flag — a footgun that looked like
    # every category loaded when only one did.
    --category)  CATEGORY_FILTER="${CATEGORY_FILTER:+$CATEGORY_FILTER,}$2"; shift 2 ;;
    --timeout)   UPLOAD_TIMEOUT="$2"
                 [[ "$UPLOAD_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: --timeout requires a positive integer" >&2; exit 1; }
                 shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run              Validate specs and rebuild zips, but skip upload"
      echo "  --rebuild              Force rebuild all plugin.zip files"
      echo "  --cleanup              Remove plugin.zip and image.tar after upload"
      echo "  --serial               Upload one at a time with delays"
      echo "  --parallel N           Number of concurrent uploads (default: 1)"
      echo "  --category CATEGORIES  Comma-separated categories (e.g., language,security)"
      echo "  --timeout SECONDS      Upload timeout in seconds (default: 900)"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN         JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL      Platform API URL (default: https://localhost:8443)"
      echo "  UPLOAD_RETRIES         Max retries on 503/connection failure (default: 3)"
      echo "  UPLOAD_RETRY_DELAY     Seconds between retries (default: 30)"
      echo "  PARALLEL_JOBS          Concurrent uploads (default: 1)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---- Helpers ----

is_eligible_plugin() {
  [ -f "$1/plugin-spec.yaml" ] || return 1
  local _pt
  _pt=$(get_spec_field pluginType "$1/plugin-spec.yaml")
  [ "$_pt" = "ManualApprovalStep" ] && return 0
  [ -f "$1/Dockerfile" ] && return 0
  local _bt
  _bt=$(get_spec_field buildType "$1/config.yaml")
  [ "$_bt" = "prebuilt" ] && return 0
  return 1
}

# ---- Category selection ----

if [ -n "$CATEGORY_FILTER" ]; then
  CATEGORIES=$(echo "$CATEGORY_FILTER" | tr ',' ' ')
elif [ -t 0 ]; then
  select_categories "$PLUGINS_DIR" || exit 0
  CATEGORIES=$(echo "$SELECTED_CATEGORIES" | tr ',' ' ')
else
  CATEGORIES=$(list_categories "$PLUGINS_DIR")
fi

# ---- Build plugin list + count ----

PLUGIN_LIST=""
TOTAL=0
for category in $CATEGORIES; do
  for plugin_dir in "${PLUGINS_DIR}/${category}"/*/; do
    is_eligible_plugin "$plugin_dir" || continue
    PLUGIN_LIST="${PLUGIN_LIST}${plugin_dir}\n"
    TOTAL=$((TOTAL + 1))
  done
done

# ---- Auth ----

echo "=== Plugin Loader ==="
echo "  URL:        $PLATFORM_BASE_URL"
echo "  Mode:       $([ "$SERIAL_MODE" = true ] && echo "serial" || echo "parallel (${PARALLEL_JOBS} workers)")"
echo "  Dry-run:    $DRY_RUN"
echo "  Rebuild:    $REBUILD"
echo "  Categories: ${CATEGORY_FILTER:-all}"
echo ""

JWT_TOKEN=""
[ "$DRY_RUN" = false ] && require_auth

# ---- Upload ----

COUNTER_DIR=$(mktemp -d)
[ -n "$COUNTER_DIR" ] && [ -d "$COUNTER_DIR" ] || { echo "ERROR: failed to create temp directory" >&2; exit 1; }
trap 'rm -rf "$COUNTER_DIR"' EXIT INT TERM
touch "$COUNTER_DIR/succeeded" "$COUNTER_DIR/skipped" "$COUNTER_DIR/failed"

export PLATFORM_BASE_URL JWT_TOKEN UPLOAD_TIMEOUT UPLOAD_RETRIES UPLOAD_RETRY_DELAY
export DRY_RUN REBUILD COUNTER_DIR PLUGINS_DIR DEPLOY_DIR SCRIPT_DIR

START_TIME=$(date +%s)
echo ""
echo "=== Processing $TOTAL plugin(s) ==="

if [ "$SERIAL_MODE" = true ]; then
  PROCESSED=0
  for category in $CATEGORIES; do
    echo ""
    echo "--- ${category} ---"
    for plugin_dir in "${PLUGINS_DIR}/${category}"/*/; do
      is_eligible_plugin "$plugin_dir" || continue
      PROCESSED=$((PROCESSED + 1))
      echo "  [$PROCESSED/$TOTAL] $(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"
      "$WORKER_SCRIPT" "$plugin_dir" || true
      remaining=$((TOTAL - PROCESSED))
      [ "$DRY_RUN" = false ] && [ "$UPLOAD_DELAY" -gt 0 ] && [ "$remaining" -gt 0 ] && sleep "$UPLOAD_DELAY"
    done
  done
else
  # `|| true`: a worker exits 1 (fail) or 2 (skip/already-exists); xargs returns
  # 123 for any 1-125 exit, which under `set -e` would abort before the summary.
  # The real result lives in the counter files; the exit gate at the end of the
  # script propagates any failure.
  printf '%b' "$PLUGIN_LIST" | xargs -P "$PARALLEL_JOBS" -I{} "$WORKER_SCRIPT" "{}" || true
fi

# ---- Summary ----

SUCCEEDED=$(wc -l < "$COUNTER_DIR/succeeded" | tr -d ' ')
SKIPPED=$(wc -l < "$COUNTER_DIR/skipped" | tr -d ' ')
FAILED=$(wc -l < "$COUNTER_DIR/failed" | tr -d ' ')

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

# ---- Cleanup ----

if [ "$CLEANUP" = true ]; then
  echo ""
  echo "=== Cleaning up build artifacts ==="
  _cleaned=0
  for category in $CATEGORIES; do
    for _pdir in "${PLUGINS_DIR}/${category}"/*/; do
      [ -d "$_pdir" ] || continue
      for _artifact in "$_pdir/plugin.zip" "$_pdir/image.tar"; do
        [ -f "$_artifact" ] && rm -f "$_artifact" && _cleaned=$((_cleaned + 1))
      done
    done
  done
  echo "  Removed ${_cleaned} artifact file(s)"
fi

echo ""
echo "=== Done ==="

# Propagate partial-failure to the exit code so CI / init-platform.sh catches it
# instead of a masked green (matches load-pipelines.sh).
[ "$FAILED" -gt 0 ] && exit 1
exit 0
