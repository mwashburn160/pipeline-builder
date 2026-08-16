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
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { MAX_REPORT_LIMIT, MAX_REPORT_RANGE_MS, scrubField, rollupIds } from '../helpers.js';

export function createPluginReportRoutes(): Router {
  const router = Router();

  // The BUILD reports (build-success-rate/duration/failures) are rollup-aware
  // via the shared `rollupIds` gate (`?includeDescendants=true` honored only for
  // `reports:rollup` holders). The plugin INVENTORY reports
  // (summary/distribution/versions) stay single-org by design (see
  // ReportingService.getPluginSummary), so they don't resolve a rollup.

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
    sendSuccess(res, 200, { failures: scrubField(failures, 'error_message') });
  }));

  return router;
}
