#!/usr/bin/env bash
set -euo pipefail

# Validate all plugins: manifest schema, Dockerfile structure, optional Docker build.
#
# Usage:
#   ./test-plugins.sh                       # test all plugins
#   ./test-plugins.sh language/java         # test a specific plugin
#   ./test-plugins.sh --manifest-only       # only validate manifests (no Docker checks)
#   ./test-plugins.sh --build               # build Docker images (slow)

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

# ---- Argument parsing ----

for arg in "$@"; do
  case "$arg" in
    --manifest-only) MANIFEST_ONLY=true ;;
    --build)         BUILD_IMAGES=true ;;
    --help|-h)
      echo "Usage: $0 [options] [category/plugin]"
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

# ---- Validation constants ----

REQUIRED_FIELDS=("name" "description" "keywords" "category" "version" "pluginType" "computeType")
CODEBUILD_FIELDS=("primaryOutputDirectory" "dockerfile" "installCommands" "commands")
V2_FIELDS=("timeout" "failureBehavior" "secrets")
VALID_COMPUTE_TYPES=("SMALL" "MEDIUM" "LARGE")
VALID_PLUGIN_TYPES=("CodeBuildStep" "ManualApprovalStep")
VALID_FAILURE_BEHAVIORS=("fail" "warn" "ignore")
VALID_CATEGORIES=("language" "security" "quality" "monitoring" "artifact" "deploy" "infrastructure" "testing" "notification" "ai" "unknown")

# ---- Validation functions ----

