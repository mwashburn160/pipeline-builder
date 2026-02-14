#!/bin/sh
set -eu

# Local development platform initialization script.
# Set ADMIN_PASSWORD in your environment or a random one will be generated.
PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-$(openssl rand -base64 24)}

# Wait for platform service to be healthy
MAX_RETRIES=30
RETRY_INTERVAL=5
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

curl -X POST ${PLATFORM_BASE_URL}/api/auth/register \
     -k -s -o /dev/null \
     -H 'Content-Type: application/json' \
     -d '{
           "username": "admin",
           "email": "admin@internal",
           "password": "SecurePassword123!",
           "organizationName": "system"
         }'

if [ $? -eq 0 ]; then
    JWT_TOKEN=$(curl -X POST ${PLATFORM_BASE_URL}/api/auth/login \
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

    echo "Logged in successfully."
    find plugins -type f -iname "plugin.zip" -exec sh -c "
        echo 'Loading plugin: $1' && curl -X POST '$2/api/plugin/upload' \
         -s -o /dev/null --max-time 900 \
         -H 'Authorization: Bearer $3' \
         -H 'x-org-id: system' \
         -F 'plugin=@$1' \
         -F 'accessModifier=public' \
         --insecure
    " _ {} "${PLATFORM_BASE_URL}" "${JWT_TOKEN}" \;
fi
