// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Flow reports: where pipeline time goes waiting.
 *
 * Mounted at `/reports/flow` behind `reports:read` (at the mount).
 *  - `GET /approvals`   manual approval waits — adds `advanced_reporting`.
 *  - `GET /queue`       queue / provisioning time and pipeline start → first
 *                       stage, the current figures — FREE (`reports:read` only).
 *  - `GET /queue/trend` the same per bucket — adds `advanced_reporting`.
 *
 * Same front half as `/reports/security`: org-scoped, rollup-aware
 * (`?includeDescendants=true` for `reports:rollup` holders), bounded by the org's
 * event retention, date-only bounds read as local midnights in `?tz=`, bucketed
 * by `?interval=` / `?tz=` / `?weekStart=`. Team-level only.
 */

import { sendSuccess, sendBadRequest, ErrorCode, parseReportInterval, requireFeature } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { getApprovalWaits, getQueueWaits, getQueueWaitTrend, securityBound } from '@pipeline-builder/pipeline-data';
import { Router, type Request, type Response } from 'express';
import { parseReportBucket } from '../helpers/report-helpers.js';
import { resolveReportScope } from '../helpers/report-scope.js';

/** Interval, bucketing, range + rollup. Sends the 400 itself. */
async function flowQuery(req: Request, res: Response, orgId: string) {
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

export function createFlowReportRoutes(): Router {
  const router = Router();

  router.get('/approvals', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const q = await flowQuery(req, res, orgId);
    if (!q) return;
    sendSuccess(res, 200, { approvals: await getApprovalWaits(q.scope, q.bucket) });
  }));

  router.get('/queue', withRoute(async ({ req, res, orgId }) => {
    const q = await flowQuery(req, res, orgId);
    if (!q) return;
    sendSuccess(res, 200, { queue: await getQueueWaits(q.scope) });
  }));

  router.get('/queue/trend', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const q = await flowQuery(req, res, orgId);
    if (!q) return;
    sendSuccess(res, 200, { trend: await getQueueWaitTrend(q.scope, q.bucket) });
  }));

  return router;
}
