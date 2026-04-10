// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { createRequestContext } from './request-types';
import type { SSEManager } from '../http/sse-connection-manager';

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
 * app.get('/pipelines', requireAuth, async (req, res) => {
 *   const ctx = getContext(req);
 *   ctx.log('INFO', 'Fetching pipelines');
 *
 *   if (!ctx.identity.orgId) {
 *     return sendError(res, 400, 'Organization ID required');
 *   }
 *
 *   // ... rest of handler
 * });
 * ```
 */
export function attachRequestContext(sseManager: SSEManager): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Create and attach context to request
    req.context = createRequestContext(req, sseManager);
    next();
  };
}
