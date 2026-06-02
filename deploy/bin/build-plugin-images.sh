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

# Fail fast with a useful message when the current user can't reach the
# docker socket. Common case on EC2: the user is `ec2-user` who hasn't been
# added to the docker group (bootstrap.sh adds them, but the user must
# re-login or run `newgrp docker` for it to take effect).
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: cannot reach docker daemon (permission denied or daemon down)" >&2
  echo "  Current user: $(id -un)" >&2
  echo "  Fix: ensure your user is in the 'docker' group, then re-login or run:" >&2
  echo "    newgrp docker && bash $0 $*" >&2
  echo "  Or run this script with sudo." >&2
  exit 1
fi

PLUGINS_DIR="$DEPLOY_DIR/plugins"
FORCE=false
RESET=false
DRY_RUN=false
BASES_ONLY=false
CATEGORY_FILTER=""
MAX_IMAGE_SIZE_MB="${MAX_IMAGE_SIZE_MB:-4096}"

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --force|--rebuild) FORCE=true; shift ;;
    --reset)     RESET=true; shift ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --bases-only) BASES_ONLY=true; shift ;;
    --category)  CATEGORY_FILTER="$2"; shift 2 ;;
    --max-image-size) MAX_IMAGE_SIZE_MB="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --force              Rebuild all images, no prompt for existing"
      echo "  --reset              Revert all plugins to buildType: build_image"
      echo "  --dry-run            Show what would be built without building"
      echo "  --bases-only         Build + push base images only, skip per-plugin builds"
      echo "  --category CATS      Comma-separated categories (e.g., language,security)"
      echo "  --max-image-size MB  Skip images larger than MB (default: 4096)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---- Build base images FIRST (dependency order) ----
#
# All base images live under `_base/`:
#   _base/_plugin-base/    → pipeline-plugin-base:24.04 (root, built first)
#   _base/_snyk-base/      → pipeline-snyk-base:1.0     (extends root)
#   _base/_sonarcloud-base/ → pipeline-sonarcloud-base:1.0
#   _base/_trivy-base/     → pipeline-trivy-base:1.0
#
# `_plugin-base` is built before any family base (family bases inherit FROM
# the root). Family bases are built alphabetically — they don't depend on
# each other.
#
# All `_*` directories at any depth are infrastructure, not plugins —
# excluded from the upload/load flow by the `! -name '_*'` filter on
# category list at the top level.
# Detect EC2 region (if running on EC2) and pick a regional Ubuntu mirror.
# Same-region traffic stays in AWS (free + fast — 100s of MB/s vs the ~1
# MB/s archive.ubuntu.com gives EC2 boxes). On non-EC2 hosts (or when IMDS
# is disabled), prints nothing and apt uses the global mirror as before.
#
# Operator override: `APT_MIRROR=<host>` env var bypasses detection.
_detect_apt_mirror() {
  if [ -n "${APT_MIRROR:-}" ]; then
    echo "$APT_MIRROR"
    return
  fi
  # Explicit init — bash 3.2 (macOS default) treats unassigned `local`
  # vars as unbound under `set -u`, so a non-EC2 host (empty _token,
  # _region never assigned) trips line 104. Initialize both to "".
  local _token="" _region=""
  # IMDSv2 token first (required on hardened EC2). Tiny timeout so we don't
  # stall non-EC2 builds.
  _token=$(curl -sf -X PUT --max-time 1 \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token 2>/dev/null || true)
  if [ -n "$_token" ]; then
    _region=$(curl -sf --max-time 1 \
      -H "X-aws-ec2-metadata-token: $_token" \
      http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)
  fi
  [ -n "$_region" ] && echo "${_region}.ec2.archive.ubuntu.com"
}

