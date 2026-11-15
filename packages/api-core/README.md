# @pipeline-builder/api-core

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Core server-side utilities (auth middleware, response helpers, error codes, quota service, HTTP client, logging, AI provider catalog) shared by every [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/) backend service.

> Internal workspace package — consumed by other packages via `workspace:*`. Not published or used standalone.

## Responsibilities

Provides the cross-cutting primitives every backend service depends on: JWT authentication and authorization middleware, inter-service token minting, standardized HTTP response and error helpers, request parameter/identity parsing, Zod validation schemas with an OpenAPI registry, a safe service-to-service HTTP client, quota enforcement types and client, structured Winston logging, an in-memory cache with cross-replica invalidation, domain event pub/sub, and the static AI provider catalog.

## Key exports

### Authentication & authorization (`./middleware`)
| Export | Purpose |
| --- | --- |
| `requireAuth` | JWT authentication middleware (accepts `RequireAuthOptions`, e.g. `allowOrgHeaderOverride` for internal routes) |
| `requirePermission`, `requireAllPermissions`, `requireSystemAdmin`, `requireInternalService` | Authorization gates (any-of / all-of permissions; the `isSuperAdmin` claim; named internal service callers only) |
| `requireFeature` | Feature-flag gate |
| `isSystemOrgId`, `isSystemAdmin`, `isServicePrincipal` | Authorization helpers (`isServicePrincipal` is true when the verified token's `principalType` is `'service'`) |
| `resolveVisibility` | Resolves the sharing rung: `'public'` needs the resource's `:publish` permission (clamped to `'org'` otherwise); an unspecified rung falls back per-entity |
| `signServiceToken`, `getServiceAuthHeader` | Mint short-lived inter-service JWTs (default TTL 5 min) accepted unmodified by `requireAuth` |

### Responses & errors (`./utils`, `./errors`)
| Export | Purpose |
| --- | --- |
| `sendSuccess`, `sendError`, `sendBadRequest`, `sendInternalError`, `sendQuotaExceeded` | Standardized JSON responses |
| `sendPaginatedNested`, `paginationMeta`, `parsePaginationParams` | Paginated response helpers |
| `extractDbError`, `errorMessage` | Safe DB-error and error-to-string extraction |
| `ErrorCode`, `getStatusForErrorCode` | Standard error code enum and HTTP status mapping |
| `AppError`, `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError` | Typed HTTP error classes |

### Request parsing (`./utils`)
| Export | Purpose |
| --- | --- |
| `getParam` | Request parameter extraction |
| `parseQueryInt`, `parseQueryString`, `parseQueryIntClamped` | Query-string coercion |
| `parsePage` | **The** pagination primitive — parses and clamps `?limit=&offset=` against a per-route `{ def, max }` (and an optional `maxOffset`). Use it instead of a hand-rolled `Math.min(Math.max(...))`; route defaults stay per-route but are declared, not re-derived |
| `envInt`, `envBool`, `envStr` | **The** env readers. Strict (a non-integer `envInt` falls back to the default rather than silently truncating), and every variable read through them must appear in `docs/environment-variables.md` — enforced by `test/env-documented.test.ts` |
| `getIdentity`, `normalizeOrgId` | Request identity (`RequestIdentity`, JWT-authoritative) and the canonical org-id spelling |

### HTTP client & services (`./services`)
| Export | Purpose |
| --- | --- |
| `InternalHttpClient`, `createSafeClient` | Service-to-service HTTP client (`ServiceConfig`, `RequestOptions`) |
| `createComplianceClient` / `ComplianceClient` | Typed compliance-service client built on the safe client |
| `QuotaService`, `createQuotaService`, `QuotaType`, `QuotaCheckResult`, `PlanTier`, `PLAN_TIERS`, `getTierLimits` | Quota enforcement client and tier presets |
| `CacheService`, `createCacheService` | In-memory LRU TTL cache with cross-replica invalidation over Redis pub/sub |
| `safeFetch`, `resolveSafeTarget`, `assertSafeUrl`, `isPrivateAddress` | SSRF guards for user/tenant-supplied URLs. **`safeFetch` is the one to use for an outbound request**: it resolves the host, PINS the vetted IP into the socket (no DNS-rebinding window between check and connect), refuses redirects, and caps body size and wall-clock time. `assertSafeUrl` is VALIDATION ONLY — for rejecting a URL at create/update time; never pair it with a `fetch` |
| `createWebhookChannel`, `createEmailChannel`, `createChannelRegistry`, `NotificationChannel`, `NotificationMessage`, `ChannelTarget`, `DeliveryResult` | Shared notification-channel contract plus the webhook (SSRF-safe, HMAC-signing) and email transports. Services supply only their own `in-app` transport |
| `wireServiceSecurity(serviceName, opts?)` | One call for every stateless service's boot security: binds the service identity for `recordAudit`, the `authz.denied` audit sink, the token-revocation reader (overridable), and the access-key-exchange service name |
| `recordAudit(event)` | The ONE emitter for the durable, hash-chained central audit trail (platform `POST /audit/events`), attributed to the service bound by `wireServiceSecurity`. Fire-and-forget; throws "audit not initialised" only if called before binding. Tests bind with `bindTestAuditService` (`/testing`) or pass `apiCoreMock({ recordAudit: spy })` |
| `logAuditEvent(logger, event)` | The short-retention operator sink: an audit event as a structured winston → Loki log line (`eventCategory: 'audit'`) |
| `getRetryDecision`, `getErrorRetryDecision`, `RetryConfig` | The single retry/backoff decision function (Retry-After aware, jittered) and the single `RetryConfig`. pipeline-data's `ConnectionRetryStrategy` is built on it |
| `createOrgIdCaster` | Builds the Mongo org-id cast (24-hex → ObjectId, anything else through) from a supplied `Types.ObjectId`, so platform and quota share one implementation without api-core depending on mongoose |
| `entityEvents` | Process-local domain event pub/sub for entity changes |

### Logging, validation & OpenAPI
| Export | Purpose |
| --- | --- |
| `createLogger`, `logger` | Winston structured logger factory and default instance |
| `AIGenerateBodySchema`, `AIGenerateFromUrlBodySchema`, `PluginCreateSchema`, `PipelineFilterSchema`, `MessageCreateSchema`, plus `BaseFilterSchema`, `UUIDSchema`, `VisibilitySchema` | Zod request-validation schemas and shared building blocks |
| `registry`, `generateOpenApiSpec` | Shared schema registry and OpenAPI spec generation |

### AI provider catalog (`./constants`)
| Export | Purpose |
| --- | --- |
| `AI_PROVIDER_CATALOG` | Static provider/model catalog |
| `AI_PROVIDER_ENV_VARS` | Provider-to-env-var mapping |
| `getAIProviderModels`, `AI_PROVIDER_NAMES` | A provider's models; provider display names |

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
