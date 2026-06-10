// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/api-core
 *
 * Core API utilities shared across all services.
 *
 * **Middleware**
 * - requireAuth, requireAdmin, requireSystemAdmin, requireFeature — JWT authentication
 * - isSystemAdmin, isServicePrincipal — authorization helpers (isSystemOrgId remains as a content-owner check, not a privilege gate)
 * - signServiceToken, getServiceAuthHeader — inter-service JWT minting
 *
 * **Types**
 * - ErrorCode, ErrorCodeStatus — standardized error code enum and status mapping
 * - RequestIdentity — parsed JWT identity
 * - ServiceConfig, RequestOptions — HTTP client types
 * - QuotaType, QuotaCheckResult — quota service types
 * - PipelineType, ComputeType, AccessModifier — pipeline domain types
 * - FeatureFlags — feature flag types
 *
 * **Utilities**
 * - createLogger — Winston-based structured logger factory
 * - sendSuccess, sendError, sendPaginated, sendBadRequest, sendInternalError — HTTP response helpers
 * - getParam, getOrgId, getAuthHeader — request parameter extraction
 * - parseQueryBoolean, parseQueryInt, parseQueryString — query string parsing
 * - getIdentity, validateIdentity — identity extraction from requests
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