# _is_transient_failure — true when a docker-build log matches a known
# transient apt/network mirror flap. Anything else is a real bug and
# should fail immediately so the operator sees it. The pattern list is
# the historical accumulation of mirror failure shapes we've observed
# (archive.ubuntu.com, launchpad, sury, npm registry, gradle plugin
# portal, etc.) — extend here, not at the call site, when a new flap
# shape shows up.
_TRANSIENT_PATTERNS='connection timed out'
_TRANSIENT_PATTERNS+='|Could not connect'
_TRANSIENT_PATTERNS+='|Temporary failure resolving'
_TRANSIENT_PATTERNS+='|503 Service Unavailable'
_TRANSIENT_PATTERNS+='|504 Gateway'
_TRANSIENT_PATTERNS+='|Gateway Time-out'
_TRANSIENT_PATTERNS+='|Connection reset by peer'
_TRANSIENT_PATTERNS+='|TLS handshake'
_TRANSIENT_PATTERNS+='|Connection failed'
_TRANSIENT_PATTERNS+='|Failed to fetch'
_TRANSIENT_PATTERNS+='|Unable to fetch some archives'
_TRANSIENT_PATTERNS+='|did not get expected size'
_TRANSIENT_PATTERNS+='|hash sum mismatch'
_TRANSIENT_PATTERNS+="|server can't find"
_TRANSIENT_PATTERNS+='|HTTP 5[0-9]{2}'
_TRANSIENT_PATTERNS+='|EOF occurred in violation of protocol'
_TRANSIENT_PATTERNS+='|read timeout'
_TRANSIENT_PATTERNS+='|operation timed out'
_TRANSIENT_PATTERNS+='|Network is unreachable'
_TRANSIENT_PATTERNS+='|No route to host'
_is_transient_failure() {
  grep -qE "$_TRANSIENT_PATTERNS" "$1"
}

# Build a single base image with output captured. Silent on success
# (just prints "  ✓ tag (Ns)"); dumps last 30 lines on failure. Set
# VERBOSE_BUILD=1 to stream output the old way (debugging).
_build_base_quiet() {
  local _tag="$1" _ctx="$2"
  local _start _elapsed _log _rc=0
  local _build_extra=""
  # The root base image takes APT_MIRROR as a build arg; family bases
  # don't (they inherit from a fully-installed base image, no apt needed).
  if [ "$(basename "$_ctx")" = "_plugin-base" ]; then
    local _mirror
    _mirror=$(_detect_apt_mirror)
    [ -n "$_mirror" ] && _build_extra="--build-arg APT_MIRROR=${_mirror}"
    [ -n "$_mirror" ] && echo "  → using apt mirror: ${_mirror}"
  fi
  _start=$(date +%s)
  if [ "${VERBOSE_BUILD:-0}" = "1" ]; then
    # shellcheck disable=SC2086
    docker build --progress plain $_build_extra -t "$_tag" "$_ctx" || _rc=$?
  else
    _log=$(mktemp)
    # shellcheck disable=SC2086
    docker build --progress plain $_build_extra -t "$_tag" "$_ctx" > "$_log" 2>&1 || _rc=$?
    if [ "$_rc" -ne 0 ]; then
      echo "  ✗ $_tag — build failed (last 30 lines):" >&2
      tail -30 "$_log" | sed 's/^/    /' >&2
    fi
    rm -f "$_log"
  fi
  _elapsed=$(($(date +%s) - _start))
  [ "$_rc" -eq 0 ] && echo "  ✓ $_tag (${_elapsed}s)"
  return "$_rc"
}

