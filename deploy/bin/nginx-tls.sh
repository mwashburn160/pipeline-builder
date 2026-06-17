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
# Idempotent: skips when both files already exist. Writes (chmod 644 key — deploy
# convention): <cert_dir>/nginx-tls.crt and <cert_dir>/nginx-tls.key.

set -euo pipefail

CERT_DIR="${1:?usage: nginx-tls.sh <cert_dir>}"
CRT="$CERT_DIR/nginx-tls.crt"
KEY="$CERT_DIR/nginx-tls.key"

if [ -f "$CRT" ] && [ -f "$KEY" ]; then
  echo "  nginx TLS certificate already present in $CERT_DIR"
  exit 0
fi

mkdir -p "$CERT_DIR"
if command -v mkcert >/dev/null 2>&1; then
  echo "=== Generating browser-trusted nginx TLS certificate via mkcert ==="
  mkcert -install >/dev/null 2>&1 || true   # idempotent
  mkcert -cert-file "$CRT" -key-file "$KEY" localhost 127.0.0.1 ::1
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
subjectAltName = DNS:localhost,IP:127.0.0.1
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
SANEOF
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$KEY" -out "$CRT" -config "$_sancnf"
  rm -f "$_sancnf"
fi
chmod 644 "$KEY" "$CRT"
