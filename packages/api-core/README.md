# @pipeline-builder/api-core

Core API utilities shared across all pipeline-builder backend services. Provides error handling, logging, authentication middleware, parameter parsing, request/response utilities, and validation schemas.

## Key Exports

### Authentication Middleware
- `requireAuth` — JWT authentication middleware
- `optionalAuth` — Optional JWT authentication (allows unauthenticated)
- `requireOrganization` — Requires valid orgId in JWT
- `requireAdmin` — Requires admin role
- `isSystemOrg`, `isSystemAdmin` — System-level access checks

### Request/Response Utilities
- `sendSuccess`, `sendError`, `sendBadRequest`, `sendInternalError`, `sendPaginated`
- `extractDbError` — Extract database error details
- `ErrorCode`, `getStatusForErrorCode` — Standard error codes

### Parameter Parsing
- `getParam`, `getRequiredParam`, `getParams`, `getOrgId`, `getAuthHeader`
- `parseQueryBoolean`, `parseQueryInt`, `parseQueryString`

### Validation Schemas (Zod)
- `AIGenerateBodySchema` — Validates AI generation requests (prompt, provider, model)
- `AIGenerateFromUrlBodySchema` — Validates Git URL generation requests (gitUrl, provider, model, apiKey?, repoToken?)

### Internal HTTP Client
- `InternalHttpClient`, `createSafeClient` — Service-to-service HTTP communication
- `ServiceConfig`, `RequestOptions`, `HttpResponse` — Client types

### AI Provider Constants
- `AI_PROVIDER_CATALOG` — Static provider/model catalog
- `AI_PROVIDER_ENV_VARS` — Provider-to-env-var mapping
- `getAIProviderModels` — Get models for a provider

### Logging
- `createLogger` — Winston logger factory

### Quota Service
- `QuotaService` (type), `createQuotaService` — Quota enforcement client
- `QuotaType`, `QuotaCheckResult` — Quota types
