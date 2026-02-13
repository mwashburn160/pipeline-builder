#!/bin/sh
set -eu

# Local development platform initialization script.
# Set ADMIN_PASSWORD in your environment or a random one will be generated.
PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-$(openssl rand -base64 24)}

curl -X POST "${PLATFORM_BASE_URL}/api/auth/register" \
     -k -s -o /dev/null \
     -H "Content-Type: application/json" \
     -d "{
           \"username\": \"admin\",
           \"email\": \"admin@internal\",
           \"password\": \"${ADMIN_PASSWORD}\",
           \"organizationName\": \"system\"
         }"

if [ $? -eq 0 ]; then
    JWT_TOKEN=$(curl -s -X POST "${PLATFORM_BASE_URL}/api/auth/login" \
    -k \
    -H "Content-Type: application/json" \
    -d "{
         \"identifier\": \"admin@internal\",
         \"password\": \"${ADMIN_PASSWORD}\"
        }" | jq -r '.data.accessToken')

    if [ -z "${JWT_TOKEN}" ] || [ "${JWT_TOKEN}" = "null" ]; then
        echo "Login failed — could not obtain JWT token" >&2
        exit 1
    fi

    echo "Logged in successfully."
    find plugins -type f -iname "plugin.zip" -exec sh -c '
        echo "Loading plugin: $1" && curl -X POST "'"${PLATFORM_BASE_URL}"'/api/plugin/upload" \
         -s -o /dev/null --max-time 900 \
         -H "Authorization: Bearer '"${JWT_TOKEN}"'" \
         -H "x-org-id: system" \
         -F "plugin=@$1" \
         -F "accessModifier=public" \
         --insecure
    ' _ {} \;
fi
