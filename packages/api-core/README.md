# @pipeline-builder/api-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Core server-side utilities shared by every backend service in [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): JWT authentication middleware, structured logging, response helpers, error codes, quota enforcement, parameter parsing, validation schemas, an internal HTTP client, and the AI provider catalog.

## Key Exports

### Authentication Middleware
- `requireAuth` — JWT authentication middleware (also accepts `RequireAuthOptions` for `allowOrgHeaderOverride` on internal-service routes)
- `requireAdmin`, `requireSystemAdmin` — role gates (admin/owner; system-org admin/owner)
- `requireFeature` — feature-flag gate
- `isSystemOrg`, `isSystemAdmin`, `isServicePrincipal` — authorization checks (last one is true when `req.user.sub` starts with `service:`)
- `resolveAccessModifier(req, requested)` — coerces `requested='public'` to `'private'` unless caller is admin/owner

### Service-to-Service Tokens
- `signServiceToken({ serviceName, orgId?, orgName?, ttlSeconds? })` — mints a short-lived JWT identifying the calling service. Default TTL 5 minutes.
- `getServiceAuthHeader(opts)` — convenience wrapper returning `Bearer <token>` for direct use in fetch/axios headers.

Tokens satisfy the standard `requireAuth` middleware unmodified (sub: `service:<name>`, role: `owner`, type: `access`). Use for inter-service HTTP calls (billing → message renewals, platform → billing on register, etc.).

### Request/Response Utilities
- `sendSuccess`, `sendError`, `sendBadRequest`, `sendInternalError`, `sendQuotaExceeded`, `sendPaginated`, `sendPaginatedNested`
- `extractDbError` — Extract database error details
- `ErrorCode`, `getStatusForErrorCode` — Standard error codes
- `AppError`, `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, `UnauthorizedError` — Typed HTTP error classes

### Parameter Parsing
- `getParam`, `getRequiredParam`, `getParams`, `getOrgId`, `getAuthHeader`
- `parseQueryBoolean`, `parseQueryInt`, `parseQueryString`

### Validation Schemas (Zod)
- `AIGenerateBodySchema` — Validates AI generation requests (prompt, provider, model)
- `AIGenerateFromUrlBodySchema` — Validates Git URL generation requests (gitUrl, provider, model, apiKey?, repoToken?)
- Plugin, pipeline, and message schemas (`PluginCreateSchema`, `PipelineFilterSchema`, `MessageCreateSchema`, etc.) plus shared building blocks (`PaginationSchema`, `UUIDSchema`, `AccessModifierSchema`)

### Internal HTTP Client
- `InternalHttpClient`, `createSafeClient` — Service-to-service HTTP communication
- `ServiceConfig`, `RequestOptions` — Client types
- `createComplianceClient` / `ComplianceClient` — Typed client for the compliance service, built on the safe HTTP client

### AI Provider Constants
- `AI_PROVIDER_CATALOG` — Static provider/model catalog
- `AI_PROVIDER_ENV_VARS` — Provider-to-env-var mapping
- `getAIProviderModels` — Get models for a provider

### Logging
- `createLogger` — Winston logger factory

### Caching & Events
- `CacheService`, `createCacheService` — In-memory TTL cache with an optional Redis backend
- `entityEvents` — Process-local domain event pub/sub for entity changes

### OpenAPI
- `registry`, `generateOpenApiSpec` — Shared schema registry and OpenAPI spec generation, so services expose consistent API documentation

### Quota Service
- `QuotaService` (type), `createQuotaService` — Quota enforcement client
- `QuotaType` — `'plugins' | 'pipelines' | 'apiCalls' | 'aiCalls' | 'storageBytes' | 'dashboards' | 'alertRules' | 'alertDestinations' | 'idpConfigs'`
- `QuotaCheckResult`, `QuotaTier` (`'developer' | 'pro' | 'unlimited'`), `QUOTA_TIERS`, `getTierLimits` — Quota domain types and tier presets

### Health Endpoints
- `createHealthRouter({ serviceName, version?, checkDependencies? })` — registers `GET /health` (liveness; always 200 unless process is dead) and `GET /ready` (readiness; 503 when any dependency is `'disconnected'`). Use as Kubernetes/ECS liveness + readiness probes respectively.

## License

Apache-2.0. See [LICENSE](./LICENSE).