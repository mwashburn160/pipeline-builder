// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  ErrorCode,
  parseReportInterval,
  parseDateRange,
  parseQueryIntClamped,
  requireSystemAdmin,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService, type PluginRuntimeFilter, type PluginRuntimeStats } from '@pipeline-builder/pipeline-data';
import { Router, type Request, type Response } from 'express';
import { MAX_REPORT_LIMIT, MAX_REPORT_RANGE_MS, scrubField, rollupIds } from '../helpers/report-helpers.js';
import { resolveReportScope } from '../helpers/report-scope.js';

/** Plugin name shape (the plugin spec's `name` rule). */
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,254}$/;
/** Publisher handle shape (`publishers.handle`, ≤ 39). */
const PUBLISHER_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
/** Version: semver-ish, bounded by `plugin_version` (≤ 50). */
const VERSION_RE = /^[0-9A-Za-z.+-]{1,50}$/;

/**
 * Parse the runtime-report filters. `?publisher=` (empty) selects own-org,
 * publisher-less plugins; an absent parameter doesn't filter.
 */
export function parsePluginRuntimeFilter(query: Request['query']): PluginRuntimeFilter | { error: string } {
  const filter: { name?: string; publisher?: string | null; version?: string } = {};
  const { name, publisher, version } = query;
  if (name !== undefined) {
    if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) return { error: 'name must be a plugin name' };
    filter.name = name;
  }
  if (publisher !== undefined) {
    if (typeof publisher !== 'string' || (publisher !== '' && !PUBLISHER_RE.test(publisher))) {
      return { error: 'publisher must be a publisher handle (or empty for own-org plugins)' };
    }
    filter.publisher = publisher === '' ? null : publisher;
  }
  if (version !== undefined) {
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return { error: 'version must be a plugin version' };
    filter.version = version;
  }
  return filter;
}

/**
 * Shared front half of the runtime routes: range (org retention-capped),
 * filters, rollup. Sends the 400 itself and returns undefined on bad input.
 */
async function pluginRuntimeStats(req: Request, res: Response, orgId: string): Promise<PluginRuntimeStats[] | undefined> {
  const scope = await resolveReportScope(req, orgId, 'event');
  if ('error' in scope) {
    sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    return undefined;
  }
  const filter = parsePluginRuntimeFilter(req.query);
  if ('error' in filter) {
    sendBadRequest(res, filter.error, ErrorCode.VALIDATION_ERROR);
    return undefined;
  }
  return reportingService.getPluginRuntime(orgId, scope.range.from, scope.range.to, filter, scope.orgIds);
}

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
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, { timeline: await reportingService.getBuildSuccessRate(orgId, interval, range.from, range.to, orgIds) });
  }));

  router.get('/build-duration', withRoute(async ({ req, res, orgId }) => {
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;
    sendSuccess(res, 200, { plugins: await reportingService.getBuildDuration(orgId, range.from, range.to, orgIds) });
  }));

  // ── Plugin RUNTIME telemetry ──────────────────────────────────────────────
  // How plugins behave when the org's pipelines RUN them (vs the BUILD reports
  // above): terminal ACTION events attributed at ingest via the step manifest.
  // Rollup-aware like the build reports. Both routes read the same per-version
  // aggregate (one cached query) and project the half they report.

  router.get('/runtime-success-rate', withRoute(async ({ req, res, orgId }) => {
    const stats = await pluginRuntimeStats(req, res, orgId);
    if (!stats) return;
    sendSuccess(res, 200, {
      plugins: stats.map(({ pluginPublisher, pluginName, pluginVersion, runs, succeeded, failed, successPct, lastRun }) =>
        ({ pluginPublisher, pluginName, pluginVersion, runs, succeeded, failed, successPct, lastRun })),
    });
  }));

  router.get('/runtime-duration', withRoute(async ({ req, res, orgId }) => {
    const stats = await pluginRuntimeStats(req, res, orgId);
    if (!stats) return;
    sendSuccess(res, 200, {
      plugins: stats.map(({ pluginPublisher, pluginName, pluginVersion, runs, p50Ms, p95Ms }) =>
        ({ pluginPublisher, pluginName, pluginVersion, runs, p50Ms, p95Ms })),
    });
  }));

  // System-admin only: cross-org failure text, so the retention floor doesn't apply.
  router.get('/build-failures', requireSystemAdmin, withRoute(async ({ req, res, orgId }) => {
    const range = parseDateRange(req.query, { maxRangeMs: MAX_REPORT_RANGE_MS });
    if ('error' in range) return sendBadRequest(res, range.error, ErrorCode.VALIDATION_ERROR);
    const limit = parseQueryIntClamped(req.query.limit, 20, MAX_REPORT_LIMIT);
    const orgIds = await rollupIds(req, orgId);
    const failures = await reportingService.getBuildFailures(orgId, range.from, range.to, limit, orgIds);
    sendSuccess(res, 200, { failures: scrubField(failures, 'error_message') });
  }));

  return router;
}
