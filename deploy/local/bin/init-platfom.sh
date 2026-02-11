#!/bin/sh

PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}

curl -X POST ${PLATFORM_BASE_URL}/api/auth/register \
     -k \
     -H "Content-Type: application/json" \
     -d '{
           "username": "admin",
           "email": "admin@internal",
           "password": "SecurePassword123!",
           "organizationName": "system"
         }'

if [ $? -ne 0 ]; then
    JWT_TOKEN=$(curl -X POST ${PLATFORM_BASE_URL}/api/auth/login \
    -k \
    -H "Content-Type: application/json" \
    -d '{
            "identifier": "admin@internal   ",
            "password": "SecurePassword123!"
        }' | jq -r '.data.accessToken')
fi