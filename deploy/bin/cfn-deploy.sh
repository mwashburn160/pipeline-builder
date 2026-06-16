#!/usr/bin/env bash
# =============================================================================
# Shared CloudFormation deploy helper for the AWS targets.
# =============================================================================
# Sourced by deploy/aws/ec2/bin/setup.sh (deploy/bin is in every target's
# clone — COMMON_SPARSE_PATHS). Not meant to be executed directly.
#
#   cfn_deploy <full-stack-name> <template-file> [param ...]
#
# Deploys a stack via `aws cloudformation deploy`, first clearing an un-updatable
# ROLLBACK_COMPLETE / REVIEW_IN_PROGRESS stack so a re-run self-heals instead of failing
# with "stack ... can not be updated". (Classic case: the first ECS cluster in a fresh
# account fails on the not-yet-ready service-linked role; the role then exists, so the
# recreate succeeds — but only after the rollback stack is cleared.)
#
# Requires $REGION to be set by the caller.
# =============================================================================

cfn_deploy() {
  local full_name="$1"
  local template_file="$2"
  shift 2
  local params=("$@")

  echo ""
  echo "=== Deploying: ${full_name} ==="

  # Note: avoid the variable name `status` — it's a read-only special in zsh.
  local stack_status
  stack_status=$(aws cloudformation describe-stacks --stack-name "$full_name" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)
  if [ "$stack_status" = "ROLLBACK_COMPLETE" ] || [ "$stack_status" = "REVIEW_IN_PROGRESS" ]; then
    echo "  ${full_name} is in ${stack_status} (not updatable) — deleting it before recreate..."
    aws cloudformation delete-stack --stack-name "$full_name" --region "$REGION"
    aws cloudformation wait stack-delete-complete --stack-name "$full_name" --region "$REGION"
    echo "  Cleared ${full_name}."
  fi

  local cmd=(
    aws cloudformation deploy
    --stack-name "$full_name"
    --template-file "$template_file"
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
    --region "$REGION"
    --no-fail-on-empty-changeset
  )
  if [ ${#params[@]} -gt 0 ]; then
    cmd+=(--parameter-overrides "${params[@]}")
  fi
  "${cmd[@]}"

  echo "  Done"
}
