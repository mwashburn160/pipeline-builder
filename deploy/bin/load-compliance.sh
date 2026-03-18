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

require_auth

TOTAL=0
SUCCEEDED=0
FAIL_COUNT=0
SKIP_COUNT=0
START_TIME=$(date +%s)

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

  STATUS=$(curl -X POST "${PLATFORM_BASE_URL}/api/compliance/rules" \
    -k -s -o /dev/null -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d @"$RULE_FILE")

  case "$(classify_status "$STATUS")" in
    ok)
      echo -e "  ${GREEN}OK${NC}    $NAME"
      SUCCEEDED=$((SUCCEEDED + 1))
      ;;
    exists)
      echo -e "  ${YELLOW}SKIP${NC}  $NAME (already exists)"
      SKIP_COUNT=$((SKIP_COUNT + 1))
      ;;
    *)
      echo -e "  ${RED}FAIL${NC}  $NAME (HTTP $STATUS)"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      ;;
  esac
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

  STATUS=$(curl -X POST "${PLATFORM_BASE_URL}/api/compliance/policies" \
    -k -s -o /dev/null -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d @"$POLICY_FILE")

  case "$(classify_status "$STATUS")" in
    ok)
      echo -e "  ${GREEN}OK${NC}    $NAME"
      SUCCEEDED=$((SUCCEEDED + 1))
      ;;
    exists)
      echo -e "  ${YELLOW}SKIP${NC}  $NAME (already exists)"
      SKIP_COUNT=$((SKIP_COUNT + 1))
      ;;
    *)
      echo -e "  ${RED}FAIL${NC}  $NAME (HTTP $STATUS)"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      ;;
  esac
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

print_summary "$TOTAL" "$SUCCEEDED" "$FAIL_COUNT" "$SKIP_COUNT" "$DURATION"
