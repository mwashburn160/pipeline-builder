#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Fargate Secrets Initialization
# =============================================================================
# Generates random secrets and stores them in AWS Secrets Manager.
# Run once before deploying stacks, or re-run to rotate secrets.
#
# ROTATION: Secrets should be rotated every 90 days. Re-run this script to
# generate new values. After rotation, restart all ECS services to pick up
# the new secrets. Consider setting a calendar reminder or using AWS Config
# rules to enforce rotation schedules.
#
# Usage: bash bin/init-secrets.sh [--domain pipeline.example.com] [--ghcr-token ghp_xxx]
# =============================================================================
set -euo pipefail

# Parse arguments
DOMAIN=""
SECRET_NAME="pipeline-builder/app-secrets"
GHCR_SECRET_NAME="pipeline-builder/ghcr-auth"
GHCR_TOKEN=""
# ghcr.io validates only the PAT for token auth — the username field just has to
# be non-empty (its value is ignored), so it's a fixed constant (the image owner)
# rather than a deploy flag.
GHCR_USER="mwashburn160"
REGION="${AWS_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --ghcr-token) GHCR_TOKEN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --secret-name) SECRET_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== Pipeline Builder - Secrets Initialization ==="
echo "  Domain: ${DOMAIN:-"(none)"}"
echo "  Region: $REGION"
echo "  Secret: $SECRET_NAME"

# Generate random secrets
echo ""
echo "=== Generating random secrets ==="
JWT_SECRET=$(openssl rand -base64 32)
REFRESH_TOKEN_SECRET=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')
MONGO_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')
ME_BASICAUTH_PASSWORD=$(openssl rand -base64 16 | tr -d '=+/')
PGADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d '=+/')
REGISTRY_TOKEN=$(openssl rand -base64 24 | tr -d '=+/')

# RSA keypair for the Docker registry token-auth flow. Both halves go into
# the same secret JSON so the image-registry task signs with the private key
# and the registry verifies with the certificate. Newlines are JSON-escaped
# so the multi-line PEM survives a `cat <<EOF` heredoc → JSON round-trip.
REGISTRY_KEY_DIR=$(mktemp -d)
trap 'rm -rf "$REGISTRY_KEY_DIR"' EXIT
openssl genrsa -out "$REGISTRY_KEY_DIR/jwt-private.pem" 4096 2>/dev/null
openssl req -x509 -new -nodes -key "$REGISTRY_KEY_DIR/jwt-private.pem" -sha256 -days 3650 \
  -subj "/CN=pipeline-image-registry-token-issuer" \
  -out "$REGISTRY_KEY_DIR/jwt-public.pem" 2>/dev/null
REGISTRY_TOKEN_PRIVATE_KEY=$(awk 'BEGIN{ORS="\\n"} {print}' "$REGISTRY_KEY_DIR/jwt-private.pem")
REGISTRY_TOKEN_CERTIFICATE=$(awk 'BEGIN{ORS="\\n"} {print}' "$REGISTRY_KEY_DIR/jwt-public.pem")

