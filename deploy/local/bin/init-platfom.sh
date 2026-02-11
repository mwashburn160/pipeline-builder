#!/bin/sh
set +x

PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}

curl -X POST ${PLATFORM_BASE_URL}/api/auth/register \
     -k \
     -H "Content-Type: application/json" \
     -d '{
           "username": "admin",
           "email": "admin@internal.com",
           "password": "SecurePassword123!",
           "organizationName": "system"
         }' 

if [ $? -eq 0 ]; then
    JWT_TOKEN=$(curl -X POST ${PLATFORM_BASE_URL}/api/auth/login \
    -k \
    -H "Content-Type: application/json" \
    -d '{
         "identifier": "admin@internal.com",
         "password": "SecurePassword123!"
        }' | jq -r '.data.accessToken')

    find . -type f -iname "*.zip" -exec curl -X POST "${PLATFORM_BASE_URL}/api/plugin/upload" \
     -H "Authorization: Bearer ${JWT_TOKEN}" \
     -H "x-org-id: system" \
     -F "plugin=@{}" \
     -F "accessModifier=public" \
     --insecure;
fi