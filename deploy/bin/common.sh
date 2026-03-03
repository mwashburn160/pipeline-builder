#!/bin/sh
# Shared functions for deploy/bin scripts.
# Source this file: . "$(dirname "$0")/common.sh"

# Common paths (caller may override SCRIPT_DIR before sourcing)
COMMON_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_DIR="${SCRIPT_DIR:-$COMMON_DIR}"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLATFORM_BASE_URL="${PLATFORM_BASE_URL:-https://localhost:8443}"

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
    -d "$(printf '{"identifier":"%s","password":"%s"}' "$PLATFORM_IDENTIFIER" "$PLATFORM_PASSWORD")" 2>&1) || true

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
