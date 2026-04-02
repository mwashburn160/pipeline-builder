#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Self-Signed Certificate for ACM
# =============================================================================
# Generates a self-signed TLS certificate and imports it into AWS Certificate
# Manager. Useful for HTTPS without a custom domain (e.g. dev/test environments
# using the ALB DNS name directly).
#
# Browsers will show a security warning, but traffic is encrypted.
#
# Prerequisites:
#   - openssl installed
#   - AWS credentials with ACM permissions
#
# Usage:
#   bash bin/init-self-signed-cert.sh [--region us-east-1] [--cn pipeline-builder]
# =============================================================================
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
CN="pipeline-builder"
DAYS=365

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --cn) CN="$2"; shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== Pipeline Builder - Self-Signed Certificate ==="
echo "  Common Name: $CN"
echo "  Valid for:   $DAYS days"
echo "  Region:      $REGION"
echo ""

CERT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/self-signed-cert.XXXXXX")"

# -----------------------------------------------------------------------
# Check for existing self-signed cert in ACM
# -----------------------------------------------------------------------
echo "=== Checking for existing self-signed certificate ==="
EXISTING_ARN=$(aws acm list-certificates \
  --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='${CN}'].CertificateArn" \
  --output text 2>/dev/null || true)

if [ -n "$EXISTING_ARN" ] && [ "$EXISTING_ARN" != "None" ]; then
  EXPIRY=$(aws acm describe-certificate \
    --certificate-arn "$EXISTING_ARN" \
    --region "$REGION" \
    --query "Certificate.NotAfter" \
    --output text 2>/dev/null || true)

  if [ -n "$EXPIRY" ] && [ "$EXPIRY" != "None" ]; then
    EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "$EXPIRY" +%s 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [ "$DAYS_LEFT" -gt 30 ]; then
      echo "  Valid self-signed certificate found: $EXISTING_ARN"
      echo "  Expires in $DAYS_LEFT days. Reusing."
      echo ""
      echo "CERTIFICATE_ARN=${EXISTING_ARN}"
      rm -rf "$CERT_DIR"
      exit 0
    else
      echo "  Certificate expires in $DAYS_LEFT days. Regenerating..."
    fi
  fi
fi

# -----------------------------------------------------------------------
# Generate self-signed certificate
# -----------------------------------------------------------------------
echo ""
echo "=== Generating self-signed certificate ==="

openssl req -x509 -newkey rsa:2048 \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days "$DAYS" \
  -nodes \
  -subj "/CN=${CN}/O=Pipeline Builder/OU=Self-Signed"

echo "  Certificate generated"

# -----------------------------------------------------------------------
# Import into ACM
# -----------------------------------------------------------------------
echo ""
echo "=== Importing certificate to ACM ==="

if [ -n "$EXISTING_ARN" ] && [ "$EXISTING_ARN" != "None" ]; then
  CERT_ARN=$(aws acm import-certificate \
    --certificate-arn "$EXISTING_ARN" \
    --certificate fileb://"$CERT_DIR/cert.pem" \
    --private-key fileb://"$CERT_DIR/key.pem" \
    --region "$REGION" \
    --query "CertificateArn" \
    --output text)
  echo "  Re-imported to existing ARN: $CERT_ARN"
else
  CERT_ARN=$(aws acm import-certificate \
    --certificate fileb://"$CERT_DIR/cert.pem" \
    --private-key fileb://"$CERT_DIR/key.pem" \
    --region "$REGION" \
    --tags "Key=Name,Value=pipeline-builder-self-signed" \
    --query "CertificateArn" \
    --output text)
  echo "  Imported new certificate: $CERT_ARN"
fi

# -----------------------------------------------------------------------
# Cleanup
# -----------------------------------------------------------------------
rm -rf "$CERT_DIR"

echo ""
echo "=== Self-signed certificate ready ==="
echo ""
echo "CERTIFICATE_ARN=${CERT_ARN}"
echo ""
echo "  Note: Browsers will show a security warning for self-signed certificates."
echo "  To add a proper domain later, redeploy with --domain and --hosted-zone-id."
