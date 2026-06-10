#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - EC2 Deployment Script
# =============================================================================
# Deploys the EC2 stack (template.yaml). In private mode the template itself
# also creates the inside-AWS-only prerequisites (VPC interface endpoints +
# Route53 private zone aliasing the domain to the internal ALB), gated on
# DeployMode=private — there is no separate prereqs stack.
#
# Runs from YOUR machine with YOUR credentials (like Fargate's setup.sh), so
# the EC2 instance role needs NO CloudFormation permissions.
#
# TLS is terminated at the ALB with an ACM cert that the template REQUESTS and
# DNS-validates against --hosted-zone-id (no certbot / Let's Encrypt on the
# box). The instance is always PRIVATE; DEPLOY_MODE only flips the ALB scheme
# (public = internet-facing, private = internal).
#
# Usage:
#   bash bin/setup.sh --key-pair my-key --domain pipeline.example.com \
#     --hosted-zone-id Z123 --ghcr-token ghp_xxxx [--region us-east-1]
#
# --domain + --hosted-zone-id are REQUIRED in BOTH modes (a PUBLIC Route53 zone
# you control) — used for ACM DNS validation + the public/private DNS alias.
# DEPLOY_MODE defaults to private; pass --deploy-mode public for internet-facing.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"        # deploy/aws/ec2
TEMPLATE="$DEPLOY_DIR/template.yaml"

# Defaults (env-overridable)
STACK_NAME="${STACK_NAME:-pipeline-builder}"
REGION="${AWS_REGION:-us-east-1}"
DEPLOY_MODE="${DEPLOY_MODE:-private}"
DOMAIN="${DOMAIN:-}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
KEY_PAIR_NAME="${KEY_PAIR_NAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
INSTANCE_TYPE="${INSTANCE_TYPE:-}"
# Transactional email via SES. ENABLED BY DEFAULT — the SES identity + DKIM +
# instance-role grant + app EMAIL_ENABLED are provisioned together. Pass --no-email
# to skip it. NOTE: a fresh SES account is sandboxed (verified recipients only)
# until you request production access, so sending is only partly usable until then.
# EMAIL_FROM defaults to noreply@DOMAIN. --no-create-ses-identity skips creating
# the SES identity (use when DOMAIN is already verified in this account).
EMAIL_ENABLED="${EMAIL_ENABLED:-true}"
EMAIL_FROM="${EMAIL_FROM:-}"
EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-pipeline-builder}"
CREATE_SES_IDENTITY="${CREATE_SES_IDENTITY:-true}"
# Optional: subscribe an address to the SES bounce/complaint SNS topic for early
# warning before SES throttles the account (you must confirm the email AWS sends).
ALERT_EMAIL="${ALERT_EMAIL:-}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --deploy-mode) DEPLOY_MODE="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --hosted-zone-id) HOSTED_ZONE_ID="$2"; shift 2 ;;
    --key-pair) KEY_PAIR_NAME="$2"; shift 2 ;;
    --ghcr-token) GHCR_TOKEN="$2"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    --email) EMAIL_ENABLED="true"; shift ;;
    --no-email) EMAIL_ENABLED="false"; shift ;;
    --email-from) EMAIL_FROM="$2"; shift 2 ;;
    --email-from-name) EMAIL_FROM_NAME="$2"; shift 2 ;;
    --no-create-ses-identity) CREATE_SES_IDENTITY="false"; shift ;;
    --alert-email) ALERT_EMAIL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Email defaults to sending from noreply@<domain> unless overridden.
if [ "$EMAIL_ENABLED" = "true" ] && [ -z "$EMAIL_FROM" ]; then
  EMAIL_FROM="noreply@${DOMAIN}"
fi

# -----------------------------------------------------------------------
# Validate
# -----------------------------------------------------------------------
if [ -z "$KEY_PAIR_NAME" ]; then
  echo "ERROR: --key-pair is required (an EC2 key pair in $REGION — serial-console/break-glass; routine access is via SSM)." >&2
  exit 1
fi
if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: template not found: $TEMPLATE" >&2
  exit 1
fi
case "$DEPLOY_MODE" in
  public|private) ;;
  *) echo "ERROR: --deploy-mode must be 'public' or 'private' (got '$DEPLOY_MODE')." >&2; exit 1 ;;
esac
# ACM (DNS-validated) terminates TLS at the ALB in BOTH modes, so a real public
# domain + its Route53 hosted zone are ALWAYS required. Bail early rather than
# let the ACM cert hang unvalidated.
if [ -z "$DOMAIN" ] || [ -z "$HOSTED_ZONE_ID" ]; then
  echo "ERROR: --domain and --hosted-zone-id are required (a PUBLIC Route53 zone" >&2
  echo "       you control) — used for ACM DNS validation and the DNS alias to the ALB." >&2
  exit 1
