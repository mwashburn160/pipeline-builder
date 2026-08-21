// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getParam,
  ErrorCode,
  sendBadRequest,
  sendSuccess,
  sendEntityNotFound,
  getServiceAuthHeader,
  createComplianceClient,
  requireFeature,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incrementQuotaFromCtx } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { buildScorecard } from '../helpers/scorecard.js';
import { pipelineService, toComplianceAttributes } from '../services/pipeline-service.js';

const complianceClient = createComplianceClient();

/** Scoring window: DORA over the trailing 30 days. */
const SCORECARD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Per-pipeline maturity scorecard: blends compliance posture (dry-run against the
 * org's rules) with per-pipeline DORA bands into a graded 0–100 score. Both
 * dimensions are computed in-process (DORA via reportingService, compliance via
 * the S2S dry-run) — no extra network hop. Gated on `advanced_reporting`, the
 * same feature that gates DORA itself.
 */
export function createScorecardRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // Mounted behind createProtectedRoute (auth + org + apiCalls quota), so this
  // heavy endpoint (compliance dry-run + DORA scan) is metered like other reads
  // rather than being a free cost-amplification path.
  router.get('/:id/scorecard', requireFeature('advanced_reporting'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // pipelineService.findById is the cached 2-arg override; its access clause
    // already covers own-org + system/parent public, matching the read route.
    const pipeline = await pipelineService.findById(id, orgId);
    if (!pipeline) return sendEntityNotFound(res, 'Pipeline');

    const to = new Date();
    const from = new Date(to.getTime() - SCORECARD_WINDOW_MS);

    // Thread the org's incident→deploy correlation-window override into the DORA
    // compute so the scorecard's CFR/MTTR (post-deploy correlation) match what the
    // `/dora` report shows for the same org (both then key the same cache entry).
    const { incidentWindowHours } = await reportingService.getIncidentSettings(orgId);

    // Per-pipeline DORA (in-process).
    const dora = await reportingService.getDoraMetrics(orgId, from.toISOString(), to.toISOString(), [orgId], {
      pipelineId: id,
      incidentWindowHours: incidentWindowHours ?? undefined,
    });

    // Compliance posture — dry-run the pipeline against the org's rules. Fail-soft:
    // if compliance is unavailable, score on DORA alone (rulesEvaluated stays 0).
    let compliance = { rulesEvaluated: 0, violations: 0, warnings: 0 };
    try {
      const attributes = toComplianceAttributes(pipeline) as Record<string, unknown>;
      const serviceAuth = getServiceAuthHeader({ serviceName: 'pipeline', orgId, role: 'member' });
      const result = await complianceClient.dryRunPipeline(orgId, attributes, serviceAuth);
      compliance = {
        rulesEvaluated: result.rulesEvaluated ?? 0,
        violations: result.violations?.length ?? 0,
        warnings: result.warnings?.length ?? 0,
      };
    } catch (err) {
      ctx.log('WARN', 'Scorecard compliance dry-run failed; scoring on DORA only', { id, error: (err as Error).message });
    }

    const scorecard = buildScorecard(id, dora, compliance, to.toISOString());
    ctx.log('COMPLETED', 'Computed pipeline scorecard', { id, score: scorecard.score, grade: scorecard.grade });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');
    return sendSuccess(res, 200, { scorecard });
  }));

  return router;
}
