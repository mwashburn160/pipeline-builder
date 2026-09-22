#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Provision the plugin-IMAGE signing keypair (EC P-256). Every plugin image the
# plugin service pushes is signed with cosign (key-based, transparency log off)
# and gets a signed SPDX SBOM attestation; synth then pins CodeBuild to the
# verified digest.
#
# The two halves go to DIFFERENT services, and that split is the point:
#   - the PRIVATE key is held by image-registry ALONE, which signs on request at
#     POST /internal/plugin-signatures (service token, caller must be `plugin`);
#   - the PUBLIC key is all the plugin service gets — it only runs `cosign
#     verify`. The plugin pod shares its network namespace with the buildkitd
#     sidecar that executes untrusted tenant Dockerfile RUN steps, so it must
#     never hold (or be able to read) the signing key.
#
#   plugin-signing-keys.sh [cert_dir]
#
# cert_dir defaults to <this script's ..>/certs. The keys are written to a
# `plugin-signing/` SUBDIRECTORY of it, mirroring token-signing-keys.sh. Unlike
# the token key, the two files are mounted SEPARATELY (the .key into
# image-registry, the .pub into plugin) — never the whole directory into plugin.
#
# Modes (PLUGIN_SIGNING_MODE, read from the environment — callers source .env):
#   local (default)  generate a PKCS#8 private key and derive its public key.
#                    Idempotent: an existing key is kept (the .pub is re-derived
#                    only if missing), so re-running setup never invalidates the
#                    signatures on images already pushed.
#   kms              the private key lives in AWS KMS and is NEVER written here.
#                    The public key is exported from KMS (needs kms:GetPublicKey
#                    for the OPERATOR running this) so plugin can still verify.
#                    PLUGIN_SIGNING_KMS_KEY_ID must be an alias (alias/<name>) —
#                    an ARN embeds the AWS account id. Re-exported every run, so
#                    retargeting the alias is picked up by the next setup.
#
# There is deliberately NO --rotate. A signature cannot outlive the key that
# made it: rotating means every existing plugin image must be re-signed (rebuilt
# / re-uploaded), or it fails verification the moment the new public key is
# mounted. Delete the key and re-run only as part of that procedure — see
# "Plugin-signing key" in docs/runbooks/secret-rotation.md.
#
# Writes (chmod 644 — deploy convention, see deploy/*/startup.sh):
#   <cert_dir>/plugin-signing/plugin-signing.key   EC P-256 private key, PKCS#8 PEM (local mode only)
#   <cert_dir>/plugin-signing/plugin-signing.pub   EC P-256 public key, SPKI PEM   (both modes)

set -euo pipefail

CERT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    # One positional only — a second path would otherwise silently replace it.
    *) [ -z "$CERT_DIR" ] || { echo "Unexpected argument: $1 (cert_dir already set to '$CERT_DIR')" >&2; exit 1; }
       CERT_DIR="$1"; shift ;;
  esac
done
CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
KEY_DIR="$CERT_DIR/plugin-signing"
KEY_FILE="$KEY_DIR/plugin-signing.key"
PUB_FILE="$KEY_DIR/plugin-signing.pub"
MODE="${PLUGIN_SIGNING_MODE:-local}"

mkdir -p "$KEY_DIR"

# Self-heal: a `docker compose up` that ran before the file existed makes Docker
# auto-create the bind-mount source as an empty DIRECTORY, which openssl cannot
# write over. Mirrors token-signing-keys.sh.
for f in "$KEY_FILE" "$PUB_FILE"; do
  if [ -e "$f" ] && [ ! -f "$f" ]; then
    echo "  clearing stale non-file at $f (likely a leftover Docker bind-mount dir)"
    rm -rf "$f"
  fi
done

case "$MODE" in
  local)
    if [ -f "$KEY_FILE" ]; then
      echo "  plugin signing key already present in $KEY_DIR"
    else
      # prime256v1 IS NIST P-256 — the same curve the KMS signer uses
      # (ECC_NIST_P256), so a deployment can move between signers without
      # changing what cosign verifies against. PKCS#8 so cosign's
      # `import-key-pair` (run by image-registry at boot) reads it without a hint.
      openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null \
        | openssl pkcs8 -topk8 -nocrypt -out "$KEY_FILE"
      echo "  wrote plugin signing key: $KEY_FILE"
    fi
    # Re-derive the public half whenever it is missing — it is a pure function
    # of the key, so this can never drift from what image-registry signs with.
    if [ ! -f "$PUB_FILE" ]; then
      openssl pkey -in "$KEY_FILE" -pubout -out "$PUB_FILE"
      echo "  wrote plugin signing public key: $PUB_FILE"
    fi
    ;;
  kms)
    KMS_KEY_ID="${PLUGIN_SIGNING_KMS_KEY_ID:-}"
    case "$KMS_KEY_ID" in
      alias/?*) ;;
      "") echo "PLUGIN_SIGNING_MODE=kms requires PLUGIN_SIGNING_KMS_KEY_ID (alias/<name>)" >&2; exit 1 ;;
      *) echo "refusing PLUGIN_SIGNING_KMS_KEY_ID='$KMS_KEY_ID': name the key BY ALIAS (alias/<name>) — an ARN embeds the AWS account id" >&2; exit 1 ;;
    esac
    # A private key left over from an earlier local-mode run is NOT the key
    # KMS signs with — refuse rather than let a stale file be mounted anywhere.
    if [ -f "$KEY_FILE" ]; then
      echo "refusing: $KEY_FILE exists but PLUGIN_SIGNING_MODE=kms — remove it (the KMS key replaces it; see docs/runbooks/secret-rotation.md)" >&2
      exit 1
    fi
    # KMS returns the SPKI public key as base64 DER; cosign verifies against PEM.
    # Written via a temp file so a failed export never truncates a good .pub.
    _tmp="$(mktemp "$KEY_DIR/.plugin-signing.pub.XXXXXX")"
    trap 'rm -f "$_tmp"' EXIT INT TERM
    aws kms get-public-key --key-id "$KMS_KEY_ID" --query PublicKey --output text \
      | base64 -d \
      | openssl pkey -pubin -inform DER -out "$_tmp"
    mv "$_tmp" "$PUB_FILE"
    trap - EXIT INT TERM
    echo "  exported plugin signing public key from KMS ($KMS_KEY_ID): $PUB_FILE"
    ;;
  *)
    echo "Unknown PLUGIN_SIGNING_MODE '$MODE' (expected local | kms)" >&2
    exit 1
    ;;
esac

# 644 (not 600): the deploy convention — mounted into containers that run as
# assorted uids, and tightening to 600 has broken reads before.
[ -f "$KEY_FILE" ] && chmod 644 "$KEY_FILE"
chmod 644 "$PUB_FILE"
