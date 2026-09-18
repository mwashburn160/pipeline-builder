#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Generate the ES256 (EC P-256) private key platform signs USER tokens with —
# access, refresh, step-up and exchanged access-key tokens. Platform is the only
# holder; every other service verifies against the public half it publishes at
# /.well-known/jwks.json, so this key is never distributed anywhere else.
#
# This is the LOCAL signer (TOKEN_SIGNING_MODE=local): docker and minikube. The
# AWS targets set TOKEN_SIGNING_MODE=kms and keep the private key inside KMS
# instead — see docs/runbooks/secret-rotation.md.
#
#   token-signing-keys.sh [cert_dir] [--rotate]
#
# cert_dir defaults to <this script's ..>/certs. The keys are written to a
# `token-signing/` SUBDIRECTORY of it, so compose can bind-mount that one
# directory into platform (and a key added by a later --rotate appears without a
# compose change) without exposing the other key material in cert_dir.
# Idempotent: skips when the key already exists, so re-running setup never
# invalidates live sessions.
#
# --rotate performs the FIRST half of a key rotation: the current key is moved to
# token-signing-previous.key (platform keeps PUBLISHING it, so tokens it signed
# stay valid) and a fresh key takes its place. Finish the rotation by deleting
# token-signing-previous.key (and unsetting TOKEN_SIGNING_KEY_PREVIOUS_FILE) once
# every token signed with it has expired.
#
# Writes (chmod 644 — deploy convention, see deploy/*/startup.sh):
#   <cert_dir>/token-signing/token-signing.key            EC P-256 private key, PKCS#8 PEM
#   <cert_dir>/token-signing/token-signing-previous.key   retiring key, only after --rotate

set -euo pipefail

CERT_DIR=""
ROTATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rotate) ROTATE=1; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) CERT_DIR="$1"; shift ;;
  esac
done
CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
KEY_DIR="$CERT_DIR/token-signing"
KEY_FILE="$KEY_DIR/token-signing.key"
PREV_FILE="$KEY_DIR/token-signing-previous.key"

mkdir -p "$KEY_DIR"

# Self-heal: a `docker compose up` that ran before the file existed makes Docker
# auto-create the bind-mount source as an empty DIRECTORY, which openssl cannot
# write over. Mirrors jwt-keys.sh.
for f in "$KEY_FILE" "$PREV_FILE"; do
  if [ -e "$f" ] && [ ! -f "$f" ]; then
    echo "  clearing stale non-file at $f (likely a leftover Docker bind-mount dir)"
    rm -rf "$f"
  fi
done

if [ -f "$KEY_FILE" ] && [ -z "$ROTATE" ]; then
  echo "  token signing key already present in $CERT_DIR (use --rotate to roll it)"
  exit 0
fi

if [ -n "$ROTATE" ]; then
  if [ ! -f "$KEY_FILE" ]; then
    echo "refusing to rotate: no current key at $KEY_FILE" >&2
    exit 1
  fi
  mv "$KEY_FILE" "$PREV_FILE"
  echo "  retired the current signing key to $PREV_FILE (still published for verification)"
fi

# prime256v1 IS NIST P-256 — the curve ES256 pins, and the same one the AWS
# targets use in KMS (ECC_NIST_P256), so a deployment can move between signers
# without changing the token format. PKCS#8 so Node reads it without a hint.
openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null \
  | openssl pkcs8 -topk8 -nocrypt -out "$KEY_FILE"

# 644 (not 600): the deploy convention — mounted into containers that run as
# assorted uids, and tightening to 600 has broken reads before.
chmod 644 "$KEY_FILE"
[ -f "$PREV_FILE" ] && chmod 644 "$PREV_FILE"

echo "  wrote token signing key: $KEY_FILE"
