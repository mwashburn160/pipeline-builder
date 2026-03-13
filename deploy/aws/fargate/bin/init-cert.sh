#!/bin/bash
# =============================================================================
# Pipeline Builder - Let's Encrypt Certificate via Route53 DNS
# =============================================================================
# Uses certbot with Route53 DNS-01 challenge to obtain a Let's Encrypt
# certificate, then imports it into AWS Certificate Manager (ACM).
#
# Prerequisites:
#   - certbot + certbot-dns-route53 installed
#   - AWS credentials with Route53 + ACM permissions
#
# Usage:
#   bash bin/init-cert.sh --domain pipeline.example.com [--region us-east-1]
#
# To install certbot on macOS:
#   brew install certbot
#   pip3 install certbot-dns-route53
#
# To install on Amazon Linux / Ubuntu:
#   pip3 install certbot certbot-dns-route53
# =============================================================================
set -euo pipefail

DOMAIN=""
REGION="${AWS_REGION:-us-east-1}"
CERT_DIR="/tmp/letsencrypt-${RANDOM}"
EMAIL=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ -z "$DOMAIN" ]; then
  echo "ERROR: --domain is required"
  echo "Usage: bash bin/init-cert.sh --domain pipeline.example.com [--email admin@example.com]"
  exit 1
fi

if [ -z "$EMAIL" ]; then
  EMAIL="admin@${DOMAIN}"
fi

echo "=== Pipeline Builder - Let's Encrypt Certificate ==="
echo "  Domain: $DOMAIN"
echo "  Region: $REGION"
echo "  Email:  $EMAIL"
echo ""

# -----------------------------------------------------------------------
# Check if a valid cert already exists in ACM
# -----------------------------------------------------------------------
echo "=== Checking for existing ACM certificate ==="
EXISTING_ARN=$(aws acm list-certificates \
  --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn" \
  --output text 2>/dev/null || true)

if [ -n "$EXISTING_ARN" ] && [ "$EXISTING_ARN" != "None" ]; then
  # Check if the cert is still valid (not expired)
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
      echo "  Valid certificate found: $EXISTING_ARN"
      echo "  Expires in $DAYS_LEFT days. Skipping renewal."
      echo ""
      echo "CERTIFICATE_ARN=$EXISTING_ARN"
      exit 0
    else
      echo "  Certificate expires in $DAYS_LEFT days. Renewing..."
    fi
  fi
fi

# -----------------------------------------------------------------------
# Obtain Let's Encrypt certificate via DNS-01 challenge
# -----------------------------------------------------------------------
echo ""
echo "=== Requesting Let's Encrypt certificate ==="
echo "  Using DNS-01 challenge via Route53"

mkdir -p "$CERT_DIR"

certbot certonly \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --dns-route53 \
  --preferred-challenges dns-01 \
  --config-dir "$CERT_DIR/config" \
  --work-dir "$CERT_DIR/work" \
  --logs-dir "$CERT_DIR/logs" \
  -d "$DOMAIN"

CERT_PATH="$CERT_DIR/config/live/$DOMAIN"

if [ ! -f "$CERT_PATH/fullchain.pem" ]; then
  echo "ERROR: Certificate files not found at $CERT_PATH"
  exit 1
fi

echo "  Certificate obtained successfully"

# -----------------------------------------------------------------------
# Import certificate into ACM
# -----------------------------------------------------------------------
echo ""
echo "=== Importing certificate to ACM ==="

if [ -n "$EXISTING_ARN" ] && [ "$EXISTING_ARN" != "None" ]; then
  # Re-import to existing ARN (preserves references)
  CERT_ARN=$(aws acm import-certificate \
    --certificate-arn "$EXISTING_ARN" \
    --certificate fileb://"$CERT_PATH/cert.pem" \
    --private-key fileb://"$CERT_PATH/privkey.pem" \
    --certificate-chain fileb://"$CERT_PATH/chain.pem" \
    --region "$REGION" \
    --query "CertificateArn" \
    --output text)
  echo "  Re-imported to existing ARN: $CERT_ARN"
else
  # New import
  CERT_ARN=$(aws acm import-certificate \
    --certificate fileb://"$CERT_PATH/cert.pem" \
    --private-key fileb://"$CERT_PATH/privkey.pem" \
    --certificate-chain fileb://"$CERT_PATH/chain.pem" \
    --region "$REGION" \
    --tags "Key=Name,Value=pipeline-builder-${DOMAIN}" \
    --query "CertificateArn" \
    --output text)
  echo "  Imported new certificate: $CERT_ARN"
fi

# -----------------------------------------------------------------------
# Cleanup
# -----------------------------------------------------------------------
rm -rf "$CERT_DIR"

echo ""
echo "=== Certificate import complete ==="
echo ""
echo "  CERTIFICATE_ARN=$CERT_ARN"
echo ""
echo "  Pass this ARN to deploy.sh:"
echo "    bash bin/deploy.sh --domain $DOMAIN --certificate-arn $CERT_ARN ..."
echo ""
echo "  To renew (run before expiry, typically every 60-90 days):"
echo "    bash bin/init-cert.sh --domain $DOMAIN --region $REGION"
