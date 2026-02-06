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
  sendSuccess,
  sendError,
  sendQuotaExceeded,
  ErrorCode,
  createLogger,
  getParam,
} from '@mwashburn160/api-core';
import type { QuotaType } from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
import { config } from '../config';
import {
  AUTH_OPTS,
  VALID_QUOTA_TYPES,
  validateQuotaValues,
  isValidQuotaType,
  getNextResetDate,
  buildOrgQuotaResponse,
  applyQuotaLimits,
  errorMessage,
  sendOrgNotFound,
  sendInvalidQuotaType,
} from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { Organization } from '../models/organization';

const logger = createLogger('quota-write');
const router: Router = Router();

// ---------------------------------------------------------------------------
// PUT /quotas/:orgId — update org name, slug, and/or quota limits (system admin only)
// ---------------------------------------------------------------------------

interface QuotaUpdateBody {
  name?: string;
  slug?: string;
  quotas?: Partial<Record<QuotaType, number>>;
  // Legacy flat format — quota values at top level
  plugins?: number;
  pipelines?: number;
  apiCalls?: number;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

router.put(
  '/:orgId',
  authenticateToken(AUTH_OPTS) as RequestHandler,
  authorizeOrg({ requireSystemAdmin: true }) as RequestHandler,
  async (req: Request, res: Response) => {
    const targetOrgId = getParam(req.params, 'orgId')!;
    const body = req.body as QuotaUpdateBody;

    // Normalise: support both { quotas: { plugins: 100 } } and flat { plugins: 100 }
    const quotaUpdates: Partial<Record<QuotaType, number>> = { ...body.quotas };
    for (const k of VALID_QUOTA_TYPES) {
      if (body[k] !== undefined && quotaUpdates[k] === undefined) {
        quotaUpdates[k] = body[k];
      }
    }
    const hasQuotas = VALID_QUOTA_TYPES.some((k) => quotaUpdates[k] !== undefined);

    // --- Validation --------------------------------------------------------
    if (body.name === undefined && body.slug === undefined && !hasQuotas) {
      return sendError(
        res, 400,
        'At least one field (name, slug, or a quota value) is required.',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0)) {
      return sendError(res, 400, 'name must be a non-empty string.', ErrorCode.VALIDATION_ERROR);
    }

    if (body.slug !== undefined) {
      if (typeof body.slug !== 'string' || body.slug.trim().length === 0) {
        return sendError(res, 400, 'slug must be a non-empty string.', ErrorCode.VALIDATION_ERROR);
      }
      if (!SLUG_RE.test(body.slug)) {
        return sendError(res, 400, 'slug must be lowercase alphanumeric with hyphens (e.g. "my-org").', ErrorCode.VALIDATION_ERROR);
      }
    }

    if (hasQuotas) {
      const quotaErrors = validateQuotaValues(quotaUpdates);
      if (quotaErrors.length > 0) {
        return sendError(res, 400, quotaErrors.join('; '), ErrorCode.VALIDATION_ERROR);
      }
    }

    // --- Persist -----------------------------------------------------------
    try {
      const org = await Organization.findById(targetOrgId);
      if (!org) return sendOrgNotFound(res);

      if (body.name !== undefined) org.name = body.name.trim();
      if (body.slug !== undefined) org.slug = body.slug.trim();
      if (hasQuotas) applyQuotaLimits(org, quotaUpdates);

      await org.save();

      logger.info('Quota updated', { orgId: targetOrgId });
      return sendSuccess(res, 200, { quota: buildOrgQuotaResponse(org) }, 'Updated successfully');
    } catch (error) {
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
    const { quotaType } = req.body as { quotaType?: string };

    if (quotaType && !isValidQuotaType(quotaType)) return sendInvalidQuotaType(res);

    try {
      const org = await Organization.findById(targetOrgId);
      if (!org) return sendOrgNotFound(res);

      const resetDate = getNextResetDate(config.quota.resetDays);
      const freshUsage = { used: 0, resetAt: resetDate };

      if (quotaType) {
        org.usage[quotaType as QuotaType] = freshUsage;
      } else {
        for (const k of VALID_QUOTA_TYPES) org.usage[k] = { ...freshUsage };
      }

      await org.save();

      logger.info('Quota usage reset', { orgId: targetOrgId, quotaType: quotaType || 'all' });
      return sendSuccess(
        res, 200,
        { quota: buildOrgQuotaResponse(org) },
        quotaType ? `${quotaType} usage reset successfully` : 'All quota usage reset successfully',
      );
    } catch (error) {
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
    const { quotaType, amount = 1 } = req.body as { quotaType?: string; amount?: number };

    if (!quotaType) {
      return sendError(res, 400, 'quotaType is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    }

    if (!isValidQuotaType(quotaType)) return sendInvalidQuotaType(res);

    try {
      const org = await Organization.findById(targetOrgId);
      if (!org) return sendOrgNotFound(res);

      const typedType = quotaType as QuotaType;

      // Auto-reset if period has expired
      if (org.usage[typedType].resetAt <= new Date()) {
        org.usage[typedType] = { used: 0, resetAt: getNextResetDate(config.quota.resetDays) };
      }

      const limit = org.quotas[typedType];
      const currentUsed = org.usage[typedType].used;

      if (limit !== -1 && currentUsed + amount > limit) {
        return sendQuotaExceeded(
          res,
          quotaType,
          {
            type: typedType,
            limit,
            used: currentUsed,
            remaining: Math.max(0, limit - currentUsed),
          },
          org.usage[typedType].resetAt.toISOString(),
        );
      }

      org.usage[typedType].used += amount;
      await org.save();

      return sendSuccess(res, 200, {
        quota: {
          type: quotaType,
          limit,
          used: org.usage[typedType].used,
          remaining: limit === -1 ? -1 : Math.max(0, limit - org.usage[typedType].used),
          resetAt: org.usage[typedType].resetAt,
        },
      }, 'Usage incremented successfully');
    } catch (error) {
      logger.error('Quota increment failed', { error: errorMessage(error), targetOrgId });
      return sendError(res, 500, 'Failed to increment quota usage', ErrorCode.DATABASE_ERROR, errorMessage(error));
    }
  },
);

export default router;
