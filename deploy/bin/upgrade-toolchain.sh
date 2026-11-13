#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

# Build and upload a new managed toolchain release — pipeline-bootstrap +
# cdk-synth, one version, read from deploy/toolchain/*/plugin-spec.yaml (bumped
# by deploy/bin/sync-image-tags.sh). It NEVER promotes: the uploaded release is
# a candidate until a platform operator puts it in canary and sets it as the
# platform default from the Toolchain console. Pipelines keep running on the
# current default meanwhile.
#
# Usage:
#   DEPLOY_TARGET=docker   ./upgrade-toolchain.sh           # default target
#   DEPLOY_TARGET=minikube ./upgrade-toolchain.sh
#   DEPLOY_TARGET=ec2 PLATFORM_BASE_URL=https://pb.example.com ./upgrade-toolchain.sh
#   DEPLOY_TARGET=eks PLATFORM_BASE_URL=https://pb.example.com ./upgrade-toolchain.sh
#   ./upgrade-toolchain.sh --cleanup                        # remove plugin.zip + image.tar after upload
#
# Idempotent per version: a release already built and pushed is not re-pushed
# (build-plugin-images.sh refuses to overwrite a managed version), and a release
# already uploaded answers 409 and is skipped. To ship a change, produce a NEW
# version (sync-image-tags.sh bumps the patch on any sourceDigest change).
#
# Auth: the upload runs as a system-org identity — PLATFORM_TOKEN (e.g. a key of
# the official-catalog-loader service account) or, on a TTY, an interactive
# admin login (load-plugins.sh's require_auth).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORM_BASE_URL_PROVIDED="${PLATFORM_BASE_URL:-}"
. "$SCRIPT_DIR/common.sh"

CLEANUP_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) CLEANUP_ARG="--cleanup"; shift ;;
    -h|--help) sed -n '5,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (see --help)" >&2; exit 1 ;;
  esac
done

DEPLOY_TARGET="${DEPLOY_TARGET:-docker}"
case "$DEPLOY_TARGET" in
  docker|minikube) ;;
  ec2|eks)
    if [ -z "$PLATFORM_BASE_URL_PROVIDED" ]; then
      echo "ERROR: DEPLOY_TARGET=$DEPLOY_TARGET needs PLATFORM_BASE_URL (the platform this release is uploaded to)." >&2
      exit 1
    fi ;;
  *) echo "ERROR: DEPLOY_TARGET must be docker|minikube|ec2|eks (got: '$DEPLOY_TARGET')" >&2; exit 1 ;;
esac
export DEPLOY_TARGET

RELEASE="$(get_spec_field version "$TOOLCHAIN_DIR/pipeline-bootstrap/plugin-spec.yaml")"
SYNTH_RELEASE="$(get_spec_field version "$TOOLCHAIN_DIR/cdk-synth/plugin-spec.yaml")"
if [ -z "$RELEASE" ] || [ "$RELEASE" != "$SYNTH_RELEASE" ]; then
  echo "ERROR: the toolchain halves disagree on the release version (pipeline-bootstrap='${RELEASE}', cdk-synth='${SYNTH_RELEASE}')." >&2
  echo "       Run deploy/bin/sync-image-tags.sh, which writes one version into both specs." >&2
  exit 1
fi

echo "=== Toolchain release ${RELEASE} (target: ${DEPLOY_TARGET}) ==="
echo "  Platform: ${PLATFORM_BASE_URL}"
echo ""

# Both halves, nothing else: the base stage builds pipeline-bootstrap (grype
# gated, pushed to library/ for cdk-synth's FROM), then cdk-synth on it.
"$SCRIPT_DIR/build-plugin-images.sh" --only pipeline-bootstrap,cdk-synth

# Upload both halves, bootstrap first. Strict: a missing image.tar fails the
# run (SKIP_MISSING_IMAGE_TAR=false) — half a release is not a release.
# shellcheck disable=SC2086
env PLATFORM_BASE_URL="$PLATFORM_BASE_URL" SKIP_MISSING_IMAGE_TAR=false \
  "$SCRIPT_DIR/load-plugins.sh" --rebuild --category "$TOOLCHAIN_CATEGORY" $CLEANUP_ARG

echo ""
echo "=== Toolchain release ${RELEASE} uploaded — NOT promoted ==="
echo "  It builds, signs and scans asynchronously (watch the Builds page). Then, from the"
echo "  Toolchain console (toolchain:operate): add canary orgs, and once the canary gate passes,"
echo "  set ${RELEASE} as the platform default. Pipelines move on their next run."
