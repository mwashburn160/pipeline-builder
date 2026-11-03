#!/usr/bin/env bash
# Build + publish the CodeBuild bootstrap image (pipeline-bootstrap:1.0).
#
# This image backs `CODEBUILD_DEFAULT_IMAGE` — the fallback runtime used
# by CodeBuild steps that don't have a plugin-baked image (cold-start
# synth, ShellSteps without a registry, `metadata_only` plugins). It is
# `FROM aws/codebuild/standard:7.0` with `pipeline-manager` baked in.
#
# Idempotency: the underlying push-base-images.sh skips per-tag when the
# tag already exists in the registry library (manifest probe). So this
# script is safe to re-run on every init — work is done only on first
# bootstrap and after the pinned Dockerfile changes.
#
# Strategy mirrors plugin loading:
#   1. Build the image locally (or skip if `pipeline-bootstrap:1.0` is
#      already in the docker cache and `--force` was not passed).
#   2. Publish to the registry library via the multi-target pusher
#      (`push-base-images.sh`) so the same transport works across local /
#      minikube / ec2 / eks targets.
#
# Why this lives outside build-plugin-images.sh: the bootstrap image is a
# CodeBuild runtime, not a plugin or plugin base. Coupling its lifecycle
# to the plugin build script muddied responsibilities — `--bases-only`,
# `--category`, plugin upload retries, image-tar materialization. None of
# those apply here. A focused script keeps the concern separable and
# callable on its own from init-platform.
#
# Usage:
#   build-codebuild-bootstrap.sh                # build (if missing) + publish (if missing)
#   build-codebuild-bootstrap.sh --force        # rebuild even if local image cache has it
#   FORCE_PUSH=true build-codebuild-bootstrap.sh # republish even if remote tag exists
#   DEPLOY_TARGET=ec2 build-codebuild-bootstrap.sh  # pick push transport (docker|minikube|ec2|eks)
#
# Prints the published image's manifest digest at the end — set it as
# CODEBUILD_DEFAULT_IMAGE_DIGEST so synth pins the default build image by digest.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
BUILD_CTX="$DEPLOY_DIR/codebuild/bootstrap"
# Image tag to build + publish. Override BOOTSTRAP_IMAGE_TAG to cut a NEW version
# (e.g. pipeline-bootstrap:1.1) instead of refreshing 1.0 in place. The tag MUST
# match the deployment's CODEBUILD_DEFAULT_IMAGE — that's what the synth pulls as
# the default build image; a mismatch yields BUILD_CONTAINER_UNABLE_TO_PULL_IMAGE.
TAG="${BOOTSTRAP_IMAGE_TAG:-pipeline-bootstrap:1.0}"
# Platform the bootstrap image is built for. Default linux/amd64 — the CodeBuild
# runtime that runs it. Override PUBLISH_PLATFORM (e.g. linux/arm64) for an
# all-Graviton stack. On an arm64 host docker emulates amd64; crane pushes the
# tarball's arch as-is (no per-push platform flag).
PUBLISH_PLATFORM="${PUBLISH_PLATFORM:-linux/amd64}"

FORCE_BUILD=false

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE_BUILD=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--force]"
      echo ""
      echo "Options:"
      echo "  --force   Rebuild the local image even when it already exists in docker cache"
      echo ""
      echo "Env:"
      echo "  DEPLOY_TARGET   docker | minikube | ec2 | eks (default: docker)"
      echo "  FORCE_PUSH      true to republish even when remote tag exists"
      echo "  BOOTSTRAP_IMAGE_TAG       image tag to build/push (default: pipeline-bootstrap:1.0);"
      echo "                            must match the deploy's CODEBUILD_DEFAULT_IMAGE"
      echo "  PIPELINE_MANAGER_VERSION  version to bake in (default: the Dockerfile's pinned ARG, kept"
      echo "                            at the released version by sync-image-tags.sh); 'latest'"
      echo "                            is resolved to a concrete version"
      echo "  BOOTSTRAP_SCAN            true|false — grype-gate the image before publishing"
      echo "                            (default: true when grype is on PATH)"
      echo "  GRYPE_FAIL_ON             severity that blocks publishing, fixable findings only:"
      echo "                            negligible|low|medium|high|critical (default: critical)"
      echo "  PUBLISH_PLATFORM          build/push platform, e.g. linux/arm64 (default: linux/amd64)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$BUILD_CTX/Dockerfile" ]; then
  echo "ERROR: $BUILD_CTX/Dockerfile not found" >&2
  exit 1
fi

# ---- Build ----
echo "=== Building $TAG ==="
if [ "$FORCE_BUILD" = false ] && docker image inspect "$TAG" >/dev/null 2>&1; then
  echo "  = $TAG present in local docker cache (use --force to rebuild)"
