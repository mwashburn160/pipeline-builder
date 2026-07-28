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
  requireFeature,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import type { Request } from 'express';
import { MAX_REPORT_LIMIT, MAX_REPORT_RANGE_MS, scrubErrorMessage, rollupIds } from '../helpers.js';

export function createExecutionReportRoutes(): Router {
  const router = Router();

  // Optional DORA scoping from the query string (shared by /dora + /dora/trend).
  // Length-cap the free-form values (they concatenate into report cache keys —
  // symmetry with the 255-char ingest cap prevents cache-memory bloat from a
  // pathologically long param). Not an injection concern (bound SQL params).
  const capParam = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, 255) : undefined;
  const doraOptions = (req: Request) => ({
    pipelineId: capParam(req.query.pipelineId),
    environment: capParam(req.query.environment),
    deploysOnly: req.query.deploysOnly === 'true',
  });

  router.get('/count', withRoute(async ({ req, res, orgId }) => {
    // Optional [from,to] window (same parsing/cap as the sibling reports) so the
    // count honors the dashboard date-range picker; omitted range = all-time.
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    const hasRange = typeof req.query.from === 'string' && typeof req.query.to === 'string';
    sendSuccess(res, 200, {
      pipelines: await reportingService.getExecutionCount(orgId, orgIds, hasRange ? range : undefined),
    });
  }));

  // Per-pipeline execution history. `pipelineId` is required (400 otherwise).
  // Org-scoping is enforced in reportingService.listPipelineExecutions via the
  // `p.org_id ${pred}` join — a pipelineId owned by another org returns [].
  router.get('/list', withRoute(async ({ req, res, orgId }) => {
    const pipelineId = typeof req.query.pipelineId === 'string' ? req.query.pipelineId : '';
    if (!pipelineId) return sendBadRequest(res, 'pipelineId is required', ErrorCode.VALIDATION_ERROR);
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 50, MAX_REPORT_LIMIT);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, {
      executions: await reportingService.listPipelineExecutions(orgId, pipelineId, orgIds, range, limit),
    });
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

  // DORA metrics (deployment frequency, change failure rate, MTTR, lead-time
  // proxy) over a [from,to] window. Same guards as the sibling reports:
  // `reports:read` is enforced at the mount; `?includeDescendants=true` is
  // honored only for `reports:rollup` holders (rollupIds), which bounds the
  // aggregate to the org→team subtree. ADDITIONALLY gated by the
  // `advanced_reporting` feature — DORA is a paid entitlement: INCLUDED on the
  // Enterprise tier, and a purchasable add-on bundle for every other tier
  // (developer/pro/team). So this route requires BOTH `reports:read` (mount) AND
  // the feature; the other reports stay available on every tier. Optional scoping:
  //   ?pipelineId=<id>     — per-pipeline DORA
  //   ?environment=<name>  — count only deploys to that target (basis=deploy)
  //   ?deploysOnly=true    — count only executions tagged with ANY environment
  router.get('/dora', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, {
      dora: await reportingService.getDoraMetrics(orgId, range.from, range.to, orgIds, doraOptions(req)),
    });
  }));

  // DORA trend — deployment frequency + change-failure rate bucketed by
  // `interval` for a sparkline. Same guards + optional scoping as /dora.
  router.get('/dora/trend', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const interval = parseReportInterval(req.query);
    if (typeof interval === 'object') return sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR);
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const orgIds = await rollupIds(req, orgId);
    sendSuccess(res, 200, {
      trend: await reportingService.getDoraTrend(orgId, interval, range.from, range.to, orgIds, doraOptions(req)),
    });
  }));

  router.get('/errors', withRoute(async ({ req, res, orgId }) => {
    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Admin access required', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 20, MAX_REPORT_LIMIT);
    // Rollup-aware like the sibling execution reports: ?includeDescendants rolls
    // the error report up over the org→team subtree for a reports:rollup holder.
    const orgIds = await rollupIds(req, orgId);
    const errors = await reportingService.getErrors(orgId, range.from, range.to, limit, orgIds);
    const scrubbed = (errors as unknown as Array<Record<string, unknown>>).map((e) => ({
      ...e,
      error_pattern: scrubErrorMessage(e.error_pattern as string | null | undefined),
    }));
    sendSuccess(res, 200, { errors: scrubbed });
  }));

  return router;
}
