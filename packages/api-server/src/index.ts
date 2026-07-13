// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/api-server
 *
 * Express server infrastructure and request lifecycle utilities.
 *
 * **App Factory**
 * - createApp — creates a configured Express app with CORS, Helmet, rate limiting
 * - runServer, startServer — server lifecycle with graceful shutdown
 *
 * **Middleware**
 * - attachRequestContext / createRequestContext — attaches identity + logging to each request
 * - requireOrgId — validates organization ID is present on the request
 * - withTenantContext — opens the RLS tenant scope for the request
 * - checkQuota — quota enforcement middleware
 * - idempotencyMiddleware — idempotent request handling
 * - createProtectedRoute / createAuthenticatedWithOrgRoute — composable middleware chains
 *
 * **Route Helpers**
 * - withRoute — wraps async route handlers with context extraction, orgId validation, and error handling
 * - getContext — retrieves RequestContext from the Express request
 * - RouteContext, RequestContext — route and request context types
 *
 * **SSE**
 * - SSEManager — Server-Sent Events connection manager
 *
 * **Observability**
 * - Tracing and metrics collection utilities
 */

// API Infrastructure
export * from './api/index.js';

// HTTP Utilities
export * from './http/index.js';