#!/usr/bin/env bash
set -euo pipefail

# Load all sample pipeline templates from deploy/samples/templates into the platform.
#
# Each template is POSTed individually to /api/pipeline-templates — there is no
# bulk template endpoint. A name that already exists in the org comes back as
# HTTP 409, which `curl_with_retry` classifies as "exists" (SKIP), so re-running
# the loader over an already-seeded platform is idempotent.
#
# Usage:
#   ./load-templates.sh                                        # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-templates.sh         # custom platform URL
#   ./load-templates.sh --dry-run                              # validate only, no upload

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

TEMPLATES_DIR="$DEPLOY_DIR/samples/templates"
UPLOAD_RETRIES=${UPLOAD_RETRIES:-3}
UPLOAD_RETRY_DELAY=${UPLOAD_RETRY_DELAY:-30}
UPLOAD_DELAY=${UPLOAD_DELAY:-3}
[[ "$UPLOAD_DELAY" =~ ^[0-9]+$ ]] || { echo "ERROR: UPLOAD_DELAY must be a non-negative integer (got: '$UPLOAD_DELAY')" >&2; exit 1; }
DRY_RUN=false
SUCCEEDED=0
FAILED=0
SKIPPED=0
TOTAL=0

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run   Validate template files, but skip upload"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN         JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL      Platform API URL (default: https://localhost:8443)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---- Helper functions ----

upload_template() {
  local template_dir="$1"
  local dir_name
  dir_name="$(basename "$template_dir")"

  # Force `public` so the seeded catalog is visible from every org (the samples
  # land in the reserved `system` org and are widened by the system-org read
  # path). Templates default to `private` on create, which would hide them.
  local body_file
  body_file=$(mktemp)
  # `trap ... RETURN` fires when this function returns, on every path below.
  trap 'rm -f "$body_file"' RETURN

  if ! jq '.visibility = "public"' "${template_dir}/template.json" > "$body_file" 2>/dev/null; then
    echo "    FAIL (invalid JSON)"; FAILED=$((FAILED + 1)); return
  fi

  # `|| _rc=$?`: curl_with_retry returns 1/2; a bare call under `set -e` would
  # abort before the dispatch below, losing the FAILED/SKIPPED accounting — and
  # the very first already-loaded template (409 → exists) would kill the run.
  local _rc=0
  curl_with_retry "$dir_name" \
    -X POST "${PLATFORM_BASE_URL}/api/pipeline-templates" \
    -H "Content-Type: application/json" \
    -H "x-org-id: system" \
    -d @"$body_file" || _rc=$?
  case "$_rc" in
    0) SUCCEEDED=$((SUCCEEDED + 1)) ;;
    2) SKIPPED=$((SKIPPED + 1)) ;;
    *) FAILED=$((FAILED + 1)) ;;
  esac
}

# ---- Main ----

echo "=== Pipeline Template Loader ==="
echo "  URL:     $PLATFORM_BASE_URL"
echo "  Source:  $TEMPLATES_DIR"
echo "  Dry-run: $DRY_RUN"
echo ""

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found in PATH" >&2; exit 1; }

# Set by require_auth, read by common.sh's curl_with_retry (which sends the
# bearer via --config so the token never lands in argv) — hence no direct
# reference in this file.
# shellcheck disable=SC2034
JWT_TOKEN=""
[ "$DRY_RUN" = false ] && require_auth

if [ ! -d "$TEMPLATES_DIR" ]; then
  echo "No templates directory found at $TEMPLATES_DIR" >&2
  exit 1
fi

# Pre-count eligible templates
for template_dir in "$TEMPLATES_DIR"/*/; do
  [ -d "$template_dir" ] || continue
  [ -f "${template_dir}/template.json" ] || continue
  TOTAL=$((TOTAL + 1))
done

START_TIME=$(date +%s)
echo ""
echo "=== Processing $TOTAL template(s) ==="

PROCESSED=0
for template_dir in "$TEMPLATES_DIR"/*/; do
  [ -d "$template_dir" ] || continue
  [ -f "${template_dir}/template.json" ] || continue
  PROCESSED=$((PROCESSED + 1))
  echo "  [$PROCESSED/$TOTAL] $(basename "$template_dir")"

  if [ "$DRY_RUN" = true ]; then
    if jq -e '.name and .props' "${template_dir}/template.json" >/dev/null 2>&1; then
      echo "    OK (dry-run)"; SUCCEEDED=$((SUCCEEDED + 1))
    else
      echo "    FAIL (invalid template.json — needs .name and .props)"; FAILED=$((FAILED + 1))
    fi
    continue
  fi

  upload_template "$template_dir"
  remaining=$((TOTAL - PROCESSED))
  [ "$UPLOAD_DELAY" -gt 0 ] && [ "$remaining" -gt 0 ] && sleep "$UPLOAD_DELAY"
done

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

echo ""
echo "=== Done ==="

# Propagate failure to exit code so CI/init catches partial-failure runs.
[ "$FAILED" -gt 0 ] && exit 1
exit 0
