#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Fargate Deployment Script
# =============================================================================
# Deploys all CloudFormation stacks in dependency order and uploads
# config files to S3.
#
# Usage:
#   bash bin/deploy.sh \
#     --domain pipeline.example.com \
#     --hosted-zone-id Z1234567890 \
#     --ghcr-token ghp_xxxx
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
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate required params
for param in DOMAIN HOSTED_ZONE_ID; do
  if [ -z "${!param}" ]; then
    echo "ERROR: --$(echo "$param" | tr '_' '-' | tr '[:upper:]' '[:lower:]') is required"
    exit 1
  fi
done

echo "========================================"
echo "Pipeline Builder - Fargate Deployment"
echo "========================================"
echo "  Domain:         $DOMAIN"
echo "  Hosted Zone:    $HOSTED_ZONE_ID"
echo "  Region:         $REGION"
echo "  Stack Prefix:   $STACK_PREFIX"
echo ""

# -----------------------------------------------------------------------
# Step 1: Obtain Let's Encrypt certificate (if no --certificate-arn given)
# -----------------------------------------------------------------------
echo "=== Step 1: Ensure TLS certificate exists ==="
if [ -z "$CERTIFICATE_ARN" ]; then
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
FOUNDATION_PARAMS=(
  "StackPrefix=${STACK_PREFIX}"
  "DomainName=${DOMAIN}"
  "HostedZoneId=${HOSTED_ZONE_ID}"
  "CertificateArn=${CERTIFICATE_ARN}"
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
COMMON_PARAMS=("StackPrefix=${STACK_PREFIX}" "DomainName=${DOMAIN}")
SECRETS_PARAMS=("AppSecretsName=${APP_SECRETS_NAME}" "GhcrAuthSecretName=${GHCR_AUTH_SECRET_NAME}")

deploy_stack "cluster" "$STACKS_DIR/02-cluster.yaml" "${COMMON_PARAMS[@]}"
deploy_stack "databases" "$STACKS_DIR/03-databases.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"
deploy_stack "services" "$STACKS_DIR/04-services.yaml" "${COMMON_PARAMS[@]}" "${SECRETS_PARAMS[@]}"
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
echo "  Application:   https://${DOMAIN}"
echo "  Grafana:       https://${DOMAIN}/grafana/"
echo "  pgAdmin:       https://${DOMAIN}/pgadmin/"
echo "  Mongo Express: https://${DOMAIN}/mongo-express/"
echo "  Registry UI:   https://${DOMAIN}/registry-express/"
echo ""
echo "  ECS Console:   https://${REGION}.console.aws.amazon.com/ecs/v2/clusters/pipeline-builder"
echo ""
echo "  Check service status:"
echo "    aws ecs list-services --cluster pipeline-builder --region $REGION"
echo "    aws ecs describe-services --cluster pipeline-builder --services nginx platform pipeline plugin quota billing message frontend --region $REGION"
echo ""
echo "  Renew Let's Encrypt certificate (every 60-90 days):"
echo "    bash bin/init-cert.sh --domain $DOMAIN --region $REGION"
