/**
 * @module api/context-middleware
 * @description Middleware that attaches request context to the request object.
 *
 * Automatically creates and attaches a RequestContext to every request,
 * eliminating the need to manually call createRequestContext in route handlers.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { createRequestContext, RequestContext } from './request-types';
import type { SSEManager } from '../http/sse-connection-manager';

/**
 * Augment Express Request type to include context property
 */
declare global {
  namespace Express {
    interface Request {
      /** Request context with identity, logging, and SSE */
      context?: RequestContext;
    }
  }
}

/**
 * Creates middleware that attaches RequestContext to req.context
 *
 * The context includes:
 * - requestId: Unique request identifier
 * - identity: User identity from JWT (orgId, userId, role)
 * - log: Logger function that sends to both Winston and SSE
 *
 * @param sseManager - SSE manager for real-time logging
 * @returns Express middleware that attaches context to req.context
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 *
 * // Apply context middleware globally
 * app.use(attachRequestContext(sseManager));
 *
 * // Use context in route handlers
 * app.get('/pipelines', authenticateToken, async (req, res) => {
 *   req.context!.log('INFO', 'Fetching pipelines');
 *
 *   if (!req.context!.identity.orgId) {
 *     return sendError(res, 400, 'Organization ID required');
 *   }
 *
 *   // ... rest of handler
 * });
 * ```
 */
export function attachRequestContext(sseManager: SSEManager): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Create and attach context to request
    req.context = createRequestContext(req, res, sseManager);
    next();
  };
}

/**
 * Type guard to check if request has context attached
 *
 * @param req - Express request
 * @returns True if request has context property
 *
 * @example
 * ```typescript
 * if (hasContext(req)) {
 *   req.context.log('INFO', 'Request has context');
 * }
 * ```
 */
export function hasContext(req: Request): req is Request & { context: RequestContext } {
  return req.context !== undefined;
}
