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
# ROLLBACK_COMPLETE / REVIEW_IN_PROGRESS stack so a re-run self-heals instead of
# failing with "stack ... can not be updated". That state is how a first deploy in
# a fresh account lands when it raced an AWS-side prerequisite (a service-linked
# role that did not exist yet): the retry would succeed, but only once the
# rolled-back stack is out of the way.
#
# Requires $REGION to be set by the caller.
#
# SHELL OPTIONS: this file is SOURCED, never executed, so it deliberately sets
# NO `set -euo pipefail`. `set` inside a sourced file mutates the CALLER's shell
# — it would silently turn on errexit for whatever sourced us (including an
# interactive shell, where a failed command would then close the terminal).
# Every caller already runs under `set -euo pipefail`; these functions therefore
# propagate failure the portable way, by RETURNING non-zero, so they behave the
# same whether or not the caller has errexit on.
#
# Every AWS call below is checked EXPLICITLY rather than left to the caller's
# errexit: a function's status is its LAST command's, and this one ends in an
# `echo`. Unchecked, a failed `aws cloudformation deploy` returns 0, the stack
# silently does not exist, and the failure surfaces steps later.
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
    if ! aws cloudformation delete-stack --stack-name "$full_name" --region "$REGION" \
       || ! aws cloudformation wait stack-delete-complete --stack-name "$full_name" --region "$REGION"; then
      echo "ERROR: could not clear the un-updatable stack ${full_name}" >&2
      echo "       Delete it by hand (or check for a retained resource blocking the delete) and re-run." >&2
      return 1
    fi
    echo "  Cleared ${full_name}."
  fi

  # CloudFormation refuses an INLINE template over 51,200 bytes; past that it has
  # to be staged in S3 (`--s3-bucket`, which uploads and deploys by URL). The ec2
  # template crossed that line as parameters were added, and the failure is a
  # late, opaque one — the deploy runs, talks to AWS, and only then reports
  # "Templates with a size greater than 51,200 bytes must be deployed via an S3
  # Bucket". Stage automatically instead of making every future edit a size
  # negotiation. The bucket is per account+region, created on demand, private.
  local tpl_bytes
  tpl_bytes=$(wc -c < "$template_file" | tr -d ' ')
  local stage=()
  if [ "$tpl_bytes" -gt 51200 ]; then
    local acct bucket
    acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
    if [ -z "$acct" ] || [ "$acct" = "None" ]; then
      echo "ERROR: template is ${tpl_bytes} bytes (over CloudFormation's 51,200 inline limit)" >&2
      echo "       and the account id could not be read to name a staging bucket." >&2
      return 1
    fi
    bucket="pipeline-builder-cfn-${acct}-${REGION}"
    if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
      echo "  Template is ${tpl_bytes} bytes — creating staging bucket ${bucket}"
      # us-east-1 is the one region that rejects an explicit LocationConstraint.
      if [ "$REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$bucket" --region "$REGION" >/dev/null || return 1
      else
        aws s3api create-bucket --bucket "$bucket" --region "$REGION" \
          --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null || return 1
      fi
      # A template carries no secrets (every credential is a NoEcho parameter that
      # lands in Secrets Manager), but it does describe the whole topology.
      aws s3api put-public-access-block --bucket "$bucket" \
        --public-access-block-configuration \
        'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' >/dev/null 2>&1 || true
    fi
    echo "  Staging the ${tpl_bytes}-byte template through s3://${bucket}"
    stage=(--s3-bucket "$bucket" --s3-prefix "cfn/${full_name}")
  fi

  local cmd=(
    aws cloudformation deploy
    --stack-name "$full_name"
    --template-file "$template_file"
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
    --region "$REGION"
    --no-fail-on-empty-changeset
    "${stage[@]+"${stage[@]}"}"
  )
  if [ ${#params[@]} -gt 0 ]; then
    cmd+=(--parameter-overrides "${params[@]}")
  fi
  if ! "${cmd[@]}"; then
    echo "ERROR: CloudFormation deploy of ${full_name} failed" >&2
    echo "       Events: aws cloudformation describe-stack-events --stack-name ${full_name} --region ${REGION} --max-items 20" >&2
    return 1
  fi

  echo "  Done"
}
