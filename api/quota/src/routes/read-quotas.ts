// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  requirePermission,
  requireSystemOrgPermission,
  requirePermissionOrService,
  sendSuccess,
  sendError,
  ErrorCode,
  VALID_QUOTA_TYPES,
  getParam,
  isValidQuotaType,
  parsePage,
  projectUsage,
  requireInternalService,
} from '@pipeline-builder/api-core';
import type { QuotaType } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { authorizeOrg } from '../middleware/authorize-org.js';
import { type AtRiskEntry, type QuotaService, quotaService as defaultQuotaService } from '../services/quota-service.js';

interface AtRiskCacheEntry {
  expires: number;
  entries: AtRiskEntry[];
}

// Page size for the internal full-collection scan in GET /quotas/at-risk. Each
// findAll() page is capped here (and by findAll's own FIND_ALL_MAX_LIMIT) while
// the loop walks the whole org collection to exhaustion.
const ORG_SCAN_PAGE_SIZE = 1000;

export function createReadQuotaRoutes(svc: QuotaService = defaultQuotaService): Router {
  const router: Router = Router();

  // Per-router memo so each test/app gets its own cache. Keyed by `threshold`
  // only: the entry now holds the COMPLETE at-risk set (the whole org
  // collection is scanned), so there is no per-page slice to key on.
  const atRiskCache = new Map<string, AtRiskCacheEntry>();

  // GET /quotas — own org quotas (orgId from JWT / header)

  router.get(
    '/',
    requireAuth as RequestHandler,
    // Purely user-facing (own-org dashboard read) — no service principal hits
    // this root path (S2S callers use /quotas/:orgId). Custom roles that drop
    // `quotas:read` are blocked; built-in Member/Admin bundles include it.
    requirePermission('quotas:read') as RequestHandler,
    withRoute(async ({ res, ctx, orgId }) => {
      const quota = await svc.findByOrgId(orgId);
      ctx.log('COMPLETED', 'Retrieved own org quotas', { orgId });
      return sendSuccess(res, 200, { quota });
    }),
  );

  /**
   * GET /quotas/internal/:orgId/profile — the per-dimension usage picture the
   * expansion-offers profile is built from (docs/plans/sales-agent.md Phase 0).
   *
   * THE QUOTA SERVICE'S FIRST `/internal/*` ROUTE. D13 makes the offers agent
   * purely a CALLER, so every signal it needs has to have a callee that accepts
   * a service principal — and this is the one the whole profile rests on.
   *
   * Reads through `findByOrgId`, which means POOLED: limits pool at the account
   * root, so a team's own counters are not the account's picture. Reading each
   * org's own numbers instead is the bug the at-risk scan already had to fix —
   * a team's limits are `-1`, so it reads as unlimited and never reports, while
   * a root shows only its own usage instead of the subtree's.
   *
   * It adds the PROJECTION to each dimension rather than leaving the caller to
   * compute one: the card, the threshold notice and this share api-core's
   * `projectUsage`, and a trajectory recomputed downstream is how the page and
   * an offer end up disagreeing about the same account.
   *
   * Registered before `/:orgId` so that route does not swallow it.
   */
  router.get(
    '/internal/:orgId/profile',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    // `authorizeOrg()` alone admits any same-org member. An account's whole
    // usage shape is a commercial read, not a member read.
    //
    // Narrowed to BILLING rather than the whole fleet (which is what
    // `requireInternalCaller` admits, because every service meters its own
    // traffic): only the offers scheduler reads this, and it runs in billing
    // until Phase 5 extracts it. Same shape as `/quotas/:orgId/own-usage`.
    requireInternalService({ callers: ['billing'] }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;
      const quota = await svc.findByOrgId(targetOrgId);

      const dimensions: Record<string, {
        used: number; limit: number; ratio: number | null;
        projected: number | null; resetAt: string | null; periodDays: number | null;
      }> = {};
      for (const [type, summary] of Object.entries(quota.quotas)) {
        if (!summary) continue;
        const periodDays = summary.periodDays ?? quota.periodDays;
        const projection = projectUsage({
          used: summary.used,
          limit: summary.limit,
          resetAt: summary.resetAt,
          periodDays: periodDays ?? 0,
        });
        dimensions[type] = {
          used: summary.used,
          limit: summary.limit,
          // Null rather than 0 for an unlimited cap: there is no ratio, and a
          // zero would read as "no pressure" on exactly the dimension that
          // cannot have any.
          ratio: summary.limit > 0 ? summary.used / summary.limit : null,
          projected: projection?.projected ?? null,
          // ISO on the wire: the summary holds a Date, and a JSON round trip
          // would stringify it anyway — doing it here keeps the contract explicit.
          resetAt: summary.resetAt ? new Date(summary.resetAt).toISOString() : null,
          periodDays: periodDays ?? null,
        };
      }

      ctx.log('COMPLETED', 'Served usage profile read', { orgId: targetOrgId });
      return sendSuccess(res, 200, {
        profile: {
          orgId: quota.orgId,
          tier: quota.tier,
          // The ACCOUNT root when the org is pooled: the unit the profile is
          // keyed by, so the caller never has to resolve the hierarchy itself.
          rootOrgId: quota.pool?.rootOrgId ?? quota.orgId,
          dimensions,
        },
      });
    }),
  );

  // GET /quotas/all — every organization's quotas. `orgs:read`, system-org-only
  // (see the gate below) — NOT the superadmin flag, which is what this said while
  // the Roles that carry `orgs:read` could already call it.
  // NOTE: Must be registered before /:orgId to avoid being caught by that route.

  router.get(
    '/all',
    requireAuth as RequestHandler,
    // Cross-tenant operator read: every org's quotas. `orgs:read` — another
    // org's rows are customer data, not this deploy's configuration, which is
    // what `platform:read` means. System-org-only either way, so no tenant Role
    // reaches it, and no `quotas:read` capability grants it: an org's own admin
    // must never see another tenant's numbers.
    ...requireSystemOrgPermission('orgs:read'),
    withRoute(async ({ req, res, ctx }) => {
      // 0-based offset, clamped (MAX_PAGE_OFFSET) so a huge `?offset=` can't make
      // Mongo walk and discard the whole collection.
      const { limit, offset } = parsePage(req.query as Record<string, unknown>, { def: 100, max: 1000 });

      const { organizations, total } = await svc.findAll({ limit, offset });
      ctx.log('COMPLETED', 'Listed all organizations', { total, limit, offset });
      return sendSuccess(res, 200, { organizations, total, limit, offset });
    }),
  );

  // GET /quotas/at-risk — orgs at >=80% on any quota. `orgs:read`, as /all is.
  // Powers the operations dashboard "orgs about to hit limits" panel and
  // is suitable for an alerting cron (call this hourly, page if response
  // non-empty for tier=Pro/Team/Enterprise).
  //
  // The scan walks the ENTIRE org collection to exhaustion (loop-paginated in
  // ORG_SCAN_PAGE_SIZE chunks) so the returned at-risk set is COMPLETE — an
  // at-risk org past the first page must never be invisible to the alerting
  // cron. The complete set is memoized for 60s per threshold so the cron and
  // the dashboard can hammer it without re-scanning every call.
  //
  // Query params:
  //   - threshold (number, default 80): percent threshold (1-100) above which
  //     an org is considered at-risk. Use threshold=100 to find already-
  //     exhausted orgs.

  router.get(
    '/at-risk',
    requireAuth as RequestHandler,
    // Cross-tenant operator read (scans every org), same reasoning and the same
    // `orgs:read` gate as /quotas/all. The per-org variant below is the
    // tenant-facing one and gates on `quotas:read` instead.
    ...requireSystemOrgPermission('orgs:read'),
    withRoute(async ({ req, res, ctx }) => {
      const rawThreshold = parseInt(String(req.query.threshold ?? '80'), 10);
      const threshold = Number.isFinite(rawThreshold) ? Math.min(100, Math.max(1, rawThreshold)) : 80;

      const now = Date.now();
      const cacheKey = `${threshold}`;
      let cached = atRiskCache.get(cacheKey);
      if (!cached || cached.expires <= now) {
        // Evaluated BY POOL in the service, through the same
        // `pooledStatusFromRows` enforcement uses. Reading each org's OWN
        // summarized numbers (the old behaviour) was wrong twice over for a
        // pooled account: a team's own limits are -1, so it read as "unlimited"
        // and was never reported, and a root showed only its own usage instead
        // of the subtree's — an account at 95% of its pooled cap looked idle and
        // alerting never fired. The per-org `/quotas/:orgId/at-risk` route
        // already pooled; this is the cross-org scan catching up.
        const computed = await svc.findAtRisk(threshold, ORG_SCAN_PAGE_SIZE);
        cached = { expires: now + config.quota.atRiskCacheTtlMs, entries: computed };
        atRiskCache.set(cacheKey, cached);
      }

      // `entries` is the COMPLETE at-risk set across all orgs, sorted by percent
      // desc. `complete: true` documents to the caller that no pagination cursor
      // needs to be followed — the whole set is present.
      const entries = cached.entries;
      ctx.log('COMPLETED', 'Listed at-risk orgs', {
        threshold, count: entries.length, total: entries.length,
      });
      return sendSuccess(res, 200, {
        atRisk: entries,
        count: entries.length,
        total: entries.length,
        threshold,
        complete: true,
      });
    }),
  );

  // GET /quotas/:orgId/at-risk — ACCOUNT-SCOPED at-risk dims for a SINGLE org.
  //
  // Lets an org owner/admin see THEIR OWN org's at-risk quota dimensions
  // without system-admin. `authorizeOrg()` enforces tenancy: a non-sysadmin
  // can only ever read their own org — passing another org's id is rejected
  // (403) by the same middleware the other per-org reads use, so a caller can
  // never scope this at another tenant. For pooled/hierarchy orgs the numbers
  // are the ROOT's pooled cap + subtree usage (via the single `findByOrgId`
  // read, which resolves the pool ONCE for every dimension), matching
  // enforcement; flat orgs report their own. The cross-org GET /quotas/at-risk
  // (`orgs:read`) above is unchanged.
  //
  // MUST be registered before `/:orgId/:quotaType` so `at-risk` is not parsed
  // as a quota type.
  //
  // Query params:
  //   - threshold (number, default 80): percent threshold (1-100) at/above
  //     which a dimension is considered at-risk (100 finds exhausted dims).

  router.get(
    '/:orgId/at-risk',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    // User-facing (org owner/admin dashboard) — no internal service calls the
    // per-org at-risk endpoint, so a plain read gate is correct here.
    requirePermission('quotas:read') as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const rawThreshold = parseInt(String(req.query.threshold ?? '80'), 10);
      const threshold = Number.isFinite(rawThreshold) ? Math.min(100, Math.max(1, rawThreshold)) : 80;

      // ONE read for everything. `findByOrgId` already resolves the pool once
      // and overlays the ROOT's shared cap + subtree usage onto every pooled
      // dimension, so its `quotas` map is exactly what `getQuotaStatus` would
      // return per type — but without re-walking the hierarchy (a root
      // resolution + a subtree query) once per dimension, which this
      // dashboard-polled route did N times per call.
      const summary = await svc.findByOrgId(targetOrgId);

      const entries: AtRiskEntry[] = [];
      for (const type of VALID_QUOTA_TYPES) {
        const status = summary.quotas[type];
        if (!status || status.unlimited) continue;
        // limit === 0 ⇒ permanently at-risk (any use is 100%+); report as 100%.
        const percent = status.limit === 0
          ? 100
          : Math.min(100, Math.round((status.used / status.limit) * 100));
        if (percent >= threshold) {
          entries.push({
            orgId: summary.orgId,
            name: summary.name,
            slug: summary.slug,
            tier: summary.tier,
            type,
            used: status.used,
            limit: status.limit,
            percent,
          });
        }
      }
      entries.sort((a, b) => b.percent - a.percent);

      ctx.log('COMPLETED', 'Listed own-org at-risk dims', {
        orgId: targetOrgId, threshold, count: entries.length,
      });
      return sendSuccess(res, 200, {
        atRisk: entries,
        count: entries.length,
        total: entries.length,
        threshold,
        orgId: summary.orgId,
      });
    }),
  );

  // GET /quotas/:orgId — all quotas for a specific org

  router.get(
    '/:orgId',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    // Internal services hit this: the quota client's `getTier()` reads
    // GET /quotas/:orgId (plugin build-queue partitioning via a `service:*`
    // token, and platform's tier lookups). Service principals carry no
    // permission claims, so admit them alongside users holding `quotas:read`.
    requirePermissionOrService('quotas:read') as RequestHandler,
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
    // Internal services hit this: the quota client's `check()` reads
    // GET /quotas/:orgId/:quotaType (the `checkQuota` middleware in every
    // service, and platform's `getOrganizationQuotaStatus` reconciler with a
    // `service:*` token). Admit service principals alongside `quotas:read`.
    requirePermissionOrService('quotas:read') as RequestHandler,
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
