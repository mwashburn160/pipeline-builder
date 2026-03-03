#!/usr/bin/env bash
# Plugin Testing Framework
# Validates all plugins: manifest schema, Dockerfile build, install commands
#
# Usage:
#   ./test-plugins.sh                    # Test all plugins
#   ./test-plugins.sh language/java      # Test a specific plugin
#   ./test-plugins.sh --manifest-only    # Only validate manifests (no Docker build)
#   ./test-plugins.sh --build            # Build Docker images (slow)
#
# Exit codes:
#   0 = All tests passed
#   1 = One or more tests failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
PLUGINS_DIR="$DEPLOY_DIR/plugins"
MANIFEST_ONLY=false
BUILD_IMAGES=false
SPECIFIC_PLUGIN=""
PASSED=0
FAILED=0
SKIPPED=0
ERRORS=()

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --manifest-only) MANIFEST_ONLY=true ;;
    --build) BUILD_IMAGES=true ;;
    --help|-h)
      echo "Usage: $0 [--manifest-only] [--build] [category/plugin]"
      echo ""
      echo "Options:"
      echo "  --manifest-only  Only validate manifests (no Docker checks)"
      echo "  --build          Build Docker images (slow, requires Docker)"
      echo "  category/plugin  Test a specific plugin (e.g., language/java)"
      exit 0
      ;;
    *) SPECIFIC_PLUGIN="$arg" ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; FAILED=$((FAILED + 1)); ERRORS+=("$2: $1"); }
log_skip() { echo -e "  ${YELLOW}SKIP${NC} $1"; SKIPPED=$((SKIPPED + 1)); }
log_info() { echo -e "${BLUE}==>${NC} $1"; }

# Required manifest fields
REQUIRED_FIELDS=("name" "description" "keywords" "version" "pluginType" "computeType" "primaryOutputDirectory" "dockerfile" "installCommands" "commands")
# New v2 fields
V2_FIELDS=("timeout" "failureBehavior" "secrets")
VALID_COMPUTE_TYPES=("SMALL" "MEDIUM" "LARGE")
VALID_PLUGIN_TYPES=("CodeBuildStep")
VALID_FAILURE_BEHAVIORS=("fail" "warn" "ignore")

validate_manifest() {
  local manifest="$1"
  local plugin_dir="$2"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"
  local all_pass=true

  # Check required fields exist
  for field in "${REQUIRED_FIELDS[@]}"; do
    if ! grep -q "^${field}:" "$manifest" 2>/dev/null; then
      log_fail "Missing required field: ${field}" "${category}/${plugin_name}"
      all_pass=false
    fi
  done

  # Check v2 fields
  for field in "${V2_FIELDS[@]}"; do
    if ! grep -q "^${field}:" "$manifest" 2>/dev/null; then
      log_fail "Missing v2 field: ${field}" "${category}/${plugin_name}"
      all_pass=false
    fi
  done

  # Validate name matches directory
  local manifest_name
  manifest_name=$(grep "^name:" "$manifest" | head -1 | sed 's/name: *//')
  if [ "$manifest_name" != "$plugin_name" ]; then
    log_fail "Name mismatch: manifest='${manifest_name}' dir='${plugin_name}'" "${category}/${plugin_name}"
    all_pass=false
  else
    log_pass "Name matches directory"
  fi

  # Validate pluginType
  local plugin_type
  plugin_type=$(grep "^pluginType:" "$manifest" | head -1 | sed 's/pluginType: *//')
  if [[ ! " ${VALID_PLUGIN_TYPES[*]} " =~ " ${plugin_type} " ]]; then
    log_fail "Invalid pluginType: ${plugin_type}" "${category}/${plugin_name}"
    all_pass=false
  else
    log_pass "Valid pluginType: ${plugin_type}"
  fi

  # Validate computeType
  local compute_type
  compute_type=$(grep "^computeType:" "$manifest" | head -1 | sed 's/computeType: *//')
  if [[ ! " ${VALID_COMPUTE_TYPES[*]} " =~ " ${compute_type} " ]]; then
    log_fail "Invalid computeType: ${compute_type}" "${category}/${plugin_name}"
    all_pass=false
  else
    log_pass "Valid computeType: ${compute_type}"
  fi

  # Validate version format (semver)
  local version
  version=$(grep "^version:" "$manifest" | head -1 | sed 's/version: *//')
  if ! echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    log_fail "Invalid version format: ${version} (expected semver)" "${category}/${plugin_name}"
    all_pass=false
  else
    log_pass "Valid version: ${version}"
  fi

  # Validate failureBehavior if present
  if grep -q "^failureBehavior:" "$manifest" 2>/dev/null; then
    local fb
    fb=$(grep "^failureBehavior:" "$manifest" | head -1 | sed 's/failureBehavior: *//')
    if [[ ! " ${VALID_FAILURE_BEHAVIORS[*]} " =~ " ${fb} " ]]; then
      log_fail "Invalid failureBehavior: ${fb} (expected: fail|warn|ignore)" "${category}/${plugin_name}"
      all_pass=false
    else
      log_pass "Valid failureBehavior: ${fb}"
    fi
  fi

  # Validate timeout if present
  if grep -q "^timeout:" "$manifest" 2>/dev/null; then
    local timeout_val
    timeout_val=$(grep "^timeout:" "$manifest" | head -1 | sed 's/timeout: *//')
    if ! echo "$timeout_val" | grep -qE '^[0-9]+$'; then
      log_fail "Invalid timeout: ${timeout_val} (expected integer minutes)" "${category}/${plugin_name}"
      all_pass=false
    else
      log_pass "Valid timeout: ${timeout_val}m"
    fi
  fi

  # Check description is not empty
  local desc
  desc=$(grep "^description:" "$manifest" | head -1 | sed 's/description: *//')
  if [ -z "$desc" ]; then
    log_fail "Empty description" "${category}/${plugin_name}"
    all_pass=false
  else
    log_pass "Has description"
  fi

  # Check keywords exist and are non-empty
  if grep -q "^keywords:" "$manifest" 2>/dev/null; then
    local keyword_count
    keyword_count=$(grep -A 20 "^keywords:" "$manifest" | grep "^  - " | wc -l | tr -d ' ')
    if [ "$keyword_count" -eq 0 ]; then
      log_fail "Empty keywords list" "${category}/${plugin_name}"
      all_pass=false
    else
      log_pass "Has ${keyword_count} keywords"
    fi
  fi

  $all_pass && log_pass "Manifest schema valid"
}