# Build the secrets JSON
SECRETS_JSON=$(cat <<EOF
{
  "JWT_SECRET": "${JWT_SECRET}",
  "REFRESH_TOKEN_SECRET": "${REFRESH_TOKEN_SECRET}",
  "POSTGRES_USER": "postgres",
  "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}",
  "DB_USER": "postgres",
  "DB_PASSWORD": "${POSTGRES_PASSWORD}",
  "MONGO_INITDB_ROOT_USERNAME": "mongo",
  "MONGO_INITDB_ROOT_PASSWORD": "${MONGO_PASSWORD}",
  "MONGODB_URI": "mongodb://mongo:${MONGO_PASSWORD}@mongodb.pipeline-builder.local:27017/platform?replicaSet=rs0&authSource=admin",
  "ME_CONFIG_BASICAUTH_USERNAME": "admin",
  "ME_CONFIG_BASICAUTH_PASSWORD": "${ME_BASICAUTH_PASSWORD}",
  "ME_CONFIG_MONGODB_ADMINUSERNAME": "mongo",
  "ME_CONFIG_MONGODB_ADMINPASSWORD": "${MONGO_PASSWORD}",
  "PGADMIN_DEFAULT_EMAIL": "admin@${DOMAIN:-localhost}",
  "PGADMIN_DEFAULT_PASSWORD": "${PGADMIN_PASSWORD}",
  "IMAGE_REGISTRY_USER": "admin",
  "IMAGE_REGISTRY_TOKEN": "${REGISTRY_TOKEN}",
  "REGISTRY_TOKEN_PRIVATE_KEY": "${REGISTRY_TOKEN_PRIVATE_KEY}",
  "REGISTRY_TOKEN_CERTIFICATE": "${REGISTRY_TOKEN_CERTIFICATE}",
  "ANTHROPIC_API_KEY": "",
  "OPENAI_API_KEY": "",
  "GOOGLE_GENERATIVE_AI_API_KEY": "",
  "XAI_API_KEY": ""
}
EOF
)

# Create or update the secret
echo ""
echo "=== Storing secrets in Secrets Manager ==="
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "$SECRET_NAME" \
    --secret-string "$SECRETS_JSON" \
    --region "$REGION"
  echo "  Updated existing secret: $SECRET_NAME"
else
  aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --description "Pipeline Builder application secrets" \
    --secret-string "$SECRETS_JSON" \
    --region "$REGION"
  echo "  Created new secret: $SECRET_NAME"
fi

# Create GHCR docker auth secret (for ECS to pull private images)
if [ -n "$GHCR_TOKEN" ]; then
  echo ""
  echo "=== Storing GHCR auth in Secrets Manager ==="
  GHCR_AUTH_JSON=$(cat <<EOF
{
  "username": "${GHCR_USER}",
  "password": "${GHCR_TOKEN}"
}
EOF
)
  if aws secretsmanager describe-secret --secret-id "$GHCR_SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --secret-id "$GHCR_SECRET_NAME" \
      --secret-string "$GHCR_AUTH_JSON" \
      --region "$REGION"
    echo "  Updated existing secret: $GHCR_SECRET_NAME"
  else
    aws secretsmanager create-secret \
      --name "$GHCR_SECRET_NAME" \
      --description "GHCR authentication for pulling private images" \
      --secret-string "$GHCR_AUTH_JSON" \
      --region "$REGION"
    echo "  Created new secret: $GHCR_SECRET_NAME"
  fi
else
  echo ""
  echo "  WARNING: No --ghcr-token provided. GHCR auth not configured."
  echo "  Private images from ghcr.io will not be pullable."
fi

echo ""
echo "=== Secrets initialization complete ==="
echo ""
echo "  App secrets:  $SECRET_NAME"
echo "  GHCR auth:    $GHCR_SECRET_NAME"
echo ""
# Only print the actual passwords to an interactive terminal. When stdout is
# piped/redirected (CI logs, `tee` transcripts, setup.sh capture) the values
# would otherwise be persisted in plaintext — so suppress them there and point
# the operator at Secrets Manager instead.
if [ -t 1 ]; then
  echo "  Credentials generated (shown once — save them):"
  echo "    PostgreSQL:    postgres / ${POSTGRES_PASSWORD}"
  echo "    MongoDB:       mongo / ${MONGO_PASSWORD}"
  echo "    Mongo Express: admin / ${ME_BASICAUTH_PASSWORD}"
  echo "    pgAdmin:       admin@${DOMAIN:-localhost} / ${PGADMIN_PASSWORD}"
  echo "    Registry:      admin / ${REGISTRY_TOKEN}"
else
  echo "  Credentials stored in Secrets Manager (not printed to a non-interactive"
  echo "  stream). Retrieve with:"
  echo "    aws secretsmanager get-secret-value --secret-id ${SECRET_NAME} \\"
  echo "      --query SecretString --output text"
fi
