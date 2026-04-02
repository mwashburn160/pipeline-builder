#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Fargate Deployment Script
# =============================================================================
# Deploys all CloudFormation stacks in dependency order and uploads
# config files to S3.
#
# Usage:
#   With custom domain:
#     bash bin/deploy.sh \
#       --domain pipeline.example.com \
#       --hosted-zone-id Z1234567890 \
#       --ghcr-token ghp_xxxx
#
#   Without domain (HTTP only, uses ALB DNS name):
#     bash bin/deploy.sh --ghcr-token ghp_xxxx
#
#   Without domain but with HTTPS (self-signed cert, browser warning):
#     bash bin/deploy.sh --ghcr-token ghp_xxxx --self-signed-cert
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STACKS_DIR="$DEPLOY_DIR/stacks"

# Defaults
STACK_PREFIX="pb"
DOMAIN=""
HOSTED_ZONE_ID=""
GHCR_TOKEN=""
GHCR_USER="mwashburn160"
REGION="${AWS_REGION:-us-east-1}"
CERTIFICATE_ARN=""
SELF_SIGNED_CERT=false
APP_SECRETS_NAME="${APP_SECRETS_NAME:-pipeline-builder/app-secrets}"
GHCR_AUTH_SECRET_NAME="${GHCR_AUTH_SECRET_NAME:-pipeline-builder/ghcr-auth}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --hosted-zone-id) HOSTED_ZONE_ID="$2"; shift 2 ;;
    --ghcr-token) GHCR_TOKEN="$2"; shift 2 ;;
    --ghcr-user) GHCR_USER="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --stack-prefix) STACK_PREFIX="$2"; shift 2 ;;
    --certificate-arn) CERTIFICATE_ARN="$2"; shift 2 ;;
    --self-signed-cert) SELF_SIGNED_CERT=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate parameters
if [ -n "$DOMAIN" ] && [ -z "$HOSTED_ZONE_ID" ]; then
  echo "ERROR: --hosted-zone-id is required when --domain is specified"
  exit 1
fi

if [ -z "$GHCR_TOKEN" ]; then
  echo "WARNING: No --ghcr-token provided. Private image pulls from ghcr.io may fail."
  echo "  Use --ghcr-token to provide a GitHub Container Registry token."
  echo ""
fi

# Validate config files exist before deploying
MISSING_CONFIGS=()
for cfg in \
  "$DEPLOY_DIR/nginx/nginx-fargate.conf" \
  "$DEPLOY_DIR/nginx/jwt.js" \
  "$DEPLOY_DIR/nginx/metrics.js" \
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
if [ -n "$DOMAIN" ]; then
  echo "  Domain:         $DOMAIN"
  echo "  Hosted Zone:    $HOSTED_ZONE_ID"
else
  echo "  Domain:         (none - will use ALB DNS name)"
fi
echo "  Region:         $REGION"
echo "  Stack Prefix:   $STACK_PREFIX"
echo ""

# -----------------------------------------------------------------------
# Step 1: Obtain TLS certificate (skipped when no domain and no --self-signed-cert)
# -----------------------------------------------------------------------
echo "=== Step 1: Ensure TLS certificate exists ==="
if [ -z "$DOMAIN" ] && [ "$SELF_SIGNED_CERT" = true ] && [ -z "$CERTIFICATE_ARN" ]; then
  echo "  No custom domain - generating self-signed certificate for HTTPS..."
  CERT_OUTPUT=$(bash "$SCRIPT_DIR/init-self-signed-cert.sh" --region "$REGION")
  echo "$CERT_OUTPUT"
  CERTIFICATE_ARN=$(echo "$CERT_OUTPUT" | grep "^CERTIFICATE_ARN=" | cut -d= -f2)
  if [ -z "$CERTIFICATE_ARN" ]; then
    echo "ERROR: Failed to obtain certificate ARN from init-self-signed-cert.sh"
    exit 1
  fi
  echo "  Self-signed Certificate ARN: $CERTIFICATE_ARN"
elif [ -z "$DOMAIN" ]; then
  echo "  No custom domain - skipping TLS certificate (HTTP-only mode)"
  echo "  Tip: use --self-signed-cert for HTTPS without a domain"
elif [ -z "$CERTIFICATE_ARN" ]; then
  echo "  No --certificate-arn provided. Obtaining Let's Encrypt certificate..."
  CERT_OUTPUT=$(bash "$SCRIPT_DIR/init-cert.sh" \
    --domain "$DOMAIN" \
    --region "$REGION")
  echo "$CERT_OUTPUT"
  CERTIFICATE_ARN=$(echo "$CERT_OUTPUT" | grep "^CERTIFICATE_ARN=" | cut -d= -f2)
  if [ -z "$CERTIFICATE_ARN" ]; then
    echo "ERROR: Failed to obtain certificate ARN from init-cert.sh"
    exit 1
  fi
  echo "  Certificate ARN: $CERTIFICATE_ARN"
else
  echo "  Using provided certificate: $CERTIFICATE_ARN"
fi

# -----------------------------------------------------------------------
# Step 2: Initialize secrets (if not already done)
# -----------------------------------------------------------------------
echo ""
echo "=== Step 2: Ensure secrets exist ==="
if ! aws secretsmanager describe-secret --secret-id "$APP_SECRETS_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "  Secrets not found. Running init-secrets.sh..."
  bash "$SCRIPT_DIR/init-secrets.sh" \
    --domain "$DOMAIN" \
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
  echo "  Template: $template_file"

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

  echo "  Stack ${STACK_PREFIX}-${stack_name} deployed successfully"

  # Trigger drift detection (non-blocking, informational only)
  local drift_id
  drift_id=$(aws cloudformation detect-stack-drift \
    --stack-name "${STACK_PREFIX}-${stack_name}" \
    --region "$REGION" \
    --query "StackDriftDetectionId" --output text 2>/dev/null || true)
  if [ -n "$drift_id" ] && [ "$drift_id" != "None" ]; then
    echo "  Drift detection started: $drift_id"
  fi
}