build_base_images() {
  local _base_root="$PLUGINS_DIR/_base"
  [ ! -d "$_base_root" ] && return 0

  echo "=== Building base images ==="
  if [ "$DRY_RUN" = true ]; then
    echo "  (dry-run) skipping base builds"
    return 0
  fi

  # Root base must build first.
  if [ -f "$_base_root/_plugin-base/Dockerfile" ]; then
    _build_base_quiet "pipeline-plugin-base:24.04" "$_base_root/_plugin-base" || return 1
  fi

  # Family bases — alphabetical, all inherit FROM pipeline-plugin-base:24.04.
  # Skip `_plugin-base` itself: it matches the `_*-base` glob but is the
  # root base built above with the `:24.04` tag. Without this guard, the
  # loop builds the same Dockerfile a second time as `pipeline-plugin-
  # base:1.0`, wasting build time and publishing a stale duplicate tag.
  for _fam_dir in "$_base_root"/_*-base; do
    [ -d "$_fam_dir" ] || continue
    local _name
    _name=$(basename "$_fam_dir" | sed 's/^_//')
    [ "$_name" = "plugin-base" ] && continue
    _build_base_quiet "pipeline-${_name}:1.0" "$_fam_dir" || return 1
  done

  # Push the bases into the in-cluster registry so buildkitd (separate
  # image cache from the host docker daemon) can resolve them. The
  # buildkitd.toml mirror at deploy/local/config/buildkitd/ maps
  # docker.io → registry:5000, so bare `FROM pipeline-plugin-base:24.04`
  # in plugin Dockerfiles resolves via that mirror.
  #
  # Fail loudly if the push fails — a half-pushed registry leaves plugin
  # builds failing at runtime with a misleading `insufficient_scope`
  # error (registry returns the same response for missing-repo and
  # actual-scope-denied). Better to abort here so the operator sees the
  # real cause (network, auth, realm misconfig).
  if [ -x "$SCRIPT_DIR/push-base-images.sh" ]; then
    "$SCRIPT_DIR/push-base-images.sh"
  fi
  echo ""
}
build_base_images

# Under --bases-only the caller (e.g. init-platform.sh under the
# build_image strategy) wants only the base images built + pushed —
# per-plugin image building is deferred to build-at-upload-time.
if [ "$BASES_ONLY" = true ]; then
  exit 0
