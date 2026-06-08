#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Fargate Deployment Script
# =============================================================================
# Deploys all CloudFormation stacks in dependency order and uploads config
# files to S3. The foundation stack requests a DNS-validated ACM cert for your
# domain and terminates TLS at the ALB (80 -> 443 redirect); the cert is
# publicly trusted, so CodeBuild plugin-image pulls work. --domain +
# --hosted-zone-id are required in both modes.
#
# Usage:
#   bash bin/deploy.sh --domain pipeline.example.com --hosted-zone-id Z123 \
#     --ghcr-token ghp_xxxx [--deploy-mode public] [--region us-east-1]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STACKS_DIR="$DEPLOY_DIR/stacks"

# Defaults
STACK_PREFIX="pb"
GHCR_TOKEN=""
REGION="${AWS_REGION:-us-east-1}"
APP_SECRETS_NAME="${APP_SECRETS_NAME:-pipeline-builder/app-secrets}"
GHCR_AUTH_SECRET_NAME="${GHCR_AUTH_SECRET_NAME:-pipeline-builder/ghcr-auth}"
# DOMAIN + HOSTED_ZONE_ID are REQUIRED: the foundation stack requests a
# DNS-validated ACM cert for DOMAIN against HOSTED_ZONE_ID (publicly trusted, so
# CodeBuild trusts the gateway on plugin-image pulls) and resolves DOMAIN to the
# ALB via a public alias (public mode) or an in-stack private zone (private).
DOMAIN="${DOMAIN:-}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
DEPLOY_MODE="${DEPLOY_MODE:-private}"
# Transactional email via SES. Off by default — a fresh SES account is sandboxed
# (verified recipients only) so email is only partly usable until production
# access is granted. --email turns on the SES identity + IAM grant + platform env
# together. EMAIL_FROM defaults to noreply@DOMAIN. --no-create-ses-identity skips
# creating the SES identity (use when DOMAIN is already verified in this account).
EMAIL_ENABLED="${EMAIL_ENABLED:-false}"
EMAIL_FROM="${EMAIL_FROM:-}"
EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-pipeline-builder}"
CREATE_SES_IDENTITY="${CREATE_SES_IDENTITY:-true}"
# Optional: subscribe an address to the SES bounce/complaint SNS topic for early
# warning before SES throttles the account (you must confirm the email AWS sends).
ALERT_EMAIL="${ALERT_EMAIL:-}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --ghcr-token) GHCR_TOKEN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --stack-prefix) STACK_PREFIX="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --hosted-zone-id) HOSTED_ZONE_ID="$2"; shift 2 ;;
    --deploy-mode) DEPLOY_MODE="$2"; shift 2 ;;
    --email) EMAIL_ENABLED="true"; shift ;;
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

# Validate
case "$DEPLOY_MODE" in
  public|private) ;;
  *) echo "ERROR: --deploy-mode must be 'public' or 'private' (got '$DEPLOY_MODE')." >&2; exit 1 ;;
esac
if [ -z "$DOMAIN" ] || [ -z "$HOSTED_ZONE_ID" ]; then
  echo "ERROR: --domain and --hosted-zone-id are required (a PUBLIC Route53 zone" >&2
  echo "       you control) — used for ACM DNS validation and the DNS alias to the ALB." >&2
  exit 1
fi
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
echo "  Deploy mode:    $DEPLOY_MODE"
echo "  Domain:         $DOMAIN"
if [ "$EMAIL_ENABLED" = "true" ]; then
echo "  Email (SES):    enabled (from: $EMAIL_FROM, create-identity: $CREATE_SES_IDENTITY)"
else
echo "  Email (SES):    disabled (pass --email to enable)"
fi
echo ""
# TLS is an ACM cert the foundation stack requests + DNS-validates against
# --hosted-zone-id (no init-cert.sh / self-signed step). The cert is publicly
# trusted, so CodeBuild's plugin-image pulls verify successfully in both modes.

