#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Ensure a TLS cert/key for the nginx gateway exists in <cert_dir>. Shared by the
# local targets (local/docker, local/minikube) — the AWS targets terminate TLS at
# the ALB (ACM), so they don't use this.
#
#   nginx-tls.sh <cert_dir>
#
# Prefers mkcert: it issues a browser-trusted leaf via a local CA it installs into
# the OS/browser trust stores, so https on localhost has NO cert warnings (no
# ERR_CERT_AUTHORITY_INVALID on the JS chunks). Falls back to a hardened self-signed
# cert — the SAN/EKU config is built via a temp file so it works on both OpenSSL and
# the LibreSSL shipped by older macOS (which lacks `req -addext`);
# extendedKeyUsage=serverAuth + basicConstraints let it be trusted once imported.
#
# Idempotent: skips when both files already exist AND the cert names `nginx`
# (the in-network hostname the frontend server calls). Writes (chmod 644 key —
# deploy convention): <cert_dir>/nginx-tls.crt, <cert_dir>/nginx-tls.key, and
# <cert_dir>/dev-ca.crt — the CA that issued the leaf (mkcert's root, or the
# self-signed leaf itself). The release images trust NO dev CA; the local
# targets mount dev-ca.crt into the containers and point NODE_EXTRA_CA_CERTS
# at it, so server-side HTTPS to the gateway verifies instead of being skipped.

set -euo pipefail

CERT_DIR="${1:?usage: nginx-tls.sh <cert_dir>}"
CRT="$CERT_DIR/nginx-tls.crt"
KEY="$CERT_DIR/nginx-tls.key"
CA="$CERT_DIR/dev-ca.crt"

# The SANs the gateway cert must carry: browsers use localhost/127.0.0.1, the
# frontend server reaches the gateway as `nginx` inside the network.
if [ -f "$CRT" ] && [ -f "$KEY" ] && [ -f "$CA" ] \
   && openssl x509 -in "$CRT" -noout -text 2>/dev/null | grep -q 'DNS:nginx'; then
  echo "  nginx TLS certificate already present in $CERT_DIR"
  exit 0
fi

mkdir -p "$CERT_DIR"
if command -v mkcert >/dev/null 2>&1; then
  echo "=== Generating browser-trusted nginx TLS certificate via mkcert ==="
  mkcert -install >/dev/null 2>&1 || true   # idempotent
  mkcert -cert-file "$CRT" -key-file "$KEY" localhost 127.0.0.1 ::1 nginx
  cp "$(mkcert -CAROOT)/rootCA.pem" "$CA"
else
  echo "=== Generating self-signed nginx TLS certificate (install 'mkcert' for an auto-trusted cert) ==="
  _sancnf=$(mktemp)
  cat > "$_sancnf" <<'SANEOF'
[req]
distinguished_name = dn
x509_extensions = v3ext
prompt = no
[dn]
CN = localhost
[v3ext]
subjectAltName = DNS:localhost,DNS:nginx,IP:127.0.0.1
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
SANEOF
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$KEY" -out "$CRT" -config "$_sancnf"
  rm -f "$_sancnf"
  # A self-signed leaf is its own trust anchor.
  cp "$CRT" "$CA"
fi
chmod 644 "$KEY" "$CRT" "$CA"
