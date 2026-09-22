// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Middleware
export * from './middleware-factory.js';
export * from './context-middleware.js';
export * from './check-quota.js';
export * from './meter-quota.js';
export * from './rate-limit-by-org.js';
export { createSharedRateLimitStore } from './rate-limit-store.js';
export * from './require-org-id.js';
export * from './tenant-context.js';
export * from './get-context.js';

// App factory
export * from './app-factory.js';

// Health-check helpers
export * from './health-checks.js';

// MongoDB connection helper (dependency-injected mongoose)
export * from './mongo-connect.js';

// Quota helpers
export * from './quota-reservation.js';

// Idempotency — only the store accessor is public; the middleware, the store
// factories and the store setter are wired by `createApp`/`middleware-factory`
// inside this package and have no external caller.
export { getIdempotencyStore, type IdempotencyStore } from './idempotency-middleware.js';

// Observability. `shutdownTracing` is called by this package's own `server.js`
// shutdown path, and the metrics middleware/handler are mounted by `createApp`.
export { withSpan, currentTraceId } from './tracing.js';
export { registerSecretRotationGauge, incCounter, observe, setGauge } from './metrics.js';

// Server utilities
export * from './server.js';

// Readiness state + guard middleware. `DEFAULT_READINESS_BYPASS` is the guard's
// own default — callers pass their own list or take the default implicitly.
export { isReady, setReady, readinessGuard } from './readiness.js';

// Route wrapper
export * from './route-wrapper.js';

// Request/Response types. `createRequestContext` is the factory
// `attachRequestContext` calls; it is not part of the public surface.
export type { RequestLogger, RequestContext } from './request-types.js';
