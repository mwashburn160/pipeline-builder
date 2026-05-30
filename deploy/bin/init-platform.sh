#!/usr/bin/env bash
set -euo pipefail

# Initialize the platform — register admin, optionally load plugins and pipelines.
#
# Usage:
#   ./init-platform.sh                                         # defaults to "local"
#   ./init-platform.sh local                                   # Docker Compose (https://localhost:8443)
#   ./init-platform.sh minikube                                # Minikube (tunnels via kubectl port-forward)
#   ./init-platform.sh ec2                                     # EC2 (requires PLATFORM_BASE_URL or stack name)
#   ./init-platform.sh --cleanup ec2                           # Clean up plugin.zip + image.tar after upload

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

CLEANUP_AFTER_UPLOAD=false
# Default: keep current strict behavior — abort on the first plugin build failure.
# Pass --continue-on-build-failure to let init proceed when some plugins fail
# (e.g., transient apt mirror flap on 1 of 124 plugins). The successful tars
# still get loaded; the failed ones are skipped by load-plugins (no image.tar
# = no upload, no spurious 500).
CONTINUE_ON_BUILD_FAILURE=false

# Parse flags before the target argument
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) CLEANUP_AFTER_UPLOAD=true; shift ;;
    --continue-on-build-failure) CONTINUE_ON_BUILD_FAILURE=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done

TARGET="${1:-local}"
NAMESPACE="pipeline-builder"
TUNNEL_PID=""

# ---- Cleanup ----

cleanup() {
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---- Resolve platform URL ----

case "$TARGET" in
  local)
    PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}
    ;;
  minikube)
    if [ -n "${PLATFORM_BASE_URL:-}" ]; then
      echo "Using PLATFORM_BASE_URL=$PLATFORM_BASE_URL"
    else
      if curl -s -k -o /dev/null -w "" "https://localhost:8443/" 2>/dev/null; then
        echo "=== Reusing existing port-forward on localhost:8443 ==="
      else
        echo "=== Setting up port-forward to nginx ==="
        kubectl port-forward svc/nginx 8443:8443 -n "$NAMESPACE" > /dev/null 2>&1 &
        TUNNEL_PID=$!
        sleep 2
        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
          echo "ERROR: Port-forward failed. Is the cluster running?" >&2
          exit 1
        fi
        echo "  Forwarding localhost:8443 -> nginx:8443"
      fi
      PLATFORM_BASE_URL="https://localhost:8443"
    fi
    ;;
  ec2)
    if [ -n "${PLATFORM_BASE_URL:-}" ]; then
      echo "Using PLATFORM_BASE_URL=$PLATFORM_BASE_URL"
    else
      # Try to resolve URL from CloudFormation stack outputs
      STACK_NAME="${STACK_NAME:-pipeline-builder}"
      echo "=== Resolving URL from CloudFormation stack: $STACK_NAME ==="
      APP_URL=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --query 'Stacks[0].Outputs[?OutputKey==`ApplicationURL`].OutputValue' \
        --output text 2>/dev/null || true)
      if [ -z "$APP_URL" ] || [ "$APP_URL" = "None" ]; then
        echo "ERROR: Could not resolve ApplicationURL from stack '$STACK_NAME'." >&2
        echo "  Set PLATFORM_BASE_URL or STACK_NAME manually." >&2
        exit 1
      fi
      PLATFORM_BASE_URL="$APP_URL"
      echo "  Resolved: $PLATFORM_BASE_URL"
    fi
    ;;
  *)
    echo "Usage: $0 [local|minikube|ec2]" >&2
    exit 1
    ;;
esac

# ---- Main ----

echo ""
echo "=== Initializing platform ($TARGET) ==="
echo "  URL: $PLATFORM_BASE_URL"
echo ""

wait_for_health 30 5

# Register admin user
echo ""
echo "=== Registering admin user ==="
prompt_credentials
REG_STATUS=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/register" \
  -k -s -o /dev/null -w "%{http_code}" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg email "$PLATFORM_IDENTIFIER" --arg pw "$PLATFORM_PASSWORD" \
    '{username: "admin", email: $email, password: $pw, organizationName: "system"}')")

