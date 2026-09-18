#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Generate the PER-SERVICE ES256 (EC P-256) signing keys for INTERNAL
# service-to-service tokens (roadmap #14), plus the public bundle every service
# verifies against.
#
# Before #14 all ten services shared one HS256 `JWT_SECRET`, so any one of them
# could mint a token naming any other — "billing said so" was unfalsifiable.
# Now each service signs with its own key, the `kid` is the key's RFC 7638
# thumbprint, and a verifier requires the token's `sub` to name the service that
# `kid` belongs to. A service that gets hold of another's token can replay it
# (5-minute TTL); it cannot mint one.
#
#   service-signing-keys.sh [cert_dir] [--rotate <service>|--rotate-all]
#                                      [--finish <service>|--finish-all]
#
# cert_dir defaults to <this script's ..>/certs. Everything is written to a
# `service-keys/` SUBDIRECTORY so compose can bind-mount one private key per
# service and the single public bundle everywhere, without exposing the other
# key material in cert_dir.
#
# Writes (chmod 644 — deploy convention, see deploy/*/startup.sh):
#   <cert_dir>/service-keys/<service>.key           EC P-256 private key, PKCS#8 PEM
#   <cert_dir>/service-keys/<service>-previous.key  retiring key, only after --rotate
#   <cert_dir>/service-keys/bundle.json             every service's PUBLIC keys
#
# Idempotent: an existing key is left alone, so re-running setup never breaks
# tokens in flight. The bundle is always rebuilt from whatever keys are present.
#
# ROTATION is two-phase, by `kid`, and must be done in this order or in-flight
# tokens break:
#   1. `--rotate <service>`  moves the current key to <service>-previous.key and
#      generates a new one. The bundle then publishes BOTH public keys, so
#      tokens signed either side of the cutover verify.
#   2. Roll the bundle out everywhere FIRST (it is public; every service reads
#      it), then restart the rotated service so it signs with the new key.
#   3. `--finish <service>` once every token signed with the old key has expired
#      (5 minutes): deletes <service>-previous.key and drops it from the bundle.
# `secret_rotation_previous_set{secret="SERVICE_SIGNING_KEY"}` is 1 on a service
# while its overlap is open. See docs/runbooks/secret-rotation.md.

set -euo pipefail

# Every internal identity that signs tokens. The application services take their
# name from SERVICE_NAME (identical in every deploy target), so these strings are
# the same ones that appear in `sub: service:<name>` and in the mesh policies.
SERVICES=(
  platform
  pipeline
  plugin
  message
  quota
  billing
  compliance
  reporting
  image-registry
  ask
  # Not a service: the deploy's own bootstrap identity, used by
  # push-base-images.sh / build-plugin-images.sh to authenticate their base-image
  # pushes against the in-cluster registry. It runs from an operator's shell, so
  # its key stays on the host and is never mounted into a pod.
  deploy-bootstrap
)

CERT_DIR=""
ROTATE=""
FINISH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rotate) ROTATE="${2:?--rotate needs a service name}"; shift 2 ;;
    --rotate-all) ROTATE="ALL"; shift ;;
    --finish) FINISH="${2:?--finish needs a service name}"; shift 2 ;;
    --finish-all) FINISH="ALL"; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) CERT_DIR="$1"; shift ;;
  esac
done
CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
KEY_DIR="$CERT_DIR/service-keys"
BUNDLE="$KEY_DIR/bundle.json"

command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl is required" >&2; exit 1; }

mkdir -p "$KEY_DIR"

_selected() {  # _selected <requested> <service> -> 0 when it applies
  [ "$1" = "ALL" ] || [ "$1" = "$2" ]
}

# Validate an explicit --rotate/--finish name against the list, so a typo fails
# loudly instead of silently doing nothing.
for _req in "$ROTATE" "$FINISH"; do
  [ -z "$_req" ] || [ "$_req" = "ALL" ] || {
    printf '%s\n' "${SERVICES[@]}" | grep -qx "$_req" \
      || { echo "ERROR: unknown service '$_req' (known: ${SERVICES[*]})" >&2; exit 1; }
  }
done