validate_manifest() {
  local manifest="$1"
  local plugin_dir="$2"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"
  local fqn="${category}/${plugin_name}"
  local all_pass=true

  # Required fields
  for field in "${REQUIRED_FIELDS[@]}"; do
    if ! grep -q "^${field}:" "$manifest" 2>/dev/null; then
      log_fail "Missing required field: ${field}" "$fqn"
      all_pass=false
    fi
  done

  # CodeBuild-specific fields only required for CodeBuildStep plugins
  local plugin_type
  plugin_type=$(get_manifest_field pluginType "$manifest")
  if [ "$plugin_type" = "CodeBuildStep" ]; then
    for field in "${CODEBUILD_FIELDS[@]}"; do
      if ! grep -q "^${field}:" "$manifest" 2>/dev/null; then
        log_fail "Missing CodeBuild field: ${field}" "$fqn"
        all_pass=false
      fi
    done
  fi

  # V2 fields
  for field in "${V2_FIELDS[@]}"; do
    if ! grep -q "^${field}:" "$manifest" 2>/dev/null; then
      log_fail "Missing v2 field: ${field}" "$fqn"
      all_pass=false
    fi
  done

  # Name matches directory
  local manifest_name
  manifest_name=$(get_manifest_field name "$manifest")
  if [ "$manifest_name" != "$plugin_name" ]; then
    log_fail "Name mismatch: manifest='${manifest_name}' dir='${plugin_name}'" "$fqn"
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
  compute_type=$(get_manifest_field computeType "$manifest")
  if [[ ! " ${VALID_COMPUTE_TYPES[*]} " =~ " ${compute_type} " ]]; then
    log_fail "Invalid computeType: ${compute_type}" "$fqn"
    all_pass=false
  else
    log_pass "Valid computeType: ${compute_type}"
  fi

  # Valid semver
  local version
  version=$(get_manifest_field version "$manifest")
  if ! echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    log_fail "Invalid version format: ${version} (expected semver)" "$fqn"
    all_pass=false
  else
    log_pass "Valid version: ${version}"
  fi

  # Optional: failureBehavior
  if grep -q "^failureBehavior:" "$manifest" 2>/dev/null; then
    local fb
    fb=$(get_manifest_field failureBehavior "$manifest")
    if [[ ! " ${VALID_FAILURE_BEHAVIORS[*]} " =~ " ${fb} " ]]; then
      log_fail "Invalid failureBehavior: ${fb} (expected: fail|warn|ignore)" "$fqn"
      all_pass=false
    else
      log_pass "Valid failureBehavior: ${fb}"
    fi
  fi

  # Optional: timeout
  if grep -q "^timeout:" "$manifest" 2>/dev/null; then
    local timeout_val
    timeout_val=$(get_manifest_field timeout "$manifest")
    if ! echo "$timeout_val" | grep -qE '^[0-9]+$'; then
      log_fail "Invalid timeout: ${timeout_val} (expected integer minutes)" "$fqn"
      all_pass=false
    else
      log_pass "Valid timeout: ${timeout_val}m"
    fi
  fi

  # Valid category
  if grep -q "^category:" "$manifest" 2>/dev/null; then
    local cat_val
    cat_val=$(get_manifest_field category "$manifest")
    if [[ ! " ${VALID_CATEGORIES[*]} " =~ " ${cat_val} " ]]; then
      log_fail "Invalid category: ${cat_val} (expected: ${VALID_CATEGORIES[*]})" "$fqn"
      all_pass=false
    elif [ "$cat_val" != "$category" ]; then
      log_fail "Category mismatch: manifest='${cat_val}' directory='${category}'" "$fqn"
      all_pass=false
    else
      log_pass "Valid category: ${cat_val}"
    fi
  fi

  # Description not empty
  local desc
  desc=$(get_manifest_field description "$manifest")
  if [ -z "$desc" ]; then
    log_fail "Empty description" "$fqn"
    all_pass=false
  else
    log_pass "Has description"
  fi

  # Keywords not empty
  if grep -q "^keywords:" "$manifest" 2>/dev/null; then
    local keyword_count
    keyword_count=$(grep -A 20 "^keywords:" "$manifest" | grep "^  - " | wc -l | tr -d ' ')
    if [ "$keyword_count" -eq 0 ]; then
      log_fail "Empty keywords list" "$fqn"
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

validate_plugin_zip() {
  local plugin_dir="$1"
  local fqn="$(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"
  local zip_file="${plugin_dir}/plugin.zip"

  if [ ! -f "$zip_file" ]; then
    log_fail "Missing plugin.zip" "$fqn"
    return
  fi

  local contents
  contents=$(unzip -l "$zip_file" 2>/dev/null | grep -E "Dockerfile|manifest.yaml" | wc -l | tr -d ' ')
  if [ "$contents" -lt 2 ]; then
    log_fail "plugin.zip missing Dockerfile or manifest.yaml" "$fqn"
  else
    log_pass "plugin.zip contains Dockerfile + manifest.yaml"
  fi
}

test_plugin() {
  local plugin_dir="$1"
  local plugin_name="$(basename "$plugin_dir")"
  local category="$(basename "$(dirname "$plugin_dir")")"
  local manifest="${plugin_dir}/manifest.yaml"
  local dockerfile="${plugin_dir}/Dockerfile"

  echo ""
  log_info "Testing ${category}/${plugin_name}"

  if [ ! -f "$manifest" ]; then
    log_fail "Missing manifest.yaml" "${category}/${plugin_name}"
    return
  fi

  local plugin_type
  plugin_type=$(get_manifest_field pluginType "$manifest")

  # Only require Dockerfile for CodeBuildStep plugins
  if [ "$plugin_type" != "ManualApprovalStep" ] && [ ! -f "$dockerfile" ]; then
    log_fail "Missing Dockerfile" "${category}/${plugin_name}"
    return
  fi

  validate_manifest "$manifest" "$plugin_dir"

  if [ "$MANIFEST_ONLY" = false ] && [ "$plugin_type" != "ManualApprovalStep" ]; then
    validate_dockerfile "$dockerfile" "$plugin_dir"
    validate_plugin_zip "$plugin_dir"
  fi
}

# ---- Main ----

echo -e "${BLUE}Plugin Testing Framework${NC}"
echo "========================"
echo "  Plugins: ${PLUGINS_DIR}"
echo "  Mode:    $([ "$MANIFEST_ONLY" = true ] && echo "manifest-only" || echo "full")$([ "$BUILD_IMAGES" = true ] && echo " +docker-build" || echo "")"

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

# ---- Supported Versions Matrix (from plugin-versions.yaml) ----

VERSIONS_FILE="$DEPLOY_DIR/plugins/plugin-versions.yaml"

if [ -f "$VERSIONS_FILE" ]; then
  echo ""
  echo -e "${BLUE}Supported Versions Matrix${NC}"
  echo "========================"
  printf "  %-35s %-15s %-30s %-15s\n" "PLUGIN" "DEFAULT" "VERSIONS" "INSTALL"
  printf "  %-35s %-15s %-30s %-15s\n" "------" "-------" "--------" "-------"

  # Parse plugin-versions.yaml — lightweight state machine
  # Collects versions from both top-level and nested tools: blocks
  _current="" _plugin="" _type="" _default="" _versions="" _tool_versions=""
  _in_versions=false _in_tools=false _nested_tool=""

  _append_ver() {
    [ -z "$1" ] && return
    if [ -n "$_tool_versions" ]; then
      _tool_versions="${_tool_versions}, $1"
    else
      _tool_versions="$1"
    fi
  }

  print_entry() {
    [ -z "$_current" ] && return
    [ -z "$_plugin" ] && _plugin="$_current"
    [ -z "$_type" ] && _type="n/a"
    # Prefer top-level versions; fall back to aggregated nested tool versions
    local display_ver="${_versions:-${_tool_versions:--}}"
    printf "  %-35s %-15s %-30s %-15s\n" "$_plugin" "${_default:--}" "$display_ver" "$_type"
  }

  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue

    # Top-level key — new tool entry
    if [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_]*): ]]; then
      print_entry
      _current="${BASH_REMATCH[1]}" _plugin="" _type="" _default="" _versions="" _tool_versions=""
      _in_versions=false _in_tools=false _nested_tool=""
      continue
    fi

    # Enter nested tools: block
    if [[ "$line" =~ ^[[:space:]]+tools:[[:space:]]*$ ]]; then
      _in_tools=true; _in_versions=false; _nested_tool=""
      continue
    fi

    # Inside nested tools block — collect versions from sub-tools
    if $_in_tools; then
      # Exit tools block when we hit a 2-space indented key (not 4+)
      if [[ "$line" =~ ^[[:space:]]{2}[a-zA-Z] ]] && ! [[ "$line" =~ ^[[:space:]]{4} ]]; then
        _in_tools=false _in_versions=false
      else
        # Nested tool name (4-space indent)
        if [[ "$line" =~ ^[[:space:]]{4}([a-zA-Z_][a-zA-Z0-9_]*): ]]; then
          _nested_tool="${BASH_REMATCH[1]}"
          _in_versions=false
        # Nested default (6-space indent)
        elif [[ "$line" =~ ^[[:space:]]{6}default:[[:space:]]*\"?([^\"]+)\"? ]]; then
          # Use first nested tool's default as the entry default if not set
          [ -z "$_default" ] && _default="${BASH_REMATCH[1]}"
          _in_versions=false
        # Nested inline versions
        elif [[ "$line" =~ ^[[:space:]]{6}versions:[[:space:]]*\[(.+)\] ]]; then
          _raw=$(echo "${BASH_REMATCH[1]}" | sed 's/"//g')
          IFS=',' read -ra _parts <<< "$_raw"
          for _p in "${_parts[@]}"; do
            _p="${_p## }"; _p="${_p%% }"
            _append_ver "$_p"
          done
          _in_versions=false
        elif [[ "$line" =~ ^[[:space:]]{6}versions: ]]; then
          _in_versions=true
        elif $_in_versions && [[ "$line" =~ ^[[:space:]]+-[[:space:]]*\"?([^\"]+)\"? ]]; then
          _append_ver "${BASH_REMATCH[1]}"
        else
          _in_versions=false
        fi
        continue
      fi
    fi

    # Top-level properties (2-space indent)
    if [[ "$line" =~ ^[[:space:]]+plugin:[[:space:]]*(.+) ]]; then
      _plugin="${BASH_REMATCH[1]}"
      _in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+install_type:[[:space:]]*(.+) ]]; then
      _type="${BASH_REMATCH[1]}"
      _in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+default:[[:space:]]*\"?([^\"]+)\"? ]]; then
      _default="${BASH_REMATCH[1]}"
      _in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+versions:[[:space:]]*\[(.+)\] ]]; then
      _versions=$(echo "${BASH_REMATCH[1]}" | sed 's/"//g; s/,  */, /g')
      _in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+versions: ]]; then
      _in_versions=true; _versions=""
    elif $_in_versions && [[ "$line" =~ ^[[:space:]]+-[[:space:]]*\"?([^\"]+)\"? ]]; then
      [ -n "$_versions" ] && _versions="${_versions}, "
      _versions="${_versions}${BASH_REMATCH[1]}"
    else
      _in_versions=false
    fi
  done < "$VERSIONS_FILE"
  print_entry  # flush last entry
fi
