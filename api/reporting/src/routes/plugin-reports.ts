// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  ErrorCode,
  parseReportInterval,
  parseDateRange,
  parseQueryIntClamped,
  isSystemAdmin,
  userHasPermission,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import type { Request } from 'express';
import { MAX_REPORT_LIMIT, MAX_REPORT_RANGE_MS, scrubErrorMessage, resolveOrgRollup } from '../helpers.js';

export function createPluginReportRoutes(): Router {
  const router = Router();

  // Org→team rollup for the BUILD reports (build-success-rate/duration/failures
  // are build-activity reports a rollup admin expects to aggregate). Identical
  // gate to the execution reports: `?includeDescendants=true` is honored only
  // for callers holding `reports:rollup` (built-in Admin/Owner + superadmin;
  // grantable to a custom Role); everyone else silently gets their own-org
  // report. The plugin INVENTORY reports (summary/distribution/versions) stay
  // single-org by design (see ReportingService.getPluginSummary), so they don't
  // resolve a rollup. Resolving to the caller's subtree means this is never a
  // cross-tenant leak (an under-report fix only).
  const rollupIds = (req: Request, orgId: string): Promise<string[] | undefined> => {
    const canRollup = userHasPermission(req, 'reports:rollup');
    return req.query.includeDescendants === 'true' && canRollup
      ? resolveOrgRollup(orgId)
      : Promise.resolve(undefined);
  };

  router.get('/summary', withRoute(async ({ res, orgId }) => {
    sendSuccess(res, 200, { summary: await reportingService.getPluginSummary(orgId) });
  }));

  router.get('/distribution', withRoute(async ({ res, orgId }) => {
    sendSuccess(res, 200, { distribution: await reportingService.getPluginDistribution(orgId) });
  }));

  router.get('/versions', withRoute(async ({ res, orgId }) => {
    sendSuccess(res, 200, { plugins: await reportingService.getPluginVersions(orgId) });
  }));

  router.get('/build-success-rate', withRoute(async ({ req, res, orgId }) => {
    const interval = parseReportInterval(req.query);
    if (typeof interval === 'object') return sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR);
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, { timeline: await reportingService.getBuildSuccessRate(orgId, interval, range.from, range.to, orgIds) });
  }));

  router.get('/build-duration', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, { plugins: await reportingService.getBuildDuration(orgId, range.from, range.to, orgIds) });
  }));

  router.get('/build-failures', withRoute(async ({ req, res, orgId }) => {
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 20, MAX_REPORT_LIMIT);
    const orgIds = await rollupIds(req, orgId);
    const failures = await reportingService.getBuildFailures(orgId, range.from, range.to, limit, orgIds);
    const scrubbed = (failures as unknown as Array<Record<string, unknown>>).map((f) => ({
      ...f,
      error_message: scrubErrorMessage(f.error_message as string | null | undefined),
    }));
    sendSuccess(res, 200, { failures: scrubbed });
  }));

  return router;
}
