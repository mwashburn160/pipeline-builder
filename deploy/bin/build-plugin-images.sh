#!/usr/bin/env bash
set -euo pipefail

# Build Docker images for plugins, save as image.tar, and update config.yaml.
#
# For each plugin: docker build → docker save → image.tar → update config.yaml
# The image.tar is gitignored and bundled into plugin.zip by load-plugins.sh.
#
# Usage:
#   ./build-plugin-images.sh                    # build all (prompt to recreate existing)
#   ./build-plugin-images.sh --force            # rebuild all, no prompt
#   ./build-plugin-images.sh --category language # build one category
#   ./build-plugin-images.sh --reset            # revert all to build_image
#
# NOTE: docker save captures single-platform images only. For multi-platform
# (ARM/x86), use docker buildx with --platform and save each platform
# separately. This is not implemented — documented as a limitation.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"
require_yq

PLUGINS_DIR="$DEPLOY_DIR/plugins"
FORCE=false
RESET=false
DRY_RUN=false
CATEGORY_FILTER=""
MAX_IMAGE_SIZE_MB="${MAX_IMAGE_SIZE_MB:-4096}"

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --force)     FORCE=true; shift ;;
    --reset)     RESET=true; shift ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --category)  CATEGORY_FILTER="$2"; shift 2 ;;
    --max-image-size) MAX_IMAGE_SIZE_MB="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --force              Rebuild all images, no prompt for existing"
      echo "  --reset              Revert all plugins to buildType: build_image"
      echo "  --dry-run            Show what would be built without building"
      echo "  --category CATS      Comma-separated categories (e.g., language,security)"
      echo "  --max-image-size MB  Skip images larger than MB (default: 4096)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---- Fargate guard ----

if [ "${DOCKER_BUILD_STRATEGY:-}" = "kaniko" ]; then
  echo "ERROR: prebuilt is not supported with kaniko (Fargate). Use build_image." >&2
  exit 1
fi

# ---- Build base images FIRST (dependency order) ----
#
# All base images live under `_base/`:
#   _base/_default/        → pipeline-plugin-base:24.04 (root, built first)
#   _base/_snyk-base/      → pipeline-snyk-base:1.0     (extends root)
#   _base/_sonarcloud-base/ → pipeline-sonarcloud-base:1.0
#   _base/_trivy-base/     → pipeline-trivy-base:1.0
#
# `_default` is built before any family base (family bases inherit FROM the
# root). Family bases are built alphabetically — they don't depend on each
# other.
#
# All `_*` directories at any depth are infrastructure, not plugins —
# excluded from the upload/load flow by the `! -name '_*'` filter on
# category list at the top level.
build_base_images() {
  local _base_root="$PLUGINS_DIR/_base"
  [ ! -d "$_base_root" ] && return 0

  echo "=== Building base images ==="
  if [ "$DRY_RUN" = true ]; then
    echo "  (dry-run) skipping base builds"
    return 0
  fi

  # Root base must build first.
  if [ -f "$_base_root/_default/Dockerfile" ]; then
    docker build --progress plain -t pipeline-plugin-base:24.04 "$_base_root/_default"
  fi

  # Family bases — alphabetical, all inherit FROM pipeline-plugin-base:24.04.
  # Tagged as `pipeline-${name}:1.0` where `${name}` is the dir name with
  # the leading underscore stripped (e.g. `_snyk-base` → `pipeline-snyk-base:1.0`).
  for _fam_dir in "$_base_root"/_*-base; do
    [ -d "$_fam_dir" ] || continue
    local _name
    _name=$(basename "$_fam_dir" | sed 's/^_//')
    echo "  Building pipeline-${_name}:1.0..."
    docker build --progress plain -t "pipeline-${_name}:1.0" "$_fam_dir"
  done
  echo ""
}
build_base_images

# ---- Build category list ----
#
# Skip directories whose name starts with `_` — these are infrastructure
# (currently `_base`), not plugins. Excluded from build, upload, and load.

if [ -n "$CATEGORY_FILTER" ]; then
  CATEGORIES=$(echo "$CATEGORY_FILTER" | tr ',' ' ')
