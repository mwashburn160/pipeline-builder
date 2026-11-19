#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Generate the RUNNER-signing key: the Ed25519 key the pipeline service signs
# every run request (start / stop / probe / ping) it sends to a customer's
# cross-account pipeline runner with (compact JWS, alg EdDSA, typ pb-run+jwt).
# The runner Lambda — in the CUSTOMER's AWS account — verifies each request
# against the PUBLIC half, which the pipeline service serves unauthenticated at
#   GET /api/pipelines/runner/jwks.json
# so nothing secret ever leaves this host and the platform holds no AWS access
# for the customer's account.
#
# A DEDICATED key, never the user-token or service-token key: a runner that
# trusted either would start pipelines on any token the platform mints.
#
#   runner-signing-keys.sh <cert_dir> [--rotate|--finish]
#
# cert_dir is REQUIRED and is the deploy target's certs directory
# (deploy/local/docker/certs, deploy/aws/eks/certs, …). The key is written to a
# `runner-signing/` SUBDIRECTORY so compose can bind-mount that one directory
# into the pipeline service and nothing else.
#
# Writes (0600 — 0644 on the docker target, see KEY_MODE below):
#   <cert_dir>/runner-signing/runner-signing.key           Ed25519 private key, PKCS#8 PEM
#   <cert_dir>/runner-signing/runner-signing-previous.key  retiring key, only after --rotate
#
# Idempotent: an existing key is left alone, so re-running setup never breaks
# requests in flight or runners' cached JWKS.
#
# ROTATION is two-phase and must be done in this order:
#   1. `--rotate`  moves the current key to runner-signing-previous.key and
#      generates a new one. The JWKS then publishes BOTH public keys; restart
#      the pipeline service so it signs with the new key.
#   2. Wait at least 10 minutes — a run request expires 600 s after it is
#      signed, and runners re-fetch the JWKS on an unknown `kid`.
#   3. `--finish`  deletes runner-signing-previous.key (dropped from the JWKS
#      on the next pipeline restart).
# A `--rotate` while runner-signing-previous.key exists is refused (exit 1,
# both keys untouched): finish the rotation in flight first.
# See docs/runbooks/secret-rotation.md.

set -euo pipefail

CERT_DIR=""
ROTATE=0
FINISH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rotate) ROTATE=1; shift ;;
    --finish) FINISH=1; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    # One positional only — a second path would otherwise silently replace it.
    *) [ -z "$CERT_DIR" ] || { echo "Unexpected argument: $1 (cert_dir already set to '$CERT_DIR')" >&2; exit 1; }
       CERT_DIR="$1"; shift ;;
  esac
done
[ -n "$CERT_DIR" ] || { echo "ERROR: cert_dir is required — pass the deploy target's certs directory, e.g. deploy/aws/eks/certs" >&2; exit 1; }
[ "$ROTATE" -eq 1 ] && [ "$FINISH" -eq 1 ] && { echo "ERROR: --rotate and --finish are separate phases; run them apart (≥ 10 minutes between)" >&2; exit 1; }

KEY_DIR="$CERT_DIR/runner-signing"
KEY_FILE="$KEY_DIR/runner-signing.key"
PREV_FILE="$KEY_DIR/runner-signing-previous.key"

# Private-key file mode. 0600 wherever the key is only read by the user who
# owns it: the k8s targets load it into a Secret with kubectl as that same user.
# The docker target is the one exception — compose BIND-MOUNTS the file into a
# container that runs as another uid, which on a Linux host reads it as
# "other" — so a cert_dir that sits next to a docker-compose.yml keeps 0644
# (local dev only). PB_PRIVATE_KEY_MODE overrides either default.
if [ -n "${PB_PRIVATE_KEY_MODE:-}" ]; then KEY_MODE="$PB_PRIVATE_KEY_MODE"
elif [ -f "$(dirname "$CERT_DIR")/docker-compose.yml" ]; then KEY_MODE=644
else KEY_MODE=600; fi

command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl is required" >&2; exit 1; }

mkdir -p "$KEY_DIR"

# Self-heal: a `docker compose up` that ran before the file existed makes Docker
# auto-create the bind-mount source as an empty DIRECTORY, which openssl cannot
# write over. Mirrors token-signing-keys.sh.
for f in "$KEY_FILE" "$PREV_FILE"; do
  if [ -e "$f" ] && [ ! -f "$f" ]; then
    echo "  clearing stale non-file at $f (likely a leftover Docker bind-mount dir)"
    rm -rf "$f"
  fi
done

if [ "$FINISH" -eq 1 ]; then
  if [ -f "$PREV_FILE" ]; then
    rm -f "$PREV_FILE"
    echo "  finished runner-signing rotation (retiring key dropped)"
  else
    echo "  no retiring runner-signing key to drop"
  fi
fi

if [ "$ROTATE" -eq 1 ]; then
  [ -f "$KEY_FILE" ] || { echo "refusing to rotate: no current key at $KEY_FILE" >&2; exit 1; }
  # A rotation already in flight: moving the current key aside again would
  # overwrite the retiring key while requests signed with it may still be live.
  [ -f "$PREV_FILE" ] && { echo "refusing to rotate: a retiring key exists at $PREV_FILE — run --finish first" >&2; exit 1; }
  mv "$KEY_FILE" "$PREV_FILE"
  echo "  retired the runner-signing key to $PREV_FILE (still published in the JWKS)"
fi

_generate() {  # _generate <key_file> — Ed25519 (EdDSA), PKCS#8 PEM
  # OpenSSL 1.1.1+ has Ed25519; the LibreSSL macOS ships does not, so fall back
  # to node:crypto (the same library that signs with the key) when it refuses.
  local _tmp
  _tmp="$(mktemp "$KEY_DIR/.runner-signing.key.XXXXXX")"
  if ( umask 077; openssl genpkey -algorithm ed25519 -out "$_tmp" ) 2>/dev/null && [ -s "$_tmp" ]; then
    :
  elif command -v node >/dev/null 2>&1; then
    ( umask 077
      node -e 'const { generateKeyPairSync } = require("crypto");
        process.stdout.write(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));' > "$_tmp" )
  else
    rm -f "$_tmp"
    echo "ERROR: need an openssl with Ed25519 (OpenSSL >= 1.1.1) or node to generate the runner signing key" >&2
    exit 1
  fi
  [ -s "$_tmp" ] || { rm -f "$_tmp"; echo "ERROR: runner signing key generation produced no key" >&2; exit 1; }
  mv "$_tmp" "$1"
  chmod "$KEY_MODE" "$1"
}

if [ ! -f "$KEY_FILE" ]; then
  _generate "$KEY_FILE"
  echo "  wrote runner signing key: $KEY_FILE"
fi
[ -f "$PREV_FILE" ] && chmod "$KEY_MODE" "$PREV_FILE"
exit 0
