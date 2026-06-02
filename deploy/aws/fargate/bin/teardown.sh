#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Fargate Teardown Script
# =============================================================================
# Deletes all CloudFormation stacks in reverse dependency order.
#
# Usage: bash bin/teardown.sh [--stack-prefix pb] [--region us-east-1] [--yes]
#   --yes / -y   skip the interactive confirmation (for CI/automation)
# =============================================================================
set -euo pipefail

STACK_PREFIX="pb"
REGION="${AWS_REGION:-us-east-1}"
ASSUME_YES=0
# Match the names init-secrets.sh / deploy.sh actually use (NOT ${STACK_PREFIX}/*).
APP_SECRETS_NAME="${APP_SECRETS_NAME:-pipeline-builder/app-secrets}"
GHCR_AUTH_SECRET_NAME="${GHCR_AUTH_SECRET_NAME:-pipeline-builder/ghcr-auth}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --stack-prefix) STACK_PREFIX="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "========================================"
echo "Pipeline Builder - Fargate Teardown"
echo "========================================"
echo "  Stack Prefix: $STACK_PREFIX"
echo "  Region:       $REGION"
echo ""

# Destructive and irreversible. Require the operator to retype the prefix so a
# wrong --stack-prefix can't wipe the wrong environment by reflex. --yes skips.
if [ "$ASSUME_YES" -ne 1 ]; then
  echo "This DELETES every '${STACK_PREFIX}-*' stack in ${REGION}"
  echo "(databases, EFS data, container registry — IRREVERSIBLE)."
  printf "Type the stack prefix '%s' to confirm: " "$STACK_PREFIX"
  read -r _confirm
  if [ "$_confirm" != "$STACK_PREFIX" ]; then
    echo "Aborted (got '${_confirm}')."
    exit 1
  fi
fi

# Delete a stack and wait; on failure, surface the failed resources instead of
# dying opaquely under `set -e`.
delete_stack() {
  local name="$1"
  if ! aws cloudformation describe-stacks --stack-name "$name" --region "$REGION" >/dev/null 2>&1; then
    echo "=== Skipping: $name (not found) ==="
    return 0
  fi
  echo "=== Deleting: $name ==="
  aws cloudformation delete-stack --stack-name "$name" --region "$REGION"
  if ! aws cloudformation wait stack-delete-complete --stack-name "$name" --region "$REGION"; then
    echo "  WARNING: $name did not delete cleanly. Failed resources:" >&2
    aws cloudformation describe-stack-events --stack-name "$name" --region "$REGION" \
      --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \
      --output text 2>/dev/null | head -20 >&2 || true
    return 1
  fi
  echo "  Deleted: $name"
}

# App stacks, reverse dependency order.
for stack in admin observability services databases cluster; do
  delete_stack "${STACK_PREFIX}-${stack}"
done

# internal-prereqs (internal mode only) attaches a Route53 private zone + VPC
# interface endpoints to foundation's VPC, so it MUST go before foundation or
# the VPC delete is blocked. No-op when it was never created (public mode).
delete_stack "${STACK_PREFIX}-internal-prereqs"

# Empty the S3 config bucket before deleting foundation. The bucket has
# versioning enabled, so `s3 rm --recursive` (current versions only) leaves
# noncurrent versions + delete markers and the bucket delete fails — purge
# every version via s3api.
FOUNDATION_NAME="${STACK_PREFIX}-foundation"
if aws cloudformation describe-stacks --stack-name "$FOUNDATION_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo ""
  echo "=== Emptying S3 config bucket ==="
  CONFIG_BUCKET=$(aws cloudformation describe-stacks \
    --stack-name "$FOUNDATION_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='ConfigBucketName'].OutputValue" \
    --output text --region "$REGION" 2>/dev/null || true)

  if [ -n "$CONFIG_BUCKET" ] && [ "$CONFIG_BUCKET" != "None" ]; then
    aws s3 rm "s3://${CONFIG_BUCKET}" --recursive --region "$REGION" 2>/dev/null || true
    if command -v jq >/dev/null 2>&1; then
      # Drain all object versions + delete markers in batches.
      while :; do
        _payload=$(aws s3api list-object-versions --bucket "$CONFIG_BUCKET" --region "$REGION" \
          --max-items 500 --output json 2>/dev/null \
          | jq -c '{Objects: [((.Versions // [])[], (.DeleteMarkers // [])[]) | {Key, VersionId}]}' 2>/dev/null \
          || echo '{"Objects":[]}')
        _n=$(printf '%s' "$_payload" | jq '.Objects | length' 2>/dev/null || echo 0)
        [ "${_n:-0}" -eq 0 ] && break
        aws s3api delete-objects --bucket "$CONFIG_BUCKET" --region "$REGION" \
          --delete "$_payload" >/dev/null 2>&1 || break
      done
    else
      echo "  WARNING: jq not found — could not purge object versions; foundation" >&2
      echo "           delete may fail if the bucket retains noncurrent versions." >&2
    fi
    echo "  Emptied: $CONFIG_BUCKET"
  fi

  echo ""
  delete_stack "$FOUNDATION_NAME"
fi

echo ""
echo "=== Teardown complete ==="
echo ""
echo "  Note: Secrets Manager secrets are NOT deleted automatically."
echo "  To delete secrets:"
echo "    aws secretsmanager delete-secret --secret-id ${APP_SECRETS_NAME} --force-delete-without-recovery --region $REGION"
echo "    aws secretsmanager delete-secret --secret-id ${GHCR_AUTH_SECRET_NAME} --force-delete-without-recovery --region $REGION"
