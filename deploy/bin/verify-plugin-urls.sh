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
CHECK_TIMEOUT=15
PASSED=0
FAILED=0
SKIPPED=0
ERRORS=()

verify_dockerfile() {
  local dockerfile="$1"
  local rel_path="${dockerfile#"$PLUGINS_DIR"/}"

  log_info "$rel_path"

  # Check curl/wget download URLs (skip apt repos and install scripts like pyenv.run, rustup, sdkman)
  # Only checks hardcoded URLs — URLs with ${VAR} or $(cmd) are skipped (use generate-plugins.sh for those)
  local urls
  urls=$(grep -E 'curl.*https://github\.com|curl.*https://[a-z]+\.(amazonaws|helm|k8s)' "$dockerfile" 2>/dev/null \
    | sed -E 's/.*(https:\/\/[^ "\\]+).*/\1/' || true)
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
