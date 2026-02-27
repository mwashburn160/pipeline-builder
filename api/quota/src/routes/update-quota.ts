/**
 * @module routes/quota-write
 * @description Write-side quota routes.
 *
 * PUT  /quotas/:orgId            — update org name/slug/quotas (system admin only)
 * POST /quotas/:orgId/reset      — reset usage counters (system admin only)
 * POST /quotas/:orgId/increment  — increment usage (same-org or system admin)
 */

import {
  authenticateToken,
  isSystemOrg,
  sendSuccess,
  sendError,
  sendQuotaExceeded,
  ErrorCode,
  createLogger,
  getParam,
  errorMessage,
} from '@mwashburn160/api-core';
import type { QuotaType } from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
import { ZodError } from 'zod';
import {
  AUTH_OPTS,
  sendOrgNotFound,
} from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { quotaService, OrgNotFoundError } from '../services/quota-service';
import { UpdateQuotaSchema, IncrementQuotaSchema, ResetQuotaSchema } from '../validation/schemas';

const logger = createLogger('quota-write');
const router: Router = Router();

// ---------------------------------------------------------------------------
// PUT /quotas/:orgId — update org name, slug, and/or quota limits (system admin only)
// ---------------------------------------------------------------------------

router.put(
  '/:orgId',
  authenticateToken(AUTH_OPTS) as RequestHandler,
  authorizeOrg({ requireSystemAdmin: true }) as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    let body: ReturnType<typeof UpdateQuotaSchema.parse>;
    try {
      body = UpdateQuotaSchema.parse(req.body);
    } catch (error) {
      const msg = error instanceof ZodError ? error.issues.map(i => i.message).join('; ') : 'Invalid request body';
      return sendError(res, 400, msg, ErrorCode.VALIDATION_ERROR);
    }

    try {
      const result = await quotaService.update(targetOrgId, body);
      return sendSuccess(res, 200, { quota: result }, 'Updated successfully');
    } catch (error) {
      if (error instanceof OrgNotFoundError) return sendOrgNotFound(res);
      logger.error('Quota update failed', { error: errorMessage(error), targetOrgId });
      return sendError(res, 500, 'Failed to update quota', ErrorCode.DATABASE_ERROR, errorMessage(error));
    }
  },
);

// ---------------------------------------------------------------------------
// POST /quotas/:orgId/reset — reset usage counters (system admin only)
// ---------------------------------------------------------------------------

router.post(
  '/:orgId/reset',
  authenticateToken(AUTH_OPTS) as RequestHandler,
  authorizeOrg({ requireSystemAdmin: true }) as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    let body: ReturnType<typeof ResetQuotaSchema.parse>;
    try {
      body = ResetQuotaSchema.parse(req.body);
    } catch (error) {
      const msg = error instanceof ZodError ? error.issues.map(i => i.message).join('; ') : 'Invalid request body';
      return sendError(res, 400, msg, ErrorCode.VALIDATION_ERROR);
    }

    const { quotaType } = body;

    try {
      const result = await quotaService.resetUsage(targetOrgId, quotaType);
      return sendSuccess(
        res, 200,
        { quota: result },
        quotaType ? `${quotaType} usage reset successfully` : 'All quota usage reset successfully',
      );
    } catch (error) {
      if (error instanceof OrgNotFoundError) return sendOrgNotFound(res);
      logger.error('Quota reset failed', { error: errorMessage(error), targetOrgId });
      return sendError(res, 500, 'Failed to reset quota usage', ErrorCode.DATABASE_ERROR, errorMessage(error));
    }
  },
);

// ---------------------------------------------------------------------------
// POST /quotas/:orgId/increment — increment usage (same-org or system admin)
// ---------------------------------------------------------------------------

router.post(
  '/:orgId/increment',
  authenticateToken(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    let body: ReturnType<typeof IncrementQuotaSchema.parse>;
    try {
      body = IncrementQuotaSchema.parse(req.body);
    } catch (error) {
      const msg = error instanceof ZodError ? error.issues.map(i => i.message).join('; ') : 'Invalid request body';
      return sendError(res, 400, msg, ErrorCode.VALIDATION_ERROR);
    }

    const { quotaType, amount } = body;

    try {
      const typedType = quotaType as QuotaType;
      const result = await quotaService.incrementUsage(targetOrgId, typedType, amount, isSystemOrg(req));

      if (result.exceeded) {
        return sendQuotaExceeded(
          res,
          quotaType,
          {
            type: result.quota.type,
            limit: result.quota.limit,
            used: result.quota.used,
            remaining: result.quota.remaining,
          },
          result.quota.resetAt,
        );
      }

      return sendSuccess(res, 200, { quota: result.quota }, 'Usage incremented successfully');
    } catch (error) {
      if (error instanceof OrgNotFoundError) return sendOrgNotFound(res);
      logger.error('Quota increment failed', { error: errorMessage(error), targetOrgId });
      return sendError(res, 500, 'Failed to increment quota usage', ErrorCode.DATABASE_ERROR, errorMessage(error));
    }
  },
);

/** Write-side quota router (mounted at /quotas). */
export default router;
