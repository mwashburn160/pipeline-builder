/**
 * @module @mwashburn160/api-core
 * @description Shared utilities for API microservices.
 *
 * This package provides common functionality used across all API microservices:
 * - Authentication middleware (JWT validation)
 * - Standardized error/success responses
 * - Quota service client
 * - Internal HTTP client
 * - Health check endpoints
 * - Logging utilities
 *
 * @example
 * ```typescript
 * import {
 *   authenticateToken,
 *   sendSuccess,
 *   sendError,
 *   createQuotaService,
 *   createLogger,
 *   ErrorCode,
 * } from '@mwashburn160/api-core';
 *
 * const logger = createLogger('my-service');
 * const quotaService = createQuotaService();
 *
 * app.get('/resource/:id', authenticateToken, async (req, res) => {
 *   const id = getParam(req.params, 'id');
 *
 *   // Check quota
 *   const quota = await quotaService.check(req.user.organizationId, 'apiCalls');
 *   if (!quota.allowed) {
 *     return sendQuotaExceeded(res, 'apiCalls', quota);
 *   }
 *
 *   // Process request...
 *   sendSuccess(res, 200, { data: result });
 *
 *   // Increment quota after success
 *   void quotaService.increment(req.user.organizationId, 'apiCalls');
 * });
 * ```
 */

// Types
export * from './types';

// Constants
export * from './constants';

// Utils
export * from './utils';

// Services
export * from './services';

// Middleware
export * from './middleware';

// Routes
export * from './routes';