# base64url of stdin, no padding — the JWK/JWS encoding.
_b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# _jwk <key_file> — echo the PUBLIC JWK for an EC P-256 private key, with
# `kid` = its RFC 7638 thumbprint (sha256 of the canonical {crv,kty,x,y} JSON).
#
# Deriving the id FROM the key means the same key always publishes under the
# same `kid`, a rotated-in key can never collide with the one it replaces, and
# nothing account-specific ever reaches a token.
_jwk() {
  local _key="$1" _der _x _y _canonical _kid
  # SubjectPublicKeyInfo for P-256 is a fixed 91 bytes: a 26-byte header, then
  # 0x04 (uncompressed point), then X and Y at 32 bytes each. So the last 64
  # bytes are X||Y.
  _der="$(mktemp)"
  openssl ec -in "$_key" -pubout -outform DER -out "$_der" 2>/dev/null
  _x="$(tail -c 64 "$_der" | head -c 32 | _b64url)"
  _y="$(tail -c 32 "$_der" | _b64url)"
  rm -f "$_der"
  # Canonical form: exactly crv, kty, x, y, lexicographic, no whitespace.
  _canonical="$(printf '{"crv":"P-256","kty":"EC","x":"%s","y":"%s"}' "$_x" "$_y")"
  _kid="$(printf '%s' "$_canonical" | openssl dgst -sha256 -binary | _b64url)"
  printf '{"kty":"EC","crv":"P-256","x":"%s","y":"%s","kid":"%s","use":"sig","alg":"ES256"}' \
    "$_x" "$_y" "$_kid"
}

_generate() {  # _generate <key_file>
  # prime256v1 IS NIST P-256 — the curve ES256 pins, the same one the user-token
  # signer uses. PKCS#8 so Node reads it without a hint.
  openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null \
    | openssl pkcs8 -topk8 -nocrypt -out "$1"
  # 644 (not 600): the deploy convention — mounted into containers that run as
  # assorted uids, and tightening to 600 has broken reads before.
  chmod 644 "$1"
}

for svc in "${SERVICES[@]}"; do
  key="$KEY_DIR/$svc.key"
  prev="$KEY_DIR/$svc-previous.key"

  # Self-heal: a `docker compose up` that ran before the file existed makes
  # Docker auto-create the bind-mount source as an empty DIRECTORY, which openssl
  # cannot write over. Mirrors token-signing-keys.sh.
  for f in "$key" "$prev"; do
    if [ -e "$f" ] && [ ! -f "$f" ]; then
      echo "  clearing stale non-file at $f (likely a leftover Docker bind-mount dir)"
      rm -rf "$f"
    fi
  done

  if [ -n "$FINISH" ] && _selected "$FINISH" "$svc" && [ -f "$prev" ]; then
    rm -f "$prev"
    echo "  finished rotation for $svc (retiring key dropped)"
  fi

  if [ -n "$ROTATE" ] && _selected "$ROTATE" "$svc"; then
    if [ ! -f "$key" ]; then
      echo "refusing to rotate $svc: no current key at $key" >&2
      exit 1
    fi
    mv "$key" "$prev"
    echo "  retired $svc's signing key to $prev (still published for verification)"
  fi

  if [ ! -f "$key" ]; then
    _generate "$key"
    echo "  wrote service signing key: $key"
  fi
  [ -f "$prev" ] && chmod 644 "$prev"
done

# Rebuild the bundle from whatever is on disk. Always regenerated (never patched)
# so it cannot drift from the keys it is supposed to describe.
{
  printf '{\n  "services": {\n'
  _first=1
  for svc in "${SERVICES[@]}"; do
    key="$KEY_DIR/$svc.key"
    prev="$KEY_DIR/$svc-previous.key"
    [ -f "$key" ] || continue
    [ $_first -eq 1 ] || printf ',\n'
    _first=0
    printf '    "%s": { "keys": [%s' "$svc" "$(_jwk "$key")"
    [ -f "$prev" ] && printf ', %s' "$(_jwk "$prev")"
    printf '] }'
  done
  printf '\n  }\n}\n'
} > "$BUNDLE.tmp"
mv "$BUNDLE.tmp" "$BUNDLE"
# Public keys only — 644 like everything else the containers mount.
chmod 644 "$BUNDLE"
echo "  wrote service key bundle: $BUNDLE"
