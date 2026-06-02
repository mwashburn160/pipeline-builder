#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Fargate Deployment Script
# =============================================================================
# Deploys all CloudFormation stacks in dependency order and uploads
# config files to S3. Uses the ALB DNS name (CNAME) directly.
#
# Both HTTP (port 80) and HTTPS (port 443, self-signed cert) are enabled.
# Browsers will show a certificate warning on HTTPS — accept once to proceed.
#
# Usage:
#   bash bin/deploy.sh --ghcr-token ghp_xxxx [--region us-east-1]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STACKS_DIR="$DEPLOY_DIR/stacks"

# Defaults
STACK_PREFIX="pb"
GHCR_TOKEN=""
GHCR_USER="mwashburn160"
REGION="${AWS_REGION:-us-east-1}"
APP_SECRETS_NAME="${APP_SECRETS_NAME:-pipeline-builder/app-secrets}"
GHCR_AUTH_SECRET_NAME="${GHCR_AUTH_SECRET_NAME:-pipeline-builder/ghcr-auth}"
# DOMAIN is the hostname clients will use to reach the ALB. For the very
# first deploy the ALB DNS isn't known yet — pass a placeholder, deploy,
# then re-run with the real ALB DNS name (printed at the end) so the cert
# gets a matching SAN. Subsequent re-deploys reuse the cert if >30d valid.
DOMAIN="${DOMAIN:-pipeline-builder.local}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --ghcr-token) GHCR_TOKEN="$2"; shift 2 ;;
    --ghcr-user) GHCR_USER="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --stack-prefix) STACK_PREFIX="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate
if [ -z "$GHCR_TOKEN" ]; then
  echo "WARNING: No --ghcr-token provided. Private image pulls from ghcr.io may fail."
  echo ""
fi

# Validate config files exist
MISSING_CONFIGS=()
for cfg in \
  "$DEPLOY_DIR/nginx/nginx-fargate.conf" \
  "$DEPLOY_DIR/nginx/jwt.js" \
  "$DEPLOY_DIR/nginx/metrics.js" \
  "$DEPLOY_DIR/nginx/registry-auth.js" \
  "$DEPLOY_DIR/config/prometheus/prometheus.yml" \
  "$DEPLOY_DIR/config/loki/loki-config.yml" \
  "$DEPLOY_DIR/config/fluent-bit/fluent-bit.conf" \
  "$DEPLOY_DIR/config/fluent-bit/parsers.conf" \
  "$DEPLOY_DIR/postgres-init.sql" \
  "$DEPLOY_DIR/mongodb-init.js"; do
  [ -f "$cfg" ] || MISSING_CONFIGS+=("$cfg")
