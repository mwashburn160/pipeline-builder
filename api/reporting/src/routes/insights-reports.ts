// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Insights tab: the stakeholder report's analytics sections, on demand.
 *
 *   GET /reports/insights?from&to&tz&weekStart&includeDescendants&sections
 *
 * Needs-attention, failure analysis, promotion, resource consumption, outdated
 * plugins and adoption — the panels that used to exist only inside a saved report.
 * They are computed by pipeline-data's `computeInsights`, which calls each
 * REGISTERED SECTION's own `run`, so the tab and a report over the same window and
 * timezone show the same numbers. Every one reads the daily rollups, not raw events.
 *
 * Gates: `reports:read` at the mount, plus `advanced_reporting` on the route — the
 * same pairing as /reports/execution/dora. Org-scoped by the authenticated org;
 * `?includeDescendants=true` widens to the team subtree only for a
 * `reports:rollup` holder (see rollupIds). The window is capped and floored to the
 * account's standard-event retention, the same horizon a stakeholder report is
 * refused against.
 *
 * The window: `YYYY-MM-DD` bounds are local midnights in `tz` (a report's periods
 * start at local midnight), `to` exclusive. The trend columns compare against the
 * equal-length window immediately before.
 */

import { ErrorCode, sendBadRequest, sendSuccess, requireFeature } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import {
  computeInsights,
  insightBound,
  isInsightSectionId,
  INSIGHT_SECTION_IDS,
  reportingService,
  type InsightSectionId,
  type SectionDataSource,
} from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { parseReportBucket } from '../helpers/report-helpers.js';
import { resolveReportScope } from '../helpers/report-scope.js';

/** `?sections=a,b` narrowed to the Insights ids, or `{ error }` naming the bad one. */
function parseSections(raw: unknown): readonly InsightSectionId[] | { error: string } {
  if (raw === undefined || raw === '') return INSIGHT_SECTION_IDS;
  if (typeof raw !== 'string') return { error: '"sections" must be a comma-separated list' };
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  const bad = ids.find((id) => !isInsightSectionId(id));
  if (bad) return { error: `Unknown insights section "${bad.slice(0, 64)}". Use: ${INSIGHT_SECTION_IDS.join(', ')}` };
  return ids as InsightSectionId[];
}

export function createInsightsReportRoutes(): Router {
  const router = Router();

  router.get('/', requireFeature('advanced_reporting'), withRoute(async ({ req, res, orgId }) => {
    const bucket = parseReportBucket(req.query);
    if ('error' in bucket) return sendBadRequest(res, bucket.error, ErrorCode.VALIDATION_ERROR);
    const sections = parseSections(req.query.sections);
    if ('error' in sections) return sendBadRequest(res, sections.error, ErrorCode.VALIDATION_ERROR);
    const scope = await resolveReportScope(req, orgId, 'event');
    if ('error' in scope) return sendBadRequest(res, scope.error, ErrorCode.VALIDATION_ERROR);
    const { range, orgIds } = scope;

    const insights = await computeInsights(reportingService as unknown as SectionDataSource, {
      orgId,
      ...(orgIds ? { orgIds } : {}),
      from: insightBound(range.from, bucket.tz),
      to: insightBound(range.to, bucket.tz),
      tz: bucket.tz,
      weekStart: bucket.weekStart,
    }, sections);
    sendSuccess(res, 200, { insights });
  }));

  return router;
}
