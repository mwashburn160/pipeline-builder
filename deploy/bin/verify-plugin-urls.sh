#!/usr/bin/env bash
set -euo pipefail

# Verify all download URLs in plugin Dockerfiles are reachable.
# Catches stale versions, moved repos, and renamed assets before they break builds.
#
# Usage:
#   ./verify-plugin-urls.sh                    # check all plugins
#   ./verify-plugin-urls.sh security/trivy     # check a specific plugin

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

PLUGINS_DIR="$DEPLOY_DIR/plugins"
SPECIFIC_PLUGIN="${1:-}"
# CHECK_TIMEOUT/PASSED/FAILED/SKIPPED/ERRORS are read & mutated by common.sh's
# check_url/check_docker_image/print_results (sourced-globals contract), so the
# SC2034 "appears unused" warnings here are false positives.
# shellcheck disable=SC2034
CHECK_TIMEOUT=15
# shellcheck disable=SC2034
PASSED=0
# shellcheck disable=SC2034
FAILED=0
# shellcheck disable=SC2034
SKIPPED=0
# shellcheck disable=SC2034
ERRORS=()

verify_dockerfile() {
  local dockerfile="$1"
  local rel_path="${dockerfile#"$PLUGINS_DIR"/}"

  log_info "$rel_path"

  # Check curl/wget download URLs.
  #
  # Strategy: grep every https:// URL out of `curl`/`wget` lines, then
  # filter (1) URLs containing shell substitution (use generate-plugins.sh
  # to verify those — versions live in plugin-versions.yaml), and (2)
  # known-noisy hosts where a HEAD check isn't meaningful (apt repos that
  # 403 on /, package-manager registries that serve per-package endpoints
  # only, install-script entry points like pyenv.run / rustup / sdkman).
  #
  # The previous regex only matched github/amazonaws/helm/k8s, missing
  # gradle.org, nodesource, sury, dl.google, etc. — newer plugins added
  # download URLs that weren't being verified.
  local urls
  urls=$(grep -E '(curl|wget)[[:space:]]' "$dockerfile" 2>/dev/null \
    | grep -oE 'https://[a-zA-Z0-9._/~?=&%+-]+' \
    | grep -v '\${' \
    | grep -v '\$(' \
    | grep -vE '(deb\.nodesource\.com|launchpad\.net|packagecloud\.io|registry\.npmjs\.org|pyenv\.run|sh\.rustup\.rs|get\.sdkman\.io|repo\.maven\.apache\.org/maven2)' \
    | sort -u || true)
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    # Skip URLs with unresolved variables, shell substitutions, or malformed captures
    echo "$url" | grep -qE '\$\{|\$\(|\)' && continue
    check_url "$url" "$rel_path"
  done <<< "$urls"

  # Check COPY --from Docker image references
  local images
  images=$(grep -E 'COPY[[:space:]]+--from=' "$dockerfile" 2>/dev/null \
    | sed -E 's/.*COPY[[:space:]]+--from=([^ ]+).*/\1/' || true)
  while IFS= read -r image; do
    [ -z "$image" ] && continue
    # Skip named build stages (no / in the name)
    if echo "$image" | grep -q '/'; then
      check_docker_image "$image" "$rel_path"
    fi
  done <<< "$images"
}

# ── Main ──

echo -e "${BLUE}Plugin URL Verification${NC}"
echo "========================"

if [ -n "$SPECIFIC_PLUGIN" ]; then
  dockerfile="$PLUGINS_DIR/$SPECIFIC_PLUGIN/Dockerfile"
  if [ -f "$dockerfile" ]; then
    verify_dockerfile "$dockerfile"
  else
    echo -e "${RED}Not found: $dockerfile${NC}"
    exit 1
  fi
else
  for category_dir in "$PLUGINS_DIR"/*/; do
    [ -d "$category_dir" ] || continue
    for plugin_dir in "${category_dir}"/*/; do
      [ -d "$plugin_dir" ] || continue
      dockerfile="$plugin_dir/Dockerfile"
      [ -f "$dockerfile" ] && verify_dockerfile "$dockerfile"
    done
  done
fi

print_results
print_errors_and_exit "All URLs verified!"
