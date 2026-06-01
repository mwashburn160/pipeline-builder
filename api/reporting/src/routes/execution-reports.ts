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
import { MAX_REPORT_LIMIT, MAX_REPORT_RANGE_MS, scrubErrorMessage } from '../helpers';

export function createExecutionReportRoutes(): Router {
  const router = Router();

  router.get('/count', withRoute(async ({ res, orgId }) => {
    sendSuccess(res, 200, { pipelines: await reportingService.getExecutionCount(orgId) });
  }));

  router.get('/success-rate', withRoute(async ({ req, res, orgId }) => {
    const interval = String(req.query.interval || 'week');
    if (!REPORT_INTERVALS.includes(interval as typeof REPORT_INTERVALS[number])) {
      return sendBadRequest(res, `interval must be one of: ${REPORT_INTERVALS.join(', ')}`, ErrorCode.VALIDATION_ERROR);
    }
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    sendSuccess(res, 200, { timeline: await reportingService.getSuccessRate(orgId, interval, range.from, range.to) });
  }));

  router.get('/duration', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    sendSuccess(res, 200, { pipelines: await reportingService.getAverageDuration(orgId, range.from, range.to) });
  }));

  router.get('/stage-failures', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    sendSuccess(res, 200, { stages: await reportingService.getStageFailures(orgId, range.from, range.to) });
  }));

  router.get('/stage-bottlenecks', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    sendSuccess(res, 200, { stages: await reportingService.getStageBottlenecks(orgId, range.from, range.to) });
  }));

  router.get('/action-failures', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    sendSuccess(res, 200, { actions: await reportingService.getActionFailures(orgId, range.from, range.to) });
  }));

  router.get('/errors', withRoute(async ({ req, res, orgId }) => {
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 20, MAX_REPORT_LIMIT);
    const errors = await reportingService.getErrors(orgId, range.from, range.to, limit);
    const scrubbed = (errors as unknown as Array<Record<string, unknown>>).map((e) => ({
      ...e,
      error_pattern: scrubErrorMessage(e.error_pattern as string | null | undefined),
    }));
    sendSuccess(res, 200, { errors: scrubbed });
  }));

  return router;
}
