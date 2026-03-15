import { sendSuccess, sendBadRequest, ErrorCode } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { reportingService } from '@mwashburn160/pipeline-data';
import { Router } from 'express';
import { parseRange, VALID_INTERVALS } from '../helpers';

export function createExecutionReportRoutes(): Router {
  const router = Router();

  router.get('/count', withRoute(async ({ res, orgId }) => {
    sendSuccess(res, 200, { pipelines: await reportingService.getExecutionCount(orgId) });
  }));

  router.get('/success-rate', withRoute(async ({ req, res, orgId }) => {
    const interval = String(req.query.interval || 'week');
    if (!VALID_INTERVALS.includes(interval)) return sendBadRequest(res, 'interval must be day, week, or month', ErrorCode.VALIDATION_ERROR);
    const { from, to } = parseRange(req.query);
    sendSuccess(res, 200, { timeline: await reportingService.getSuccessRate(orgId, interval, from, to) });
  }));

  router.get('/timeline', withRoute(async ({ req, res, orgId }) => {
    const interval = String(req.query.interval || 'week');
    const { from, to } = parseRange(req.query);
    sendSuccess(res, 200, { timeline: await reportingService.getSuccessRate(orgId, interval, from, to) });
  }));

  router.get('/duration', withRoute(async ({ req, res, orgId }) => {
    const { from, to } = parseRange(req.query);
    sendSuccess(res, 200, { pipelines: await reportingService.getAverageDuration(orgId, from, to) });
  }));

  router.get('/stage-failures', withRoute(async ({ req, res, orgId }) => {
    const { from, to } = parseRange(req.query);
    sendSuccess(res, 200, { stages: await reportingService.getStageFailures(orgId, from, to) });
  }));

  router.get('/stage-bottlenecks', withRoute(async ({ req, res, orgId }) => {
    const { from, to } = parseRange(req.query);
    sendSuccess(res, 200, { stages: await reportingService.getStageBottlenecks(orgId, from, to) });
  }));

  router.get('/action-failures', withRoute(async ({ req, res, orgId }) => {
    const { from, to } = parseRange(req.query);
    sendSuccess(res, 200, { actions: await reportingService.getActionFailures(orgId, from, to) });
  }));

  router.get('/errors', withRoute(async ({ req, res, orgId }) => {
    const { from, to } = parseRange(req.query);
    const limit = parseInt(String(req.query.limit || '20'), 10);
    sendSuccess(res, 200, { errors: await reportingService.getErrors(orgId, from, to, limit) });
  }));

  return router;
}
