#!/bin/sh
set +x

PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}

curl -X POST ${PLATFORM_BASE_URL}/api/auth/register \
     -k -s -o /dev/null \
     -H "Content-Type: application/json" \
     -d '{
           "username": "admin",
           "email": "admin@internal",
           "password": "SecurePassword123!",
           "organizationName": "system"
         }'

if [ $? -eq 0 ]; then
    JWT_TOKEN=$(curl -s -X POST ${PLATFORM_BASE_URL}/api/auth/login \
    -k \
    -H "Content-Type: application/json" \
    -d '{
         "identifier": "admin@internal",
         "password": "SecurePassword123!"
        }' | jq -r '.data.accessToken')

    echo "Logged in successfully. JWT Token: ${JWT_TOKEN}"
    find . -type f -iname "plugin.zip" -exec sh -c '
        echo "Loading plugin: $1" && curl -X POST "'"${PLATFORM_BASE_URL}"'/api/plugin/upload" \
         -s -o /dev/null --max-time 900 \
         -H "Authorization: Bearer '"${JWT_TOKEN}"'" \
         -H "x-org-id: system" \
         -F "plugin=@$1" \
         -F "accessModifier=public" \
         --insecure
    ' _ {} \;
fi