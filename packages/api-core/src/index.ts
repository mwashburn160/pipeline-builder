// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/api-core
 *
 * Core API utilities shared across all services.
 *
 * **Middleware**
 * - requireAuth, requireSystemAdmin, requireFeature — JWT authentication
 * - isSystemAdmin, isServicePrincipal — authorization helpers (isSystemOrgId remains as a content-owner check, not a privilege gate)
 * - signServiceToken, getServiceAuthHeader — inter-service JWT minting
 *
 * **Types**
 * - ErrorCode, ErrorCodeStatus — standardized error code enum and status mapping
 * - RequestIdentity — parsed JWT identity
 * - ServiceConfig, RequestOptions — HTTP client types
 * - QuotaType, QuotaCheckResult — quota service types
 * - PipelineType, ComputeType, Visibility — pipeline domain types
 * - FeatureFlags — feature flag types
 *
 * **Utilities**
 * - createLogger — Winston-based structured logger factory
 * - sendSuccess, sendError, sendPaginatedNested, sendBadRequest, sendInternalError — HTTP response helpers
 * - getParam, getOrgId — request parameter extraction
 * - parseQueryInt, parseQueryString — query string parsing
 * - getIdentity — identity extraction from requests
 * - actorId — the audit actor for a route context (one `system` sentinel)
 * - errorMessage — safe error-to-string conversion
 *
 * **Constants**
 * - HTTP status codes, AI provider identifiers, time constants
 *
 * **Services**
 * - InternalHttpClient, createSafeClient — internal service-to-service HTTP client
 * - createQuotaService — quota enforcement client factory
 * - CacheService — in-memory TTL cache
 * - ComplianceClient — compliance service client
 * - EntityEventEmitter — domain event pub/sub
 * - retryForever — capped-backoff wait for a dependency that must come up
 *
 * **Errors**
 * - AppError, NotFoundError, ForbiddenError — typed HTTP error classes
 *
 * **Validation**
 * - Zod-based request validation schemas and middleware
 *
 * **Routes**
 * - Health check route factory
 *
 * **OpenAPI**
 * - Schema registry and spec generation
 */

/**
 * PUBLIC SURFACE POLICY
 *
 * The root re-exports the ten sub-barrels, and each SUB-BARREL is the allow-list
 * for its own area — that is where a module is either `export *`'d or narrowed
 * to the names services may use. Internals are excluded there rather than here,
 * so the exclusion sits next to the code that defines them and cannot be missed
 * by someone adding a module.
 *
 * Currently narrowed (the rest is the intended surface):
 * - `services/retry-strategy` — decision functions only; `parseRetryAfter` and
 *   `addJitter` are backoff internals.
 * - `services/circuit-breaker` — `CircuitOpenError` + `resetCircuitBreakers`;
 *   the `CircuitBreaker` class is wired by the shared HTTP client, not by
 *   services.
 * - `services/service-keys` — verify/inspect only; signing, the key bundle and
 *   `_resetServiceKeysForTests` stay inside.
 * - `utils/jwk` — constants, shapes, decoders and the two signer-facing helpers
 *   platform needs; `jwkThumbprint` / `publicKeyFromJwk` stay inside.
 *
 * api-core's own modules and its `testing/` helpers reach the excluded symbols
 * by DEEP import (`@pipeline-builder/api-core/lib/services/service-keys.js`),
 * which is also how the unit tests reach them.
 */

// Types
export * from './types/index.js';

// Constants
export * from './constants/index.js';

// Utils
export * from './utils/index.js';

// Helpers
export * from './helpers/index.js';

// Services
export * from './services/index.js';

// Middleware
export * from './middleware/index.js';

// Routes
export * from './routes/index.js';

// Errors
export * from './errors/index.js';

// Validation
export * from './validation/index.js';

// OpenAPI
export * from './openapi/index.js';