fi

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

      _bt=$(get_spec_field buildType "$config")
      [ "$_bt" = "prebuilt" ] || continue

      # Revert config.yaml — one yq write replaces the prior cascade of
      # sed deletes + `echo >>` appends so field order is deterministic
      # across plugins (was non-deterministic when dockerfile got
      # appended to end).
      yq -i 'del(.imageTag) | del(.imageHash) | .buildType = "build_image" | .dockerfile = "Dockerfile"' "$config"

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

    # Build-skip decision tree. The build tag now lives inside
    # config.yaml as `imageTag:` — same file the platform parses on
    # upload, so build script and runtime share one source of truth.
    # (Old layouts used `imageHash:` (an earlier, misnamed field that
    # actually stored a tag) and a `.image-hash` sidecar; both are still
    # accepted on read so existing checkouts keep their skip semantics
    # across upgrade. Either is overwritten with `imageTag:` on the next
    # successful build.)
    #
    # Source state we trust: `imageTag:` from config.yaml. Build output:
    # `image.tar`. Either can be missing independently — `--cleanup`
    # deletes image.tar, a `git clean` deletes neither (config.yaml is
    # checked in), an interrupted build leaves config.yaml untouched.
    #
    # Reasons we'd skip a build, in priority order:
    #   1. `imageTag` matches current source AND `image.tar` exists →
    #      everything is in sync, definitely skip.
    #   2. `imageTag` matches current source but `image.tar` is gone →
    #      source is unchanged but the cached tar was deleted (probably
    #      by --cleanup). Skip only if we know the image is already in
    #      the in-cluster registry (REGISTRY_CHECK=true); otherwise
    #      rebuild so the next load-plugins step has something to upload.
    #   3. `image.tar` exists but `imageTag` is missing or mismatched →
    #      can't verify freshness, treat as stale and prompt/rebuild.
    if [ "$FORCE" != true ]; then
      # Read `imageTag:` from config.yaml. Fall back to legacy `imageHash:`
      # and the older `.image-hash` sidecar so pre-rename / pre-consolidation
      # checkouts still skip correctly on the first post-upgrade run; once
      # that run completes, the legacy entries are gone and the canonical
      # read above always succeeds.
      existing_tag=$(get_spec_field imageTag "$plugin_dir/config.yaml")
      if [ -z "$existing_tag" ]; then
        existing_tag=$(get_spec_field imageHash "$plugin_dir/config.yaml")
      fi
      if [ -z "$existing_tag" ]; then
        existing_tag=$(cat "$plugin_dir/.image-hash" 2>/dev/null || true)
      fi
      hash_matches=$([ "$existing_tag" = "$tag" ] && echo true || echo false)
      tar_present=$([ -f "$plugin_dir/image.tar" ] && echo true || echo false)

      if [ "$hash_matches" = true ] && [ "$tar_present" = true ]; then
        echo "  [${CURRENT}/${TOTAL}] SKIP $label (image.tar exists, hash unchanged)"
        SKIPPED=$((SKIPPED + 1))
        continue
      fi
      if [ "$hash_matches" = true ] && [ "$tar_present" = false ] && [ "${REGISTRY_CHECK:-false}" = true ]; then
        # image.tar was likely deleted by --cleanup. Source is unchanged,
        # so the registry should still hold the previously-uploaded copy.
        echo "  [${CURRENT}/${TOTAL}] SKIP $label (image.tar missing, hash unchanged — trusting registry copy)"
        SKIPPED=$((SKIPPED + 1))
        continue
      fi
      if [ "$tar_present" = true ] && [ "$hash_matches" != true ]; then
        # Hash mismatch with an existing tar — source changed since the
        # last build, or .image-hash was clobbered.
        if [ -t 0 ] && [ "$DRY_RUN" != true ]; then
          printf '  [%s/%s] %s has existing image.tar but source changed. Rebuild? [Y/n]: ' "$CURRENT" "$TOTAL" "$label"
          read -r _answer
          if [ "$_answer" = "n" ] || [ "$_answer" = "N" ]; then
            echo "    Skipped (manual)"
            SKIPPED=$((SKIPPED + 1))
            continue
          fi
        fi
      elif [ "$tar_present" = false ] && [ "$hash_matches" = true ]; then
        # image.tar gone, .image-hash still here — quiet feedback that
        # we're rebuilding to recreate the tarball.
        echo "  [${CURRENT}/${TOTAL}] REBUILD $label (image.tar missing; pass REGISTRY_CHECK=true to skip when the image is already in the in-cluster registry)"
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
      if _is_transient_failure "$build_log"; then
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

    # Update config.yaml. Synthesize a minimal one if the plugin lacks it
    # (rare — but one outlier plugin shouldn't abort an otherwise-clean run).
    # The schema's `.strict()` parser accepts `imageTag` (the canonical
    # field) and rejects everything else; strip legacy `imageHash` and any
    # stray `imageTag` before re-writing.
    # Image identity is `<name>:<version>` from plugin-spec.yaml; the local
    # docker tag (`plugin:${tag}` saved into image.tar) is incidental and
    # gets re-tagged at push time by `loadAndPush`.
    config="$plugin_dir/config.yaml"
    if [ ! -f "$config" ]; then
      printf 'pluginSpec: plugin-spec.yaml\ndockerfile: Dockerfile\nbuildType: build_image\n' > "$config"
    fi
    # Single yq write: switch to prebuilt, drop the source-build fields
    # the .strict() schema would otherwise reject, persist the fresh tag.
    # Replaces a cascade of sed_inplace deletes + `>>` append that left
    # field order non-deterministic across plugins.
    TAG="$tag" yq -i '
      del(.imageHash) | del(.imageTag) | del(.dockerfile)
      | .buildType = "prebuilt"
      | .imageTag = strenv(TAG)
    ' "$config"

    # One-time cleanup of the legacy sidecar file from prior runs of this
    # script; harmless on plugins that never had one. Remove this block
    # once every plugin in the tree has been rebuilt at least once.
    rm -f "$plugin_dir/.image-hash"

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