else
  # The pipeline-manager version to bake in. DEFAULT: the Dockerfile's own
  # pinned `ARG PIPELINE_MANAGER_VERSION`, which the release keeps on the
  # just-published version (sync-image-tags.sh) — so no build-arg is passed and
  # the image is reproducible from the tree. An explicit version is passed
  # through; the bare dist-tag `latest` is resolved to a CONCRETE version first,
  # because caching an `npm install …@latest` layer silently reuses a
  # pre-publish layer and ships stale code long after a release.
  _pm_version="${PIPELINE_MANAGER_VERSION:-}"
  _build_args=()
  if [ "$_pm_version" = "latest" ]; then
    _pm_version="$(npm view @pipeline-builder/pipeline-manager version 2>/dev/null || true)"
    if [ -z "$_pm_version" ]; then
      echo "ERROR: could not resolve pipeline-manager@latest from npm; unset PIPELINE_MANAGER_VERSION to use the pinned version" >&2
      exit 1
    fi
    echo "  resolved pipeline-manager@latest -> $_pm_version"
  fi
  if [ -n "$_pm_version" ]; then
    _build_args+=(--build-arg "PIPELINE_MANAGER_VERSION=${_pm_version}")
  else
    echo "  pipeline-manager: $(sed -nE 's/^ARG PIPELINE_MANAGER_VERSION="?([^"]+)"?.*/\1/p' "$BUILD_CTX/Dockerfile") (pinned in the Dockerfile)"
  fi

  # PUBLISH_PLATFORM defaults to linux/amd64 (the CodeBuild runtime) while the
  # operator's host is often arm64, so register QEMU/binfmt first — exactly what
  # build-plugin-images.sh does before its own cross-arch builds. Without it the
  # build dies mid-RUN with `exec format error`. Idempotent, and best-effort by
  # contract (it always exits 0; a missing emulator surfaces as the build failure
  # below, not as a silent skip).
  bash "$SCRIPT_DIR/ensure-binfmt.sh" "$PUBLISH_PLATFORM"

  # "${arr[@]+"${arr[@]}"}" expands to nothing for an EMPTY array — plain
  # "${arr[@]}" throws "unbound variable" under `set -u` on bash 3.2 (macOS).
  docker build --platform "$PUBLISH_PLATFORM" \
    "${_build_args[@]+"${_build_args[@]}"}" \
    -t "$TAG" "$BUILD_CTX"
fi

# ---- Vulnerability gate ----
# The bootstrap image is built HERE, per deployment, rather than by the release
# workflow, so the release's sign/scan path never sees it. Scan it before it
# reaches the registry with the same bar the release applies to platform images:
# fail on any finding at or above GRYPE_FAIL_ON (default critical, as in CI) that
# has a fix (rebuild with --force to pick the fix
# up — the Dockerfile runs a full apt upgrade). CI scans it too: the PR smoke
# build when its Dockerfile changes, and plugin-base-freshness weekly.
# BOOTSTRAP_SCAN=false skips (e.g. an air-gapped host without the grype DB).
_scan="${BOOTSTRAP_SCAN:-auto}"
if [ "$_scan" = auto ]; then
  if command -v grype >/dev/null 2>&1; then _scan=true; else
    _scan=false
    echo "  NOTE: grype not on PATH — $TAG is published UNSCANNED (install grype, or set BOOTSTRAP_SCAN=false to silence)" >&2
  fi
fi
if [ "$_scan" = true ]; then
  GRYPE_FAIL_ON="${GRYPE_FAIL_ON:-critical}"
  case "$GRYPE_FAIL_ON" in negligible|low|medium|high|critical) ;; *) echo "ERROR: GRYPE_FAIL_ON must be negligible|low|medium|high|critical (got '$GRYPE_FAIL_ON')" >&2; exit 1 ;; esac
  echo ""
  echo "=== Scanning $TAG (grype, fixable at/above $GRYPE_FAIL_ON) ==="
  grype "docker:$TAG" --only-fixed --fail-on "$GRYPE_FAIL_ON" \
    || { echo "ERROR: $TAG has fixable vulnerabilities at/above $GRYPE_FAIL_ON — not publishing. Rebuild with --force." >&2; exit 1; }
fi

# ---- Publish ----
# Reuse push-base-images.sh — it owns the per-target transport (docker
# sidecar for local, kubectl-run crane pod for minikube/ec2/eks) and
# the registry token exchange. PUSH_TAGS overrides its discovery so we
# don't also re-walk the plugin-base set.
echo ""
echo "=== Publishing $TAG to registry library ==="
PUSH_TAGS="$TAG" \
  DEPLOY_TARGET="${DEPLOY_TARGET:-docker}" \
  "$SCRIPT_DIR/push-base-images.sh"

# ---- Digest ----
# The synth pins the default build image BY DIGEST when
# CODEBUILD_DEFAULT_IMAGE_DIGEST is set (a tag in library/ can be re-pointed by
# anyone holding a registry push credential). crane pushed the `docker save`
# tarball as-is, so `crane digest --tarball` over the same tarball is exactly
# the manifest digest now in the registry. Same pinned crane image the pusher
# uses (read from push-base-images.sh, so the two can't drift).
_crane="${CRANE_IMAGE:-$(sed -nE 's/^CRANE_IMAGE="\$\{CRANE_IMAGE:-([^}]+)\}".*/\1/p' "$SCRIPT_DIR/push-base-images.sh")}"
if [ -n "$_crane" ] && _digest="$(docker save "$TAG" | docker run --rm -i --entrypoint sh "$_crane" \
     -c 'cat > /tmp/img.tar && crane digest --tarball /tmp/img.tar' 2>/dev/null)" \
   && printf '%s' "$_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo ""
  echo "=== Pin the default build image ==="
  echo "  Set in the environment that runs \`pipeline-manager pipeline synth/deploy\`:"
  echo "    CODEBUILD_DEFAULT_IMAGE=${TAG}"
  echo "    CODEBUILD_DEFAULT_IMAGE_DIGEST=${_digest}"
  echo "  (the synth then pulls <registry>/library/${TAG%%:*}@${_digest}, and carries both"
  echo "   into the pipeline so its self-mutating synth keeps the pin)."
  echo "  NOTE: this is the LOCAL image's digest. If the publish above skipped an existing tag,"
  echo "        confirm it matches the registry (crane digest <registry>/library/${TAG}) or re-run with FORCE_PUSH=true."
else
  echo "  WARNING: could not compute ${TAG}'s digest — the synth will pull it by its mutable tag" >&2
  echo "           until CODEBUILD_DEFAULT_IMAGE_DIGEST is set (crane digest <registry>/library/${TAG})." >&2
fi
