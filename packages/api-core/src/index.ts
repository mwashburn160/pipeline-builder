// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/api-core
 *
 * Core API utilities shared across all services.
 *
 * **Middleware**
 * - requireAuth, optionalAuth, requireOrganization, requireAdmin — JWT authentication
 * - isSystemOrg, isSystemAdmin — authorization helpers
 *
 * **Types**
 * - ErrorCode, ErrorCodeStatus — standardized error code enum and status mapping
 * - RequestIdentity — parsed JWT identity
 * - ServiceConfig, RequestOptions, HttpResponse — HTTP client types
 * - QuotaType, QuotaCheckResult — quota service types
 * - PipelineType, ComputeType, AccessModifier — pipeline domain types
 * - FeatureFlags, BillingPlan — feature and billing types
 *
 * **Utilities**
 * - createLogger — Winston-based structured logger factory
 * - sendSuccess, sendError, sendPaginated, sendBadRequest, sendInternalError — HTTP response helpers
 * - getParam, getRequiredParam, getParams, getOrgId, getAuthHeader — request parameter extraction
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
export * from './types';

// Constants
export * from './constants';

// Utils
export * from './utils';

// Helpers
export * from './helpers';

// Services
export * from './services';

// Middleware
export * from './middleware';

// Routes
export * from './routes';

// Errors
export * from './errors';

// Validation
export * from './validation';

// OpenAPI
export * from './openapi';
