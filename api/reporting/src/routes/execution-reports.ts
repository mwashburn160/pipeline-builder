// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  ErrorCode,
  parseReportInterval,
  parseDateRange,
  parseQueryIntClamped,
  requireFeature,
  requireSystemOrgPermission,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { previousDashboardWindow, reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { MAX_REPORT_LIMIT, MAX_REPORT_RANGE_MS, parseReportBucket, scrubField, rollupIds } from '../helpers/report-helpers.js';
import { resolveReportScope } from '../helpers/report-scope.js';
import { orgRetentionWindowFromSettings, floorFrom, retentionOrgIdFor, resolveOrgRetentionWindow } from '../helpers/retention-cap.js';

/**
 * `?compare=previous` on the dashboard headline routes (/dora, /success-rate):
 * `false` when absent, `true` for `previous`, `{ error }` for anything else.
 * (A stakeholder report compares against the previous CALENDAR period instead —
 * see docs/dora-metrics.md.)
 */
function parseCompare(query: Record<string, unknown>): boolean | { error: string } {
  const v = query.compare;
  if (v === undefined || v === '') return false;
  return v === 'previous' ? true : { error: '"compare" must be "previous"' };
}

/**
 * The comparison is an `advanced_reporting` read even on a free route: a request
 * that asks for it without the entitlement is refused by the same gate /dora
 * uses; without `?compare` the route stays free (`reports:read` only).
 */
const requireAdvanced = requireFeature('advanced_reporting');
function compareGate(req: Request, res: Response, next: NextFunction): void {
  if (req.query.compare === undefined || req.query.compare === '') return next();
  requireAdvanced(req, res, next);
}

/**
 * The previous window for a comparison, or null when it would start before the
 * retention horizon (that data is purged — a partial window would compare a
 * fraction of a period against a whole one). `minFromMs <= 0` = unlimited.
 */
function comparableWindow(range: { from: string; to: string }, minFromMs: number): { from: string; to: string } | null {
  const prev = previousDashboardWindow(range.from, range.to);
  if (!prev) return null;
  return minFromMs > 0 && Date.parse(prev.from) < minFromMs ? null : prev;
}

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
  });

  router.get('/count', withRoute(async ({ req, res, orgId }) => {
    // Optional [from,to] window (same parsing/cap as the sibling reports) so the
    // count honors the dashboard date-range picker; omitted range = all-time.
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
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
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 50, MAX_REPORT_LIMIT);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, {
      executions: await reportingService.listPipelineExecutions(orgId, pipelineId, orgIds, range, limit),
    });
  }));

  // `?tz=` (IANA name) and `?weekStart=` (monday|sunday) bucket the series the
  // way the stakeholder report does (see parseReportBucket); invalid → 400.
  router.get('/success-rate', compareGate, withRoute(async ({ req, res, orgId }) => {
    const interval = parseReportInterval(req.query);
    if (typeof interval === 'object') return sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR);
    const bucket = parseReportBucket(req.query);
    if ('error' in bucket) return sendBadRequest(res, bucket.error, ErrorCode.VALIDATION_ERROR);
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    const compare = parseCompare(req.query);
    if (typeof compare === 'object') return sendBadRequest(res, compare.error, ErrorCode.VALIDATION_ERROR);
    const timeline = reportingService.getSuccessRate(orgId, interval, range.from, range.to, orgIds, bucket);
    if (!compare) return sendSuccess(res, 200, { timeline: await timeline });
    // `?compare=previous`: the same figures for the equal-length window just
    // before (advanced_reporting — enforced by compareGate on this route), or
    // `previous: null` when that window starts before the event retention horizon.
    const win = await resolveOrgRetentionWindow(orgId, 'event', retentionOrgIdFor(req, orgId));
    const prev = comparableWindow(range, win.minFromMs);
    const [current, previous] = await Promise.all([
      timeline,
      prev ? reportingService.getSuccessRate(orgId, interval, prev.from, prev.to, orgIds, bucket) : Promise.resolve(null),
    ]);
    sendSuccess(res, 200, { timeline: current, previous: prev && previous ? { window: prev, timeline: previous } : null });
  }));

  router.get('/duration', withRoute(async ({ req, res, orgId }) => {
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, { pipelines: await reportingService.getAverageDuration(orgId, range.from, range.to, orgIds) });
  }));

  router.get('/stage-failures', withRoute(async ({ req, res, orgId }) => {
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, { stages: await reportingService.getStageFailures(orgId, range.from, range.to, orgIds) });
  }));

  router.get('/stage-bottlenecks', withRoute(async ({ req, res, orgId }) => {
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, { stages: await reportingService.getStageBottlenecks(orgId, range.from, range.to, orgIds) });
  }));

  router.get('/action-failures', withRoute(async ({ req, res, orgId }) => {
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, { actions: await reportingService.getActionFailures(orgId, range.from, range.to, orgIds) });
  }));

  // DORA metrics (deployment frequency, change failure rate, MTTR, lead-time
  // proxy) over a [from,to] window. Same guards as the sibling reports:
  // `reports:read` is enforced at the mount; `?includeDescendants=true` is
  // honored only for `reports:rollup` holders (rollupIds), which bounds the
  // aggregate to the org→team subtree. ADDITIONALLY gated by the
  // `advanced_reporting` feature — DORA is a paid entitlement: INCLUDED on the
  // Business and Enterprise tiers, and a purchasable add-on bundle for the others
  // (developer/pro/team). So this route requires BOTH `reports:read` (mount) AND
  // the feature; the other reports stay available on every tier. Optional scoping:
  //   ?pipelineId=<id>     — per-pipeline DORA
  //   ?environment=<name>  — restrict to a single deploy environment
  router.get('/dora', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    // The org's settings row carries both its incident→deploy correlation window
    // override and its DORA retention cap, so one fetch feeds the range cap and
    // the incident window (null = env default) — don't double-fetch it via
    // resolveReportScope. The rollup lookup is independent, so it runs alongside.
    const [settings, orgIds] = await Promise.all([
      reportingService.getReportingSettings(orgId, retentionOrgIdFor(req, orgId)),
      rollupIds(req, orgId),
    ]);
    const win = orgRetentionWindowFromSettings(settings, 'dora');
    const parsed = parseDateRange(req.query, { maxRangeMs: win.maxRangeMs });
    if ('error' in parsed) return sendBadRequest(res, parsed.error, ErrorCode.VALIDATION_ERROR);
    // Floor `from` at the retention horizon so the returned dora.window reflects
    // the clamp (frontend truncation banner); unlimited (`minFromMs=0`) = no floor.
    const range = floorFrom(parsed, win.minFromMs);
    const { incidentWindowHours } = settings;
    const compare = parseCompare(req.query);
    if (typeof compare === 'object') return sendBadRequest(res, compare.error, ErrorCode.VALIDATION_ERROR);
    const opts = { ...doraOptions(req), incidentWindowHours: incidentWindowHours ?? undefined };
    if (!compare) {
      return sendSuccess(res, 200, { dora: await reportingService.getDoraMetrics(orgId, range.from, range.to, orgIds, opts) });
    }
    // `?compare=previous`: the same DORA figures for the equal-length window just
    // before, or `previous: null` when it starts before the DORA retention horizon.
    const prev = comparableWindow(range, win.minFromMs);
    const [dora, previous] = await Promise.all([
      reportingService.getDoraMetrics(orgId, range.from, range.to, orgIds, opts),
      prev ? reportingService.getDoraMetrics(orgId, prev.from, prev.to, orgIds, opts) : Promise.resolve(null),
    ]);
    sendSuccess(res, 200, { dora, previous });
  }));

  // DORA trend — deployment frequency + change-failure rate bucketed by
  // `interval` for a sparkline. Same guards + optional scoping as /dora, plus
  // `?tz=` / `?weekStart=` bucketing (see /success-rate). The org's incident
  // window is threaded in like /dora's: the trend's CFR includes post-deploy
  // (incident-correlated) failures, so it must correlate with the same window or
  // its buckets would not add up to the headline.
  router.get('/dora/trend', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const interval = parseReportInterval(req.query);
    if (typeof interval === 'object') return sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR);
    const bucket = parseReportBucket(req.query);
    if ('error' in bucket) return sendBadRequest(res, bucket.error, ErrorCode.VALIDATION_ERROR);
    const [settings, orgIds] = await Promise.all([
      reportingService.getReportingSettings(orgId, retentionOrgIdFor(req, orgId)),
      rollupIds(req, orgId),
    ]);
    const win = orgRetentionWindowFromSettings(settings, 'dora');
    const parsed = parseDateRange(req.query, { maxRangeMs: win.maxRangeMs });
    if ('error' in parsed) return sendBadRequest(res, parsed.error, ErrorCode.VALIDATION_ERROR);
    const range = floorFrom(parsed, win.minFromMs);
    sendSuccess(res, 200, {
      trend: await reportingService.getDoraTrend(orgId, interval, range.from, range.to, orgIds, {
        ...doraOptions(req),
        incidentWindowHours: settings.incidentWindowHours ?? undefined,
        ...bucket,
      }),
    });
  }));

  // Distinct deploy environments observed in the window — powers the DORA
  // environment-scope datalist. Same gates + rollup as /dora.
  router.get('/environments', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const scope = await resolveReportScope(req, orgId, 'dora');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, {
      environments: await reportingService.getReportEnvironments(orgId, range.from, range.to, orgIds),
    });
  }));

  // Per-pipeline BUILD HEALTH. Standard reporting — gated only by the
  // mount's `reports:read` (NOT `advanced_reporting`; build health ships on every
  // tier). `pipelineId` is required; org-scoping is enforced in
  // reportingService.getBuildHealth via the `p.org_id ${pred}` join (a pipelineId
  // owned by another org returns an empty breakdown). Rollup-aware like the
  // sibling execution reports.
  router.get('/build-health', withRoute(async ({ req, res, orgId }) => {
    const pipelineId = typeof req.query.pipelineId === 'string' ? req.query.pipelineId : '';
    if (!pipelineId) return sendBadRequest(res, 'pipelineId is required', ErrorCode.VALIDATION_ERROR);
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, {
      buildHealth: await reportingService.getBuildHealth(orgId, pipelineId, range.from, range.to, orgIds),
    });
  }));

  // The org's own error patterns, grouped by failure category (the ingest-time
  // classifier's `failure_category`) with the top error texts in each. The
  // TENANT read of the same failures `/errors` reads across every org: gated only
  // by the mount's `reports:read` (every tier), org-scoped + rollup-aware like the
  // sibling reports, bounded by the org's event retention — and there is no
  // cross-org path in it. Error text is scrubbed of credential-shaped substrings
  // on the way out, as `/errors` is.
  router.get('/error-patterns', withRoute(async ({ req, res, orgId }) => {
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    const limit = parseQueryIntClamped(req.query.limit, 20, MAX_REPORT_LIMIT);
    const categories = await reportingService.getErrorCategories(orgId, range.from, range.to, limit, orgIds);
    sendSuccess(res, 200, {
      categories: categories.map((c) => ({ ...c, patterns: scrubField(c.patterns, 'error_pattern') })),
    });
  }));

  // Flaky stages — a stage that FAILED and then PASSED on retry in the same
  // execution, ranked per (pipeline, stage) with its flake rate. The ranked list
  // ships on every tier (`reports:read` at the mount); the trend below is the
  // `advanced_reporting` half. Org-scoped + rollup-aware like the siblings.
  router.get('/flaky-stages', withRoute(async ({ req, res, orgId }) => {
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    const limit = parseQueryIntClamped(req.query.limit, 50, MAX_REPORT_LIMIT);
    sendSuccess(res, 200, { stages: await reportingService.getFlakyStages(orgId, range.from, range.to, orgIds, limit) });
  }));

  // The flake rate per time bucket — every stage, or one (pipeline, stage) via
  // `?pipelineId=&stageName=` — with the same `?tz=` / `?weekStart=` bucketing as
  // /success-rate. ADDITIONALLY gated by `advanced_reporting`, like /dora/trend.
  router.get('/flaky-stages/trend', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const interval = parseReportInterval(req.query);
    if (typeof interval === 'object') return sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR);
    const bucket = parseReportBucket(req.query);
    if ('error' in bucket) return sendBadRequest(res, bucket.error, ErrorCode.VALIDATION_ERROR);
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, {
      trend: await reportingService.getFlakyStageTrend(orgId, interval, range.from, range.to, orgIds, {
        ...bucket,
        pipelineId: capParam(req.query.pipelineId),
        stageName: capParam(req.query.stageName),
      }),
    });
  }));

  // Free-form error TEXT across EVERY org — the platform operator's read, which
  // is why it is gated on `orgs:read` (system-org-only, so ungrantable inside a
  // tenant) rather than `reports:read` or the superadmin flag. Cross-org by
  // construction: no caller org and no rollup, so `includeDescendants` has
  // nothing to add. Bounded by the absolute range ceiling rather than a per-org
  // retention floor, since no single org's retention applies.
  router.get('/errors', ...requireSystemOrgPermission('orgs:read'), withRoute(async ({ req, res }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 20, MAX_REPORT_LIMIT);
    const errors = await reportingService.getPlatformErrors(range.from, range.to, limit);
    sendSuccess(res, 200, { errors: scrubField(errors, 'error_pattern') });
  }));

  return router;
}
