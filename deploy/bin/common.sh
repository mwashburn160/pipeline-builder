#!/bin/sh
# Shared functions for deploy/bin scripts.
# Source this file: . "$(dirname "$0")/common.sh"

# Common paths (caller may override SCRIPT_DIR before sourcing)
COMMON_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_DIR="${SCRIPT_DIR:-$COMMON_DIR}"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
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
log_info() { echo -e "${BLUE}==>${NC} $1"; }

# ---------------------------------------------------------------------------
# get_manifest_field — extract a top-level field from a manifest.yaml
#   $1 field name   $2 manifest file path
#   Echoes the value (trimmed), empty string if not found
# ---------------------------------------------------------------------------
get_manifest_field() {
  grep "^${1}:" "$2" 2>/dev/null | head -1 | sed "s/^${1}: *//"
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
  _max="${1:-30}"
  _interval="${2:-5}"
  echo "Waiting for platform to be ready at ${PLATFORM_BASE_URL}/health ..."
  _i=1
  while [ "$_i" -le "$_max" ]; do
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
  _curl_code=$(curl -fsSL -o /dev/null -w "%{http_code}" -L --head --max-time "${CHECK_TIMEOUT:-15}" "$1" 2>/dev/null) || _curl_code="000"
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
