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
import type { Request } from 'express';
import { MAX_REPORT_LIMIT, MAX_REPORT_RANGE_MS, scrubErrorMessage, resolveOrgRollup } from '../helpers.js';

export function createExecutionReportRoutes(): Router {
  const router = Router();

  // `?includeDescendants=true` rolls a parent org's report up over its team
  // subtree (best-effort; falls back to single-org — see resolveOrgRollup).
  // SECURITY: downward (parent → child) visibility is an admin capability —
  // org members get no inherited view of their teams (matches the RBAC model),
  // so the flag is honored only for admins/owners/sysadmins. Non-admins silently
  // get their own-org report.
  const rollupIds = (req: Request, orgId: string): Promise<string[] | undefined> => {
    const canRollup = isSystemAdmin(req) || req.user?.role === 'admin' || req.user?.role === 'owner';
    return req.query.includeDescendants === 'true' && canRollup
      ? resolveOrgRollup(orgId)
      : Promise.resolve(undefined);
  };

  router.get('/count', withRoute(async ({ req, res, orgId }) => {
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, { pipelines: await reportingService.getExecutionCount(orgId, orgIds) });
  }));

  router.get('/success-rate', withRoute(async ({ req, res, orgId }) => {
    const interval = parseReportInterval(req.query);
    if (typeof interval === 'object') return sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR);
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, { timeline: await reportingService.getSuccessRate(orgId, interval, range.from, range.to, orgIds) });
  }));

  router.get('/duration', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, { pipelines: await reportingService.getAverageDuration(orgId, range.from, range.to, orgIds) });
  }));

  router.get('/stage-failures', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, { stages: await reportingService.getStageFailures(orgId, range.from, range.to, orgIds) });
  }));

  router.get('/stage-bottlenecks', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, { stages: await reportingService.getStageBottlenecks(orgId, range.from, range.to, orgIds) });
  }));

  router.get('/action-failures', withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, { actions: await reportingService.getActionFailures(orgId, range.from, range.to, orgIds) });
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
