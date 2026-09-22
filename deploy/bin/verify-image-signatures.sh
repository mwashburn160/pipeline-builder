#!/usr/bin/env bash
set -euo pipefail

# Verify every `ghcr.io/<owner>/<svc>:<version>` referenced under deploy/** carries
# a valid COSIGN keyless signature produced by THIS repo's release workflow, and
# fail the deploy if any is unsigned or signed by anything else. This is the
# deploy-time complement to verify-image-tags.sh (which only checks the tag
# EXISTS): it proves the image an operator is about to run is the exact artifact
# our CI built and signed — closing the "someone pushed a look-alike tag" gap.
#
# Signatures are produced by .github/workflows/release.yml (keyless: Sigstore
# Fulcio cert bound to the workflow's GitHub OIDC identity), so verification pins:
#   - the certificate identity to that workflow AT refs/heads/main — exactly the
#     ref release.yml runs on. Any other ref (a fork's branch, a PR branch, a tag
#     someone pushed with a modified release.yml) is rejected, even though it
#     would carry this repo's workflow path; and
#   - the OIDC issuer to GitHub Actions.
#
# ENFORCED by default: exit non-zero on the first unverifiable image. Locally-built
# dev images (minikube/docker targets) are NOT signed, so this is wired only into
# the AWS setup paths that pull the CI-published images. Break-glass override for
# an operator who KNOWS they're running unsigned images: SKIP_IMAGE_SIGNATURE_VERIFY=1.
#
# Usage:
#   deploy/bin/verify-image-signatures.sh [owner]     # default owner: mwashburn160
#   PB_VERIFY_REFS="ghcr.io/o/svc@sha256:… …" deploy/bin/verify-image-signatures.sh
#       verify exactly these refs instead of gathering them from deploy/ (used by
#       sync-image-tags.sh BEFORE it pins a digest into the manifests)
#
# Exit codes — THE convention shared by every deploy/bin/verify-*.sh:
#   0  verified: everything checked passed
#   1  FAILED: a real verdict — something is missing, unsigned or unreachable
#   2  nothing to verify (no refs / no files). Non-zero on purpose: a gate must
#      not go green having checked nothing.
#   3  could not verify — an infra error, never a verdict: a missing tool, a bad
#      argument, or the registry/network answering 5xx / rate-limiting.
# Here: 1 = an image failed verification; 3 = cosign unavailable or too old.

OWNER="${1:-mwashburn160}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# GitHub repo slug that OWNS the signing workflow. The certificate identity is the
# workflow file's URL at the one ref releases are built from.
REPO_SLUG="${IMAGE_SIGNING_REPO:-mwashburn160/pipeline-builder}"
WORKFLOW_REF="${IMAGE_SIGNING_WORKFLOW:-.github/workflows/release.yml}"
SIGNING_GIT_REF="${IMAGE_SIGNING_GIT_REF:-refs/heads/main}"
# An exact identity, not a regexp: nothing about it should be allowed to vary.
IDENTITY="https://github.com/${REPO_SLUG}/${WORKFLOW_REF}@${SIGNING_GIT_REF}"
OIDC_ISSUER="https://token.actions.githubusercontent.com"

if [ "${SKIP_IMAGE_SIGNATURE_VERIFY:-0}" = "1" ]; then
  echo "SKIP_IMAGE_SIGNATURE_VERIFY=1 — skipping deploy-time image signature verification (break-glass)."
  exit 0
fi