done
if [ ${#MISSING_CONFIGS[@]} -gt 0 ]; then
  echo "ERROR: Required config files are missing:"
  for f in "${MISSING_CONFIGS[@]}"; do echo "  - $f"; done
  exit 1
fi

echo "========================================"
echo "Pipeline Builder - Fargate Deployment"
echo "========================================"
echo "  Region:         $REGION"
echo "  Stack Prefix:   $STACK_PREFIX"
echo "  Domain:         $DOMAIN"
echo ""

# -----------------------------------------------------------------------
# Step 1: Generate self-signed certificate for HTTPS
# -----------------------------------------------------------------------
echo "=== Step 1: Ensure TLS certificate exists ==="
CERT_OUTPUT=$(bash "$SCRIPT_DIR/init-cert.sh" --domain "$DOMAIN" --region "$REGION")
CERTIFICATE_ARN=$(echo "$CERT_OUTPUT" | grep "^CERTIFICATE_ARN=" | cut -d= -f2)
if [ -z "$CERTIFICATE_ARN" ]; then
  echo "  WARNING: Failed to obtain certificate. HTTPS will be disabled."
else
  echo "  Certificate: $CERTIFICATE_ARN"
fi

# -----------------------------------------------------------------------
# Step 2: Initialize secrets (if not already done)
# -----------------------------------------------------------------------
echo ""
echo "=== Step 2: Ensure secrets exist ==="
if ! aws secretsmanager describe-secret --secret-id "$APP_SECRETS_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "  Secrets not found. Running init-secrets.sh..."
  bash "$SCRIPT_DIR/init-secrets.sh" \
    --ghcr-token "$GHCR_TOKEN" \
    --ghcr-user "$GHCR_USER" \
    --region "$REGION"
else
  echo "  Secrets already exist in Secrets Manager"
fi

# -----------------------------------------------------------------------
# Helper function to deploy a stack
# -----------------------------------------------------------------------
deploy_stack() {
  local stack_name="$1"
  local template_file="$2"
  shift 2
  local params=("$@")

  echo ""
  echo "=== Deploying: ${STACK_PREFIX}-${stack_name} ==="

  local cmd=(
    aws cloudformation deploy
    --stack-name "${STACK_PREFIX}-${stack_name}"
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

# -----------------------------------------------------------------------
# Step 3: Deploy foundation stack
# -----------------------------------------------------------------------
# Deployment posture: public (internet-facing ALB; CodeBuild over internet) or
# private (inside-AWS-only: internal-scheme ALB in private subnets +
# VPC-attached CodeBuild). Defaults to private; set DEPLOY_MODE=public to flip it.
# private mode REQUIRES an ACM-ISSUED (publicly trusted) cert (CERTIFICATE_ARN)
# + a Route53 private zone for the domain → the internal ALB.
DEPLOY_MODE="${DEPLOY_MODE:-private}"
case "$DEPLOY_MODE" in
  public|private) ;;
  *) echo "ERROR: DEPLOY_MODE must be 'public' or 'private' (got '$DEPLOY_MODE')." >&2; exit 1 ;;
esac
DEPLOY_MODE_PARAM=("DeployMode=${DEPLOY_MODE}")
FOUNDATION_PARAMS=("StackPrefix=${STACK_PREFIX}" "${DEPLOY_MODE_PARAM[@]}")
[ -n "$CERTIFICATE_ARN" ] && FOUNDATION_PARAMS+=("CertificateArn=${CERTIFICATE_ARN}")
deploy_stack "foundation" "$STACKS_DIR/01-foundation.yaml" "${FOUNDATION_PARAMS[@]}"

# -----------------------------------------------------------------------
# Step 4: Upload config files to S3
# -----------------------------------------------------------------------
echo ""
echo "=== Uploading config files to S3 ==="
CONFIG_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-foundation" \
  --query "Stacks[0].Outputs[?OutputKey=='ConfigBucketName'].OutputValue" \
  --output text --region "$REGION")
# `--output text` prints "None" (not empty) when the query misses, so guard
# both — otherwise the uploads below silently target s3://None/...
if [ -z "$CONFIG_BUCKET" ] || [ "$CONFIG_BUCKET" = "None" ]; then
  echo "ERROR: could not read ConfigBucketName from ${STACK_PREFIX}-foundation outputs." >&2
  exit 1
fi

aws s3 cp "$DEPLOY_DIR/nginx/nginx-fargate.conf" "s3://${CONFIG_BUCKET}/nginx/nginx.conf" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/nginx/jwt.js" "s3://${CONFIG_BUCKET}/nginx/jwt.js" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/nginx/metrics.js" "s3://${CONFIG_BUCKET}/nginx/metrics.js" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/nginx/registry-auth.js" "s3://${CONFIG_BUCKET}/nginx/registry-auth.js" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/prometheus/prometheus.yml" "s3://${CONFIG_BUCKET}/prometheus/prometheus.yml" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/loki/loki-config.yml" "s3://${CONFIG_BUCKET}/loki/loki-config.yml" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/fluent-bit/fluent-bit.conf" "s3://${CONFIG_BUCKET}/fluent-bit/fluent-bit.conf" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/fluent-bit/parsers.conf" "s3://${CONFIG_BUCKET}/fluent-bit/parsers.conf" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/postgres-init.sql" "s3://${CONFIG_BUCKET}/postgres/init.sql" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/pgbouncer/pgbouncer.ini" "s3://${CONFIG_BUCKET}/pgbouncer/pgbouncer.ini" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/mongodb-init.js" "s3://${CONFIG_BUCKET}/mongodb/mongo-init.js" --region "$REGION"
echo "  Done"

# -----------------------------------------------------------------------
# Step 5: Deploy remaining stacks
# -----------------------------------------------------------------------
BASE_HOST=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-foundation" \
  --query "Stacks[0].Outputs[?OutputKey=='DomainName'].OutputValue" \
  --output text --region "$REGION")
if [ -z "$BASE_HOST" ] || [ "$BASE_HOST" = "None" ]; then
  echo "ERROR: could not read DomainName from ${STACK_PREFIX}-foundation outputs." >&2
  exit 1
fi

# Scheme tracks TLS availability: ALB has cert => https, else http.
# Used as the canonical public base URL — passed to every stack so services
# and the docker registry's bearer realm derive from the same source.
if [ -n "$CERTIFICATE_ARN" ]; then
  PLATFORM_BASE_URL="https://${BASE_HOST}"
else
  PLATFORM_BASE_URL="http://${BASE_HOST}"
fi

# Private mode: provision the inside-AWS-only prerequisites (VPC interface
# endpoints + Route53 private zone + ALB 443 ingress from the VPC) so the
# VPC-attached CodeBuild projects can reach AWS APIs and pull plugin images
# from the internal ALB. Reads the foundation outputs added for this purpose.
if [ "$DEPLOY_MODE" = "private" ]; then
  fout() { aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-foundation" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text --region "$REGION"; }
  SHARED_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
  # Capture + validate each foundation output; an empty/None value would
  # otherwise be passed straight into the prereqs stack (e.g. VpcId=None).
  VPC_ID="$(fout VpcId)"; VPC_CIDR="$(fout VpcCidr)"
  SUBNET1="$(fout PrivateSubnet1Id)"; SUBNET2="$(fout PrivateSubnet2Id)"
  ALB_SG="$(fout ALBSecurityGroupId)"; ALB_DNS="$(fout ALBDnsName)"
  ALB_ZONE="$(fout AlbCanonicalHostedZoneId)"
  for _pair in "VpcId:$VPC_ID" "VpcCidr:$VPC_CIDR" "PrivateSubnet1Id:$SUBNET1" \
               "PrivateSubnet2Id:$SUBNET2" "ALBSecurityGroupId:$ALB_SG" \
               "ALBDnsName:$ALB_DNS" "AlbCanonicalHostedZoneId:$ALB_ZONE"; do
    if [ -z "${_pair#*:}" ] || [ "${_pair#*:}" = "None" ]; then
      echo "ERROR: foundation output '${_pair%%:*}' is empty/None — cannot deploy private-prereqs." >&2
      exit 1
    fi
  done
  deploy_stack "private-prereqs" "$SHARED_DIR/private-prereqs.yaml" \
    "StackPrefix=${STACK_PREFIX}" \
    "VpcId=${VPC_ID}" \
    "VpcCidr=${VPC_CIDR}" \
    "SubnetIds=${SUBNET1},${SUBNET2}" \
    "DomainName=${BASE_HOST}" \
    "GatewaySecurityGroupId=${ALB_SG}" \
    "GatewayType=alb" \
    "AlbDnsName=${ALB_DNS}" \
    "AlbCanonicalHostedZoneId=${ALB_ZONE}"
fi

COMMON_PARAMS=("StackPrefix=${STACK_PREFIX}" "DomainName=${BASE_HOST}")
SECRETS_PARAMS=("AppSecretsName=${APP_SECRETS_NAME}" "GhcrAuthSecretName=${GHCR_AUTH_SECRET_NAME}")
PLATFORM_URL_PARAM=("PlatformBaseUrl=${PLATFORM_BASE_URL}")

deploy_stack "cluster" "$STACKS_DIR/02-cluster.yaml" "${COMMON_PARAMS[@]}"
deploy_stack "databases" "$STACKS_DIR/03-databases.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"
deploy_stack "services" "$STACKS_DIR/04-services.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}" "${PLATFORM_URL_PARAM[@]}" "${DEPLOY_MODE_PARAM[@]}"
deploy_stack "observability" "$STACKS_DIR/05-observability.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"
deploy_stack "admin" "$STACKS_DIR/06-admin.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}" "${PLATFORM_URL_PARAM[@]}"

# -----------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------
echo ""
echo "========================================"
echo "Deployment Complete"
echo "========================================"
echo ""
echo "  HTTP:          http://${BASE_HOST}"
if [ -n "$CERTIFICATE_ARN" ]; then
echo "  HTTPS:         https://${BASE_HOST}  (self-signed — accept browser warning)"
fi
echo ""
echo "  pgAdmin:       http://${BASE_HOST}/pgadmin/"
echo "  Mongo Express: http://${BASE_HOST}/mongo-express/"
echo "  Registry UI:   http://${BASE_HOST}/dashboard/registry (sysadmin only)"
echo ""
echo "  ECS Console:   https://${REGION}.console.aws.amazon.com/ecs/v2/clusters/pipeline-builder"
