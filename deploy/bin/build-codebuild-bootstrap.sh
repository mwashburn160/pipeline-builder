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
#   DEPLOY_TARGET=ec2 build-codebuild-bootstrap.sh  # pick push transport (local|minikube|ec2|eks)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
BUILD_CTX="$DEPLOY_DIR/codebuild/bootstrap"
TAG="pipeline-bootstrap:1.0"
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
      echo "  DEPLOY_TARGET   local | minikube | ec2 | eks (default: local)"
      echo "  FORCE_PUSH      true to republish even when remote tag exists"
      echo "  PIPELINE_MANAGER_VERSION  npm dist-tag or version (default: latest)"
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
  _build_args=()
  [ -n "${PIPELINE_MANAGER_VERSION:-}" ] && \
    _build_args+=(--build-arg "PIPELINE_MANAGER_VERSION=${PIPELINE_MANAGER_VERSION}")
  # "${arr[@]+"${arr[@]}"}" expands to nothing for an EMPTY array — plain
  # "${arr[@]}" throws "unbound variable" under `set -u` on bash 3.2 (macOS).
  docker build --platform "$PUBLISH_PLATFORM" "${_build_args[@]+"${_build_args[@]}"}" -t "$TAG" "$BUILD_CTX"
fi

# ---- Publish ----
# Reuse push-base-images.sh — it owns the per-target transport (docker
# sidecar for local/eks, kubectl-run crane pod for minikube/ec2) and
# the registry token exchange. PUSH_TAGS overrides its discovery so we
# don't also re-walk the plugin-base set.
echo ""
echo "=== Publishing $TAG to registry library ==="
PUSH_TAGS="$TAG" \
  DEPLOY_TARGET="${DEPLOY_TARGET:-local}" \
  "$SCRIPT_DIR/push-base-images.sh"
