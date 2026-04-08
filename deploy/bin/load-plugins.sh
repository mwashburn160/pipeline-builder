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

maybe_rebuild_zip() {
  local plugin_path="$1"
  local zip_file="${plugin_path}/plugin.zip"
  local specfile="${plugin_path}/plugin-spec.yaml"
  local config="${plugin_path}/config.yaml"
  local dockerfile="${plugin_path}/Dockerfile"
  local image_tar="${plugin_path}/image.tar"
  local reason=""

  # Determine buildType from config.yaml
  local _build_type="build_image"
  [ -f "$config" ] && _build_type=$(grep '^buildType:' "$config" 2>/dev/null | sed 's/^buildType: *//' || echo "build_image")

  local zip_files="plugin-spec.yaml"
  [ -f "$config" ] && zip_files="config.yaml $zip_files"
  if [ "$_build_type" = "prebuilt" ]; then
    [ -f "$image_tar" ] && zip_files="$zip_files image.tar"
  else
    [ -f "$dockerfile" ] && zip_files="$zip_files Dockerfile"
  fi

  if [ "$REBUILD" = true ] || [ ! -f "$zip_file" ]; then
    reason="Rebuilt plugin.zip"
  elif [ "$specfile" -nt "$zip_file" ]; then
    reason="Rebuilt plugin.zip (spec changed)"
  elif [ -f "$config" ] && [ "$config" -nt "$zip_file" ]; then
    reason="Rebuilt plugin.zip (config changed)"
  elif [ "$_build_type" != "prebuilt" ] && [ -f "$dockerfile" ] && [ "$dockerfile" -nt "$zip_file" ]; then
    reason="Rebuilt plugin.zip (Dockerfile changed)"
  elif [ "$_build_type" = "prebuilt" ] && [ -f "$image_tar" ] && [ "$image_tar" -nt "$zip_file" ]; then
    reason="Rebuilt plugin.zip (image.tar changed)"
  else
    return 0
  fi

  # shellcheck disable=SC2086
  (cd "$plugin_path" && zip -q plugin.zip -- $zip_files)  # word-split intentional: known filenames
  echo "    $reason"
}

# Increment a counter — writes to COUNTER_DIR file in parallel mode,
# updates global variable in serial mode.
_increment_counter() {
  if [ -n "${COUNTER_DIR:-}" ]; then
    echo "1" >> "$COUNTER_DIR/$1"
  else
    case "$1" in
      succeeded) SUCCEEDED=$((SUCCEEDED + 1)) ;;
      skipped)   SKIPPED=$((SKIPPED + 1)) ;;
      failed)    FAILED=$((FAILED + 1)) ;;
    esac
  fi
}

# Upload a single plugin — used by both serial and parallel modes
upload_one_plugin() {
  local plugin_dir="$1"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"
  local label="${category}/${plugin_name}"

  validate_spec "$plugin_dir/plugin-spec.yaml" "$plugin_dir" || {
    echo "  FAIL $label (invalid spec)"
    _increment_counter "failed"
    return
  }
  maybe_rebuild_zip "$plugin_dir"

  if [ "$DRY_RUN" = true ]; then
    echo "  OK   $label (dry-run)"
    _increment_counter "succeeded"
    return
  fi

  _attempt=1
  while [ "$_attempt" -le "$UPLOAD_RETRIES" ]; do
    status=$(curl -X POST "${PLATFORM_BASE_URL}/api/plugin/upload" \
      -s -o /dev/null -w "%{http_code}" --max-time "$UPLOAD_TIMEOUT" \
      -H "Authorization: Bearer ${JWT_TOKEN}" \
      -H "x-org-id: system" \
      -H "x-internal-service: true" \
      -F "plugin=@${plugin_dir}/plugin.zip" \
      -F "accessModifier=public" \
      --insecure 2>/dev/null || echo "000")

    _result="$(classify_status "$status")"

    if [ "$_result" = "fail" ] && { [ "$status" = "429" ] || [ "$status" = "502" ] || [ "$status" = "503" ] || [ "$status" = "504" ] || [ "$status" = "000" ]; } && [ "$_attempt" -lt "$UPLOAD_RETRIES" ]; then
      echo "  RETRY $label (HTTP ${status}) attempt ${_attempt}/${UPLOAD_RETRIES}"
      sleep "$UPLOAD_RETRY_DELAY"
      _attempt=$((_attempt + 1))
      continue
    fi

    case "$_result" in
      ok)     echo "  OK   $label (HTTP ${status})"; _increment_counter "succeeded" ;;
      exists) echo "  SKIP $label (exists)";         _increment_counter "skipped" ;;
      fail)   echo "  FAIL $label (HTTP ${status})"; _increment_counter "failed" ;;
    esac
    break
  done
}

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

