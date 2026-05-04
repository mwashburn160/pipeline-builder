#!/usr/bin/env bash
set -euo pipefail

# Generate and verify plugin tool versions from plugin-versions.yaml.
#
# This script is the single source of truth for all tool versions.
# It validates that every declared version is actually downloadable,
# so stale/phantom versions are caught before they break Docker builds.
#
# Usage:
#   ./generate-plugins.sh              # verify all versions
#   ./generate-plugins.sh --verify     # verify only (default)
#   ./generate-plugins.sh --dump       # dump parsed version matrix
#   ./generate-plugins.sh --check-one trivy  # check a single tool

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
require_yq

VERSIONS_FILE="$DEPLOY_DIR/plugins/plugin-versions.yaml"
MODE="${1:---verify}"
CHECK_ONE="${2:-}"
CHECK_TIMEOUT=15
PASSED=0
FAILED=0
SKIPPED=0
ERRORS=()

# ── YAML traversal via yq ──
#
# Replaced ~90 lines of awk/regex YAML state machine. Iterates each
# top-level tool entry, pulls structured fields, then dispatches to
# verify_tool. Skips tools whose `versions` list is empty (e.g.
# install_type: apt/none/sdkman entries that don't pin a version).
verify_versions() {
  local tools
  tools=$(yq eval 'keys | .[]' "$VERSIONS_FILE")

  while IFS= read -r tool; do
    [ -z "$tool" ] && continue

    # Pull each field once; `// ""` keeps yq from emitting the literal
    # string `null` for absent keys.
    local install_type image tag_prefix url_template url package
    install_type=$(yq eval ".${tool}.install_type // \"\"" "$VERSIONS_FILE")
    image=$(yq eval ".${tool}.image // \"\"" "$VERSIONS_FILE")
    tag_prefix=$(yq eval ".${tool}.tag_prefix // \"\"" "$VERSIONS_FILE")
    url_template=$(yq eval ".${tool}.url_template // \"\"" "$VERSIONS_FILE")
    url=$(yq eval ".${tool}.url // \"\"" "$VERSIONS_FILE")
    package=$(yq eval ".${tool}.package // \"\"" "$VERSIONS_FILE")

    local versions=()
    while IFS= read -r v; do
      [ -n "$v" ] && versions+=("$v")
    done < <(yq eval ".${tool}.versions[]? // empty" "$VERSIONS_FILE")

    [ ${#versions[@]} -eq 0 ] && continue
    verify_tool "$tool" "$install_type" "$image" "$tag_prefix" "$url_template" "$url" "$package" "${versions[@]}"
  done <<< "$tools"
}

verify_tool() {
  local tool="$1" install_type="$2" image="$3" tag_prefix="$4" url_template="$5" url="$6" package="$7"
  shift 7
  local versions=("$@")

  # If checking one tool, skip others
  if [ -n "$CHECK_ONE" ] && [ "$tool" != "$CHECK_ONE" ]; then
    return
  fi

  echo -e "  ${BLUE}${tool}${NC} (${install_type})"

  case "$install_type" in
    copy_from)
      for v in "${versions[@]}"; do
        local full_image="${image}:${tag_prefix}${v}"
        check_docker_image "$full_image" "$full_image"
      done
      ;;
    curl_tar|curl_bin|curl_zip)
      for v in "${versions[@]}"; do
        local resolved_url="${url_template//\{version\}/$v}"
        check_url "$resolved_url" "$tool $v"
      done
      ;;
    script)
      if [ -n "$url" ]; then
        check_url "$url" "$tool (install script)"
      else
        log_skip "no URL to verify"
      fi
      ;;
    docker_multistage)
      for v in "${versions[@]}"; do
        local full_image="${image//\{version\}/$v}"
        check_docker_image "$full_image" "$tool $v"
      done
      ;;
    npm|pip)
      # Package managers handle their own resolution
      echo -e "    ${GREEN}OK${NC}  $package (via $install_type)"
      PASSED=$((PASSED + 1))
      ;;
    none)
      log_skip "install_type=none (versions managed by nested tools)"
      ;;
    *)
      log_skip "unknown install_type: $install_type"
      ;;
  esac
}

# ── Main ──

if [ ! -f "$VERSIONS_FILE" ]; then
  echo -e "${RED}Missing: $VERSIONS_FILE${NC}"
  exit 1
fi

echo -e "${BLUE}Plugin Version Matrix — Verification${NC}"
echo "======================================="
echo "  Source: $VERSIONS_FILE"
echo ""

case "$MODE" in
  --verify|"")
    verify_versions
    print_results
    print_errors_and_exit "All versions verified!"
    ;;
  --check-one)
    CHECK_ONE="$2"
    verify_versions
    echo ""
    if [ ${#ERRORS[@]} -gt 0 ]; then
      exit 1
    fi
    ;;
  --dump)
    echo "Parsed version matrix:"
    # Simple dump — show tool names and versions
    current=""
    while IFS= read -r line; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^[[:space:]]*$ ]] && continue
      if [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_]*): ]]; then
        current="${BASH_REMATCH[1]}"
      elif [[ "$line" =~ ^[[:space:]]+versions:[[:space:]]*\[(.+)\] ]]; then
        echo "  $current: ${BASH_REMATCH[1]}"
      fi
    done < "$VERSIONS_FILE"
    ;;
  *)
    echo "Usage: $0 [--verify|--dump|--check-one <tool>]"
    exit 1
    ;;
esac
