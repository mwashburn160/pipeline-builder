#!/bin/sh
set -eu

# Load all sample pipelines from deploy/samples into the platform.
# Usage:
#   ./load-pipelines.sh                          # defaults to https://localhost:8443
#   PLATFORM_BASE_URL=https://host ./load-pipelines.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SAMPLES_DIR="$DEPLOY_DIR/samples"
PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}

echo "=== Loading pipelines ==="
echo "  URL: $PLATFORM_BASE_URL"

# Login
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

if [ ! -d "$SAMPLES_DIR" ]; then
    echo "No samples directory found at $SAMPLES_DIR" >&2
    exit 1
fi

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

echo ""
echo "=== Done ==="