else
  CATEGORIES=$(find -L "$PLUGINS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '_*' | sort | xargs -I{} basename {})
fi

# ---- Parse buildArgs from plugin-spec.yaml (delegates to yq) ----
parse_build_arg_flags() {
  yq_buildargs "$1" | tr '\n' ' '
}

# ---- Reset mode ----

if [ "$RESET" = true ]; then
  echo "=== Resetting all plugins to build_image ==="
  count=0
  for category_dir in "$PLUGINS_DIR"/*/; do
    for plugin_dir in "$category_dir"*/; do
      config="$plugin_dir/config.yaml"
      [ -f "$config" ] || continue

      _bt=$(grep '^buildType:' "$config" 2>/dev/null | sed 's/^buildType: *//')
      [ "$_bt" = "prebuilt" ] || continue

      # Revert config.yaml
      sed_inplace '/^imageTag:/d' "$config"
      sed_inplace 's/^buildType: prebuilt$/buildType: build_image/' "$config"
      # Re-add dockerfile if missing
      grep -q '^dockerfile:' "$config" || echo "dockerfile: Dockerfile" >> "$config"

      # Remove image.tar
      rm -f "$plugin_dir/image.tar"

      name=$(basename "$plugin_dir")
      category=$(basename "$category_dir")
      echo "  RESET ${category}/${name}"
      count=$((count + 1))
    done
  done
  echo ""
  echo "Reset $count plugin(s) to build_image."
  echo "Run 'load-plugins.sh --rebuild' to rebuild plugin.zip files."
  exit 0
fi

# ---- Main build loop ----

echo "=== Building Plugin Images ==="
echo "  Mode:       $([ "$FORCE" = true ] && echo "force" || echo "interactive")"
echo "  Dry-run:    $DRY_RUN"
echo "  Categories: ${CATEGORY_FILTER:-all}"
echo "  Max size:   ${MAX_IMAGE_SIZE_MB}MB"
echo ""

BUILT=0; SKIPPED=0; FAILED=0

# Build list of eligible plugin directories into a temp file (avoids subshell)
PLUGIN_LIST_FILE=$(mktemp)
trap "rm -f '$PLUGIN_LIST_FILE'" EXIT
for category_dir in "$PLUGINS_DIR"/*/; do
  category=$(basename "$category_dir")
  case " $CATEGORIES " in *" $category "*) ;; *) continue ;; esac
  for plugin_dir in "$category_dir"*/; do
    [ -f "$plugin_dir/plugin-spec.yaml" ] && [ -f "$plugin_dir/Dockerfile" ] && echo "$plugin_dir" >> "$PLUGIN_LIST_FILE"
  done
done
TOTAL=$(wc -l < "$PLUGIN_LIST_FILE" | tr -d ' ')

CURRENT=0
while IFS= read -r plugin_dir; do
    [ -n "$plugin_dir" ] || continue
    category=$(basename "$(dirname "$plugin_dir")")

    CURRENT=$((CURRENT + 1))
    name=$(get_spec_field name "$plugin_dir/plugin-spec.yaml")
    label="${category}/${name}"
    tag=$(compute_image_tag "$plugin_dir")

    # Check for existing image.tar
    if [ -f "$plugin_dir/image.tar" ] && [ "$FORCE" != true ]; then
      existing_tag=$(grep '^imageTag:' "$plugin_dir/config.yaml" 2>/dev/null | sed 's/^imageTag: *//')
      if [ "$existing_tag" = "$tag" ]; then
        echo "  [${CURRENT}/${TOTAL}] SKIP $label (image.tar exists, hash unchanged)"
        SKIPPED=$((SKIPPED + 1))
        continue
      fi
      # Hash changed — prompt to recreate
      if [ -t 0 ] && [ "$DRY_RUN" != true ]; then
        printf "  [${CURRENT}/${TOTAL}] $label has existing image.tar. Recreate? [y/N]: "
        read -r _answer
        if [ "$_answer" != "y" ] && [ "$_answer" != "Y" ]; then
          echo "    Skipped"
          SKIPPED=$((SKIPPED + 1))
          continue
        fi
      fi
    fi

    if [ "$DRY_RUN" = true ]; then
      echo "  [${CURRENT}/${TOTAL}] BUILD $label -> $tag (dry-run)"
      BUILT=$((BUILT + 1))
      continue
    fi

    echo "  [${CURRENT}/${TOTAL}] BUILD $label -> $tag"

    # Build image — with retry on transient network failures.
    #
    # Plugin Dockerfiles overwhelmingly use `apt-get update && apt-get install`
    # which has no built-in retry. When archive.ubuntu.com / launchpad / sury
    # mirrors flap (504s, connection timeouts), the build fails on a fully
    # transient error. Retry the whole `docker build` up to BUILD_MAX_ATTEMPTS
    # times when the failure log matches a known-transient pattern; surface
    # any other failure (compile error, missing package, etc.) immediately.
    build_args=$(parse_build_arg_flags "$plugin_dir/plugin-spec.yaml")
    build_log=$(mktemp)
    max_attempts=${BUILD_MAX_ATTEMPTS:-3}
    attempt=1
    build_ok=false
    while [ "$attempt" -le "$max_attempts" ]; do
      # shellcheck disable=SC2086
      if docker build --progress plain $build_args \
          -t "plugin:${tag}" -f "$plugin_dir/Dockerfile" "$plugin_dir" > "$build_log" 2>&1; then
        build_ok=true
        break
      fi
      # Detect transient apt/network failures. Anything else is a real bug
      # and should fail immediately so the operator sees it.
      if grep -qE 'connection timed out|Could not connect|Temporary failure resolving|503 Service Unavailable|504 Gateway|Gateway Time-out|Connection reset by peer|TLS handshake' "$build_log"; then
        backoff=$((attempt * 10))
        echo "    transient network failure on attempt $attempt/$max_attempts — sleeping ${backoff}s"
        sleep "$backoff"
        attempt=$((attempt + 1))
        continue
      fi
      # Real failure — break out and report.
      break
    done
    if [ "$build_ok" != "true" ]; then
      echo "    FAIL (docker build failed after $attempt attempt(s) — last 20 lines:)"
      tail -20 "$build_log" | sed 's/^/      /'
      rm -f "$build_log"
      FAILED=$((FAILED + 1))
      continue
    fi
    rm -f "$build_log"

    # Save to tar
    tar_path="$plugin_dir/image.tar"
    if ! docker save "plugin:${tag}" -o "$tar_path" 2>/dev/null; then
      echo "    FAIL (docker save failed)"
      rm -f "$tar_path"
      docker rmi "plugin:${tag}" > /dev/null 2>&1 || true
      FAILED=$((FAILED + 1))
      continue
    fi

    # Check size
    tar_size_mb=$(( $(wc -c < "$tar_path") / 1024 / 1024 ))
    if [ "$tar_size_mb" -gt "$MAX_IMAGE_SIZE_MB" ]; then
      echo "    SKIP (image ${tar_size_mb}MB exceeds ${MAX_IMAGE_SIZE_MB}MB limit)"
      rm -f "$tar_path"
      docker rmi "plugin:${tag}" > /dev/null 2>&1 || true
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    # Update config.yaml
    config="$plugin_dir/config.yaml"
    sed_inplace 's/^buildType: build_image$/buildType: prebuilt/' "$config"
    sed_inplace '/^dockerfile:/d' "$config"
    sed_inplace '/^imageTag:/d' "$config"
    echo "imageTag: ${tag}" >> "$config"

    # Cleanup docker image
    docker rmi "plugin:${tag}" > /dev/null 2>&1 || true

    echo "    OK (${tar_size_mb}MB)"
    BUILT=$((BUILT + 1))
done < "$PLUGIN_LIST_FILE"

echo ""
echo "=== Summary ==="
echo "  Built:   $BUILT"
echo "  Skipped: $SKIPPED"
echo "  Failed:  $FAILED"

[ "$FAILED" -gt 0 ] && exit 1
exit 0
