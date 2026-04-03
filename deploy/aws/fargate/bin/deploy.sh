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

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --ghcr-token) GHCR_TOKEN="$2"; shift 2 ;;
    --ghcr-user) GHCR_USER="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --stack-prefix) STACK_PREFIX="$2"; shift 2 ;;
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
echo ""

# -----------------------------------------------------------------------
# Step 1: Generate self-signed certificate for HTTPS
# -----------------------------------------------------------------------
echo "=== Step 1: Ensure TLS certificate exists ==="
CERT_OUTPUT=$(bash "$SCRIPT_DIR/init-cert.sh" --region "$REGION")
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
FOUNDATION_PARAMS=("StackPrefix=${STACK_PREFIX}")
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

aws s3 cp "$DEPLOY_DIR/nginx/nginx-fargate.conf" "s3://${CONFIG_BUCKET}/nginx/nginx.conf" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/nginx/jwt.js" "s3://${CONFIG_BUCKET}/nginx/jwt.js" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/nginx/metrics.js" "s3://${CONFIG_BUCKET}/nginx/metrics.js" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/prometheus/prometheus.yml" "s3://${CONFIG_BUCKET}/prometheus/prometheus.yml" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/loki/loki-config.yml" "s3://${CONFIG_BUCKET}/loki/loki-config.yml" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/fluent-bit/fluent-bit.conf" "s3://${CONFIG_BUCKET}/fluent-bit/fluent-bit.conf" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/config/fluent-bit/parsers.conf" "s3://${CONFIG_BUCKET}/fluent-bit/parsers.conf" --region "$REGION"
aws s3 sync "$DEPLOY_DIR/config/grafana/" "s3://${CONFIG_BUCKET}/grafana/" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/postgres-init.sql" "s3://${CONFIG_BUCKET}/postgres/init.sql" --region "$REGION"
aws s3 cp "$DEPLOY_DIR/mongodb-init.js" "s3://${CONFIG_BUCKET}/mongodb/mongo-init.js" --region "$REGION"
echo "  Done"

# -----------------------------------------------------------------------
# Step 5: Deploy remaining stacks
# -----------------------------------------------------------------------
BASE_HOST=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-foundation" \
  --query "Stacks[0].Outputs[?OutputKey=='DomainName'].OutputValue" \
  --output text --region "$REGION")

COMMON_PARAMS=("StackPrefix=${STACK_PREFIX}" "DomainName=${BASE_HOST}")
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
echo "  HTTP:          http://${BASE_HOST}"
if [ -n "$CERTIFICATE_ARN" ]; then
echo "  HTTPS:         https://${BASE_HOST}  (self-signed — accept browser warning)"
fi
echo ""
echo "  Grafana:       http://${BASE_HOST}/grafana/"
echo "  pgAdmin:       http://${BASE_HOST}/pgadmin/"
echo "  Mongo Express: http://${BASE_HOST}/mongo-express/"
echo "  Registry UI:   http://${BASE_HOST}/registry-ui/"
echo ""
echo "  ECS Console:   https://${REGION}.console.aws.amazon.com/ecs/v2/clusters/pipeline-builder"