validate_dockerfile() {
  local dockerfile="$1"
  local plugin_dir="$2"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"

  # Check FROM instruction exists
  if ! grep -q "^FROM " "$dockerfile" 2>/dev/null; then
    log_fail "Missing FROM instruction" "${category}/${plugin_name}"
    return
  fi
  log_pass "Has FROM instruction"

  # Check WORKDIR is set
  if ! grep -q "^WORKDIR " "$dockerfile" 2>/dev/null; then
    log_fail "Missing WORKDIR instruction" "${category}/${plugin_name}"
  else
    log_pass "Has WORKDIR"
  fi

  # Check no secrets in ENV/ARG
  if grep -qE "^(ENV|ARG)\s+(.*TOKEN|.*SECRET|.*PASSWORD|.*API_KEY|.*PRIVATE_KEY)" "$dockerfile" 2>/dev/null; then
    log_fail "Potential secret in ENV/ARG instruction" "${category}/${plugin_name}"
  else
    log_pass "No secrets in ENV/ARG"
  fi

  # Check for apt cleanup
  if grep -q "apt-get install" "$dockerfile" 2>/dev/null; then
    if grep -q "rm -rf /var/lib/apt/lists" "$dockerfile" 2>/dev/null; then
      log_pass "Has apt cache cleanup"
    else
      log_fail "Missing apt cache cleanup (rm -rf /var/lib/apt/lists/*)" "${category}/${plugin_name}"
    fi
  fi

  # Build test (optional)
  if [ "$BUILD_IMAGES" = true ]; then
    local tag="plugin-test-${category}-${plugin_name}:latest"
    log_info "Building Docker image: ${tag}"
    if docker build -t "$tag" "$plugin_dir" > /dev/null 2>&1; then
      log_pass "Docker build successful"
      docker rmi "$tag" > /dev/null 2>&1 || true
    else
      log_fail "Docker build failed" "${category}/${plugin_name}"
    fi
  fi
}

validate_plugin_zip() {
  local plugin_dir="$1"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"
  local zip_file="${plugin_dir}/plugin.zip"

  if [ ! -f "$zip_file" ]; then
    log_fail "Missing plugin.zip" "${category}/${plugin_name}"
    return
  fi

  # Check zip contains required files
  local contents
  contents=$(unzip -l "$zip_file" 2>/dev/null | grep -E "Dockerfile|manifest.yaml" | wc -l | tr -d ' ')
  if [ "$contents" -lt 2 ]; then
    log_fail "plugin.zip missing Dockerfile or manifest.yaml" "${category}/${plugin_name}"
  else
    log_pass "plugin.zip contains Dockerfile + manifest.yaml"
  fi
}

# Main test loop
test_plugin() {
  local plugin_dir="$1"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"
  local manifest="${plugin_dir}/manifest.yaml"
  local dockerfile="${plugin_dir}/Dockerfile"

  echo ""
  log_info "Testing ${category}/${plugin_name}"

  # Check required files exist
  if [ ! -f "$manifest" ]; then
    log_fail "Missing manifest.yaml" "${category}/${plugin_name}"
    return
  fi
  if [ ! -f "$dockerfile" ]; then
    log_fail "Missing Dockerfile" "${category}/${plugin_name}"
    return
  fi

  validate_manifest "$manifest" "$plugin_dir"

  if [ "$MANIFEST_ONLY" = false ]; then
    validate_dockerfile "$dockerfile" "$plugin_dir"
    validate_plugin_zip "$plugin_dir"
  fi
}

# Discover and test plugins
echo -e "${BLUE}Plugin Testing Framework${NC}"
echo "========================"
echo "Plugins dir: ${PLUGINS_DIR}"
echo "Mode: $([ "$MANIFEST_ONLY" = true ] && echo "manifest-only" || echo "full")$([ "$BUILD_IMAGES" = true ] && echo " +docker-build" || echo "")"

if [ -n "$SPECIFIC_PLUGIN" ]; then
  plugin_path="${PLUGINS_DIR}/${SPECIFIC_PLUGIN}"
  if [ -d "$plugin_path" ]; then
    test_plugin "$plugin_path"
  else
    echo -e "${RED}Plugin not found: ${SPECIFIC_PLUGIN}${NC}"
    exit 1
  fi
else
  for category_dir in "${PLUGINS_DIR}"/*/; do
    category=$(basename "$category_dir")
    [ ! -d "$category_dir" ] && continue
    for plugin_dir in "${category_dir}"/*/; do
      [ -d "$plugin_dir" ] || continue
      test_plugin "$plugin_dir"
    done
  done
fi

# Summary
echo ""
echo "========================"
echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}"

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}Failures:${NC}"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
fi

echo -e "\n${GREEN}All tests passed!${NC}"
exit 0
