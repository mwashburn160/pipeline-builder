// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Delivery reports: run latency and runner reliability, and the deployment
 * calendar and change volume.
 *
 * Mounted at `/reports/delivery` behind `reports:read` (at the mount).
 *  - `GET /runners` is FREE: run requests by outcome, time to acceptance, top
 *    failure codes and per-runner reliability. Bounded by EVENT retention.
 *    Lists the org's ancestors' runners shared with teams even when idle (the
 *    chain comes from platform's `/organization/:id/parent`; a failed lookup
 *    omits them, never fails the read).
 *  - `GET /calendar` adds `advanced_reporting` (the DORA entitlement, tagged on
 *    the route like `/reports/execution/dora`): deployments per local day per
 *    environment, commits per deploy, production deploys. Bounded by DORA
 *    retention (it reads `dora_deployments`, which outlives raw events).
 *
 * Both are org-scoped and rollup-aware (`?includeDescendants=true` for
 * `reports:rollup` holders) and bucket/count days in `?tz=` (and `?weekStart=`
 * for the runner series). Neither returns a runner's function URL, key material
 * or any per-person field.
 */

import { sendSuccess, sendBadRequest, ErrorCode, parseReportInterval, requireFeature } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { getDeploymentCalendar, getRunnerReliability, securityBound } from '@pipeline-builder/pipeline-data';
import { Router, type Request, type Response } from 'express';
import { parseReportBucket, resolveOrgAncestors } from '../helpers/report-helpers.js';
import { resolveReportScope } from '../helpers/report-scope.js';
import type { RetentionKind } from '../helpers/retention-cap.js';

/** Bucketing, range + rollup for one Delivery read. Sends the 400 itself. */
async function deliveryQuery(req: Request, res: Response, orgId: string, kind: RetentionKind) {
  const interval = parseReportInterval(req.query);
  if (typeof interval === 'object') { sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR); return undefined; }
  const bucket = parseReportBucket(req.query);
  if ('error' in bucket) { sendBadRequest(res, bucket.error, ErrorCode.VALIDATION_ERROR); return undefined; }
  const scope = await resolveReportScope(req, orgId, kind);
  if ('error' in scope) { sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR); return undefined; }
  return {
    scope: { orgId, ...(scope.orgIds ? { orgIds: scope.orgIds } : {}), from: securityBound(scope.range.from, bucket.tz), to: securityBound(scope.range.to, bucket.tz) },
    bucket: { interval, tz: bucket.tz, weekStart: bucket.weekStart },
  };
}

export function createDeliveryReportRoutes(): Router {
  const router = Router();

  router.get('/runners', withRoute(async ({ req, res, orgId }) => {
    const q = await deliveryQuery(req, res, orgId, 'event');
    if (!q) return;
    // Runners a parent shares with teams are listed even when idle. The JWT's
    // parent claim is the ACTIVE org's, so it is only a shortcut when that org
    // is the one being reported on. Fail-soft: no chain → no idle shared rows.
    const knownParent = req.user?.organizationId === orgId ? req.user?.parentOrganizationId : undefined;
    const sharedByOrgIds = await resolveOrgAncestors(orgId, knownParent);
    sendSuccess(res, 200, { runners: await getRunnerReliability(q.scope, q.bucket, { sharedByOrgIds }) });
  }));

  router.get('/calendar', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const q = await deliveryQuery(req, res, orgId, 'dora');
    if (!q) return;
    sendSuccess(res, 200, { calendar: await getDeploymentCalendar(q.scope, { tz: q.bucket.tz }) });
  }));

  return router;
}
