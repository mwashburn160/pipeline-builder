/**
 * @module routes/quota-write
 * @description Write-side quota routes.
 *
 * PUT  /quotas/:orgId            — update org name/slug/quotas (system admin only)
 * POST /quotas/:orgId/reset      — reset usage counters (system admin only)
 * POST /quotas/:orgId/increment  — increment usage (same-org or system admin)
 */

import {
  requireAuth,
  isSystemOrg,
  sendSuccess,
  sendError,
  sendBadRequest,
  sendQuotaExceeded,
  ErrorCode,
  createLogger,
  getParam,
  errorMessage,
  validateBody,
} from '@mwashburn160/api-core';
import type { QuotaType } from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
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
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg({ requireSystemAdmin: true }) as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    const validation = validateBody(req, UpdateQuotaSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const body = validation.value;

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
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg({ requireSystemAdmin: true }) as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    const validation = validateBody(req, ResetQuotaSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const { quotaType } = validation.value;

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
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    const validation = validateBody(req, IncrementQuotaSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const { quotaType, amount } = validation.value;

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
