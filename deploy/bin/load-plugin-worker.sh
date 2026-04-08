#!/usr/bin/env bash
set -euo pipefail

# load-plugin-worker.sh — process a single plugin upload.
# Used by load-plugins.sh in both serial and parallel modes.
#
# Usage:   ./load-plugin-worker.sh <plugin_dir>
#
# Required env vars:
#   PLATFORM_BASE_URL       Platform API URL
#   JWT_TOKEN               Auth token
#   UPLOAD_TIMEOUT          Curl timeout in seconds
#   UPLOAD_RETRIES          Max retry count
#   UPLOAD_RETRY_DELAY      Sleep between retries
#   COUNTER_DIR             Counter files dir (parallel) or empty (serial)
#   DRY_RUN                 'true' or 'false'
#   REBUILD                 'true' or 'false'
#   SCRIPT_DIR              Directory containing common.sh
#
# Output: writes "1\n" to $COUNTER_DIR/{succeeded|skipped|failed} when set,
# otherwise the caller increments globals based on this script's exit code:
#   0 = succeeded, 1 = failed, 2 = skipped (exists)

# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

plugin_dir="$1"
[ -d "$plugin_dir" ] || exit 0

plugin_name="$(basename "$plugin_dir")"
category="$(basename "$(dirname "$plugin_dir")")"
label="${category}/${plugin_name}"

# ---- Counter helper ----

_count() {
  if [ -n "${COUNTER_DIR:-}" ]; then
    echo "1" >> "$COUNTER_DIR/$1"
  fi
}

# ---- Validate plugin spec ----

specfile="$plugin_dir/plugin-spec.yaml"
errors=""
for field in name description version pluginType computeType; do
  grep -q "^${field}:" "$specfile" 2>/dev/null || errors="${errors}Missing ${field} "
done
if [ -n "$errors" ]; then
  echo "  FAIL $label ($errors)"
  _count failed
  exit 1
fi

# ---- Determine zip contents from buildType ----

config="$plugin_dir/config.yaml"
zip_file="$plugin_dir/plugin.zip"
dockerfile="$plugin_dir/Dockerfile"
image_tar="$plugin_dir/image.tar"

build_type="build_image"
[ -f "$config" ] && build_type=$(grep '^buildType:' "$config" 2>/dev/null | sed 's/^buildType: *//' || echo "build_image")

zip_files="plugin-spec.yaml"
[ -f "$config" ] && zip_files="config.yaml $zip_files"
if [ "$build_type" = "prebuilt" ]; then
  [ -f "$image_tar" ] && zip_files="$zip_files image.tar"
else
  [ -f "$dockerfile" ] && zip_files="$zip_files Dockerfile"
fi

# ---- Decide whether to rebuild plugin.zip ----

needs_rebuild=false
{ [ "${REBUILD:-}" = "true" ] || [ ! -f "$zip_file" ]; } && needs_rebuild=true
[ "$specfile" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
[ -f "$config" ] && [ "$config" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
if [ "$build_type" = "prebuilt" ]; then
  [ -f "$image_tar" ] && [ "$image_tar" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
else
  [ -f "$dockerfile" ] && [ "$dockerfile" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
fi

if [ "$needs_rebuild" = true ]; then
  # shellcheck disable=SC2086
  (cd "$plugin_dir" && zip -q plugin.zip -- $zip_files)
fi

# ---- Dry run ----

if [ "${DRY_RUN:-}" = "true" ]; then
  echo "  OK   $label (dry-run)"
  _count succeeded
  exit 0
fi

# ---- Upload with retry ----

attempt=1
while [ "$attempt" -le "$UPLOAD_RETRIES" ]; do
  status=$(curl -X POST "${PLATFORM_BASE_URL}/api/plugin/upload" \
    -s -o /dev/null -w "%{http_code}" --max-time "$UPLOAD_TIMEOUT" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "x-org-id: system" \
    -H "x-internal-service: true" \
    -F "plugin=@${zip_file}" \
    -F "accessModifier=public" \
    --insecure 2>/dev/null || echo "000")

  result="$(classify_status "$status")"
  retryable_status=false
  case "$status" in 429|502|503|504|000) retryable_status=true ;; esac

  if [ "$result" = "fail" ] && [ "$retryable_status" = true ] && [ "$attempt" -lt "$UPLOAD_RETRIES" ]; then
    echo "  RETRY $label (HTTP ${status}) attempt ${attempt}/${UPLOAD_RETRIES}"
    sleep "$UPLOAD_RETRY_DELAY"
    attempt=$((attempt + 1))
    continue
  fi

  case "$result" in
    ok)     echo "  OK   $label (HTTP ${status})"; _count succeeded; exit 0 ;;
    exists) echo "  SKIP $label (exists)";         _count skipped;   exit 2 ;;
    fail)   echo "  FAIL $label (HTTP ${status})"; _count failed;    exit 1 ;;
  esac
done
