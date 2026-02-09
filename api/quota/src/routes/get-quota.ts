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
  authenticateToken,
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
import { config } from '../config';
import {
  AUTH_OPTS,
  buildDefaultOrgQuotaResponse,
  buildOrgQuotaResponse,
  computeQuotaStatus,
  isValidQuotaType,
  sendMissingOrgId,
  sendInvalidQuotaType,
} from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { Organization, IOrganization } from '../models/organization';

const logger = createLogger('quota-read');
const router: Router = Router();

// ---------------------------------------------------------------------------
// GET /quotas — own org quotas (orgId from JWT / header)
// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticateToken(AUTH_OPTS) as RequestHandler,
  async (req: Request, res: Response) => {
    const orgId = req.user?.organizationId;
    if (!orgId) return sendMissingOrgId(res);

    return fetchOrgQuotas(res, orgId);
  },
);

// ---------------------------------------------------------------------------
// GET /quotas/all — all organizations with quotas (system admin only)
// NOTE: Must be registered before /:orgId to avoid being caught by that route.
// ---------------------------------------------------------------------------

router.get(
  '/all',
  authenticateToken(AUTH_OPTS) as RequestHandler,
  async (req: Request, res: Response) => {
    if (!isSystemAdmin(req)) {
      return sendError(
        res, 403,
        'Access denied. Only system administrators can view all organizations.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    try {
      const orgs = await Organization.find()
        .select('name slug quotas usage')
        .sort({ name: 1 })
        .lean();

      const organizations = orgs.map((org) => buildOrgQuotaResponse(org as IOrganization));

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
  authenticateToken(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  async (req: Request, res: Response) => {
    return fetchOrgQuotas(res, getParam(req.params, 'orgId')!);
  },
);

// ---------------------------------------------------------------------------
// GET /quotas/:orgId/:quotaType — single quota type status
// ---------------------------------------------------------------------------

router.get(
  '/:orgId/:quotaType',
  authenticateToken(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;
    const quotaType = getParam(req.params, 'quotaType');

    if (!quotaType || !isValidQuotaType(quotaType)) return sendInvalidQuotaType(res);

    try {
      const org = await Organization.findById(targetOrgId).select('quotas usage').lean();

      const typedType = quotaType as QuotaType;
      const limit = org?.quotas?.[typedType] ?? config.quota.defaults[typedType];
      const usage = org?.usage?.[typedType] ?? { used: 0, resetAt: new Date() };

      return sendSuccess(res, 200, { quotaType, status: computeQuotaStatus(limit, usage) });
    } catch (error) {
      logger.error('Quota status query failed', { error: errorMessage(error), targetOrgId });
      return sendError(res, 500, errorMessage(error), ErrorCode.INTERNAL_ERROR);
    }
  },
);

// ---------------------------------------------------------------------------
// Shared handler
// ---------------------------------------------------------------------------

async function fetchOrgQuotas(res: Response, orgId: string): Promise<void> {
  try {
    const org = await Organization.findById(orgId).select('quotas usage name slug').lean();

    if (!org) {
      sendSuccess(res, 200, { quota: buildDefaultOrgQuotaResponse(orgId) });
      return;
    }

    sendSuccess(res, 200, { quota: buildOrgQuotaResponse(org as IOrganization) });
  } catch (error) {
    logger.error('Quota query failed', { error: errorMessage(error), orgId });
    sendError(res, 500, errorMessage(error), ErrorCode.INTERNAL_ERROR);
  }
}

export default router;
