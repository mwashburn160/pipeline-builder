#!/usr/bin/env bash
set -eu

# Initialize the platform — register admin, optionally load plugins and pipelines.
#
# Usage:
#   ./init-platform.sh                                         # defaults to "local"
#   ./init-platform.sh local                                   # Docker Compose (https://localhost:8443)
#   ./init-platform.sh minikube                                # Minikube (tunnels via kubectl port-forward)
#   ./init-platform.sh ec2                                     # EC2 (requires PLATFORM_BASE_URL or stack name)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

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
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" PLATFORM_TOKEN="$JWT_TOKEN" "$SCRIPT_DIR/load-plugins.sh"
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

# Load compliance rules
echo ""
printf "Load sample compliance rules? [y/N] "
read -r LOAD_RULES
if [ "$LOAD_RULES" = "y" ] || [ "$LOAD_RULES" = "Y" ]; then
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" PLATFORM_TOKEN="$JWT_TOKEN" "$SCRIPT_DIR/load-compliance-rules.sh"
else
  echo "  Skipping compliance rule loading."
fi

echo ""
echo "=== Initialization complete ==="