# -----------------------------------------------------------------------
# Step 3: Deploy foundation stack
# -----------------------------------------------------------------------
FOUNDATION_PARAMS=("StackPrefix=${STACK_PREFIX}")
[ -n "$DOMAIN" ] && FOUNDATION_PARAMS+=("DomainName=${DOMAIN}")
[ -n "$HOSTED_ZONE_ID" ] && FOUNDATION_PARAMS+=("HostedZoneId=${HOSTED_ZONE_ID}")
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

echo "  S3 Bucket: $CONFIG_BUCKET"

# Nginx config
aws s3 cp "$DEPLOY_DIR/nginx/nginx-fargate.conf" "s3://${CONFIG_BUCKET}/nginx/nginx.conf" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/nginx/jwt.js" "s3://${CONFIG_BUCKET}/nginx/jwt.js" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/nginx/metrics.js" "s3://${CONFIG_BUCKET}/nginx/metrics.js" --region "$REGION"

# Prometheus config
aws s3 cp "$DEPLOY_DIR/config/prometheus/prometheus.yml" "s3://${CONFIG_BUCKET}/prometheus/prometheus.yml" --region "$REGION"

# Loki config
aws s3 cp "$DEPLOY_DIR/config/loki/loki-config.yml" "s3://${CONFIG_BUCKET}/loki/loki-config.yml" --region "$REGION"

# Fluent Bit config
aws s3 cp "$DEPLOY_DIR/config/fluent-bit/fluent-bit.conf" "s3://${CONFIG_BUCKET}/fluent-bit/fluent-bit.conf" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/fluent-bit/parsers.conf" "s3://${CONFIG_BUCKET}/fluent-bit/parsers.conf" --region "$REGION"

# Grafana config
aws s3 sync "$DEPLOY_DIR/config/grafana/" "s3://${CONFIG_BUCKET}/grafana/" --region "$REGION"

# Database init scripts
aws s3 cp "$DEPLOY_DIR/postgres-init.sql" "s3://${CONFIG_BUCKET}/postgres/init.sql" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/mongodb-init.js" "s3://${CONFIG_BUCKET}/mongodb/mongo-init.js" --region "$REGION"

echo "  Config files uploaded"

# -----------------------------------------------------------------------
# Step 5: Deploy remaining stacks in order
# -----------------------------------------------------------------------

# Determine protocol (HTTPS with domain or self-signed cert, HTTP otherwise)
PROTOCOL="https"
[ -z "$DOMAIN" ] && [ -z "$CERTIFICATE_ARN" ] && PROTOCOL="http"

# Resolve the effective base hostname (custom domain or ALB DNS)
BASE_HOST=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-foundation" \
  --query "Stacks[0].Outputs[?OutputKey=='DomainName'].OutputValue" \
  --output text --region "$REGION")
echo "  Base hostname: $BASE_HOST"

BASE_URL="${PROTOCOL}://${BASE_HOST}"
COMMON_PARAMS=("StackPrefix=${STACK_PREFIX}" "DomainName=${BASE_HOST}")
SECRETS_PARAMS=("AppSecretsName=${APP_SECRETS_NAME}" "GhcrAuthSecretName=${GHCR_AUTH_SECRET_NAME}")

deploy_stack "cluster" "$STACKS_DIR/02-cluster.yaml" "${COMMON_PARAMS[@]}"
deploy_stack "databases" "$STACKS_DIR/03-databases.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"
deploy_stack "services" "$STACKS_DIR/04-services.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}" "BaseUrl=${BASE_URL}"
deploy_stack "observability" "$STACKS_DIR/05-observability.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}" "BaseUrl=${BASE_URL}"
deploy_stack "admin" "$STACKS_DIR/06-admin.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"

# -----------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------
echo ""
echo "========================================"
echo "Deployment Complete"
echo "========================================"
echo ""
echo "  Application:   ${PROTOCOL}://${BASE_HOST}"
echo "  Grafana:       ${PROTOCOL}://${BASE_HOST}/grafana/"
echo "  pgAdmin:       ${PROTOCOL}://${BASE_HOST}/pgadmin/"
echo "  Mongo Express: ${PROTOCOL}://${BASE_HOST}/mongo-express/"
echo "  Registry UI:   ${PROTOCOL}://${BASE_HOST}/registry-ui/"
echo ""
echo "  ECS Console:   https://${REGION}.console.aws.amazon.com/ecs/v2/clusters/pipeline-builder"
echo ""
echo "  Check service status:"
echo "    aws ecs list-services --cluster pipeline-builder --region $REGION"
echo "    aws ecs describe-services --cluster pipeline-builder --services nginx platform pipeline plugin quota billing message frontend --region $REGION"
echo ""
if [ -n "$DOMAIN" ]; then
  echo "  Renew Let's Encrypt certificate (every 60-90 days):"
  echo "    bash bin/init-cert.sh --domain $DOMAIN --region $REGION"
elif [ "$SELF_SIGNED_CERT" = true ]; then
  echo "  Running with self-signed certificate (HTTPS, browser warning expected)."
  echo "  To add a proper domain later, redeploy with --domain and --hosted-zone-id."
else
  echo "  Running without custom domain (HTTP only)."
  echo "  To enable HTTPS without a domain: redeploy with --self-signed-cert"
  echo "  To add a domain later: redeploy with --domain and --hosted-zone-id"
fi
