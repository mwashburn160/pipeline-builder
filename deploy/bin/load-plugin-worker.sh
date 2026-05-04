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

# Auto-detect metadata_only: no Dockerfile and no image.tar
if [ "$build_type" = "build_image" ] && [ ! -f "$dockerfile" ] && [ ! -f "$image_tar" ]; then
  build_type="metadata_only"
fi

zip_files="plugin-spec.yaml"
[ -f "$config" ] && zip_files="config.yaml $zip_files"
case "$build_type" in
  prebuilt)
    if [ -f "$image_tar" ]; then
      zip_files="$zip_files image.tar"
    elif [ "${SKIP_MISSING_IMAGE_TAR:-}" = "true" ]; then
      # Set by init-platform.sh --continue-on-build-failure: plugins whose
      # build failed upstream get skipped here so the rest of the bootstrap
      # can proceed. Operator sees the count in the summary.
      echo "  SKIP $label (buildType=prebuilt but image.tar missing — build failed upstream)"
      _count skipped
      exit 2
    else
      echo "  FAIL $label (buildType=prebuilt but image.tar missing — run build-plugin-images.sh)"
      _count failed
      exit 1
    fi
    ;;
  build_image)
    [ -f "$dockerfile" ] && zip_files="$zip_files Dockerfile"
    ;;
  metadata_only)
    # No Dockerfile or image.tar needed — commands run in default CodeBuild image
    ;;
esac

# ---- Decide whether to rebuild plugin.zip ----

needs_rebuild=false
{ [ "${REBUILD:-}" = "true" ] || [ ! -f "$zip_file" ]; } && needs_rebuild=true
[ "$specfile" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
[ -f "$config" ] && [ "$config" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true
case "$build_type" in
  prebuilt)
    [ -f "$image_tar" ] && [ "$image_tar" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true ;;
  build_image)
    [ -f "$dockerfile" ] && [ "$dockerfile" -nt "$zip_file" ] 2>/dev/null && needs_rebuild=true ;;
  metadata_only)
    ;; # no additional files to check
esac

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

curl_with_retry "$label" \
  -X POST "${PLATFORM_BASE_URL}/api/plugin/upload" \
  --max-time "$UPLOAD_TIMEOUT" \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "x-org-id: system" \
  -H "x-internal-service: true" \
  -F "plugin=@${zip_file}" \
  -F "accessModifier=public"
_rc=$?
case "$_rc" in
  0) _count succeeded; exit 0 ;;
  2) _count skipped;   exit 2 ;;
  *) _count failed;    exit 1 ;;
esac