case "$(classify_status "$REG_STATUS")" in
  ok)   echo "  Admin user created." ;;
  *)    echo "  Admin user already exists (HTTP $REG_STATUS) — continuing." ;;
esac

echo ""
echo "=== Logging in ==="
login

# Build + publish the CodeBuild bootstrap image (pipeline-bootstrap:1.0).
# Backs CODEBUILD_DEFAULT_IMAGE so cold-start synth runs against an image
# with pipeline-manager pre-installed, instead of paying ~30s for the
# npm install on every pipeline. Idempotent — push step skips when the
# tag is already in the registry library, so this is cheap to re-run.
# Independent of plugin loading: the runtime image is needed even when
# plugins aren't being uploaded (e.g. operator only refreshing services).
#
# Non-interactive runs (no TTY): skip by default. Set BUILD_BOOTSTRAP=true
# in CI env to opt in, BUILD_BOOTSTRAP=false to be explicit. Auto-running
# a docker build + registry push under set -e on a headless host wasn't
# what callers wanted.
echo ""
BUILD_BOOTSTRAP="${BUILD_BOOTSTRAP:-}"
if [ -z "$BUILD_BOOTSTRAP" ] && [ -t 0 ]; then
  printf "Build + publish CodeBuild bootstrap image (pipeline-bootstrap:1.0)? [Y/n] "
  read -r BUILD_BOOTSTRAP
  BUILD_BOOTSTRAP="${BUILD_BOOTSTRAP:-y}"
fi
case "$BUILD_BOOTSTRAP" in
  y|Y|yes|true) DEPLOY_TARGET="$TARGET" "$SCRIPT_DIR/build-codebuild-bootstrap.sh" ;;
  *)            echo "  Skipping CodeBuild bootstrap image." ;;
esac

