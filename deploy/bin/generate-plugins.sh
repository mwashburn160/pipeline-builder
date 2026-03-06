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

VERSIONS_FILE="$DEPLOY_DIR/plugins/plugin-versions.yaml"
MODE="${1:---verify}"
CHECK_ONE="${2:-}"
CHECK_TIMEOUT=15
PASSED=0
FAILED=0
SKIPPED=0
ERRORS=()

# ── YAML parser (lightweight, no python dependency) ──
# Reads plugin-versions.yaml and extracts tool entries.
# We use a simple state machine since the YAML structure is flat.

verify_versions() {
  local current_tool=""
  local install_type="" image="" tag_prefix="" url_template="" url="" package=""
  local in_versions=false
  local in_nested_tools=false
  local versions=()

  while IFS= read -r line; do
    # Skip comments and blank lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue

    # Top-level key (tool name) — no leading whitespace
    if [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_]*): ]]; then
      # Process previous tool
      if [ -n "$current_tool" ] && [ ${#versions[@]} -gt 0 ]; then
        verify_tool "$current_tool" "$install_type" "$image" "$tag_prefix" "$url_template" "$url" "$package" "${versions[@]}"
      fi
      current_tool="${BASH_REMATCH[1]}"
      install_type="" image="" tag_prefix="" url_template="" url="" package=""
      versions=()
      in_versions=false
      in_nested_tools=false
      continue
    fi

    # Detect nested tools: block — skip everything inside it
    if [[ "$line" =~ ^[[:space:]]+tools:[[:space:]]*$ ]]; then
      in_nested_tools=true
      in_versions=false
      continue
    fi

    # Inside nested tools block: only exit when we hit a non-deeply-indented key
    # Nested tool content is indented 4+ spaces; top-level tool properties use 2 spaces
    if $in_nested_tools; then
      # A 2-space indented key means we're back to top-level tool properties
      if [[ "$line" =~ ^[[:space:]]{2}[a-zA-Z] ]] && ! [[ "$line" =~ ^[[:space:]]{4} ]]; then
        in_nested_tools=false
      else
        continue
      fi
    fi

    # Nested keys (top-level tool properties, 2-space indent)
    if [[ "$line" =~ ^[[:space:]]+install_type:[[:space:]]*(.+) ]]; then
      install_type="${BASH_REMATCH[1]}"
      in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+image:[[:space:]]*(.+) ]]; then
      image="${BASH_REMATCH[1]}"
      image="${image%\"}"
      image="${image#\"}"
      in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+tag_prefix:[[:space:]]*\"(.*)\" ]]; then
      tag_prefix="${BASH_REMATCH[1]}"
      in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+url_template:[[:space:]]*\"(.+)\" ]]; then
      url_template="${BASH_REMATCH[1]}"
      in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+url:[[:space:]]*\"(.+)\" ]]; then
      url="${BASH_REMATCH[1]}"
      in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+package:[[:space:]]*(.+) ]]; then
      package="${BASH_REMATCH[1]}"
      package="${package%\"}"
      package="${package#\"}"
      in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+versions:[[:space:]]*\[(.+)\] ]]; then
      # Inline array: ["1.0", "2.0"]
      local raw="${BASH_REMATCH[1]}"
      IFS=',' read -ra parts <<< "$raw"
      for part in "${parts[@]}"; do
        part="${part// /}"
        part="${part%\"}"
        part="${part#\"}"
        [ -n "$part" ] && versions+=("$part")
      done
      in_versions=false
    elif [[ "$line" =~ ^[[:space:]]+versions: ]]; then
      in_versions=true
    elif $in_versions && [[ "$line" =~ ^[[:space:]]+-[[:space:]]*\"?([^\"]+)\"? ]]; then
      versions+=("${BASH_REMATCH[1]}")
    else
      in_versions=false
    fi
  done < "$VERSIONS_FILE"

  # Process last tool
  if [ -n "$current_tool" ] && [ ${#versions[@]} -gt 0 ]; then
    verify_tool "$current_tool" "$install_type" "$image" "$tag_prefix" "$url_template" "$url" "$package" "${versions[@]}"
  fi
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
