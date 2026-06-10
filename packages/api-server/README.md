# @pipeline-builder/api-server

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Express server infrastructure for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): app factory, middleware (CORS, Helmet, rate limiting, idempotency, ETag), request context, route wrappers, health-check helpers, and SSE support.

> Internal workspace package — consumed by other packages via `workspace:*`. Not published or used standalone.

## Responsibilities

Assembles the standardized HTTP runtime shared by every backend service: a configured Express app factory, request-context middleware (identity + structured logging), org-scoped rate limiting, idempotency and ETag handling, quota enforcement, async route wrappers with consistent error mapping, health/readiness checks, metrics and OpenTelemetry tracing, and a Server-Sent Events connection manager. Builds on `@pipeline-builder/api-core` for auth, responses, and logging.

## Key exports

### App factory & lifecycle (`./api`)
| Export | Purpose |
| --- | --- |
| `createApp` | Configured Express app: CORS, Helmet (strict CSP), gzip/deflate compression, org-keyed rate limiting (shared Redis store when `redisUrl` is set), `/health`, `/ready`, `/warmup`, `/metrics`, and Swagger UI + OpenAPI at `/docs`. Fails fast if `JWT_SECRET` is unset. |
| `startServer`, `runServer` | Server lifecycle with graceful shutdown |

### Middleware (`./api`)
| Export | Purpose |
| --- | --- |
| `attachRequestContext`, `createRequestContext` | Attach identity + logging (`RequestContext`) to each request |
| `requireOrgId` | Validate the `x-org-id` header is present |
| `checkQuota` | Quota enforcement middleware |
| `etagMiddleware` | Conditional GET (304 Not Modified) support |
| `idempotencyMiddleware`, `createMemoryStore`, `createRedisIdempotencyStore` | Idempotency-key handling with pluggable stores |

### Route helpers (`./api`)
| Export | Purpose |
| --- | --- |
| `withRoute` | Wrap async handlers with context extraction, orgId validation, and error mapping |
| `getContext` | Retrieve `RequestContext` from an Express request |
| `createProtectedRoute`, `createAuthenticatedWithOrgRoute` | Composable auth/org middleware chains |

### Health, quota & observability (`./api`)
| Export | Purpose |
| --- | --- |
| `postgresHealthCheck` | Returns `{ postgres: 'connected' \| 'disconnected' }` |
| `mongoHealthCheck` | Returns `{ mongodb: 'connected' \| 'unknown' \| 'disconnected' }` from mongoose `readyState` |
| `incrementQuotaFromCtx` | Increment a quota counter from the route context |
| `metricsMiddleware`, `metricsHandler`, `incCounter`, `observe`, `setGauge` | Prometheus metrics collection and `/metrics` handler |
| `initTracing`, `currentTraceId` | OpenTelemetry tracing init and current trace ID |

### Server-Sent Events (`./http`)
| Export | Purpose |
| --- | --- |
| `SSEManager` | Connection manager for streaming logs/events to clients |

## Usage

```ts
import { createApp, withRoute, getContext } from '@pipeline-builder/api-server';
import { requireAuth, sendSuccess } from '@pipeline-builder/api-core';

const { app } = createApp({ serviceName: 'plugin-service' });

app.get(
  '/plugins',
  requireAuth(),
  withRoute(async (req, res) => {
    const { orgId, logger } = getContext(req);
    logger.info('listing plugins', { orgId });
    return sendSuccess(res, await plugins.findByOrg(orgId));
  }),
);
```

## Development

```bash
pnpm build   # projen build (compile + lint + test)
pnpm test    # run the Jest test suite
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
