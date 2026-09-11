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
#   - the certificate identity to that workflow (any git ref), and
#   - the OIDC issuer to GitHub Actions.
#
# ENFORCED by default: exit non-zero on the first unverifiable image. Locally-built
# dev images (minikube/docker targets) are NOT signed, so this is wired only into
# the AWS setup paths that pull the CI-published images. Break-glass override for
# an operator who KNOWS they're running unsigned images: SKIP_IMAGE_SIGNATURE_VERIFY=1.
#
# Usage:
#   deploy/bin/verify-image-signatures.sh [owner]     # default owner: mwashburn160
#
# Exit codes: 0 = every referenced image is validly signed · 1 = one or more failed
#             verification · 2 = no refs found · 3 = infra error (cosign unavailable).

OWNER="${1:-mwashburn160}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# GitHub repo slug that OWNS the signing workflow. The certificate-identity is the
# workflow file's URL; the regexp accepts any git ref (@refs/heads/main, a tag, …).
REPO_SLUG="${IMAGE_SIGNING_REPO:-mwashburn160/pipeline-builder}"
WORKFLOW_REF="${IMAGE_SIGNING_WORKFLOW:-.github/workflows/release.yml}"
IDENTITY_REGEXP="^https://github.com/${REPO_SLUG}/${WORKFLOW_REF}@"
# Escape regex metacharacter dots (github.com, .github, release.yml) so they match
# literally — defense-in-depth against a near-name matcher. The '@' has no end-anchor
# on purpose (any git ref after it is accepted).
IDENTITY_REGEXP="${IDENTITY_REGEXP//./\\.}"
OIDC_ISSUER="https://token.actions.githubusercontent.com"

if [ "${SKIP_IMAGE_SIGNATURE_VERIFY:-0}" = "1" ]; then
  echo "SKIP_IMAGE_SIGNATURE_VERIFY=1 — skipping deploy-time image signature verification (break-glass)."
  exit 0
fi

# cosign is required. Install it best-effort if missing; a hard failure to obtain
# it is an INFRA error (exit 3), distinct from a real verification failure (exit 1),
# so an operator can tell "couldn't check" from "check failed".
if ! command -v cosign >/dev/null 2>&1; then
  echo "cosign not found — installing…"
  arch="$(uname -m)"; case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  if ! curl -fsSL "https://github.com/sigstore/cosign/releases/latest/download/cosign-${os}-${arch}" -o /usr/local/bin/cosign 2>/dev/null \
      && ! sudo curl -fsSL "https://github.com/sigstore/cosign/releases/latest/download/cosign-${os}-${arch}" -o /usr/local/bin/cosign 2>/dev/null; then
    echo "ERROR: could not download cosign — cannot verify image signatures." >&2
    exit 3
  fi
  chmod +x /usr/local/bin/cosign 2>/dev/null || sudo chmod +x /usr/local/bin/cosign
fi

# Distinct semver-pinned ghcr refs under deploy/ (same gather as verify-image-tags.sh).
# while-read (not mapfile) so this also runs on macOS bash 3.2.
REFS=()
while IFS= read -r _ref; do REFS+=("$_ref"); done < <(
  grep -rhoE "ghcr\.io/${OWNER}/[a-z0-9-]+:[0-9]+\.[0-9]+\.[0-9]+" "$ROOT/deploy" 2>/dev/null | sort -u
)

if [ "${#REFS[@]}" -eq 0 ]; then
  echo "No ghcr.io/${OWNER}/*:<version> references found under deploy/ — nothing to verify."
  exit 2
fi

echo "Verifying cosign signatures on ${#REFS[@]} deploy image(s) (identity ${IDENTITY_REGEXP}) …"
FAILED=()
for ref in "${REFS[@]}"; do
  if cosign verify \
      --certificate-identity-regexp "$IDENTITY_REGEXP" \
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
