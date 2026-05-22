#!/usr/bin/env bash
# ============================================================================
# Build + push the custom nginx-njs image (F-1.2a).
#
# One-time operator action. The Fargate task definition (and eventually the
# k8s pods) reference `${REGISTRY}/${IMAGE_NAME}:${TAG}`; after a successful
# push, bump that reference in the consuming manifests.
#
# Defaults match the public production registry; override via env to push
# elsewhere (e.g. a private ECR for FedRAMP, an Artifactory mirror, …).
#
# Required# docker (with buildx)
# gh auth login --hostname ghcr.io # OR docker login ghcr.io
# ============================================================================

set -euo pipefail

REGISTRY="${REGISTRY:-ghcr.io/mwashburn160}"
IMAGE_NAME="${IMAGE_NAME:-nginx-njs}"
TAG="${TAG:-1.27}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "Building ${FULL_IMAGE} for ${PLATFORMS}"

# `--push` requires the buildx builder to be a moby/buildkit driver, NOT the
# default Docker driver. If you see `error:... docker driver does not
# support multi-arch builds`, run `docker buildx create --use` once.
docker buildx build \
  --platform "${PLATFORMS}" \
  --push \
  --pull \
  --provenance=false \
  --tag "${FULL_IMAGE}" \
  --file "${SCRIPT_DIR}/Dockerfile" \
  "${SCRIPT_DIR}"

# Resolve the immutable digest so the operator can pin by SHA in
# 04-services.yaml. `--push` doesn't surface this; use `docker buildx
# imagetools` to fetch it from the registry.
SHA=$(docker buildx imagetools inspect --raw "${FULL_IMAGE}" 2>/dev/null \
  | grep -m1 '"digest"' | sed -E 's/.*"sha256:([a-f0-9]+)".*/sha256:\1/' || true)

if [ -n "${SHA}" ]; then
  echo
  echo "Pushed: ${FULL_IMAGE}"
  echo "Digest: ${SHA}"
  echo
  echo "Pin in deploy/aws/fargate/stacks/04-services.yaml as:"
  echo " NginxImage default: ${FULL_IMAGE}@${SHA}"
else
  echo
  echo "Pushed: ${FULL_IMAGE}"
  echo "(digest lookup failed  fetch manually via 'docker buildx imagetools inspect ${FULL_IMAGE}')"
fi
