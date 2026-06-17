#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Generate the RS256 keypair + x509 cert used by `pipeline-image-registry`'s
# Docker registry token auth. The registry verifies tokens using the x509 cert
# (mounted as REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE); the service signs tokens with
# the matching private key (loaded via REGISTRY_TOKEN_PRIVATE_KEY).
#
# Shared by every deploy target (local/docker, local/minikube, aws/ec2) — was
# `deploy/local/docker/bin/gen-image-registry-jwt-keys.sh`, lifted into deploy/bin
# (always in the provision sparse-checkout) so the targets stop hand-rolling
# near-identical openssl blocks. eks generates an ephemeral pair inline (it goes
# straight into a Secret and is discarded), so it doesn't use this.
#
#   jwt-keys.sh [cert_dir] [--force]
#
# cert_dir defaults to <this script's ..>/certs. Idempotent: skips when both files
# already exist (so re-running setup doesn't invalidate issued registry tokens);
# pass --force to regenerate. Writes (chmod 644 — deploy convention, see
# deploy/*/startup.sh):
#   <cert_dir>/image-registry-jwt.key   RSA private key (4096-bit, PEM)
#   <cert_dir>/image-registry-jwt.crt   Self-signed x509 cert (PEM)

set -euo pipefail

CERT_DIR=""
FORCE=""
# while/case (not a bare for-loop) so an unknown --flag errors instead of being
# silently swallowed as the cert_dir — consistent with the other deploy/bin scripts.
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) CERT_DIR="$1"; shift ;;
  esac
done
CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
KEY_FILE="$CERT_DIR/image-registry-jwt.key"
CERT_FILE="$CERT_DIR/image-registry-jwt.crt"

if [ -f "$KEY_FILE" ] && [ -f "$CERT_FILE" ] && [ -z "$FORCE" ]; then
  echo "  registry JWT keypair already present in $CERT_DIR (use --force to regenerate)"
  exit 0
fi

mkdir -p "$CERT_DIR"

# 4096-bit RSA — matches the registry's expected RS256 verification. The cert is
# self-signed with 10-year validity (rotate by regenerating with --force); the
# subject is informational only — the registry uses just the embedded public key.
openssl genrsa -out "$KEY_FILE" 4096
openssl req -x509 -new -nodes -key "$KEY_FILE" -sha256 -days 3650 \
  -subj "/CN=pipeline-image-registry-token-issuer" \
  -out "$CERT_FILE"

# 644 (not 600): the deploy convention — these are mounted into containers that
# run as assorted uids, and tightening to 600 has broken reads before.
chmod 644 "$KEY_FILE" "$CERT_FILE"

echo "  wrote registry JWT keypair: $KEY_FILE + $CERT_FILE"
