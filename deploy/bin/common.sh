#!/usr/bin/env bash
# Shared functions for deploy/bin scripts.
# Source this file: . "$(dirname "$0")/common.sh"
# Note: Requires bash (uses arrays, ERRORS+=(), ${#ERRORS[@]}).

# Common paths (caller may override SCRIPT_DIR before sourcing)
COMMON_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)"
SCRIPT_DIR="${SCRIPT_DIR:-$COMMON_DIR}"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
PLATFORM_BASE_URL="${PLATFORM_BASE_URL:-https://localhost:8443}"

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ---- Logging helpers ----
# Callers must initialize: PASSED=0 FAILED=0 SKIPPED=0 ERRORS=()

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; FAILED=$((FAILED + 1)); ERRORS+=("$2: $1"); }
log_skip() { echo -e "  ${YELLOW}SKIP${NC} $1"; SKIPPED=$((SKIPPED + 1)); }
log_warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }
log_info() { echo -e "${BLUE}==>${NC} $1"; }

# ---------------------------------------------------------------------------
# get_spec_field — extract a top-level field from a YAML file (e.g. plugin-spec.yaml)
#   $1 field name   $2 YAML file path
#   Echoes the value (trimmed), empty string if not found
# ---------------------------------------------------------------------------
get_spec_field() {
  grep "^${1}:" "$2" 2>/dev/null | head -1 | sed "s/^${1}: *//"
}

# ---------------------------------------------------------------------------
# sed_inplace — portable in-place sed (macOS uses -i '', Linux uses -i)
#   $1 sed expression   $2 file path
# ---------------------------------------------------------------------------
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$1" "$2"
  else
    sed -i '' "$1" "$2"
  fi
}

# ---------------------------------------------------------------------------
# sha256_hash — portable SHA-256 (works on Linux and macOS)
#   Reads stdin, outputs 64-char hex digest
# ---------------------------------------------------------------------------
sha256_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# ---------------------------------------------------------------------------
# require_yq — ensure `yq` (mikefarah's Go YAML parser) is on PATH.
#
# Replaced ~150 lines of brittle awk YAML state-machine code in
# build-plugin-images.sh and generate-plugins.sh — those parsers broke on
# multi-line values, comments after value, single-quoted strings with
# embedded commas, etc. Call this once at the top of any script that uses
# the `yq_*` helpers below.
# ---------------------------------------------------------------------------
require_yq() {
  if ! command -v yq >/dev/null 2>&1; then
    echo "ERROR: yq is required but not installed." >&2
    echo "  macOS:  brew install yq" >&2
    echo "  Linux:  https://github.com/mikefarah/yq#install" >&2
    exit 1
  fi
}

# yq_buildargs — emit `--build-arg KEY=VALUE` flags for plugin-spec.yaml
# Outputs nothing if `buildArgs` is absent. Quoting is yq's responsibility.
yq_buildargs() {
  local _spec="$1"
  yq eval '
    .buildArgs // {}
    | to_entries
    | map("--build-arg " + .key + "=" + (.value | tostring))
    | .[]
  ' "$_spec"
}

