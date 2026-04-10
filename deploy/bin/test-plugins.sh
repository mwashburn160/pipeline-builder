#!/usr/bin/env bash
set -euo pipefail

# Validate all plugins: spec schema, Dockerfile structure, optional Docker build.
#
# Usage:
#   ./test-plugins.sh                       # test all plugins
#   ./test-plugins.sh language/java         # test a specific plugin
#   ./test-plugins.sh --spec-only           # only validate specs (no Docker checks)
#   ./test-plugins.sh --build               # build Docker images (slow)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

PLUGINS_DIR="$DEPLOY_DIR/plugins"
SPEC_ONLY=false
BUILD_IMAGES=false
SPECIFIC_PLUGIN=""
PASSED=0
FAILED=0
SKIPPED=0
ERRORS=()

# ---- Argument parsing ----

for arg in "$@"; do
  case "$arg" in
    --spec-only) SPEC_ONLY=true ;;
    --build)     BUILD_IMAGES=true ;;
    --help|-h)
      echo "Usage: $0 [options] [category/plugin]"
      echo ""
      echo "Options:"
      echo "  --spec-only  Only validate specs (no Docker checks)"
      echo "  --build      Build Docker images (slow, requires Docker)"
      echo "  category/plugin  Test a specific plugin (e.g., language/java)"
      exit 0
      ;;
    *) SPECIFIC_PLUGIN="$arg" ;;
  esac
done

# ---- Validation constants ----

REQUIRED_FIELDS=("name" "description" "keywords" "category" "version" "pluginType" "computeType")
CODEBUILD_FIELDS=("primaryOutputDirectory" "dockerfile" "installCommands" "commands")
V2_FIELDS=("timeout" "failureBehavior" "secrets")
VALID_COMPUTE_TYPES=("SMALL" "MEDIUM" "LARGE")
VALID_PLUGIN_TYPES=("CodeBuildStep" "ManualApprovalStep")
VALID_FAILURE_BEHAVIORS=("fail" "warn" "ignore")
VALID_CATEGORIES=("language" "security" "quality" "monitoring" "artifact" "deploy" "infrastructure" "testing" "notification" "ai" "unknown")

# ---- Validation functions ----

validate_spec() {
  local specfile="$1"
  local plugin_dir="$2"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"
  local fqn="${category}/${plugin_name}"
  local all_pass=true

  # Required fields
  for field in "${REQUIRED_FIELDS[@]}"; do
    if ! grep -q "^${field}:" "$specfile" 2>/dev/null; then
      log_fail "Missing required field: ${field}" "$fqn"
      all_pass=false
    fi
  done

  # CodeBuild-specific fields only required for CodeBuildStep plugins
  local plugin_type
  plugin_type=$(get_spec_field pluginType "$specfile")
  if [ "$plugin_type" = "CodeBuildStep" ]; then
    for field in "${CODEBUILD_FIELDS[@]}"; do
      if ! grep -q "^${field}:" "$specfile" 2>/dev/null; then
        log_fail "Missing CodeBuild field: ${field}" "$fqn"
        all_pass=false
      fi
    done
  fi

  # V2 fields
  for field in "${V2_FIELDS[@]}"; do
    if ! grep -q "^${field}:" "$specfile" 2>/dev/null; then
      log_fail "Missing v2 field: ${field}" "$fqn"
      all_pass=false
    fi
  done

  # Name matches directory
  local spec_name
  spec_name=$(get_spec_field name "$specfile")
  if [ "$spec_name" != "$plugin_name" ]; then
    log_fail "Name mismatch: spec='${spec_name}' dir='${plugin_name}'" "$fqn"
    all_pass=false
  else
    log_pass "Name matches directory"
  fi

  # Valid pluginType
  if [[ ! " ${VALID_PLUGIN_TYPES[*]} " =~ " ${plugin_type} " ]]; then
    log_fail "Invalid pluginType: ${plugin_type}" "$fqn"
    all_pass=false
  else
    log_pass "Valid pluginType: ${plugin_type}"
  fi

  # Valid computeType
  local compute_type
  compute_type=$(get_spec_field computeType "$specfile")
  if [[ ! " ${VALID_COMPUTE_TYPES[*]} " =~ " ${compute_type} " ]]; then
    log_fail "Invalid computeType: ${compute_type}" "$fqn"
    all_pass=false
  else
    log_pass "Valid computeType: ${compute_type}"
  fi

  # Valid semver
  local version
  version=$(get_spec_field version "$specfile")
  if ! echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    log_fail "Invalid version format: ${version} (expected semver)" "$fqn"
    all_pass=false
  else
    log_pass "Valid version: ${version}"
  fi

  # Optional: failureBehavior
  if grep -q "^failureBehavior:" "$specfile" 2>/dev/null; then
    local fb
    fb=$(get_spec_field failureBehavior "$specfile")
    if [[ ! " ${VALID_FAILURE_BEHAVIORS[*]} " =~ " ${fb} " ]]; then
      log_fail "Invalid failureBehavior: ${fb} (expected: fail|warn|ignore)" "$fqn"
      all_pass=false
    else
      log_pass "Valid failureBehavior: ${fb}"
    fi
  fi

  # Optional: timeout
  if grep -q "^timeout:" "$specfile" 2>/dev/null; then
    local timeout_val
    timeout_val=$(get_spec_field timeout "$specfile")
    if ! echo "$timeout_val" | grep -qE '^[0-9]+$'; then
      log_fail "Invalid timeout: ${timeout_val} (expected integer minutes)" "$fqn"
      all_pass=false
    else
      log_pass "Valid timeout: ${timeout_val}m"
    fi
  fi

  # Valid category
  if grep -q "^category:" "$specfile" 2>/dev/null; then
    local cat_val
    cat_val=$(get_spec_field category "$specfile")
    if [[ ! " ${VALID_CATEGORIES[*]} " =~ " ${cat_val} " ]]; then
      log_fail "Invalid category: ${cat_val} (expected: ${VALID_CATEGORIES[*]})" "$fqn"
      all_pass=false
    elif [ "$cat_val" != "$category" ]; then
      log_fail "Category mismatch: spec='${cat_val}' directory='${category}'" "$fqn"
      all_pass=false
    else
      log_pass "Valid category: ${cat_val}"
    fi
  fi

  # Description not empty
  local desc
  desc=$(get_spec_field description "$specfile")
  if [ -z "$desc" ]; then
    log_fail "Empty description" "$fqn"
    all_pass=false
  else
    log_pass "Has description"
  fi

  # Keywords not empty
  if grep -q "^keywords:" "$specfile" 2>/dev/null; then
    local keyword_count
    keyword_count=$(grep -A 20 "^keywords:" "$specfile" | grep "^  - " | wc -l | tr -d ' ')
    if [ "$keyword_count" -eq 0 ]; then
      log_fail "Empty keywords list" "$fqn"
      all_pass=false
    else
      log_pass "Has ${keyword_count} keywords"
    fi
  fi

  $all_pass && log_pass "Spec schema valid"
}

