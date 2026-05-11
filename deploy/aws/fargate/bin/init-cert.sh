#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - Self-Signed Certificate for ALB HTTPS
# =============================================================================
# Generates a self-signed TLS certificate and imports it into ACM.
# Reuses an existing certificate if it has >30 days validity remaining.
#
# Usage:
#   bash bin/init-cert.sh --domain pipeline.example.com [--region us-east-1]
#
# --domain is REQUIRED. Pass the hostname (or ALB DNS name from a prior deploy)
# clients will use to reach the ALB. The cert's CN and Subject Alternative Name
# both reflect this value — without a matching SAN, modern TLS clients
# (OpenSSL 3+, Go stdlib) reject the cert with "certificate verify failed".
#
# Outputs:
#   CERTIFICATE_ARN=arn:aws:acm:...
#   CERTIFICATE_PEM_B64=<base64-encoded PEM>
# =============================================================================
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DOMAIN=""
DAYS=365
TAG_NAME="pipeline-builder-self-signed"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --cn) DOMAIN="$2"; shift 2 ;;  # back-compat alias
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ -z "$DOMAIN" ]; then
  echo "ERROR: --domain is required (the hostname clients use to reach the ALB)" >&2
  echo "  e.g. bash bin/init-cert.sh --domain pipeline.example.com" >&2
  echo "  For a first deploy where the ALB DNS isn't known yet, pass a" >&2
  echo "  placeholder (e.g. pipeline-builder.local), deploy once to get" >&2
  echo "  the ALB DNS name, then re-run with --domain <alb-dns>." >&2
  exit 1
fi

# OpenSSL/RFC 6125: IP literals need IP: SAN, hostnames need DNS: SAN.
if printf '%s' "$DOMAIN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  SAN_ENTRY="IP:${DOMAIN}"
else
  SAN_ENTRY="DNS:${DOMAIN}"
fi
CN="$DOMAIN"

# Check for existing valid cert. Matches on ACM's DomainName field which
# mirrors the cert's CN — so re-running with the same --domain reuses the
# cert when >30d valid. Changing --domain produces a fresh cert (correct,
# since the SAN must match).
EXISTING_ARN=$(aws acm list-certificates \
  --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='${CN}'].CertificateArn | [0]" \
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
      # Re-emit the existing cert's PEM so callers can trust it downstream
      # (e.g. init-secrets.sh injects PLATFORM_CA_CERT into app-secrets).
      EXISTING_PEM=$(aws acm get-certificate \
        --certificate-arn "$EXISTING_ARN" \
        --region "$REGION" \
        --query "Certificate" --output text 2>/dev/null || true)
      if [ -n "$EXISTING_PEM" ]; then
        echo "CERTIFICATE_PEM_B64=$(printf '%s' "$EXISTING_PEM" | base64 -w0 2>/dev/null || printf '%s' "$EXISTING_PEM" | base64 | tr -d '\n')"
      fi
      exit 0
    fi
  fi
fi

# Generate self-signed cert
CERT_DIR="$(mktemp -d)"
[ -n "$CERT_DIR" ] && [ -d "$CERT_DIR" ] || { echo "ERROR: failed to create temp directory" >&2; exit 1; }
trap 'rm -rf "$CERT_DIR"' EXIT
openssl req -x509 -newkey rsa:2048 \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days "$DAYS" \
  -nodes \
  -subj "/CN=${CN}" \
  -addext "subjectAltName=${SAN_ENTRY}" \
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

echo "  Certificate imported: $CERT_ARN" >&2
echo "CERTIFICATE_ARN=${CERT_ARN}"
# Emit the PEM as base64 so deploy.sh can pipe it through shell vars and
# pass it to init-secrets.sh. The PEM is mounted into the plugin container
# at runtime so kaniko trusts the ALB's self-signed cert when following
# bearer-token challenges to ${PlatformBaseUrl}/image-registry/token.
echo "CERTIFICATE_PEM_B64=$(base64 -w0 < "$CERT_DIR/cert.pem" 2>/dev/null || base64 < "$CERT_DIR/cert.pem" | tr -d '\n')"
