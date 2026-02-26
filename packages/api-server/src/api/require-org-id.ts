/**
 * @module api/require-org-id
 * @description Middleware that validates the requesting user has an orgId.
 *
 * Must be used after `attachRequestContext`.
 */

import { ErrorCode } from '@mwashburn160/api-core';
import { Request, Response, NextFunction } from 'express';

/**
 * Create middleware that validates the request has an orgId in the identity headers.
 *
 * @returns Express middleware
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 *
 * app.get('/pipelines', authenticateToken, requireOrgId(), handler);
 * ```
 */
export function requireOrgId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.context!;

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
