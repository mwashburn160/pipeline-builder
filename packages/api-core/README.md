# @pipeline-builder/api-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Core server-side utilities (auth middleware, response helpers, error codes, quota service, HTTP client, logging, AI provider catalog) shared by every [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) backend service.

> Internal workspace package — consumed by other packages via `workspace:*`. Not published or used standalone.

## Responsibilities

Provides the cross-cutting primitives every backend service depends on: JWT authentication and authorization middleware, inter-service token minting, standardized HTTP response and error helpers, request parameter/identity parsing, Zod validation schemas with an OpenAPI registry, a safe service-to-service HTTP client, quota enforcement types and client, structured Winston logging, an in-memory/Redis cache, domain event pub/sub, and the static AI provider catalog.

## Key exports

### Authentication & authorization (`./middleware`)
| Export | Purpose |
| --- | --- |
| `requireAuth` | JWT authentication middleware (accepts `RequireAuthOptions`, e.g. `allowOrgHeaderOverride` for internal routes) |
| `requireAdmin`, `requireSystemAdmin` | Role gates (admin/owner; system-org admin/owner) |
| `requireFeature` | Feature-flag gate |
| `isSystemOrgId`, `isSystemAdmin`, `isServicePrincipal` | Authorization helpers (`isServicePrincipal` is true when `req.user.sub` starts with `service:`) |
| `resolveAccessModifier` | Coerces requested `'public'` to `'private'` unless caller is admin/owner |
| `signServiceToken`, `getServiceAuthHeader` | Mint short-lived inter-service JWTs (default TTL 5 min) accepted unmodified by `requireAuth` |

### Responses & errors (`./utils`, `./errors`)
| Export | Purpose |
| --- | --- |
| `sendSuccess`, `sendError`, `sendBadRequest`, `sendInternalError`, `sendQuotaExceeded` | Standardized JSON responses |
| `sendPaginated`, `sendPaginatedNested`, `parsePaginationParams` | Paginated response helpers |
| `extractDbError`, `errorMessage` | Safe DB-error and error-to-string extraction |
| `ErrorCode`, `getStatusForErrorCode` | Standard error code enum and HTTP status mapping |
| `AppError`, `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, `UnauthorizedError` | Typed HTTP error classes |

### Request parsing (`./utils`)
| Export | Purpose |
| --- | --- |
| `getParam`, `getRequiredParam`, `getParams`, `getOrgId`, `getAuthHeader` | Request parameter/header extraction |
| `parseQueryBoolean`, `parseQueryInt`, `parseQueryString` | Query-string coercion |
| `getIdentity`, `validateIdentity` | Parsed JWT identity (`RequestIdentity`) helpers |

### HTTP client & services (`./services`)
| Export | Purpose |
| --- | --- |
| `InternalHttpClient`, `createSafeClient` | Service-to-service HTTP client (`ServiceConfig`, `RequestOptions`) |
| `createComplianceClient` / `ComplianceClient` | Typed compliance-service client built on the safe client |
| `QuotaService`, `createQuotaService`, `QuotaType`, `QuotaCheckResult`, `QuotaTier`, `QUOTA_TIERS`, `getTierLimits` | Quota enforcement client and tier presets |
| `CacheService`, `createCacheService` | In-memory TTL cache with optional Redis backend |
| `entityEvents` | Process-local domain event pub/sub for entity changes |

### Logging, validation & OpenAPI
| Export | Purpose |
| --- | --- |
| `createLogger`, `logger` | Winston structured logger factory and default instance |
| `AIGenerateBodySchema`, `AIGenerateFromUrlBodySchema`, `PluginCreateSchema`, `PipelineFilterSchema`, `MessageCreateSchema`, plus `PaginationSchema`, `UUIDSchema`, `AccessModifierSchema` | Zod request-validation schemas and shared building blocks |
| `registry`, `generateOpenApiSpec` | Shared schema registry and OpenAPI spec generation |

### AI provider catalog (`./constants`)
| Export | Purpose |
| --- | --- |
| `AI_PROVIDER_CATALOG` | Static provider/model catalog |
| `AI_PROVIDER_ENV_VARS` | Provider-to-env-var mapping |
| `getAIProviderModels`, `getAIProviderName` | Lookup helpers for a provider's models/name |

### Health (`./routes`)
| Export | Purpose |
| --- | --- |
| `createHealthRouter` | Registers `GET /health` (liveness) and `GET /ready` (readiness; 503 when a dependency is `'disconnected'`) |

## Usage

```ts
import {
  requireAuth,
  sendSuccess,
  sendError,
  NotFoundError,
  createLogger,
} from '@pipeline-builder/api-core';

const log = createLogger('plugin-service');

router.get('/plugins/:id', requireAuth(), async (req, res) => {
  const plugin = await plugins.findById(req.params.id);
  if (!plugin) throw new NotFoundError('plugin not found');
  return sendSuccess(res, plugin);
});
```

## Development

```bash
pnpm build   # projen build (compile + lint + test)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
