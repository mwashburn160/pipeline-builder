# @pipeline-builder/api-server

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Express server infrastructure for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): the app factory, middleware (CORS, Helmet, rate limiting, idempotency, ETag), request context with structured logging, route wrappers, health-check helpers, and SSE support used by every backend service.

## Key Exports

### App Factory
- `createApp({ checkDependencies?, warmupHooks?, ... })` — Creates a configured Express app with CORS, Helmet, rate limiting, `/health` (liveness), `/ready` (readiness), `/warmup`, `/metrics`, and OpenAPI/Swagger UI. Pass `warmupHooks: [() => mongoose.connection.db?.admin().ping()]` for services that need to pre-warm Mongo/Redis on cold start.
- `runServer`, `startServer` — Server lifecycle with graceful shutdown

### Middleware
- `attachRequestContext` / `createRequestContext` — Identity + logging attached to every request
- `requireOrgId` — Validates `x-org-id` header
- `checkQuota` — Quota enforcement middleware
- `etagMiddleware` — Conditional GET (304 Not Modified) support
- `idempotencyMiddleware` — Idempotency key handling

### Route Helpers
- `withRoute` — Wraps async handlers with context extraction, orgId validation, and error mapping
- `getContext` — Retrieves `RequestContext` from an Express request
- `createProtectedRoute`, `createAuthenticatedWithOrgRoute` — Composable middleware chains

### Health & Quota Helpers
- `postgresHealthCheck` — Returns `{ postgres: 'connected' | 'disconnected' }` (the `'unknown'` fallback was removed — a real probe failure now correctly fails `/ready`)
- `mongoHealthCheck(connection)` — Returns `{ mongodb: 'connected' | 'unknown' | 'disconnected' }` based on mongoose's `readyState` (1 = connected, 2 = connecting/unknown, anything else = disconnected)
- `incrementQuotaFromCtx(service, { req, ctx, orgId }, type)` — Increments a quota counter using values pulled from the route context. `type` is `'plugins' | 'pipelines' | 'apiCalls' | 'aiCalls'`.

### Server-Sent Events
- `SSEManager` — Connection manager for streaming logs to clients

## License

Apache-2.0. See [LICENSE](./LICENSE).