# Load plugins
echo ""
printf "Load plugins? [y/N] "
read -r LOAD_PLUGINS
if [ "$LOAD_PLUGINS" = "y" ] || [ "$LOAD_PLUGINS" = "Y" ]; then

  # ---- Plugin build strategy ----
  BUILD_STRATEGY="${PLUGIN_BUILD_STRATEGY:-}"
  if [ -z "$BUILD_STRATEGY" ] && [ -t 0 ]; then
    echo ""
    echo "  Plugin build strategy:"
    echo "    1) prebuilt     — Use pre-built images bundled as image.tar (default)"
    echo "    2) build_image  — Build from Dockerfile at upload time (slow)"
    echo ""
    printf "  Select [1/2] (default: 1): "
    read -r _strategy_choice
    case "$_strategy_choice" in
      2|build_image) BUILD_STRATEGY="build_image" ;;
      *)             BUILD_STRATEGY="prebuilt" ;;
    esac
  fi
  BUILD_STRATEGY="${BUILD_STRATEGY:-prebuilt}"

  # ---- Category selection ----
  SELECTED_CATEGORIES=""
  if [ -n "${PLUGIN_CATEGORY:-}" ]; then
    SELECTED_CATEGORIES="$PLUGIN_CATEGORY"
  elif [ -t 0 ]; then
    select_categories "$DEPLOY_DIR/plugins" || exit 0
  fi

  CATEGORY_ARG=""
  [ -n "$SELECTED_CATEGORIES" ] && CATEGORY_ARG="--category $SELECTED_CATEGORIES"

  # Base images must be present in the in-cluster registry for *both*
  # strategies — even build_image plugin Dockerfiles use bare
  # `FROM pipeline-plugin-base:24.04`, which buildkit resolves at
  # build-time via the registry mirror.
  #
  # Strategy selection:
  #   prebuilt    → full build-plugin-images.sh handles bases internally,
  #                 so we go straight to it (no --bases-only step).
  #   build_image → bases never get built by the full script (it only
  #                 builds per-plugin images), so we run --bases-only
  #                 to seed the registry before plugin uploads start.
  #
  # DEPLOY_TARGET is consumed by push-base-images.sh to pick the right
  # transport: local→docker-sidecar on backend-network, minikube/ec2→
  # crane-in-kubectl-run-pod inside the cluster.
  if [ "$BUILD_STRATEGY" = "prebuilt" ]; then
    echo ""
    BUILD_ARGS=""
    [ "${FORCE_REBUILD:-}" != "true" ] || BUILD_ARGS="$BUILD_ARGS --force"
    # The build script returns non-zero if any plugin failed to build. Under
    # `set -e` that aborts init entirely — typical case is one bad apt mirror
    # killing the whole bootstrap. With --continue-on-build-failure we log
    # and proceed; load-plugins will skip plugins lacking an image.tar.
    BUILD_RC=0
    # shellcheck disable=SC2086
    DEPLOY_TARGET="$TARGET" "$SCRIPT_DIR/build-plugin-images.sh" $BUILD_ARGS $CATEGORY_ARG || BUILD_RC=$?
    if [ "$BUILD_RC" -ne 0 ]; then
      if [ "$CONTINUE_ON_BUILD_FAILURE" = "true" ]; then
        echo "  WARNING: build-plugin-images exited $BUILD_RC — continuing per --continue-on-build-failure" >&2
      else
        echo "  ERROR: build-plugin-images exited $BUILD_RC. Re-run with --continue-on-build-failure to proceed with the plugins that did build." >&2
        exit "$BUILD_RC"
      fi
    fi
    echo ""
  else
    # build_image strategy — seed the in-cluster registry with base
    # images, since the per-plugin build step is skipped on this path
    # but plugin Dockerfiles still reference the bases.
    echo ""
    DEPLOY_TARGET="$TARGET" "$SCRIPT_DIR/build-plugin-images.sh" --bases-only
    echo ""
  fi

  # Re-authenticate before upload (token may have expired during prebuilt image builds)
  echo ""
  echo "=== Refreshing auth token ==="
  login

  CLEANUP_ARG=""
  [ "$CLEANUP_AFTER_UPLOAD" = true ] && CLEANUP_ARG="--cleanup"

  # shellcheck disable=SC2086
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" \
    PLATFORM_TOKEN="$JWT_TOKEN" \
    SKIP_MISSING_IMAGE_TAR="$CONTINUE_ON_BUILD_FAILURE" \
    "$SCRIPT_DIR/load-plugins.sh" --rebuild $CATEGORY_ARG $CLEANUP_ARG
else
  echo "  Skipping plugin loading."
fi

# Load pipelines
echo ""
printf "Load sample pipelines? [y/N] "
read -r LOAD_PIPELINES
if [ "$LOAD_PIPELINES" = "y" ] || [ "$LOAD_PIPELINES" = "Y" ]; then
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" PLATFORM_TOKEN="$JWT_TOKEN" "$SCRIPT_DIR/load-pipelines.sh"
else
  echo "  Skipping pipeline loading."
fi

# Load compliance rules and policy templates
echo ""
printf "Load sample compliance rules and policy templates? [y/N] "
read -r LOAD_COMPLIANCE
if [ "$LOAD_COMPLIANCE" = "y" ] || [ "$LOAD_COMPLIANCE" = "Y" ]; then
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" PLATFORM_TOKEN="$JWT_TOKEN" "$SCRIPT_DIR/load-compliance.sh"
else
  echo "  Skipping compliance loading."
fi

# Load default observability dashboards. Skipped silently if any are already
# present (the platform service also has an in-process seeder; this script
# is the operator-driven equivalent, idempotent by `(orgId='system', name)`).
echo ""
printf "Load default observability dashboards? [y/N] "
read -r LOAD_DASHBOARDS
if [ "$LOAD_DASHBOARDS" = "y" ] || [ "$LOAD_DASHBOARDS" = "Y" ]; then
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" PLATFORM_TOKEN="$JWT_TOKEN" "$SCRIPT_DIR/load-dashboards.sh"
else
  echo "  Skipping dashboard loading."
fi

echo ""
echo "=== Initialization complete ==="
