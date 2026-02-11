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