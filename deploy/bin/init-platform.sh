#!/bin/sh
set -eu

# Platform initialization script — works with both local (Docker Compose) and minikube.
# Usage:
#   ./init-platform.sh              # defaults to "local"
#   ./init-platform.sh local        # Docker Compose (https://localhost:8443)
#   ./init-platform.sh minikube     # Minikube (tunnels via minikube service)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-local}"
PROFILE="pipeline-builder"
NAMESPACE="pipeline-builder"
TUNNEL_PID=""

cleanup() {
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

case "$TARGET" in
  local)
    PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}
    ;;
  minikube)
    if [ -n "${PLATFORM_BASE_URL:-}" ]; then
      echo "Using PLATFORM_BASE_URL=$PLATFORM_BASE_URL"
    else
      # Docker driver on macOS can't route to minikube IP directly.
      # Use kubectl port-forward to tunnel through to nginx.
      # Reuse existing port-forward if already running on 8443.
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
  *)
    echo "Usage: $0 [local|minikube]" >&2
    exit 1
    ;;
esac

echo ""
echo "=== Initializing platform ($TARGET) ==="
echo "  URL: $PLATFORM_BASE_URL"

# Wait for platform service to be healthy
MAX_RETRIES=30
RETRY_INTERVAL=5
echo ""
echo "Waiting for platform to be ready at ${PLATFORM_BASE_URL}/health ..."
for i in $(seq 1 $MAX_RETRIES); do
    STATUS=$(curl -s -k -o /dev/null -w "%{http_code}" "${PLATFORM_BASE_URL}/health" 2>/dev/null || true)
    if [ "$STATUS" = "200" ]; then
        echo "Platform is healthy."
        break
    fi
    if [ "$i" = "$MAX_RETRIES" ]; then
        echo "Platform failed to become healthy after $((MAX_RETRIES * RETRY_INTERVAL))s — aborting." >&2
        exit 1
    fi
    sleep $RETRY_INTERVAL
done

echo ""
echo "=== Registering admin user ==="
REG_STATUS=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/register" \
     -k -s -o /dev/null -w "%{http_code}" \
     -H 'Content-Type: application/json' \
     -d '{
           "username": "admin",
           "email": "admin@internal",
           "password": "SecurePassword123!",
           "organizationName": "system"
         }')
if [ "$REG_STATUS" = "201" ] || [ "$REG_STATUS" = "200" ]; then
    echo "  Admin user created."
else
    echo "  Admin user already exists (HTTP $REG_STATUS) — continuing."
fi

echo ""
echo "=== Logging in ==="
JWT_TOKEN=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/login" \
    -k -s \
    -H 'Content-Type: application/json' \
    -d '{
         "identifier": "admin@internal",
         "password": "SecurePassword123!"
        }' | jq -r '.data.accessToken')

if [ -z "${JWT_TOKEN}" ] || [ "${JWT_TOKEN}" = "null" ]; then
    echo "Login failed — could not obtain JWT token" >&2
    exit 1
fi
echo "  Logged in successfully."

PLUGINS_DIR="$DEPLOY_DIR/plugins"
if [ -d "$PLUGINS_DIR" ]; then
    echo ""
    echo "=== Uploading plugins ==="
    find "$PLUGINS_DIR" -type f -iname "plugin.zip" -exec sh -c '
        echo "  Uploading: $1"
        UPLOAD_STATUS=$(curl -X POST "$2/api/plugin/upload" \
         -s -o /dev/null -w "%{http_code}" --max-time 900 \
         -H "Authorization: Bearer $3" \
         -H "x-org-id: system" \
         -F "plugin=@$1" \
         -F "accessModifier=public" \
         --insecure)
        echo "    HTTP $UPLOAD_STATUS"
    ' _ {} "${PLATFORM_BASE_URL}" "${JWT_TOKEN}" \;
else
    echo "No plugins directory found at $PLUGINS_DIR — skipping plugin upload."
fi

SAMPLES_DIR="$DEPLOY_DIR/samples"
if [ -d "$SAMPLES_DIR" ]; then
    echo ""
    echo "=== Creating sample pipelines ==="
    find "$SAMPLES_DIR" -type f -iname "*.json" -exec sh -c '
        echo "  Creating: $(basename "$1")"
        BODY=$(jq ".accessModifier = \"public\"" "$1")
        CREATE_STATUS=$(curl -X POST "$2/api/pipeline" \
         -s -o /dev/null -w "%{http_code}" \
         -H "Authorization: Bearer $3" \
         -H "Content-Type: application/json" \
         -H "x-org-id: system" \
         -d "$BODY" \
         --insecure)
        echo "    HTTP $CREATE_STATUS"
    ' _ {} "${PLATFORM_BASE_URL}" "${JWT_TOKEN}" \;
else
    echo "No samples directory found at $SAMPLES_DIR — skipping pipeline creation."
fi

echo ""
echo "=== Initialization complete ==="
