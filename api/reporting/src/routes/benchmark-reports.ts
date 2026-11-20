// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Team benchmarking: the Reports → Teams tab.
 *
 *   GET /reports/benchmark/teams?from&to&interval&tz&weekStart
 *
 * One row per team in the caller's org → team hierarchy, plus the org itself:
 * deployment frequency, change failure rate, lead time and median time to
 * restore (each with its band, the MIN_DORA_SAMPLE `insufficient` rule and `n`),
 * the success rate and the run count. Every row is built by pipeline-data's
 * `computeTeamBenchmark` from the team's OWN dashboard reads, in the team's own
 * tenant scope, so a row equals the numbers on that team's dashboard.
 *
 * Team level ONLY — never per person.
 *
 * Gates: `reports:read` at the mount; `reports:rollup` on the route (looking
 * DOWN into the teams is the same granted capability a rollup read needs — see
 * rollupIds); `advanced_reporting` on the route (the same pairing as
 * /reports/execution/dora).
 *
 * The subtree is resolved STRICTLY: a platform outage is a 503, not a
 * one-row table that reads as "this org has no teams". An org with no teams
 * answers `hasTeams: false` with no rows (and nothing is queried).
 *
 * The windows: the DORA cells use the range capped + floored to the account's
 * DORA retention, the success rate the range capped + floored to its event
 * retention — exactly what /execution/dora and /execution/success-rate apply, so
 * the windows (and therefore the numbers) are the dashboard's.
 */

import { ErrorCode, fetchOrgNames, parseDateRange, parseReportInterval, requireFeature, requirePermission, sendBadRequest, sendError, sendSuccess, SYSTEM_ORG_ID, createLogger } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { computeTeamBenchmark, reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { parseReportBucket, REPORTING_HTTP_TIMEOUT_MS, resolveOrgSubtree } from '../helpers/report-helpers.js';
import { floorFrom, orgRetentionWindowFromSettings, retentionOrgIdFor } from '../helpers/retention-cap.js';

const logger = createLogger('reporting-benchmark');

/** Display names, best-effort: a failed lookup renders ids, never fails the table. */
async function namesFor(orgIds: string[]): Promise<Record<string, string>> {
  try {
    return await fetchOrgNames(orgIds, { authOrgId: SYSTEM_ORG_ID, timeout: REPORTING_HTTP_TIMEOUT_MS });
  } catch (err) {
    logger.warn('Team name lookup failed; rendering ids', { err: String(err) });
    return {};
  }
}

export function createBenchmarkReportRoutes(): Router {
  const router = Router();

  router.get('/teams', requirePermission('reports:rollup'), requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const interval = parseReportInterval(req.query);
    if (typeof interval === 'object') return sendBadRequest(res, interval.error, ErrorCode.VALIDATION_ERROR);
    const bucket = parseReportBucket(req.query);
    if ('error' in bucket) return sendBadRequest(res, bucket.error, ErrorCode.VALIDATION_ERROR);

    // One settings read feeds both retention windows (the account root's).
    const settings = await reportingService.getReportingSettings(orgId, retentionOrgIdFor(req, orgId));
    const doraWin = orgRetentionWindowFromSettings(settings, 'dora');
    const eventWin = orgRetentionWindowFromSettings(settings, 'event');
    const doraParsed = parseDateRange(req.query, { maxRangeMs: doraWin.maxRangeMs });
    if ('error' in doraParsed) return sendBadRequest(res, doraParsed.error, ErrorCode.VALIDATION_ERROR);
    const eventParsed = parseDateRange(req.query, { maxRangeMs: eventWin.maxRangeMs });
    if ('error' in eventParsed) return sendBadRequest(res, eventParsed.error, ErrorCode.VALIDATION_ERROR);

    let subtree: string[] | undefined;
    try {
      subtree = await resolveOrgSubtree(orgId);
    } catch (err) {
      logger.warn('Team hierarchy unavailable for the benchmark', { orgId, err: String(err) });
      return sendError(res, 503, 'The team hierarchy is temporarily unavailable', ErrorCode.SERVICE_UNAVAILABLE);
    }
    if (!subtree || subtree.length < 2) {
      return sendSuccess(res, 200, { benchmark: { hasTeams: false, rows: [] } });
    }

    const benchmark = await computeTeamBenchmark(reportingService, {
      parentOrgId: orgId,
      orgIds: subtree,
      names: await namesFor(subtree),
      doraRange: floorFrom(doraParsed, doraWin.minFromMs),
      eventRange: floorFrom(eventParsed, eventWin.minFromMs),
      interval,
      ...bucket,
    });
    sendSuccess(res, 200, { benchmark: { hasTeams: true, ...benchmark } });
  }));

  return router;
}
