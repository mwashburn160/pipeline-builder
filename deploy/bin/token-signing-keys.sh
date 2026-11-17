#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Generate the ES256 (EC P-256) private key platform signs USER tokens with —
# access, refresh, step-up and exchanged access-key tokens. Platform is the only
# holder; every other service verifies against the public half it publishes at
# /.well-known/jwks.json, so this key is never distributed anywhere else.
#
# This is the LOCAL signer (TOKEN_SIGNING_MODE=local), which is what the LOCAL
# targets ship: docker and minikube have no KMS to reach, so they run this
# generator and platform mounts the key it writes.
#
# The AWS targets (ec2, eks) default to TOKEN_SIGNING_MODE=kms, where the
# private key never leaves AWS: this script generates nothing, no token-signing
# Secret is created (pb_create_token_signing_secret skips it), and platform
# signs through kms:Sign. The DEPLOY creates that key — eks in setup.sh
# (pb_ensure_token_signing_kms_key), ec2 as a CloudFormation resource — and
# names it by alias in TOKEN_SIGNING_KMS_KEY_ID. This script fails closed if the
# key is missing rather than writing one on disk that would look like the live
# signer. The IAM grant is the instance role (ec2 template.yaml) or a Pod
# Identity association (eks setup.sh). Set TOKEN_SIGNING_MODE=local to opt out.
# See docs/runbooks/secret-rotation.md.
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
# Writes (0600 — 0644 on the docker target, see KEY_MODE below):
#   <cert_dir>/token-signing/token-signing.key            EC P-256 private key, PKCS#8 PEM
#   <cert_dir>/token-signing/token-signing-previous.key   retiring key, only after --rotate

set -euo pipefail

CERT_DIR=""
ROTATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rotate) ROTATE=1; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    # One positional only — a second path would otherwise silently replace it.
    *) [ -z "$CERT_DIR" ] || { echo "Unexpected argument: $1 (cert_dir already set to '$CERT_DIR')" >&2; exit 1; }
       CERT_DIR="$1"; shift ;;
  esac
done
CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
KEY_DIR="$CERT_DIR/token-signing"

# Private-key file mode. 0600 wherever the key is only read by the user who
# owns it: the k8s targets load it into a Secret with kubectl as that same user
# (ec2's startup.sh chowns it to minikube, the user its kubectl runs as). The
# docker target is the one exception — compose BIND-MOUNTS the file into
# containers that run as assorted uids, which on a Linux host read it as
# "other" — so a cert_dir that sits next to a docker-compose.yml keeps 0644
# (local dev only; tightening it there has broken reads before).
# PB_PRIVATE_KEY_MODE overrides either default.
if [ -n "${PB_PRIVATE_KEY_MODE:-}" ]; then KEY_MODE="$PB_PRIVATE_KEY_MODE"
elif [ -f "$(dirname "$CERT_DIR")/docker-compose.yml" ]; then KEY_MODE=644
else KEY_MODE=600; fi
KEY_FILE="$KEY_DIR/token-signing.key"
PREV_FILE="$KEY_DIR/token-signing-previous.key"

# KMS mode: the signing key lives in AWS and this generator has nothing to do.
# Validate the alias and STOP — do not write a local key that nothing would use
# and that would sit on disk looking like the live signer. Mirrors the same
# guard in plugin-signing-keys.sh.
if [ "${TOKEN_SIGNING_MODE:-local}" = "kms" ]; then
  case "${TOKEN_SIGNING_KMS_KEY_ID:-}" in
    alias/?*) ;;
    "") echo "TOKEN_SIGNING_MODE=kms requires TOKEN_SIGNING_KMS_KEY_ID (alias/<name>)" >&2
        echo "  The deploy normally sets this up for you (eks: setup.sh; ec2: the stack's" >&2
        echo "  TokenSigningKey), so an empty value means .env drifted from the deploy." >&2
        exit 1 ;;
    *) echo "refusing TOKEN_SIGNING_KMS_KEY_ID='${TOKEN_SIGNING_KMS_KEY_ID}': name the key BY ALIAS (alias/<name>) — an ARN embeds the AWS account id" >&2
       exit 1 ;;
  esac
  # A key from an earlier local-mode run is NOT what KMS signs with. Refuse
  # rather than leave a stale private key that no longer mints anything.
  if [ -f "$KEY_FILE" ]; then
    echo "refusing: $KEY_FILE exists but TOKEN_SIGNING_MODE=kms — remove it (the KMS key replaces it; see docs/runbooks/secret-rotation.md)" >&2
    exit 1
  fi
  echo "  token signing: KMS mode ($TOKEN_SIGNING_KMS_KEY_ID) — no local key generated"
  exit 0
fi

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
( umask 077
  openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null \
    | openssl pkcs8 -topk8 -nocrypt -out "$KEY_FILE" )

chmod "$KEY_MODE" "$KEY_FILE"
[ -f "$PREV_FILE" ] && chmod "$KEY_MODE" "$PREV_FILE"

echo "  wrote token signing key: $KEY_FILE"