validate_dockerfile() {
  local dockerfile="$1"
  local plugin_dir="$2"
  local fqn="$(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"

  if ! grep -q "^FROM " "$dockerfile" 2>/dev/null; then
    log_fail "Missing FROM instruction" "$fqn"
    return
  fi
  log_pass "Has FROM instruction"

  if ! grep -q "^WORKDIR " "$dockerfile" 2>/dev/null; then
    log_fail "Missing WORKDIR instruction" "$fqn"
  else
    log_pass "Has WORKDIR"
  fi

  if grep -qE "^(ENV|ARG)\s+(.*TOKEN|.*SECRET|.*PASSWORD|.*API_KEY|.*PRIVATE_KEY)" "$dockerfile" 2>/dev/null; then
    log_fail "Potential secret in ENV/ARG instruction" "$fqn"
  else
    log_pass "No secrets in ENV/ARG"
  fi

  if grep -q "apt-get install" "$dockerfile" 2>/dev/null; then
    if grep -q "rm -rf /var/lib/apt/lists" "$dockerfile" 2>/dev/null; then
      log_pass "Has apt cache cleanup"
    else
      log_fail "Missing apt cache cleanup (rm -rf /var/lib/apt/lists/*)" "$fqn"
    fi
  fi

  if [ "$BUILD_IMAGES" = true ]; then
    local tag="plugin-test-${fqn//\//-}:latest"
    log_info "Building Docker image: ${tag}"
    if docker build -t "$tag" "$plugin_dir" > /dev/null 2>&1; then
      log_pass "Docker build successful"
      docker rmi "$tag" > /dev/null 2>&1 || true
    else
      log_fail "Docker build failed" "$fqn"
    fi
  fi
}

validate_config() {
  local plugin_dir="$1"
  local fqn="$(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"
  local config="${plugin_dir}/config.yaml"

  if [ ! -f "$config" ]; then
    log_skip "No config.yaml"
    return
  fi

  local bt
  bt=$(grep '^buildType:' "$config" 2>/dev/null | sed 's/^buildType: *//')
  case "$bt" in
    build_image|prebuilt) log_pass "Valid buildType: ${bt}" ;;
    "") log_fail "Missing buildType in config.yaml" "$fqn" ;;
    *)  log_fail "Invalid buildType: ${bt} (expected build_image or prebuilt)" "$fqn" ;;
  esac
}

test_plugin() {
  local plugin_dir="$1"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"
  local specfile="${plugin_dir}/plugin-spec.yaml"
  local dockerfile="${plugin_dir}/Dockerfile"

  echo ""
  log_info "Testing ${category}/${plugin_name}"

  if [ ! -f "$specfile" ]; then
    log_fail "Missing plugin-spec.yaml" "${category}/${plugin_name}"
    return
  fi

  local plugin_type
  plugin_type=$(get_spec_field pluginType "$specfile")

  # Only require Dockerfile for CodeBuildStep plugins
  if [ "$plugin_type" != "ManualApprovalStep" ] && [ ! -f "$dockerfile" ]; then
    log_fail "Missing Dockerfile" "${category}/${plugin_name}"
    return
  fi

  validate_spec "$specfile" "$plugin_dir"

  validate_config "$plugin_dir"

  if [ "$SPEC_ONLY" = false ] && [ "$plugin_type" != "ManualApprovalStep" ]; then
    validate_dockerfile "$dockerfile" "$plugin_dir"
  fi
}

# ---- Main ----

echo -e "${BLUE}Plugin Testing Framework${NC}"
echo "========================"
echo "  Plugins: ${PLUGINS_DIR}"
echo "  Mode:    $([ "$SPEC_ONLY" = true ] && echo "spec-only" || echo "full")$([ "$BUILD_IMAGES" = true ] && echo " +docker-build" || echo "")"

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
    [ -d "$category_dir" ] || continue
    for plugin_dir in "${category_dir}"/*/; do
      [ -d "$plugin_dir" ] || continue
      test_plugin "$plugin_dir"
    done
  done
fi

# ---- Summary ----

print_results
print_errors_and_exit "All tests passed!"

# ---- Versions Matrix (optional) ----

if [ -x "$SCRIPT_DIR/show-plugin-versions.sh" ]; then
  "$SCRIPT_DIR/show-plugin-versions.sh"
fi
