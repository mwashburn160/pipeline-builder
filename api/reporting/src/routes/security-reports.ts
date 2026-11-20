// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The advanced security reports: vulnerability exposure / time to fix, and the
 * compliance trend.
 *
 * Mounted at `/reports/security` behind `reports:read` (at the mount); each route
 * adds `advanced_reporting`, the same pairing as `/reports/execution/dora`. Both
 * are org-scoped and rollup-aware (`?includeDescendants=true` for `reports:rollup`
 * holders), bounded by the org's event retention, and bucketed by `?interval=`,
 * `?tz=` and `?weekStart=` exactly as the stakeholder sections bucket them. Each
 * calls the SAME pipeline-data function its stakeholder section calls, so the
 * dashboard and the report agree.
 */

import { sendSuccess, sendBadRequest, ErrorCode, parseReportInterval, requireFeature } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { getComplianceTrend, getVulnerabilityExposure, securityBound } from '@pipeline-builder/pipeline-data';
import { Router, type Request, type Response } from 'express';
import { parseReportBucket } from '../helpers/report-helpers.js';
import { resolveReportScope } from '../helpers/report-scope.js';

/** The shared front half: interval, bucketing, range + rollup. Sends the 400 itself. */
async function securityQuery(req: Request, res: Response, orgId: string) {
  const interval = parseReportInterval(req.query);
  if (typeof interval === 'object') { sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR); return undefined; }
  const bucket = parseReportBucket(req.query);
  if ('error' in bucket) { sendBadRequest(res, bucket.error, ErrorCode.VALIDATION_ERROR); return undefined; }
  const scope = await resolveReportScope(req, orgId, 'event');
  if ('error' in scope) { sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR); return undefined; }
  return {
    scope: { orgId, ...(scope.orgIds ? { orgIds: scope.orgIds } : {}), from: securityBound(scope.range.from, bucket.tz), to: securityBound(scope.range.to, bucket.tz) },
    bucket: { interval, tz: bucket.tz, weekStart: bucket.weekStart },
  };
}

export function createSecurityReportRoutes(): Router {
  const router = Router();

  router.get('/vulnerabilities', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const q = await securityQuery(req, res, orgId);
    if (!q) return;
    sendSuccess(res, 200, { vulnerabilities: await getVulnerabilityExposure(q.scope, q.bucket) });
  }));

  router.get('/compliance-trend', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const q = await securityQuery(req, res, orgId);
    if (!q) return;
    sendSuccess(res, 200, { compliance: await getComplianceTrend(q.scope, q.bucket) });
  }));

  return router;
}
