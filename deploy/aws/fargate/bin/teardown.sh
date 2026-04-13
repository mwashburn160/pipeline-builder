#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Fargate Teardown Script
# =============================================================================
# Deletes all CloudFormation stacks in reverse dependency order.
#
# Usage: bash bin/teardown.sh [--stack-prefix pb] [--region us-east-1]
# =============================================================================
set -euo pipefail

STACK_PREFIX="pb"
REGION="${AWS_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --stack-prefix) STACK_PREFIX="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "========================================"
echo "Pipeline Builder - Fargate Teardown"
echo "========================================"
echo "  Stack Prefix: $STACK_PREFIX"
echo "  Region:       $REGION"
echo ""

# Delete stacks in reverse order
STACKS=("admin" "observability" "services" "databases" "cluster")

for stack in "${STACKS[@]}"; do
  STACK_NAME="${STACK_PREFIX}-${stack}"
  if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
    echo "=== Deleting: $STACK_NAME ==="
    aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
    echo "  Deleted: $STACK_NAME"
  else
    echo "=== Skipping: $STACK_NAME (not found) ==="
  fi
done

# Empty S3 bucket before deleting foundation
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
    echo "  Emptied: $CONFIG_BUCKET"
  fi

  echo ""
  echo "=== Deleting: $FOUNDATION_NAME ==="
  aws cloudformation delete-stack --stack-name "$FOUNDATION_NAME" --region "$REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$FOUNDATION_NAME" --region "$REGION"
  echo "  Deleted: $FOUNDATION_NAME"
fi

echo ""
echo "=== Teardown complete ==="
echo ""
echo "  Note: Secrets Manager secrets are NOT deleted automatically."
echo "  To delete secrets:"
echo "    aws secretsmanager delete-secret --secret-id ${STACK_PREFIX}/app-secrets --force-delete-without-recovery --region $REGION"
echo "    aws secretsmanager delete-secret --secret-id ${STACK_PREFIX}/ghcr-auth --force-delete-without-recovery --region $REGION"
