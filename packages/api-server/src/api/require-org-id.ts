import { ErrorCode, sendError } from '@mwashburn160/api-core';
import { Request, Response, NextFunction } from 'express';
import { getContext } from './get-context';

/**
 * Create middleware that validates the request has an orgId in the identity headers.
 *
 * @returns Express middleware
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 *
 * app.get('/pipelines', requireAuth, requireOrgId(), handler);
 * ```
 */
export function requireOrgId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = getContext(req);

    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from request headers');
      sendError(res, 400, 'Organization ID is required. Please provide x-org-id header.', ErrorCode.VALIDATION_ERROR);
      return;
    }

    next();
  };
}
