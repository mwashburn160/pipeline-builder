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
  parseQueryIntClamped,
} from '@pipeline-builder/api-core';
import type { QuotaType } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { config } from '../config';
import {
  isValidQuotaType,
} from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { QuotaService, quotaService as defaultQuotaService } from '../services/quota-service';

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

interface AtRiskCacheEntry {
  expires: number;
  entries: AtRiskEntry[];
}

export function createReadQuotaRoutes(svc: QuotaService = defaultQuotaService): Router {
  const router: Router = Router();

  // Per-router memo so each test/app gets its own cache.
  const atRiskCache = new Map<number, AtRiskCacheEntry>();

  // GET /quotas — own org quotas (orgId from JWT / header)

  router.get(
    '/',
    requireAuth as RequestHandler,
    withRoute(async ({ res, ctx, orgId }) => {
      const quota = await svc.findByOrgId(orgId);
      ctx.log('COMPLETED', 'Retrieved own org quotas', { orgId });
      return sendSuccess(res, 200, { quota });
    }),
  );

  // GET /quotas/all — all organizations with quotas (system admin only)
  // NOTE: Must be registered before /:orgId to avoid being caught by that route.

  router.get(
    '/all',
    requireAuth as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      if (!isSystemAdmin(req)) {
        return sendError(
          res, 403,
          'Access denied. Only system administrators can view all organizations.',
          ErrorCode.INSUFFICIENT_PERMISSIONS,
        );
      }

      const limit = parseQueryIntClamped(req.query.limit, 100, 1000);
      const offset = parseQueryIntClamped(req.query.offset, 1, Number.MAX_SAFE_INTEGER) - 1;

      const organizations = await svc.findAll({ limit, offset });
      ctx.log('COMPLETED', 'Listed all organizations', { total: organizations.length, limit, offset });
      return sendSuccess(res, 200, { organizations, total: organizations.length, limit, offset });
    }),
  );

  // GET /quotas/at-risk — orgs at >=80% on any quota (system admin only).
  // Powers the operations dashboard "orgs about to hit limits" panel and
  // is suitable for an alerting cron (call this hourly, page if response
  // non-empty for tier=Pro/Unlimited).
  //
  // The full at-risk scan is memoized for 60s per threshold so the alerting
  // cron and the dashboard can hammer this without re-scanning the org
  // collection every call. Pagination is applied to the cached result.
  //
  // Query params:
  //   - threshold (number, default 80): percent threshold (1-99) above which
  //     an org is considered at-risk. Caps at 99 — to find already-exhausted
  //     orgs use threshold=100.
  //   - limit, offset: pagination over the sorted at-risk list.

  router.get(
    '/at-risk',
    requireAuth as RequestHandler,
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

      const limit = parseQueryIntClamped(req.query.limit, 100, 1000);
      const offset = parseQueryIntClamped(req.query.offset, 1, Number.MAX_SAFE_INTEGER) - 1;

      const now = Date.now();
      let cached = atRiskCache.get(threshold);
      if (!cached || cached.expires <= now) {
        const organizations = await svc.findAll();
        const computed: AtRiskEntry[] = [];
        for (const org of organizations) {
          for (const type of VALID_QUOTA_TYPES) {
            const summary = org.quotas[type];
            if (!summary || summary.unlimited) continue;
            // limit === 0 means the org is permanently at risk (any use
            // pushes 100%+); report as 100%.
            const percent = summary.limit === 0
              ? 100
              : Math.min(100, Math.round((summary.used / summary.limit) * 100));
            if (percent >= threshold) {
              computed.push({
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
        computed.sort((a, b) => b.percent - a.percent);
        cached = { expires: now + config.quota.atRiskCacheTtlMs, entries: computed };
        atRiskCache.set(threshold, cached);
      }

      const page = cached.entries.slice(offset, offset + limit);
      ctx.log('COMPLETED', 'Listed at-risk orgs', {
        threshold, count: page.length, total: cached.entries.length,
      });
      return sendSuccess(res, 200, {
        atRisk: page,
        count: page.length,
        total: cached.entries.length,
        threshold,
        limit,
        offset,
      });
    }),
  );

  // GET /quotas/:orgId — all quotas for a specific org

  router.get(
    '/:orgId',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const quota = await svc.findByOrgId(targetOrgId);
      ctx.log('COMPLETED', 'Retrieved org quotas', { orgId: targetOrgId });
      return sendSuccess(res, 200, { quota });
    }),
  );

  // GET /quotas/:orgId/:quotaType — single quota type status

  router.get(
    '/:orgId/:quotaType',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;
      const quotaType = getParam(req.params, 'quotaType');

      if (!quotaType || !isValidQuotaType(quotaType)) return sendError(res, 400, `Invalid quota type. Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`, ErrorCode.VALIDATION_ERROR);

      const status = await svc.getQuotaStatus(targetOrgId, quotaType as QuotaType);
      ctx.log('COMPLETED', 'Retrieved quota status', { orgId: targetOrgId, quotaType });
      return sendSuccess(res, 200, { quotaType, status });
    }),
  );

  return router;
}
