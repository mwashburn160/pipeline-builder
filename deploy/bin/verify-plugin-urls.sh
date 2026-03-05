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
TIMEOUT=15
PASSED=0
FAILED=0
ERRORS=()

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

check_url() {
  local url="$1"
  local file="$2"
  local code
  code=$(curl -fsSL -o /dev/null -w "%{http_code}" --head --max-time "$TIMEOUT" "$url" 2>/dev/null) || code="000"

  # Follow redirects — 200 and 302 are both acceptable
  if [ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "301" ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    ERRORS+=("$file: HTTP $code — $url")
    echo -e "  ${RED}FAIL${NC} HTTP $code — $url"
  fi
}

check_docker_image() {
  local image="$1"
  local file="$2"

  if docker manifest inspect "$image" > /dev/null 2>&1; then
    PASSED=$((PASSED + 1))
    return
  fi
  # Fallback: Docker Hub Tags API (avoids unauthenticated pull rate limits)
  local repo="${image%%:*}"
  local tag="${image#*:}"
  local api_result
  api_result=$(curl -s --max-time "$TIMEOUT" "https://hub.docker.com/v2/repositories/${repo}/tags/${tag}" 2>/dev/null)
  if echo "$api_result" | grep -q '"name"'; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    ERRORS+=("$file: image not found — $image")
    echo -e "  ${RED}FAIL${NC} image not found — $image"
  fi
}

verify_dockerfile() {
  local dockerfile="$1"
  local rel_path="${dockerfile#"$PLUGINS_DIR"/}"

  echo -e "${BLUE}==>${NC} $rel_path"

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
    for plugin_dir in "$category_dir"*/; do
      [ -d "$plugin_dir" ] || continue
      dockerfile="$plugin_dir/Dockerfile"
      [ -f "$dockerfile" ] && verify_dockerfile "$dockerfile"
    done
  done
fi

echo ""
echo "========================"
echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}Broken URLs/images:${NC}"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
fi

echo -e "\n${GREEN}All URLs verified!${NC}"