# ---------------------------------------------------------------------------
# compute_image_tag — deterministic image tag from plugin directory contents
#
# Hashes the SHA256 of every file in the plugin directory (except the build
# outputs `image.tar` and `plugin.zip`), plus the plugin-spec.yaml buildArgs.
# Files are listed in sorted order so the hash is stable across runs.
#
# Why hash the whole directory: previously this hashed only the Dockerfile +
# buildArgs, which silently shipped stale `image.tar`s when COPY'd files
# (entrypoint scripts, configs, sibling sources) changed. Anything visible
# to the build context now bumps the tag.
#
#   $1 plugin directory
#   Outputs: p-{name}-{sha256-first-12}
# ---------------------------------------------------------------------------
compute_image_tag() {
  local _plugin_dir="$1"
  local _name
  _name=$(get_spec_field name "$_plugin_dir/plugin-spec.yaml")
  local _name_clean
  _name_clean=$(echo "$_name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')

  # Hash every file in the plugin directory in sorted order, excluding build
  # outputs that aren't part of the source. We hash filename+content so a
  # rename also invalidates the tag.
  local _content_hash
  _content_hash=$(
    find "$_plugin_dir" -type f \
      -not -name 'image.tar' \
      -not -name 'plugin.zip' \
      -not -name '.DS_Store' \
      | LC_ALL=C sort \
      | while read -r _f; do
          printf '%s\n' "${_f#"$_plugin_dir"/}"
          cat "$_f"
        done \
      | sha256_hash
  )

  # buildArgs hashed via yq for the same reason `parse_build_arg_flags`
  # delegates to it: awk-based YAML parsing was fragile across quoting.
  local _build_args=""
  if command -v yq >/dev/null 2>&1; then
    _build_args=$(yq eval '
      .buildArgs // {}
      | to_entries
      | map(.key + "=" + (.value | tostring))
      | sort
      | .[]
    ' "$_plugin_dir/plugin-spec.yaml" 2>/dev/null || true)
  fi

  local _hash
  _hash=$(printf '%s\n%s' "$_content_hash" "$_build_args" | sha256_hash)
  echo "p-${_name_clean}-${_hash:0:12}"
}

# ---------------------------------------------------------------------------
# print_results — display test/verify results summary
#   Uses: PASSED, FAILED, SKIPPED
# ---------------------------------------------------------------------------
print_results() {
  echo ""
  echo "========================"
  echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}"
}

# ---------------------------------------------------------------------------
# print_errors_and_exit — print error list and exit 1 if any, else print success
#   $1 success message (e.g. "All tests passed!")
#   Uses: ERRORS[]
# ---------------------------------------------------------------------------
print_errors_and_exit() {
  if [ ${#ERRORS[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}Failures:${NC}"
    for err in "${ERRORS[@]}"; do
      echo "  - $err"
    done
    exit 1
  fi
  echo -e "\n${GREEN}${1}${NC}"
}

# ---------------------------------------------------------------------------
# wait_for_health — poll $PLATFORM_BASE_URL/health until 200
#   $1  max retries  (default 30)
#   $2  interval sec (default 5)
# ---------------------------------------------------------------------------
wait_for_health() {
  local _max="${1:-30}"
  local _interval="${2:-5}"
  echo "Waiting for platform to be ready at ${PLATFORM_BASE_URL}/health ..."
  local _i=1
  while [ "$_i" -le "$_max" ]; do
    local _status
    _status=$(curl -s -k -o /dev/null -w "%{http_code}" "${PLATFORM_BASE_URL}/health" 2>/dev/null || true)
    if [ "$_status" = "200" ]; then
      echo "Platform is healthy."
      return 0
    fi
    if [ "$_i" = "$_max" ]; then
      echo "Platform failed to become healthy after $((_max * _interval))s — aborting." >&2
      return 1
    fi
    sleep "$_interval"
    _i=$((_i + 1))
  done
}

# ---------------------------------------------------------------------------
# prompt_credentials — prompt for identifier/password if not already set
#   Sets PLATFORM_IDENTIFIER and PLATFORM_PASSWORD
# ---------------------------------------------------------------------------
prompt_credentials() {
  _default_id="admin@internal"
  _default_pw="SecurePassword123!"

  if [ -z "${PLATFORM_IDENTIFIER:-}" ]; then
    printf "Identifier [%s]: " "$_default_id"
    read -r PLATFORM_IDENTIFIER
    PLATFORM_IDENTIFIER="${PLATFORM_IDENTIFIER:-$_default_id}"
  fi

  if [ -z "${PLATFORM_PASSWORD:-}" ]; then
    printf "Password [%s]: " "$_default_pw"
    read -r PLATFORM_PASSWORD
    PLATFORM_PASSWORD="${PLATFORM_PASSWORD:-$_default_pw}"
  fi
}

# ---------------------------------------------------------------------------
# login — authenticate against $PLATFORM_BASE_URL and set JWT_TOKEN
#   Requires PLATFORM_IDENTIFIER and PLATFORM_PASSWORD to be set.
# ---------------------------------------------------------------------------
login() {
  local _resp
  _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/login" \
    -k -s \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg id "$PLATFORM_IDENTIFIER" --arg pw "$PLATFORM_PASSWORD" \
      '{identifier: $id, password: $pw}')" 2>&1) || true

  JWT_TOKEN=$(printf '%s' "$_resp" | jq -r '.data.accessToken' 2>/dev/null) || true

  if [ -z "${JWT_TOKEN}" ] || [ "${JWT_TOKEN}" = "null" ]; then
    echo "Login failed — could not obtain JWT token" >&2
    echo "Response: ${_resp}" >&2
    return 1
  fi
  echo "  Logged in successfully."
}

# ---------------------------------------------------------------------------
# require_auth — ensure JWT_TOKEN is set (via PLATFORM_TOKEN or login)
#   Sets JWT_TOKEN for the calling script.
# ---------------------------------------------------------------------------
require_auth() {
  if [ -n "${PLATFORM_TOKEN:-}" ]; then
    JWT_TOKEN="$PLATFORM_TOKEN"
    echo "=== Using provided PLATFORM_TOKEN ==="
    echo ""
    return 0
  fi

  prompt_credentials
  echo "=== Authenticating ==="
  login
  echo ""
}

# ---------------------------------------------------------------------------
# check_url — verify a URL is reachable (HTTP 200/301/302)
#   $1 url  $2 label
#   Uses/increments: PASSED, FAILED, ERRORS[], CHECK_TIMEOUT (default 15)
# ---------------------------------------------------------------------------
check_url() {
  _curl_code=$(curl -sSL -o /dev/null -w "%{http_code}" --head --max-time "${CHECK_TIMEOUT:-15}" "$1" 2>/dev/null) || _curl_code="000"
  if [ "$_curl_code" = "200" ] || [ "$_curl_code" = "302" ] || [ "$_curl_code" = "301" ]; then
    echo -e "    ${GREEN}OK${NC}  $2"
    PASSED=$((PASSED + 1))
  else
    echo -e "    ${RED}FAIL${NC} HTTP $_curl_code — $2"
    FAILED=$((FAILED + 1))
    ERRORS+=("$2 (HTTP $_curl_code)")
  fi
}

# ---------------------------------------------------------------------------
# check_docker_image — verify a Docker image exists
#   $1 image  $2 label
#   Uses/increments: PASSED, FAILED, ERRORS[], CHECK_TIMEOUT (default 15)
# ---------------------------------------------------------------------------
check_docker_image() {
  if docker manifest inspect "$1" > /dev/null 2>&1; then
    echo -e "    ${GREEN}OK${NC}  $2"
    PASSED=$((PASSED + 1))
    return
  fi
  # Fallback: Docker Hub Tags API (avoids unauthenticated pull rate limits)
  _img_repo="${1%%:*}"
  _img_tag="${1#*:}"
  _api_result=$(curl -s --max-time "${CHECK_TIMEOUT:-15}" "https://hub.docker.com/v2/repositories/${_img_repo}/tags/${_img_tag}" 2>/dev/null)
  if echo "$_api_result" | grep -q '"name"'; then
    echo -e "    ${GREEN}OK${NC}  $2 (via hub API)"
    PASSED=$((PASSED + 1))
  else
    echo -e "    ${RED}FAIL${NC} image not found — $2"
    FAILED=$((FAILED + 1))
    ERRORS+=("$2 (image not found)")
  fi
}

# ---------------------------------------------------------------------------
# select_categories — interactive numbered category picker
#   $1 plugins directory
#   Sets: SELECTED_CATEGORIES (comma-separated, empty if "all" chosen)
#   Returns 0 if categories selected, 1 if user cancelled
# ---------------------------------------------------------------------------
select_categories() {
  local _plugins_dir="$1"
  local _available
  # cd into plugins dir first so `find` doesn't try (and fail) to restore
  # cwd when called as sudo -u from a directory the new user can't read.
  # `_base` IS shown — it's infrastructure but operators want visibility
  # into what's there (and may want to build it explicitly).
  _available=$(cd "$_plugins_dir" && find -L . -mindepth 1 -maxdepth 1 -type d | sort | sed 's|^\./||')

  echo ""
  # Show running user + the plugins-dir owner. If they differ, find/sed/etc.
  # may hit permission errors — the most common cause of the "Failed to
  # restore initial working directory" error operators see when running
  # this script via `sudo -u minikube ...`.
  local _running_user _dir_owner _dir_perms
  _running_user=$(id -un 2>/dev/null || echo "?")
  _dir_owner=$(stat -c '%U:%G' "$_plugins_dir" 2>/dev/null || stat -f '%Su:%Sg' "$_plugins_dir" 2>/dev/null || echo "?")
  _dir_perms=$(stat -c '%a' "$_plugins_dir" 2>/dev/null || stat -f '%Lp' "$_plugins_dir" 2>/dev/null || echo "?")
  echo "  Running as: ${_running_user}    Plugins dir: ${_dir_owner} (${_dir_perms})"
  echo ""
  echo "  Available categories:"
  local _i=0 _cat _count _cat_owner
  for _cat in $_available; do
    _i=$((_i + 1))
    _count=$(cd "$_plugins_dir/$_cat" 2>/dev/null && find -L . -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    _cat_owner=$(stat -c '%U:%G' "$_plugins_dir/$_cat" 2>/dev/null || stat -f '%Su:%Sg' "$_plugins_dir/$_cat" 2>/dev/null || echo "?")
    printf "    %2d) %-20s %3d plugins   [%s]\n" "${_i}" "${_cat}" "${_count}" "${_cat_owner}"
  done

  echo ""
  local _answer
  printf "  Load all categories? [Y/n]: "
  read -r _answer

  if [ "$_answer" = "n" ] || [ "$_answer" = "N" ]; then
    local _selected_nums _picked="" _num _idx
    printf "  Enter category numbers (comma-separated, e.g. 1,3,4): "
    read -r _selected_nums
    for _num in $(echo "$_selected_nums" | tr ',' ' '); do
      _idx=0
      for _cat in $_available; do
        _idx=$((_idx + 1))
        [ "$_idx" = "$_num" ] && _picked="${_picked}${_cat},"
      done
    done
    SELECTED_CATEGORIES="${_picked%,}"
    [ -n "$SELECTED_CATEGORIES" ] || { echo "  No valid categories selected."; return 1; }
    echo "  Selected: $SELECTED_CATEGORIES"
  else
    SELECTED_CATEGORIES=$(echo "$_available" | tr ' ' ',' | tr '\n' ',' | sed 's/,$//')
  fi
}

# ---------------------------------------------------------------------------
# classify_status — map an HTTP status code to a result keyword
#   $1  HTTP status code
#   Echoes: "ok", "exists", or "fail"
# ---------------------------------------------------------------------------
classify_status() {
  case "$1" in
    200|201|202) echo "ok" ;;
    409)         echo "exists" ;;
    *)           echo "fail" ;;
  esac
}

