#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - EC2 Deployment Script
# =============================================================================
# Deploys the EC2 base stack (template.yaml) and, in internal mode, the shared
# internal-prereqs.yaml stack (VPC interface endpoints + Route53 PRIVATE zone +
# gateway 443-from-VPC ingress). Mirrors the Fargate bin/deploy.sh so EC2 gets
# the same one-command experience with internal-mode prereqs deployed
# automatically — no manual "aws cloudformation deploy" follow-up step.
#
# Runs from YOUR machine with YOUR credentials (like Fargate's deploy.sh), so
# the EC2 instance role needs NO CloudFormation permissions to stand these up.
#
# The instance issues its own publicly-trusted Let's Encrypt cert on first boot
# (bootstrap.sh):
#   - public   -> HTTP-01 (needs public :80)
#   - internal -> DNS-01 over Route53 (uses the instance role's scoped Route53
#                 permissions, which template.yaml attaches when
#                 DeployMode=internal)
#
# Usage:
#   bash bin/deploy.sh --key-pair my-key --domain pipeline.example.com \
#     --hosted-zone-id Z123 --ghcr-token ghp_xxxx [--region us-east-1]
#
# DEPLOY_MODE defaults to internal. Pass --deploy-mode public (or DEPLOY_MODE=
# public) for the internet-facing / IP-only path. internal mode REQUIRES
# --domain + --hosted-zone-id (a PUBLIC Route53 zone you control) so the
# publicly-trusted DNS-01 cert can be issued.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"        # deploy/aws/ec2
SHARED_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"        # deploy/aws
TEMPLATE="$DEPLOY_DIR/template.yaml"
PREREQS_TEMPLATE="$SHARED_DIR/internal-prereqs.yaml"

# Defaults (env-overridable)
STACK_NAME="${STACK_NAME:-pipeline-builder}"
REGION="${AWS_REGION:-us-east-1}"
DEPLOY_MODE="${DEPLOY_MODE:-internal}"
DOMAIN="${DOMAIN:-}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
KEY_PAIR_NAME="${KEY_PAIR_NAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
GHCR_USER="${GHCR_USER:-mwashburn160}"
INSTANCE_TYPE="${INSTANCE_TYPE:-}"

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
    --ghcr-user) GHCR_USER="$2"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# -----------------------------------------------------------------------
# Validate
# -----------------------------------------------------------------------
if [ -z "$KEY_PAIR_NAME" ]; then
  echo "ERROR: --key-pair is required (an EC2 key pair name in $REGION for SSH access)." >&2
  exit 1
fi
if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: template not found: $TEMPLATE" >&2
  exit 1
fi
case "$DEPLOY_MODE" in
  public|internal) ;;
  *) echo "ERROR: --deploy-mode must be 'public' or 'internal' (got '$DEPLOY_MODE')." >&2; exit 1 ;;
esac
if [ "$DEPLOY_MODE" = "internal" ]; then
  # internal mode needs a publicly-trusted DNS-01 cert, which requires a real
  # public domain + its Route53 hosted zone you control. Bail early rather than
  # let the instance silently fall back to a self-signed cert (which CodeBuild
  # plugin pulls then reject with x509 "unknown authority").
  if [ -z "$DOMAIN" ] || [ -z "$HOSTED_ZONE_ID" ]; then
    echo "ERROR: internal mode requires --domain and --hosted-zone-id (a PUBLIC" >&2
    echo "       Route53 zone you control) so the DNS-01 cert can be issued." >&2
    echo "       Use --deploy-mode public for an IP-only / self-signed deploy." >&2
    exit 1
  fi
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
echo "  Domain:      ${DOMAIN:-<none — Elastic IP + self-signed>}"
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
  "GhcrUser=${GHCR_USER}"
)
[ -n "$DOMAIN" ]         && BASE_PARAMS+=("DomainName=${DOMAIN}")
[ -n "$HOSTED_ZONE_ID" ] && BASE_PARAMS+=("HostedZoneId=${HOSTED_ZONE_ID}")
[ -n "$INSTANCE_TYPE" ]  && BASE_PARAMS+=("InstanceType=${INSTANCE_TYPE}")
deploy_stack "$STACK_NAME" "$TEMPLATE" "${BASE_PARAMS[@]}"

# -----------------------------------------------------------------------
# Step 2: Internal mode — auto-deploy the inside-AWS-only prerequisites
# -----------------------------------------------------------------------
# Reads the base stack's outputs (added for exactly this purpose) and stands up
# the VPC interface endpoints + Route53 PRIVATE zone (A -> instance private IP)
# + gateway 443-from-VPC ingress, with GatewayType=ip. The instance meanwhile
# issues its DNS-01 cert against the PUBLIC zone during bootstrap — independent
# of this private zone, so deploying it now is safe.
if [ "$DEPLOY_MODE" = "internal" ]; then
  # Capture each required output and fail loudly if empty/None — otherwise a
  # mistyped/renamed output would silently feed "VpcId=" (or "None") into the
  # prereqs stack and fail deep inside CloudFormation with a confusing error.
  VPC_ID="$(out VpcId)"
  VPC_CIDR="$(out VpcCidr)"
  SUBNET_ID="$(out SubnetId)"
  SG_ID="$(out SecurityGroupId)"
  PRIV_IP="$(out InstancePrivateIp)"
  for _pair in "VpcId:$VPC_ID" "VpcCidr:$VPC_CIDR" "SubnetId:$SUBNET_ID" \
               "SecurityGroupId:$SG_ID" "InstancePrivateIp:$PRIV_IP"; do
    if [ -z "${_pair#*:}" ] || [ "${_pair#*:}" = "None" ]; then
      echo "ERROR: base stack '${STACK_NAME}' output '${_pair%%:*}' is empty/None —" >&2
      echo "       cannot deploy internal-prereqs. Did the base stack finish?" >&2
      exit 1
    fi
  done
  deploy_stack "${STACK_NAME}-internal" "$PREREQS_TEMPLATE" \
    "StackPrefix=${STACK_NAME}" \
    "VpcId=${VPC_ID}" \
    "VpcCidr=${VPC_CIDR}" \
    "SubnetIds=${SUBNET_ID}" \
    "DomainName=${DOMAIN}" \
    "GatewaySecurityGroupId=${SG_ID}" \
    "GatewayType=ip" \
    "GatewayPrivateIp=${PRIV_IP}"
fi

# -----------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------
APP_URL="$(out ApplicationURL)"
PRIVATE_IP="$(out InstancePrivateIp)"

echo ""
echo "========================================"
echo "Deployment Complete"
echo "========================================"
echo ""
echo "  Application:  ${APP_URL}"
if [ "$DEPLOY_MODE" = "internal" ]; then
echo "  Mode:         internal (reach it from inside the VPC via the private zone)"
echo "  Private IP:   ${PRIVATE_IP}"
echo "  Prereqs:      ${STACK_NAME}-internal (VPC endpoints + private zone + 443-from-VPC)"
fi
echo ""
echo "  Bootstrap still runs ON the instance (cert + minikube + services),"
echo "  asynchronously after the stack completes. Watch it with:"
echo "    aws cloudformation describe-stacks --stack-name ${STACK_NAME} --region ${REGION} \\"
echo "      --query \"Stacks[0].Outputs[?OutputKey=='BootstrapLog'].OutputValue\" --output text"
echo ""