# -----------------------------------------------------------------------
# Step 1: Initialize secrets (if not already done)
# -----------------------------------------------------------------------
echo "=== Step 1: Ensure secrets exist ==="
if ! aws secretsmanager describe-secret --secret-id "$APP_SECRETS_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "  Secrets not found. Running init-secrets.sh..."
  bash "$SCRIPT_DIR/init-secrets.sh" \
    --ghcr-token "$GHCR_TOKEN" \
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
# Step 2: Deploy foundation stack
# -----------------------------------------------------------------------
# Deployment posture: public (internet-facing ALB; CodeBuild over internet) or
# private (inside-AWS-only: internal-scheme ALB in private subnets + a private
# Route53 zone + VPC-attached CodeBuild). The foundation requests a DNS-validated
# ACM cert for DOMAIN against HostedZoneId (publicly trusted) and DNS-validates
# during stack creation — expect a few minutes in CREATE_IN_PROGRESS.
DEPLOY_MODE_PARAM=("DeployMode=${DEPLOY_MODE}")
FOUNDATION_PARAMS=(
  "StackPrefix=${STACK_PREFIX}"
  "${DEPLOY_MODE_PARAM[@]}"
  "DomainName=${DOMAIN}"
  "HostedZoneId=${HOSTED_ZONE_ID}"
  "EmailEnabled=${EMAIL_ENABLED}"
  "CreateSesIdentity=${CREATE_SES_IDENTITY}"
  "AlertEmail=${ALERT_EMAIL}"
)
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
# The canonical host is the registered domain (resolved to the ALB by the
# public alias / private zone the foundation created). Passed to every stack so
# services + the docker registry's bearer realm derive from the same source.
BASE_HOST="$DOMAIN"
PLATFORM_BASE_URL="https://${BASE_HOST}"

# Private mode: the inside-AWS-only prerequisites (VPC interface endpoints +
# the private Route53 zone aliasing DOMAIN to the internal ALB) are created IN
# the foundation stack itself, gated on DeployMode=private — no separate
# prereqs stack to deploy here.

COMMON_PARAMS=("StackPrefix=${STACK_PREFIX}" "DomainName=${BASE_HOST}")
SECRETS_PARAMS=("AppSecretsName=${APP_SECRETS_NAME}" "GhcrAuthSecretName=${GHCR_AUTH_SECRET_NAME}")
PLATFORM_URL_PARAM=("PlatformBaseUrl=${PLATFORM_BASE_URL}")
# Email params flow to the cluster stack (task-role grant) and the services
# stack (platform env). EmailFrom must match between them — the IAM grant is
# scoped to it via ses:FromAddress.
EMAIL_PARAMS=("EmailEnabled=${EMAIL_ENABLED}" "EmailFrom=${EMAIL_FROM}")
EMAIL_SVC_PARAMS=("${EMAIL_PARAMS[@]}" "EmailFromName=${EMAIL_FROM_NAME}")

deploy_stack "cluster" "$STACKS_DIR/02-cluster.yaml" "${COMMON_PARAMS[@]}" "${EMAIL_PARAMS[@]}"
deploy_stack "databases" "$STACKS_DIR/03-databases.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"
deploy_stack "services" "$STACKS_DIR/04-services.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}" "${PLATFORM_URL_PARAM[@]}" "${DEPLOY_MODE_PARAM[@]}" "${EMAIL_SVC_PARAMS[@]}"
deploy_stack "observability" "$STACKS_DIR/05-observability.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"
deploy_stack "admin" "$STACKS_DIR/06-admin.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"

# -----------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------
echo ""
echo "========================================"
echo "Deployment Complete"
echo "========================================"
echo ""
echo "  Application:   https://${BASE_HOST}  (ACM cert at the ALB; 80 redirects to 443)"
if [ "$DEPLOY_MODE" = "private" ]; then
echo "  Mode:          private (internal ALB — reach it from inside the VPC)"
else
echo "  Mode:          public (internet-facing ALB)"
fi
echo ""
echo "  pgAdmin:       https://${BASE_HOST}/pgadmin/"
echo "  Mongo Express: https://${BASE_HOST}/mongo-express/"
echo "  Registry UI:   https://${BASE_HOST}/dashboard/registry (sysadmin only)"
echo ""
echo "  ECS Console:   https://${REGION}.console.aws.amazon.com/ecs/v2/clusters/pipeline-builder"
if [ "$EMAIL_ENABLED" = "true" ]; then
echo ""
echo "  Email (SES):   sending from ${EMAIL_FROM}"
echo "                 DKIM CNAMEs were added to your Route53 zone; verification is"
echo "                 ASYNCHRONOUS (minutes-hours). Check status:"
echo "                 https://${REGION}.console.aws.amazon.com/ses/home?region=${REGION}#/verified-identities"
echo "                 New SES accounts are SANDBOXED: you can only send to verified"
echo "                 recipients (200/day) until you request production access:"
echo "                 https://${REGION}.console.aws.amazon.com/ses/home?region=${REGION}#/account"
echo "                 To smoke-test in sandbox, verify a REAL recipient — never admin@internal."
echo "                 Bounces/complaints publish to SNS topic ${STACK_PREFIX}-email-events"
if [ -n "$ALERT_EMAIL" ]; then
echo "                 (alert: ${ALERT_EMAIL} — CONFIRM the SNS subscription email AWS sent)."
else
echo "                 (no --alert-email given; subscribe to the topic to get warned)."
fi
fi
