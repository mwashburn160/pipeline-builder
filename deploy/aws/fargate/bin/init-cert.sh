#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Self-Signed Certificate for ALB HTTPS
# =============================================================================
# Generates a self-signed TLS certificate and imports it into ACM.
# Reuses an existing certificate if it has >30 days validity remaining.
#
# Usage:
#   bash bin/init-cert.sh [--region us-east-1]
#
# Outputs:
#   CERTIFICATE_ARN=arn:aws:acm:...
# =============================================================================
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
CN="pipeline-builder"
DAYS=365
TAG_NAME="pipeline-builder-self-signed"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --cn) CN="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Check for existing valid cert
EXISTING_ARN=$(aws acm list-certificates \
  --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='${CN}'].CertificateArn" \
  --output text 2>/dev/null || true)

if [ -n "$EXISTING_ARN" ] && [ "$EXISTING_ARN" != "None" ]; then
  NOT_AFTER=$(aws acm describe-certificate \
    --certificate-arn "$EXISTING_ARN" \
    --region "$REGION" \
    --query "Certificate.NotAfter" \
    --output text 2>/dev/null || true)

  if [ -n "$NOT_AFTER" ] && [ "$NOT_AFTER" != "None" ]; then
    EXPIRY_EPOCH=$(date -d "$NOT_AFTER" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "$NOT_AFTER" +%s 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [ "$DAYS_LEFT" -gt 30 ]; then
      echo "  Reusing existing certificate ($DAYS_LEFT days remaining)" >&2
      echo "CERTIFICATE_ARN=${EXISTING_ARN}"
      exit 0
    fi
  fi
fi

# Generate self-signed cert
CERT_DIR="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days "$DAYS" \
  -nodes \
  -subj "/CN=${CN}" \
  2>/dev/null

# Import to ACM
if [ -n "$EXISTING_ARN" ] && [ "$EXISTING_ARN" != "None" ]; then
  CERT_ARN=$(aws acm import-certificate \
    --certificate-arn "$EXISTING_ARN" \
    --certificate fileb://"$CERT_DIR/cert.pem" \
    --private-key fileb://"$CERT_DIR/key.pem" \
    --region "$REGION" \
    --query "CertificateArn" --output text)
else
  CERT_ARN=$(aws acm import-certificate \
    --certificate fileb://"$CERT_DIR/cert.pem" \
    --private-key fileb://"$CERT_DIR/key.pem" \
    --region "$REGION" \
    --tags "Key=Name,Value=${TAG_NAME}" \
    --query "CertificateArn" --output text)
fi

rm -rf "$CERT_DIR"
echo "  Certificate imported: $CERT_ARN" >&2
echo "CERTIFICATE_ARN=${CERT_ARN}"
