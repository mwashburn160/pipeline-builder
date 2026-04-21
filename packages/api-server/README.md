# @pipeline-builder/api-server

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

Express server infrastructure for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): the app factory, middleware (CORS, Helmet, rate limiting, idempotency, ETag), request context with structured logging, route wrappers, health-check helpers, and SSE support used by every backend service.

## Key Exports

### App Factory
- `createApp` — Creates a configured Express app with CORS, Helmet, rate limiting, health checks, metrics, and OpenAPI/Swagger UI
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
- `postgresHealthCheck` — `checkDependencies` callback for Postgres-backed services
- `mongoHealthCheck(connection)` — `checkDependencies` factory for MongoDB services
- `incrementQuotaFromCtx(service, { req, ctx, orgId }, type)` — Increments a quota counter using values pulled from the route context

### Server-Sent Events
- `SSEManager` — Connection manager for streaming logs to clients

## License

Apache-2.0. See [LICENSE](./LICENSE).

---

**Keywords:** aws, codepipeline, codebuild, cicd, ci-cd, devops, cdk, aws-cdk, cloudformation, pipeline, pipeline-as-code, containerized, docker, kubernetes, plugins, typescript, self-service, multi-tenant, compliance, automation, infrastructure-as-code, iac, cli
