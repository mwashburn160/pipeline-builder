// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { reportingService } from '@mwashburn160/pipeline-data';
import { Router } from 'express';
import { parseRange, VALID_INTERVALS } from '../helpers';

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
    if (!VALID_INTERVALS.includes(interval)) return sendBadRequest(res, 'interval must be day, week, or month', ErrorCode.VALIDATION_ERROR);
    const { from, to } = parseRange(req.query);
    sendSuccess(res, 200, { timeline: await reportingService.getBuildSuccessRate(orgId, interval, from, to) });
  }));

  router.get('/build-duration', withRoute(async ({ req, res, orgId }) => {
    const { from, to } = parseRange(req.query);
    sendSuccess(res, 200, { plugins: await reportingService.getBuildDuration(orgId, from, to) });
  }));

  router.get('/build-failures', withRoute(async ({ req, res, orgId }) => {
    const { from, to } = parseRange(req.query);
    const limit = parseInt(String(req.query.limit || '20'), 10);
    sendSuccess(res, 200, { failures: await reportingService.getBuildFailures(orgId, from, to, limit) });
  }));

  return router;
}
