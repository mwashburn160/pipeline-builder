// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  isSystemAdmin,
  sendSuccess,
  sendError,
  ErrorCode,
  VALID_QUOTA_TYPES,
  getParam,
} from '@pipeline-builder/api-core';
import type { QuotaType } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, RequestHandler } from 'express';
import {
  AUTH_OPTS,
  isValidQuotaType,
} from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { quotaService } from '../services/quota-service';

const router: Router = Router();

// GET /quotas — own org quotas (orgId from JWT / header)

router.get(
  '/',
  requireAuth(AUTH_OPTS) as RequestHandler,
  withRoute(async ({ res, ctx, orgId }) => {
    const quota = await quotaService.findByOrgId(orgId);
    ctx.log('COMPLETED', 'Retrieved own org quotas', { orgId });
    return sendSuccess(res, 200, { quota });
  }),
);

// GET /quotas/all — all organizations with quotas (system admin only)
// NOTE: Must be registered before /:orgId to avoid being caught by that route.

router.get(
  '/all',
  requireAuth(AUTH_OPTS) as RequestHandler,
  withRoute(async ({ req, res, ctx }) => {
    if (!isSystemAdmin(req)) {
      return sendError(
        res, 403,
        'Access denied. Only system administrators can view all organizations.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    const organizations = await quotaService.findAll();
    ctx.log('COMPLETED', 'Listed all organizations', { total: organizations.length });
    return sendSuccess(res, 200, { organizations, total: organizations.length });
  }),
);

// GET /quotas/at-risk — orgs at >=80% on any quota (system admin only).
// Powers the operations dashboard "orgs about to hit limits" panel and
// is suitable for an alerting cron (call this hourly, page if response
// non-empty for tier=Pro/Unlimited).
//
// Query params:
//   - threshold (number, default 80): percent threshold (1-99) above which
//     an org is considered at-risk. Caps at 99 — to find already-exhausted
//     orgs use threshold=100.
//
// Response shape:
//   {
//     atRisk: [
//       { orgId, name, slug, tier, type, used, limit, percent }
//     ],
//     count: number,
//     threshold: number,
//   }

router.get(
  '/at-risk',
  requireAuth(AUTH_OPTS) as RequestHandler,
  withRoute(async ({ req, res, ctx }) => {
    if (!isSystemAdmin(req)) {
      return sendError(
        res, 403,
        'Access denied. Only system administrators can view at-risk orgs.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    const rawThreshold = parseInt(String(req.query.threshold ?? '80'), 10);
    const threshold = Number.isFinite(rawThreshold) ? Math.min(100, Math.max(1, rawThreshold)) : 80;

    const organizations = await quotaService.findAll();
    interface AtRiskEntry {
      orgId: string;
      name: string;
      slug: string;
      tier?: string;
      type: QuotaType;
      used: number;
      limit: number;
      percent: number;
    }
    const atRisk: AtRiskEntry[] = [];
    for (const org of organizations) {
      for (const type of VALID_QUOTA_TYPES) {
        const summary = org.quotas[type];
        if (!summary || summary.unlimited || summary.limit <= 0) continue;
        const percent = Math.min(100, Math.round((summary.used / summary.limit) * 100));
        if (percent >= threshold) {
          atRisk.push({
            orgId: org.orgId,
            name: org.name,
            slug: org.slug,
            tier: org.tier,
            type,
            used: summary.used,
            limit: summary.limit,
            percent,
          });
        }
      }
    }
    atRisk.sort((a, b) => b.percent - a.percent);

    ctx.log('COMPLETED', 'Listed at-risk orgs', { threshold, count: atRisk.length });
    return sendSuccess(res, 200, { atRisk, count: atRisk.length, threshold });
  }),
);

// GET /quotas/:orgId — all quotas for a specific org

router.get(
  '/:orgId',
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  withRoute(async ({ req, res, ctx }) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    const quota = await quotaService.findByOrgId(targetOrgId);
    ctx.log('COMPLETED', 'Retrieved org quotas', { orgId: targetOrgId });
    return sendSuccess(res, 200, { quota });
  }),
);

// GET /quotas/:orgId/:quotaType — single quota type status

router.get(
  '/:orgId/:quotaType',
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  withRoute(async ({ req, res, ctx }) => {
    const targetOrgId = getParam(req.params, 'orgId')!;
    const quotaType = getParam(req.params, 'quotaType');

    if (!quotaType || !isValidQuotaType(quotaType)) return sendError(res, 400, `Invalid quota type. Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`, ErrorCode.VALIDATION_ERROR);

    const status = await quotaService.getQuotaStatus(targetOrgId, quotaType as QuotaType);
    ctx.log('COMPLETED', 'Retrieved quota status', { orgId: targetOrgId, quotaType });
    return sendSuccess(res, 200, { quotaType, status });
  }),
);

/** Read-side quota router (mounted at /quotas). */
export default router;