if [ "$SERIAL_MODE" = true ]; then
  # Legacy serial mode with delays
  UPLOAD_DELAY=${UPLOAD_DELAY:-5}
  SUCCEEDED=0; FAILED=0; SKIPPED=0; PROCESSED=0

  for category in $CATEGORIES; do
    category_dir="${PLUGINS_DIR}/${category}"
    [ -d "$category_dir" ] || continue
    echo ""
    echo "--- ${category} ---"
    for plugin_dir in "${category_dir}"/*/; do
      is_eligible_plugin "$plugin_dir" || continue
      PROCESSED=$((PROCESSED + 1))
      echo "  [$PROCESSED/$TOTAL] $(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"
      # Inline upload for serial (uses global counters directly)
      COUNTER_DIR=""
      upload_one_plugin "$plugin_dir"
      remaining=$((TOTAL - PROCESSED))
      [ "$DRY_RUN" = false ] && [ "$UPLOAD_DELAY" -gt 0 ] 2>/dev/null && [ "$remaining" -gt 0 ] && sleep "$UPLOAD_DELAY"
    done
  done
else
  # Parallel mode — no delays, concurrent uploads via temp worker script
  COUNTER_DIR=$(mktemp -d)
  [ -n "$COUNTER_DIR" ] && [ -d "$COUNTER_DIR" ] || { echo "ERROR: failed to create temp directory" >&2; exit 1; }
  trap 'rm -rf "$COUNTER_DIR"' EXIT INT TERM
  touch "$COUNTER_DIR/succeeded" "$COUNTER_DIR/skipped" "$COUNTER_DIR/failed"

  export PLATFORM_BASE_URL JWT_TOKEN UPLOAD_TIMEOUT UPLOAD_RETRIES UPLOAD_RETRY_DELAY
  export DRY_RUN REBUILD COUNTER_DIR PLUGINS_DIR DEPLOY_DIR SCRIPT_DIR

  # Write worker script to temp file (avoids xargs -I{} + bash -c quoting issues)
  WORKER_SCRIPT="$COUNTER_DIR/worker.sh"
  cat > "$WORKER_SCRIPT" <<'WORKER_EOF'
#!/usr/bin/env bash
. "$SCRIPT_DIR/common.sh"

plugin_dir="$1"
[ -d "$plugin_dir" ] || exit 0

plugin_name="$(basename "$plugin_dir")"
category="$(basename "$(dirname "$plugin_dir")")"
label="${category}/${plugin_name}"

# Validate
errors=""
specfile="$plugin_dir/plugin-spec.yaml"
_pt=$(get_spec_field pluginType "$specfile")
for field in name description version pluginType computeType; do
  grep -q "^${field}:" "$specfile" 2>/dev/null || errors="${errors}Missing ${field} "
done
if [ -n "$errors" ]; then
  echo "  FAIL $label ($errors)"
  echo "1" >> "$COUNTER_DIR/failed"
  exit 0
fi

# Rebuild zip if needed
zip_file="${plugin_dir}/plugin.zip"
config="$plugin_dir/config.yaml"
_build_type="build_image"
[ -f "$config" ] && _build_type=$(grep '^buildType:' "$config" 2>/dev/null | sed 's/^buildType: *//' || echo "build_image")

zip_files="plugin-spec.yaml"
[ -f "$config" ] && zip_files="config.yaml $zip_files"
if [ "$_build_type" = "prebuilt" ]; then
  [ -f "$plugin_dir/image.tar" ] && zip_files="$zip_files image.tar"
else
  [ -f "$plugin_dir/Dockerfile" ] && zip_files="$zip_files Dockerfile"
fi

needs_rebuild=false
[ "$REBUILD" = true ] || [ ! -f "$zip_file" ] && needs_rebuild=true
[ "$specfile" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
[ -f "$config" ] && [ "$config" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
if [ "$_build_type" != "prebuilt" ]; then
  [ -f "$plugin_dir/Dockerfile" ] && [ "$plugin_dir/Dockerfile" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
else
  [ -f "$plugin_dir/image.tar" ] && [ "$plugin_dir/image.tar" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
fi
if [ "$needs_rebuild" = true ]; then
  # shellcheck disable=SC2086
  (cd "$plugin_dir" && zip -q plugin.zip -- $zip_files)
fi

if [ "$DRY_RUN" = true ]; then
  echo "  OK   $label (dry-run)"
  echo "1" >> "$COUNTER_DIR/succeeded"
  exit 0
fi

_attempt=1
while [ "$_attempt" -le "$UPLOAD_RETRIES" ]; do
  status=$(curl -X POST "${PLATFORM_BASE_URL}/api/plugin/upload" \
    -s -o /dev/null -w "%{http_code}" --max-time "$UPLOAD_TIMEOUT" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "x-org-id: system" \
    -H "x-internal-service: true" \
    -F "plugin=@${plugin_dir}/plugin.zip" \
    -F "accessModifier=public" \
    --insecure 2>/dev/null || echo "000")

  _result="$(classify_status "$status")"

  if [ "$_result" = "fail" ] && { [ "$status" = "429" ] || [ "$status" = "502" ] || [ "$status" = "503" ] || [ "$status" = "504" ] || [ "$status" = "000" ]; } && [ "$_attempt" -lt "$UPLOAD_RETRIES" ]; then
    echo "  RETRY $label (HTTP ${status}) attempt ${_attempt}/${UPLOAD_RETRIES}"
    sleep "$UPLOAD_RETRY_DELAY"
    _attempt=$((_attempt + 1))
    continue
  fi

  case "$_result" in
    ok)     echo "  OK   $label (HTTP ${status})"; echo "1" >> "$COUNTER_DIR/succeeded" ;;
    exists) echo "  SKIP $label (exists)";         echo "1" >> "$COUNTER_DIR/skipped" ;;
    fail)   echo "  FAIL $label (HTTP ${status})"; echo "1" >> "$COUNTER_DIR/failed" ;;
  esac
  break
done
WORKER_EOF
  chmod +x "$WORKER_SCRIPT"

  printf '%b' "$PLUGIN_LIST" | xargs -P "$PARALLEL_JOBS" -I{} bash "$WORKER_SCRIPT" "{}"

  SUCCEEDED=$(wc -l < "$COUNTER_DIR/succeeded" | tr -d ' ')
  SKIPPED=$(wc -l < "$COUNTER_DIR/skipped" | tr -d ' ')
  FAILED=$(wc -l < "$COUNTER_DIR/failed" | tr -d ' ')
  # Cleanup handled by EXIT trap
fi

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="
