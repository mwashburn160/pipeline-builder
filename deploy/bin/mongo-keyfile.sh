#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Idempotent MongoDB replica-set keyfile generator — shared across every target
# so the internal-auth secret is generated PER DEPLOY (not a single committed key
# shared by all installs). Mirrors jwt-keys.sh / nginx-tls.sh (skip-if-exists).
#
#   pb_ensure_mongo_keyfile <path>          # SOURCE this file and call, or…
#   deploy/bin/mongo-keyfile.sh <path>      # …run it directly
#
# MongoDB requires the keyfile be 400/600 and owned by the mongod user; we write
# 600 here (the k8s init-container / mongod entrypoint tightens to 400 at start).
set -euo pipefail

pb_ensure_mongo_keyfile() {
  local _keyfile="$1"
  if [ -z "$_keyfile" ]; then
    echo "ERROR: pb_ensure_mongo_keyfile requires a path" >&2
    return 2
  fi
  if [ -f "$_keyfile" ]; then
    echo "  mongodb-keyfile exists: $_keyfile (skipping)"
    return 0
  fi
  # Write via a temp file and move into place. `> "$_keyfile"` creates the file
  # BEFORE openssl runs, so a failing `openssl rand` (no entropy, full disk)
  # would leave a zero-byte keyfile that the skip-if-exists check above then
  # honours forever — mongod refuses to start and a re-run never repairs it.
  # The temp file is also chmod'd before the move, so the key is never briefly
  # world-readable at the final path.
  local _tmp
  _tmp="$(mktemp "${_keyfile}.XXXXXX")" || { echo "ERROR: cannot create a temp file next to $_keyfile" >&2; return 1; }
  # 756 base64 bytes is MongoDB's documented keyfile length upper bound.
  if ! openssl rand -base64 756 > "$_tmp"; then
    rm -f "$_tmp"
    echo "ERROR: openssl rand failed — no mongodb-keyfile written" >&2
    return 1
  fi
  chmod 600 "$_tmp"
  mv "$_tmp" "$_keyfile"
  echo "  generated mongodb-keyfile: $_keyfile"
}

# Direct-execution entrypoint.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  [ "$#" -ge 1 ] || { echo "usage: $0 <keyfile-path>" >&2; exit 2; }
  pb_ensure_mongo_keyfile "$1"
fi
