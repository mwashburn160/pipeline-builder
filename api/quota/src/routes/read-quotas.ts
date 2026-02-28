/**
 * @module routes/quota-read
 * @description Read-side quota routes.
 *
 * GET /quotas                    — own org quotas (from JWT)
 * GET /quotas/all                — all organizations with quotas (system admin only)
 * GET /quotas/:orgId             — all quotas for a specific org
 * GET /quotas/:orgId/:quotaType  — single quota type status
 */

import {
  requireAuth,
  isSystemAdmin,
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  getParam,
  errorMessage,
} from '@mwashburn160/api-core';
import type { QuotaType } from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
import {
  AUTH_OPTS,
  isValidQuotaType,
  sendMissingOrgId,
  sendInvalidQuotaType,
} from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { quotaService } from '../services/quota-service';

const logger = createLogger('quota-read');
const router: Router = Router();

// ---------------------------------------------------------------------------
// GET /quotas — own org quotas (orgId from JWT / header)
// ---------------------------------------------------------------------------

router.get(
  '/',
  requireAuth(AUTH_OPTS) as RequestHandler,
  async (req: Request, res: Response) => {
    const orgId = req.user?.organizationId;
    if (!orgId) return sendMissingOrgId(res);

    try {
      const quota = await quotaService.findByOrgId(orgId);
      return sendSuccess(res, 200, { quota });
    } catch (error) {
      logger.error('Quota query failed', { error: errorMessage(error), orgId });
      return sendError(res, 500, errorMessage(error), ErrorCode.INTERNAL_ERROR);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /quotas/all — all organizations with quotas (system admin only)
// NOTE: Must be registered before /:orgId to avoid being caught by that route.
// ---------------------------------------------------------------------------

router.get(
  '/all',
  requireAuth(AUTH_OPTS) as RequestHandler,
  async (req: Request, res: Response) => {
    if (!isSystemAdmin(req)) {
      return sendError(
        res, 403,
        'Access denied. Only system administrators can view all organizations.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    try {
      const organizations = await quotaService.findAll();
      return sendSuccess(res, 200, { organizations, total: organizations.length });
    } catch (error) {
      logger.error('Failed to list all organizations', { error: errorMessage(error) });
      return sendError(res, 500, 'Failed to list organizations', ErrorCode.DATABASE_ERROR, errorMessage(error));
    }
  },
);

// ---------------------------------------------------------------------------
// GET /quotas/:orgId — all quotas for a specific org
// ---------------------------------------------------------------------------

router.get(
  '/:orgId',
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    try {
      const quota = await quotaService.findByOrgId(targetOrgId);
      return sendSuccess(res, 200, { quota });
    } catch (error) {
      logger.error('Quota query failed', { error: errorMessage(error), orgId: targetOrgId });
      return sendError(res, 500, errorMessage(error), ErrorCode.INTERNAL_ERROR);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /quotas/:orgId/:quotaType — single quota type status
// ---------------------------------------------------------------------------

router.get(
  '/:orgId/:quotaType',
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;
    const quotaType = getParam(req.params, 'quotaType');

    if (!quotaType || !isValidQuotaType(quotaType)) return sendInvalidQuotaType(res);

    try {
      const status = await quotaService.getQuotaStatus(targetOrgId, quotaType as QuotaType);
      return sendSuccess(res, 200, { quotaType, status });
    } catch (error) {
      logger.error('Quota status query failed', { error: errorMessage(error), targetOrgId });
      return sendError(res, 500, errorMessage(error), ErrorCode.INTERNAL_ERROR);
    }
  },
);

/** Read-side quota router (mounted at /quotas). */
export default router;