# ---------------------------------------------------------------------------
# is_retryable_status — check if an HTTP status code is worth retrying
#   $1  HTTP status code
#   Returns 0 (retryable) or 1 (not retryable)
# ---------------------------------------------------------------------------
is_retryable_status() {
  case "$1" in
    429|502|503|504|000) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# curl_with_retry — POST with retry loop on retryable HTTP status codes
#   $1  label (display name for logging)
#   $2+ curl arguments (URL, headers, data, etc.)
#   Env: UPLOAD_RETRIES (default 3), UPLOAD_RETRY_DELAY (default 30)
#   Exits: 0=ok, 1=fail, 2=exists (skip)
# ---------------------------------------------------------------------------
curl_with_retry() {
  local _label="$1"; shift
  local _retries="${UPLOAD_RETRIES:-3}"
  local _delay="${UPLOAD_RETRY_DELAY:-30}"
  local _attempt=1 _status _result

  while [ "$_attempt" -le "$_retries" ]; do
    _status=$(curl -s -o /dev/null -w "%{http_code}" --insecure "$@" 2>/dev/null || echo "000")
    _result="$(classify_status "$_status")"

    if [ "$_result" = "fail" ] && is_retryable_status "$_status" && [ "$_attempt" -lt "$_retries" ]; then
      echo -e "  ${YELLOW}RETRY${NC} $_label (HTTP $_status) attempt ${_attempt}/${_retries}"
      sleep "$_delay"
      _attempt=$((_attempt + 1))
      continue
    fi

    case "$_result" in
      ok)     echo -e "  ${GREEN}OK${NC}   $_label (HTTP $_status)"; return 0 ;;
      exists) echo -e "  ${YELLOW}SKIP${NC} $_label (exists)";       return 2 ;;
      *)      echo -e "  ${RED}FAIL${NC} $_label (HTTP $_status)";   return 1 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# print_summary — display the standard upload/create summary
#   $1 total  $2 succeeded  $3 failed  $4 skipped  $5 duration_seconds
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  echo "=== Summary ==="
  echo "  Total:     $1"
  echo "  Succeeded: $2"
  echo "  Failed:    $3"
  echo "  Skipped:   $4"
  echo "  Duration:  ${5}s"

  if [ "$3" -gt 0 ]; then
    echo ""
    echo "WARNING: $3 item(s) failed"
  fi
}
