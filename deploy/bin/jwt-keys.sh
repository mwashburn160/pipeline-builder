#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Generate the RS256 keypair + x509 cert used by `pipeline-image-registry`'s
# Docker registry token auth. The registry verifies tokens using the x509 cert
# (mounted as REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE); the service signs tokens with
# the matching private key (loaded via REGISTRY_TOKEN_PRIVATE_KEY).
#
# Shared by every deploy target that keeps this keypair ON DISK: docker,
# minikube and ec2 all call it (see each target's bin/setup.sh / startup.sh).
# It lives in deploy/bin — always in the provision sparse-checkout — so those
# targets stop hand-rolling near-identical openssl blocks. eks does NOT use it:
# it generates an ephemeral 2048-bit pair inline (deploy/aws/eks/bin/setup.sh),
# which goes straight into a Secret and is discarded with the temp dir.
#
#   jwt-keys.sh [cert_dir] [--force]
#
# cert_dir defaults to <this script's ..>/certs. Idempotent: skips when both files
# already exist (so re-running setup doesn't invalidate issued registry tokens);
# pass --force to regenerate. Writes (the key 0600 — 0644 on the docker target,
# see KEY_MODE below; the cert 0644):
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
    # One positional only — a second path would otherwise silently replace it.
    *) [ -z "$CERT_DIR" ] || { echo "Unexpected argument: $1 (cert_dir already set to '$CERT_DIR')" >&2; exit 1; }
       CERT_DIR="$1"; shift ;;
  esac
done
CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
KEY_FILE="$CERT_DIR/image-registry-jwt.key"
CERT_FILE="$CERT_DIR/image-registry-jwt.crt"

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

if [ -f "$KEY_FILE" ] && [ -f "$CERT_FILE" ] && [ -z "$FORCE" ]; then
  echo "  registry JWT keypair already present in $CERT_DIR (use --force to regenerate)"
  exit 0
fi

mkdir -p "$CERT_DIR"

# Self-heal: a prior `docker compose up` that ran before these files existed makes
# Docker auto-create the bind-mount sources as empty DIRECTORIES. openssl can't
# write over a directory ("genrsa: Can't open … Is a directory"), so clear any
# non-regular-file at the target paths first — lets a re-run recover instead of
# failing. (Harmless on the k8s targets, where these are never bind-mounted.)
for f in "$KEY_FILE" "$CERT_FILE"; do
  if [ -e "$f" ] && [ ! -f "$f" ]; then
    echo "  clearing stale non-file at $f (likely a leftover Docker bind-mount dir)"
    rm -rf "$f"
  fi
done

# 4096-bit RSA — matches the registry's expected RS256 verification. The cert is
# self-signed with 10-year validity (rotate by regenerating with --force); the
# subject is informational only — the registry uses just the embedded public key.
( umask 077; openssl genrsa -out "$KEY_FILE" 4096 )
openssl req -x509 -new -nodes -key "$KEY_FILE" -sha256 -days 3650 \
  -subj "/CN=pipeline-image-registry-token-issuer" \
  -out "$CERT_FILE"

# The cert is public (0644); the private key gets KEY_MODE (see above).
chmod "$KEY_MODE" "$KEY_FILE"
chmod 644 "$CERT_FILE"

echo "  wrote registry JWT keypair: $KEY_FILE + $CERT_FILE"
