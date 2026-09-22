#!/usr/bin/env bash
set -euo pipefail

# Load sample compliance rules and policy templates into the platform.
# Reads the nested set-based tree:
#   deploy/compliance/standard/{rules,policies}/*/          (set:standard)
#   deploy/compliance/advanced/<framework>/{rules,policies}/*/  (set:advanced)
#
# A name that already exists comes back as HTTP 409, which `curl_with_retry`
# classifies as "exists" (SKIP), so re-running over a seeded platform is
# idempotent.
#
# Usage:
#   ./load-compliance.sh                                       # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-compliance.sh        # custom platform URL
#   ./load-compliance.sh --dry-run                             # validate only, no upload

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

COMPLIANCE_DIR="$DEPLOY_DIR/compliance"
UPLOAD_RETRIES=${UPLOAD_RETRIES:-3}
UPLOAD_RETRY_DELAY=${UPLOAD_RETRY_DELAY:-10}
DRY_RUN=false

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run   Validate rule.json / policy.json files, but skip upload"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN         JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL      Platform API URL (default: https://localhost:8443)"
      echo "  UPLOAD_RETRIES         Max retries on 503/connection failure (default: 3)"
      echo "  UPLOAD_RETRY_DELAY     Seconds between retries (default: 10)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found in PATH" >&2; exit 1; }

# Set by require_auth, read by common.sh's curl_with_retry (which sends the
# bearer via --config so the token never lands in argv) — hence no direct
# reference in this file.
# shellcheck disable=SC2034
JWT_TOKEN=""
[ "$DRY_RUN" = false ] && require_auth

TOTAL=0
SUCCEEDED=0
FAILED=0
SKIPPED=0
START_TIME=$(date +%s)

# ---------------------------------------------------------------------------
# post_with_retry — POST a JSON file with retry on 429/503/502/504
#   $1 url  $2 json_file  $3 name
#
# No `x-org-id` header: the tenant comes from the loader's own token. nginx
# OVERWRITES x-org-id on every proxied request, and api-core's getIdentity
# ignores it outright for a service-account principal.
# ---------------------------------------------------------------------------
post_with_retry() {
  if [ "$DRY_RUN" = true ]; then
    echo "  OK   $3 (dry-run)"; SUCCEEDED=$((SUCCEEDED + 1)); return
  fi
  # `|| _rc=$?` is required: curl_with_retry returns 1 (fail) / 2 (exists), and
  # under `set -e` a bare call aborts the whole script mid-loop — so the very
  # first already-loaded rule (HTTP 409 → exists) would abort the entire
  # compliance load, making re-runs non-idempotent.
  local _rc=0
  curl_with_retry "$3" \
    -X POST "$1" \
    -H "Content-Type: application/json" \
    -d @"$2" || _rc=$?
  case "$_rc" in
    0) SUCCEEDED=$((SUCCEEDED + 1)) ;;
    2) SKIPPED=$((SKIPPED + 1)) ;;
    *) FAILED=$((FAILED + 1)) ;;
  esac
}

# nullglob so a missing set/framework tree expands to nothing (not a literal
# glob) — keeps the loops from POSTing a bogus path when a set is absent.
shopt -s nullglob

# ---------------------------------------------------------------------------
# Load rules — Standard set + every Advanced framework.
# ---------------------------------------------------------------------------
echo "=== Compliance Loader ==="
echo "  URL:     $PLATFORM_BASE_URL"
echo "  Source:  $COMPLIANCE_DIR"
echo "  Dry-run: $DRY_RUN"
echo ""
echo "=== Loading compliance rules ==="
echo "  Source: $COMPLIANCE_DIR/{standard,advanced/*}/rules/*/"
echo ""

for RULE_FILE in \
  "$COMPLIANCE_DIR"/standard/rules/*/rule.json \
  "$COMPLIANCE_DIR"/advanced/*/rules/*/rule.json; do
  [ -f "$RULE_FILE" ] || continue
  RULE_DIR="$(dirname "$RULE_FILE")"

  TOTAL=$((TOTAL + 1))
  # Guard jq: a single malformed rule.json under `set -e` would abort the whole
  # compliance load with no failed-count and no summary. Count it + continue.
  # jq -e: exit non-zero when .name is absent/null (plain -r yields the string
  # "null" with exit 0, so a rule missing its name would POST as name="null").
  if ! NAME=$(jq -er '.name' "$RULE_FILE" 2>/dev/null); then
    echo "  FAIL $(basename "$RULE_DIR") (invalid rule.json or missing .name)"; FAILED=$((FAILED + 1)); continue
  fi
  post_with_retry "${PLATFORM_BASE_URL}/api/compliance/rules" "$RULE_FILE" "$NAME"
done

# ---------------------------------------------------------------------------
# Load policy templates — Standard set + every Advanced framework.
# ---------------------------------------------------------------------------
echo ""
echo "=== Loading compliance policy templates ==="
echo "  Source: $COMPLIANCE_DIR/{standard,advanced/*}/policies/*/"
echo ""

for POLICY_FILE in \
  "$COMPLIANCE_DIR"/standard/policies/*/policy.json \
  "$COMPLIANCE_DIR"/advanced/*/policies/*/policy.json; do
  [ -f "$POLICY_FILE" ] || continue
  POLICY_DIR="$(dirname "$POLICY_FILE")"

  TOTAL=$((TOTAL + 1))
  if ! NAME=$(jq -er '.name' "$POLICY_FILE" 2>/dev/null); then
    echo "  FAIL $(basename "$POLICY_DIR") (invalid policy.json or missing .name)"; FAILED=$((FAILED + 1)); continue
  fi
  post_with_retry "${PLATFORM_BASE_URL}/api/compliance/policies" "$POLICY_FILE" "$NAME"
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="

# Loading nothing is not a successful load — with nullglob an absent tree
# expands away silently, so a missing/mis-synced deploy/compliance/ printed a
# 0/0/0 summary and exited 0, which init-platform.sh and CI read as clean.
# (Matches the same guard in load-plugins.sh / build-plugin-images.sh.)
if [ "$TOTAL" -eq 0 ]; then
  echo "ERROR: no compliance rules or policies found under $COMPLIANCE_DIR" >&2
  echo "  Expected $COMPLIANCE_DIR/{standard,advanced/*}/{rules,policies}/*/ — is the tree checked out?" >&2
  exit 1
fi

# Propagate partial-failure to the exit code (matches load-templates.sh) so a
# failed compliance load is not masked as green.
[ "$FAILED" -gt 0 ] && exit 1
exit 0
