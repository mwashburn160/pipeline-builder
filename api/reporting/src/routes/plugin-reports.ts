// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  ErrorCode,
  REPORT_INTERVALS,
  parseDateRange,
  parseQueryIntClamped,
  isSystemAdmin,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { MAX_REPORT_LIMIT, MAX_REPORT_RANGE_MS, scrubErrorMessage } from '../helpers.js';

export function createPluginReportRoutes(): Router {
  const router = Router();

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
    const interval = String(req.query.interval || 'week');
    if (!REPORT_INTERVALS.includes(interval as typeof REPORT_INTERVALS[number])) {
      return sendBadRequest(res, `interval must be one of: ${REPORT_INTERVALS.join(', ')}`, ErrorCode.VALIDATION_ERROR);
    }
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    sendSuccess(res, 200, { timeline: await reportingService.getBuildSuccessRate(orgId, interval, range.from, range.to) });
  }));

  router.get('/build-duration', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    sendSuccess(res, 200, { plugins: await reportingService.getBuildDuration(orgId, range.from, range.to) });
  }));

  router.get('/build-failures', withRoute(async ({ req, res, orgId }) => {
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 20, MAX_REPORT_LIMIT);
    const failures = await reportingService.getBuildFailures(orgId, range.from, range.to, limit);
    const scrubbed = (failures as unknown as Array<Record<string, unknown>>).map((f) => ({
      ...f,
      error_message: scrubErrorMessage(f.error_message as string | null | undefined),
    }));
    sendSuccess(res, 200, { failures: scrubbed });
  }));

  return router;
}
