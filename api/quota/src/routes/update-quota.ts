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
  errorMessage,
} from '@mwashburn160/api-core';
import type { QuotaType } from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { config } from '../config';
import {
  AUTH_OPTS,
  VALID_QUOTA_TYPES,
  QUOTA_TIERS,
  getNextResetDate,
  buildOrgQuotaResponse,
  applyQuotaLimits,
  sendOrgNotFound,
} from '../helpers/quota-helpers';
import type { QuotaTier } from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { Organization } from '../models/organization';
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
      const org = await Organization.findById(targetOrgId);
      if (!org) return sendOrgNotFound(res);

      if (body.name !== undefined) org.name = body.name;
      if (body.slug !== undefined) org.slug = body.slug;

      if (body.tier !== undefined) {
        const tier = body.tier as QuotaTier;
        org.tier = tier;
        applyQuotaLimits(org, QUOTA_TIERS[tier].limits);
      }
      if (body.quotas) applyQuotaLimits(org, body.quotas);

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

    let body: ReturnType<typeof ResetQuotaSchema.parse>;
    try {
      body = ResetQuotaSchema.parse(req.body);
    } catch (error) {
      const msg = error instanceof ZodError ? error.issues.map(i => i.message).join('; ') : 'Invalid request body';
      return sendError(res, 400, msg, ErrorCode.VALIDATION_ERROR);
    }

    const { quotaType } = body;

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
      const usagePath = `usage.${typedType}`;

      // Auto-reset expired periods atomically before incrementing
      await Organization.updateOne(
        { _id: targetOrgId, [`${usagePath}.resetAt`]: { $lte: new Date() } },
        { $set: { [`${usagePath}.used`]: 0, [`${usagePath}.resetAt`]: getNextResetDate(config.quota.resetDays) } },
      );

      // Atomic increment with limit check in a single query.
      // The filter ensures we only increment when quota is unlimited (-1) or has remaining capacity.
      const org = await Organization.findOneAndUpdate(
        {
          _id: targetOrgId,
          $or: [
            { [`quotas.${typedType}`]: -1 },
            { $expr: { $lte: [{ $add: [`$${usagePath}.used`, amount] }, `$quotas.${typedType}`] } },
          ],
        },
        { $inc: { [`${usagePath}.used`]: amount } },
        { new: true },
      );

      if (!org) {
        // Either org doesn't exist or quota would be exceeded — distinguish the two
        const existingOrg = await Organization.findById(targetOrgId);
        if (!existingOrg) return sendOrgNotFound(res);

        const limit = existingOrg.quotas[typedType];
        const currentUsed = existingOrg.usage[typedType].used;
        return sendQuotaExceeded(
          res,
          quotaType,
          {
            type: typedType,
            limit,
            used: currentUsed,
            remaining: Math.max(0, limit - currentUsed),
          },
          existingOrg.usage[typedType].resetAt.toISOString(),
        );
      }

      const limit = org.quotas[typedType];
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
