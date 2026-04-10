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
cd "$SCRIPT_DIR" || exit 1
. "$SCRIPT_DIR/common.sh"

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
      echo "  --max-image-size MB  Skip images larger than MB (default: 1024)"
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

# ---- Build category list ----

if [ -n "$CATEGORY_FILTER" ]; then
  CATEGORIES=$(echo "$CATEGORY_FILTER" | tr ',' ' ')
else
  CATEGORIES=$(find "$PLUGINS_DIR" -mindepth 1 -maxdepth 1 -type d | sort | xargs -I{} basename {})
fi

# ---- Parse buildArgs from plugin-spec.yaml ----

parse_build_arg_flags() {
  local specfile="$1"
  if grep -q "^buildArgs:" "$specfile" 2>/dev/null; then
    awk '
      /^buildArgs:/ { capture=1; next }
      capture && /^  [A-Za-z_]/ {
        gsub(/^  /, "")
        split($0, a, ": *")
        gsub(/"/, "", a[2])
        gsub(/'\''/, "", a[2])
        printf "--build-arg %s=%s ", a[1], a[2]
      }
      capture && /^[^ ]/ { exit }
    ' "$specfile"
  fi
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

    # Build image
    build_args=$(parse_build_arg_flags "$plugin_dir/plugin-spec.yaml")
    build_log=$(mktemp)
    # shellcheck disable=SC2086
    if ! docker build --progress plain $build_args \
        -t "plugin:${tag}" -f "$plugin_dir/Dockerfile" "$plugin_dir" > "$build_log" 2>&1; then
      echo "    FAIL (docker build failed — last 20 lines:)"
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