fi
if [ -z "$GHCR_TOKEN" ]; then
  echo "WARNING: No --ghcr-token provided. Anonymous ghcr.io pulls are rate-limited (60/hr)."
  echo ""
fi

echo "========================================"
echo "Pipeline Builder - EC2 Deployment"
echo "========================================"
echo "  Region:      $REGION"
echo "  Stack:       $STACK_NAME"
echo "  Deploy mode: $DEPLOY_MODE"
echo "  Domain:      ${DOMAIN}"
if [ "$EMAIL_ENABLED" = "true" ]; then
echo "  Email (SES): enabled (from: $EMAIL_FROM, create-identity: $CREATE_SES_IDENTITY)"
else
echo "  Email (SES): disabled (--no-email)"
fi
echo ""

# -----------------------------------------------------------------------
# Helper: deploy a stack (waits for completion)
# -----------------------------------------------------------------------
deploy_stack() {
  local stack_name="$1"
  local template_file="$2"
  shift 2
  local params=("$@")

  echo ""
  echo "=== Deploying: ${stack_name} ==="

  local cmd=(
    aws cloudformation deploy
    --stack-name "${stack_name}"
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

# Read a single output value from the base stack ("" if absent).
out() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text --region "$REGION"
}

# -----------------------------------------------------------------------
# Step 1: Deploy the EC2 base stack (VPC, instance, SG, UserData bootstrap)
# -----------------------------------------------------------------------
BASE_PARAMS=(
  "DeployMode=${DEPLOY_MODE}"
  "KeyPairName=${KEY_PAIR_NAME}"
  "GhcrToken=${GHCR_TOKEN}"
  "EmailEnabled=${EMAIL_ENABLED}"
  "CreateSesIdentity=${CREATE_SES_IDENTITY}"
  "EmailFrom=${EMAIL_FROM}"
  "EmailFromName=${EMAIL_FROM_NAME}"
  "AlertEmail=${ALERT_EMAIL}"
)
[ -n "$DOMAIN" ]         && BASE_PARAMS+=("DomainName=${DOMAIN}")
[ -n "$HOSTED_ZONE_ID" ] && BASE_PARAMS+=("HostedZoneId=${HOSTED_ZONE_ID}")
[ -n "$INSTANCE_TYPE" ]  && BASE_PARAMS+=("InstanceType=${INSTANCE_TYPE}")
deploy_stack "$STACK_NAME" "$TEMPLATE" "${BASE_PARAMS[@]}"

# Private-mode prerequisites (VPC interface endpoints + Route53 private zone
# aliasing the domain to the internal ALB) are now created IN the base stack
# itself, gated on DeployMode=private — there is no separate prereqs stack to
# deploy. (The ALB's DNS is known in-stack, which is what allowed the merge.)

# -----------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------
APP_URL="$(out ApplicationURL)"

echo ""
echo "========================================"
echo "Deployment Complete"
echo "========================================"
echo ""
echo "  Application:  ${APP_URL}"
if [ "$DEPLOY_MODE" = "private" ]; then
echo "  Mode:         private (internal ALB — reach it from inside the VPC via the private zone)"
else
echo "  Mode:         public (internet-facing ALB)"
fi
echo ""
echo "  The ALB target stays UNHEALTHY (503) until the instance finishes"
echo "  bootstrapping minikube + services asynchronously. Watch bootstrap:"
echo "    aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} \\"
echo "      --query \"Stacks[0].Outputs[?OutputKey=='BootstrapLog'].OutputValue\" --output text"
echo ""
if [ "$EMAIL_ENABLED" = "true" ]; then
echo "  Email (SES):  sending from ${EMAIL_FROM} (region ${REGION})"
echo "                DKIM CNAMEs were added to your Route53 zone; verification is"
echo "                ASYNCHRONOUS (minutes-hours). Check status:"
echo "                https://${REGION}.console.aws.amazon.com/ses/home?region=${REGION}#/verified-identities"
echo "                New SES accounts are SANDBOXED: send only to verified recipients"
echo "                (200/day) until you request production access:"
echo "                https://${REGION}.console.aws.amazon.com/ses/home?region=${REGION}#/account"
echo "                To smoke-test in sandbox, verify a REAL recipient — never admin@internal."
echo "                Bounces/complaints publish to SNS topic ${STACK_NAME}-email-events"
if [ -n "$ALERT_EMAIL" ]; then
echo "                (alert: ${ALERT_EMAIL} — CONFIRM the SNS subscription email AWS sent)."
else
echo "                (no --alert-email given; subscribe to the topic to get warned)."
fi
echo ""
fi
