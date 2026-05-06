#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Generate the RS256 keypair + x509 cert used by `pipeline-image-registry`'s
# Docker registry token auth. The registry verifies tokens using the x509 cert
# (mounted as REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE); the service signs tokens
# with the matching private key (loaded via REGISTRY_TOKEN_PRIVATE_KEY).
#
# Run once at deploy time. Both key + cert must be present before the
# registry container starts in token-auth mode (it won't accept any push/pull
# without them).
#
# Outputs:
#   deploy/local/certs/registry-token.key      RSA private key (4096-bit, PEM)
#   deploy/local/certs/registry-token.crt      Self-signed x509 cert (PEM)
#
# To rotate keys: regenerate both files, restart registry, restart
# pipeline-image-registry. Tokens issued under the old key stop working
# immediately. (The Distribution registry can also accept a bundle with
# multiple certs for rolling rotation; document that separately.)

set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
KEY_FILE="$CERT_DIR/registry-token.key"
CERT_FILE="$CERT_DIR/registry-token.crt"

if [ -f "$KEY_FILE" ] && [ -f "$CERT_FILE" ] && [ "${1:-}" != "--force" ]; then
  echo "Key + cert already exist at $CERT_DIR. Use --force to regenerate."
  exit 0
fi

mkdir -p "$CERT_DIR"

# 4096-bit RSA — matches the registry's expected RS256 verification.
openssl genrsa -out "$KEY_FILE" 4096

# Self-signed x509 cert with 10-year validity (long-lived; rotate by
# regenerating). Subject is informational only; the registry only uses the
# embedded public key for verification.
openssl req -x509 -new -nodes -key "$KEY_FILE" -sha256 -days 3650 \
  -subj "/CN=pipeline-image-registry-token-issuer" \
  -out "$CERT_FILE"

chmod 600 "$KEY_FILE"
chmod 644 "$CERT_FILE"

echo "Wrote:"
echo "  Private key: $KEY_FILE"
echo "  Certificate: $CERT_FILE"
echo ""
echo "Mount $CERT_FILE into the registry as REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE."
echo "Mount $KEY_FILE into pipeline-image-registry as REGISTRY_TOKEN_PRIVATE_KEY."
