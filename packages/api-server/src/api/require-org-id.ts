/**
 * @module api/require-org-id
 * @description Middleware that validates the requesting user has an orgId.
 *
 * Must be used after `authenticateToken`.
 */

import { ErrorCode } from '@mwashburn160/api-core';
import { Request, Response, NextFunction } from 'express';
import { createRequestContext } from './request-types';
import type { SSEManager } from '../http/sse-connection-manager';

/**
 * Create middleware that validates the request has an orgId in the identity headers.
 *
 * @param sseManager - SSE manager for request context logging
 * @returns Express middleware
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 * const requireOrg = requireOrgId(sseManager);
 *
 * app.get('/pipelines', authenticateToken, requireOrg, handler);
 * ```
 */
export function requireOrgId(sseManager: SSEManager) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = createRequestContext(req, res, sseManager);

    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from request headers');
      res.status(400).json({
        success: false,
        statusCode: 400,
        message: 'Organization ID is required. Please provide x-org-id header.',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    next();
  };
}
