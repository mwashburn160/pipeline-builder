#!/usr/bin/env bash
set -euo pipefail

# Load sample compliance rules and policy templates into the platform.
# Reads from deploy/compliance/rules/*/ and deploy/compliance/policies/*/.
#
# Expects:
#   PLATFORM_BASE_URL  — platform URL (default https://localhost:8443)
#   PLATFORM_TOKEN     — JWT token (or will prompt for login)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

COMPLIANCE_DIR="$DEPLOY_DIR/compliance"
UPLOAD_RETRIES=${UPLOAD_RETRIES:-3}
UPLOAD_RETRY_DELAY=${UPLOAD_RETRY_DELAY:-10}

require_auth

TOTAL=0
SUCCEEDED=0
FAILED=0
SKIPPED=0
START_TIME=$(date +%s)

# ---------------------------------------------------------------------------
# post_with_retry — POST a JSON file with retry on 429/503/502/504
#   $1 url  $2 json_file  $3 name
# ---------------------------------------------------------------------------
post_with_retry() {
  curl_with_retry "$3" \
    -X POST "$1" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -H "x-internal-service: true" \
    -d @"$2"
  local _rc=$?
  case "$_rc" in
    0) SUCCEEDED=$((SUCCEEDED + 1)) ;;
    2) SKIPPED=$((SKIPPED + 1)) ;;
    *) FAILED=$((FAILED + 1)) ;;
  esac
}

# ---------------------------------------------------------------------------
# Load rules
# ---------------------------------------------------------------------------
RULES_DIR="$COMPLIANCE_DIR/rules"

echo "=== Loading compliance rules ==="
echo "  Source: $RULES_DIR"
echo ""

for RULE_DIR in "$RULES_DIR"/*/; do
  RULE_FILE="$RULE_DIR/rule.json"
  [ -f "$RULE_FILE" ] || continue

  TOTAL=$((TOTAL + 1))
  NAME=$(jq -r '.name' "$RULE_FILE")
  post_with_retry "${PLATFORM_BASE_URL}/api/compliance/rules" "$RULE_FILE" "$NAME"
done

# ---------------------------------------------------------------------------
# Load policy templates
# ---------------------------------------------------------------------------
POLICIES_DIR="$COMPLIANCE_DIR/policies"

echo ""
echo "=== Loading compliance policy templates ==="
echo "  Source: $POLICIES_DIR"
echo ""

for POLICY_DIR in "$POLICIES_DIR"/*/; do
  POLICY_FILE="$POLICY_DIR/policy.json"
  [ -f "$POLICY_FILE" ] || continue

  TOTAL=$((TOTAL + 1))
  NAME=$(jq -r '.name' "$POLICY_FILE")
  post_with_retry "${PLATFORM_BASE_URL}/api/compliance/policies" "$POLICY_FILE" "$NAME"
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"
