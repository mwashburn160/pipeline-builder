#!/usr/bin/env bash
set -euo pipefail

# Verify every `ghcr.io/<owner>/<svc>:<version>` referenced under deploy/** is
# actually published to GHCR. Run in CI AFTER the image push + `sync-image-tags.sh`
# and BEFORE committing the synced manifests — it fails the release if a referenced
# tag is missing (the "sync-ahead-of-publish" gap that left compliance:3.4.78 / the
# ai-core / pipeline-events versions dangling).
#
# Usage:
#   deploy/bin/verify-image-tags.sh [owner]        # default owner: mwashburn160
#
# Exit codes: 0 = every referenced tag exists · 1 = one or more missing · 2 = no refs.
# Public images need no auth (an anonymous pull token is enough).

OWNER="${1:-mwashburn160}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Distinct semver-pinned ghcr refs across compose / k8s / CloudFormation under deploy/.
mapfile -t REFS < <(
  grep -rhoE "ghcr\.io/${OWNER}/[a-z0-9-]+:[0-9]+\.[0-9]+\.[0-9]+" "$ROOT/deploy" 2>/dev/null | sort -u
)

if [ "${#REFS[@]}" -eq 0 ]; then
  echo "No ghcr.io/${OWNER}/*:<version> references found under deploy/ — nothing to verify."
  exit 2
fi

echo "Verifying ${#REFS[@]} deploy image tag(s) against ghcr.io …"
MISSING=()
for ref in "${REFS[@]}"; do
  repo="${ref#ghcr.io/${OWNER}/}"; tag="${repo##*:}"; repo="${repo%%:*}"
  tok="$(curl -fsSL "https://ghcr.io/token?scope=repository:${OWNER}/${repo}:pull" \
    | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
  code="$(curl -fsS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${tok}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${OWNER}/${repo}/manifests/${tag}" || true)"
  if [ "$code" = "200" ]; then
    echo "  ok      ${ref}"
  else
    echo "  MISSING ${ref}  (HTTP ${code})"
    MISSING+=("$ref")
  fi
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  {
    echo
    echo "ERROR: ${#MISSING[@]} image tag(s) referenced under deploy/ are NOT published on ghcr.io:"
    printf '  - %s\n' "${MISSING[@]}"
    echo "Publish the missing image(s), or pin the manifest(s) to a published tag, before releasing."
  } >&2
  exit 1
fi

echo
echo "All ${#REFS[@]} deploy image tags are published on ghcr.io ✓"
