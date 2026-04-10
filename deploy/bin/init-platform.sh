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

# Parse flags before the target argument
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) CLEANUP_AFTER_UPLOAD=true; shift ;;
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
    echo "    1) build_image  — Build from Dockerfile at upload time (default)"
    echo "    2) prebuilt     — Pre-build images now, bundle as image.tar"
    echo ""
    printf "  Select [1/2] (default: 1): "
    read -r _strategy_choice
    case "$_strategy_choice" in
      2|prebuilt) BUILD_STRATEGY="prebuilt" ;;
      *)          BUILD_STRATEGY="build_image" ;;
    esac
  fi
  BUILD_STRATEGY="${BUILD_STRATEGY:-build_image}"

  # ---- Category selection (shared between build and load) ----
  SELECTED_CATEGORIES=""
  if [ -n "${PLUGIN_CATEGORY:-}" ]; then
    SELECTED_CATEGORIES="$PLUGIN_CATEGORY"
  elif [ -t 0 ]; then
    AVAILABLE=$(find "$DEPLOY_DIR/plugins" -mindepth 1 -maxdepth 1 -type d | sort | xargs -I{} basename {})
    echo ""
    echo "  Available categories:"
    _i=0
    for _cat in $AVAILABLE; do
      _i=$((_i + 1))
      _count=$(find "$DEPLOY_DIR/plugins/$_cat" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
      echo "    ${_i}) ${_cat} (${_count} plugins)"
    done
    echo ""
    printf "  Load all categories? [Y/n]: "
    read -r _load_all
    if [ "$_load_all" = "n" ] || [ "$_load_all" = "N" ]; then
      printf "  Enter category numbers (comma-separated, e.g. 1,3,4): "
      read -r _selected_nums
      _picked=""
      for num in $(echo "$_selected_nums" | tr ',' ' '); do
        _idx=0
        for _cat in $AVAILABLE; do
          _idx=$((_idx + 1))
          [ "$_idx" = "$num" ] && _picked="${_picked}${_cat},"
        done
      done
      SELECTED_CATEGORIES="${_picked%,}"
    else
      # User picked "all" — expand to full category list so child scripts don't re-prompt
      SELECTED_CATEGORIES=$(echo "$AVAILABLE" | tr ' ' ',' | tr '\n' ',' | sed 's/,$//')
    fi
  fi

  CATEGORY_ARG=""
  [ -n "$SELECTED_CATEGORIES" ] && CATEGORY_ARG="--category $SELECTED_CATEGORIES"

  if [ "$BUILD_STRATEGY" = "prebuilt" ]; then
    echo ""
    BUILD_ARGS=""
    [ "${FORCE_REBUILD:-}" != "true" ] || BUILD_ARGS="$BUILD_ARGS --force"
    # shellcheck disable=SC2086
    "$SCRIPT_DIR/build-plugin-images.sh" $BUILD_ARGS $CATEGORY_ARG
    echo ""
  fi

  # shellcheck disable=SC2086
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" PLATFORM_TOKEN="$JWT_TOKEN" "$SCRIPT_DIR/load-plugins.sh" --rebuild $CATEGORY_ARG

  # Clean up build artifacts to reclaim disk space
  if [ "$CLEANUP_AFTER_UPLOAD" = true ]; then
    echo ""
    echo "=== Cleaning up plugin build artifacts ==="
    _cleaned=0
    for _pdir in "$DEPLOY_DIR/plugins"/*/*/; do
      [ -d "$_pdir" ] || continue
      for _artifact in "$_pdir/plugin.zip" "$_pdir/image.tar"; do
        if [ -f "$_artifact" ]; then
          rm -f "$_artifact"
          _cleaned=$((_cleaned + 1))
        fi
      done
    done
    echo "  Removed ${_cleaned} artifact file(s)"
  fi
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

echo ""
echo "=== Initialization complete ==="
