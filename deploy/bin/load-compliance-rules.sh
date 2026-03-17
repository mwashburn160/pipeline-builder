#!/usr/bin/env bash
set -eu

# Load sample compliance rules into the platform.
# Reads rule.json files from deploy/rules/*/ subdirectories.
#
# Expects:
#   PLATFORM_BASE_URL  — platform URL (default https://localhost:8443)
#   PLATFORM_TOKEN     — JWT token (or will prompt for login)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

RULES_DIR="$DEPLOY_DIR/rules"
PASSED=0 FAILED=0 SKIPPED=0 ERRORS=()

require_auth

echo "=== Loading sample compliance rules ==="
echo "  Source: $RULES_DIR"
echo ""

TOTAL=0
SUCCEEDED=0
FAIL_COUNT=0
SKIP_COUNT=0
START_TIME=$(date +%s)

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

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

print_summary "$TOTAL" "$SUCCEEDED" "$FAIL_COUNT" "$SKIP_COUNT" "$DURATION"