# cosign is required. Install it best-effort if missing; a hard failure to obtain
# it is an INFRA error (exit 3), distinct from a real verification failure (exit 1),
# so an operator can tell "couldn't check" from "check failed". The download is
# pinned to COSIGN_VERSION and checked against a per-OS/arch SHA-256 — this binary
# is the thing deciding whether an image is trusted, so a swapped release asset
# must fail closed. Same version as .github/workflows/release.yml.
COSIGN_VERSION="v3.1.3"
if ! command -v cosign >/dev/null 2>&1; then
  echo "cosign not found — installing ${COSIGN_VERSION}…"
  arch="$(uname -m)"; case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "${os}-${arch}" in
    linux-amd64)  cosign_sha256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ;;
    linux-arm64)  cosign_sha256=c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a ;;
    darwin-amd64) cosign_sha256=2347488e5d5b25336644024dfeca5601b190e91197a71a917bda44744aff106c ;;
    darwin-arm64) cosign_sha256=5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76 ;;
    *) echo "ERROR: no pinned cosign build for ${os}-${arch} — cannot verify image signatures." >&2; exit 3 ;;
  esac
  tmp_cosign="$(mktemp)"
  # EXIT INT TERM: an untrapped SIGINT/SIGTERM kills the shell without running
  # the EXIT trap, leaving the half-downloaded binary behind.
  trap 'rm -f "$tmp_cosign"' EXIT INT TERM
  if ! curl -fsSL "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-${os}-${arch}" -o "$tmp_cosign"; then
    echo "ERROR: could not download cosign ${COSIGN_VERSION} — cannot verify image signatures." >&2
    exit 3
  fi
  # shasum ships on macOS and most Linux; sha256sum is the coreutils fallback.
  if command -v sha256sum >/dev/null 2>&1; then actual_sha256="$(sha256sum "$tmp_cosign" | awk '{print $1}')"
  else actual_sha256="$(shasum -a 256 "$tmp_cosign" | awk '{print $1}')"; fi
  if [ "$actual_sha256" != "$cosign_sha256" ]; then
    echo "ERROR: cosign ${COSIGN_VERSION} checksum mismatch (got ${actual_sha256}, want ${cosign_sha256})." >&2
    exit 3
  fi
  if ! install -m 0755 "$tmp_cosign" /usr/local/bin/cosign 2>/dev/null \
      && ! sudo install -m 0755 "$tmp_cosign" /usr/local/bin/cosign; then
    echo "ERROR: could not install cosign to /usr/local/bin — cannot verify image signatures." >&2
    exit 3
  fi
fi

# An operator's pre-installed cosign must be v3+. The release workflow signs with
# cosign v3, whose keyless signatures are Sigstore bundles a v2 binary cannot read
# — it would report every image UNSIGNED and look exactly like a real tampering
# finding. Say so instead, as an INFRA error.
cosign_installed="$(cosign version 2>/dev/null | awk '/GitVersion:/ {print $2; exit}')"
case "${cosign_installed}" in
  v[3-9]*|v[1-9][0-9]*) ;;
  *) echo "ERROR: cosign ${cosign_installed:-<unknown>} on PATH is too old — ${COSIGN_VERSION} or newer is required to verify v3 keyless signatures." >&2; exit 3 ;;
esac

# Distinct semver-pinned ghcr refs under deploy/ (same gather as verify-image-tags.sh).
# while-read (not mapfile) so this also runs on macOS bash 3.2.
REFS=()
if [ -n "${PB_VERIFY_REFS:-}" ]; then
  # shellcheck disable=SC2206  # word-split on purpose: a space-separated list
  REFS=(${PB_VERIFY_REFS})
else
while IFS= read -r _ref; do REFS+=("$_ref"); done < <(
  # Digest-pinned refs (`:<ver>@sha256:…`, written by sync-image-tags.sh) are
  # verified BY DIGEST — the exact bytes the manifests will run.
  grep -rhoE "ghcr\.io/${OWNER}/[a-z0-9-]+:[0-9]+\.[0-9]+\.[0-9]+(@sha256:[0-9a-f]{64})?" "$ROOT/deploy" 2>/dev/null | sort -u
)
fi

if [ "${#REFS[@]}" -eq 0 ]; then
  echo "No ghcr.io/${OWNER}/*:<version> references found under deploy/ — nothing to verify."
  exit 2
fi

echo "Verifying cosign signatures on ${#REFS[@]} deploy image(s) (identity ${IDENTITY}) …"
FAILED=()
for ref in "${REFS[@]}"; do
  if cosign verify \
      --certificate-identity "$IDENTITY" \
      --certificate-oidc-issuer "$OIDC_ISSUER" \
      "$ref" >/dev/null 2>&1; then
    echo "  signed   ${ref}"
  else
    echo "  UNSIGNED ${ref}"
    FAILED+=("$ref")
  fi
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  {
    echo
    echo "ERROR: ${#FAILED[@]} deploy image(s) failed cosign signature verification:"
    printf '  - %s\n' "${FAILED[@]}"
    echo "These are not signed by ${REPO_SLUG}'s release workflow. Refusing to deploy."
    echo "(Break-glass, if you KNOW the images are trusted: SKIP_IMAGE_SIGNATURE_VERIFY=1.)"
  } >&2
  exit 1
fi

echo
echo "All ${#REFS[@]} deploy images carry a valid release-workflow signature ✓"
