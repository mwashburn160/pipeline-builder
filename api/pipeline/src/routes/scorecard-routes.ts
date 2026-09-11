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
  runConcurrent,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incrementQuotaFromCtx } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { buildScorecard, type Scorecard } from '../helpers/scorecard.js';
import { pipelineService, toComplianceAttributes } from '../services/pipeline-service.js';

const complianceClient = createComplianceClient();

/** Scoring window: DORA over the trailing 30 days. */
const SCORECARD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Cap on pipelines scored per org-wide roll-up (bounds the N× compliance+DORA cost). */
const ORG_SCORECARD_MAX = parseInt(process.env.ORG_SCORECARD_MAX_PIPELINES || '50', 10);
/** Max concurrent per-pipeline computes in a roll-up (bounds load on the compliance service). */
const ORG_SCORECARD_CONCURRENCY = parseInt(process.env.ORG_SCORECARD_CONCURRENCY || '4', 10);

/** Minimal shape the scorecard compute needs off a pipeline record. */
interface ScorablePipeline { id: string; name?: string; [k: string]: unknown }

/**
 * Compute one pipeline's maturity scorecard: per-pipeline DORA (in-process) blended
 * with a compliance dry-run (S2S, fail-soft). Shared by the per-pipeline route and
 * the org-wide roll-up so the two can never diverge in how a score is derived.
 */
async function computeScorecard(
  pipeline: ScorablePipeline,
  orgId: string,
  from: Date,
  to: Date,
  incidentWindowHours: number | null | undefined,
  warn: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<Scorecard> {
  const id = pipeline.id;
  const dora = await reportingService.getDoraMetrics(orgId, from.toISOString(), to.toISOString(), [orgId], {
    pipelineId: id,
    incidentWindowHours: incidentWindowHours ?? undefined,
  });

  // Compliance posture — dry-run against the org's rules. Fail-soft: if compliance
  // is unavailable, score on DORA alone (rulesEvaluated stays 0).
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
    warn('Scorecard compliance dry-run failed; scoring on DORA only', { id, error: (err as Error).message });
  }

  return buildScorecard(id, dora, compliance, to.toISOString());
}

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

    const scorecard = await computeScorecard(pipeline as ScorablePipeline, orgId, from, to, incidentWindowHours, (msg, meta) => ctx.log('WARN', msg, meta));
    ctx.log('COMPLETED', 'Computed pipeline scorecard', { id, score: scorecard.score, grade: scorecard.grade });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');
    return sendSuccess(res, 200, { scorecard });
  }));

  // Org-wide maturity roll-up: a "software health" leaderboard grading every
  // pipeline in the org, plus aggregate stats. Turns the per-pipeline widget into
  // a platform-team view. Bounded (ORG_SCORECARD_MAX pipelines, ORG_SCORECARD_CONCURRENCY
  // parallelism) so it can't become a cost-amplification path; metered like other
  // reads. `/scorecard` is a single path segment so it never collides with the
  // two-segment `/:id/scorecard` above.
  router.get('/scorecard', requireFeature('advanced_reporting'), withRoute(async ({ req, res, ctx, orgId }) => {
    const to = new Date();
    const from = new Date(to.getTime() - SCORECARD_WINDOW_MS);
    const { incidentWindowHours } = await reportingService.getIncidentSettings(orgId);

    // List the org's pipelines (RLS + access clause scope it), capped.
    const listed = await pipelineService.findPaginated({}, orgId, { limit: ORG_SCORECARD_MAX + 1, offset: 0 });
    const pipelines = listed.data.slice(0, ORG_SCORECARD_MAX) as ScorablePipeline[];
    const truncated = listed.data.length > ORG_SCORECARD_MAX || listed.hasMore === true;

    // Compute each pipeline's scorecard with bounded concurrency (each does a
    // compliance dry-run + DORA scan). computeScorecard is fail-soft per pipeline.
    const scored = await runConcurrent(pipelines, ORG_SCORECARD_CONCURRENCY, async (p) => {
      const card = await computeScorecard(p, orgId, from, to, incidentWindowHours, (msg, meta) => ctx.log('WARN', msg, meta));
      return { ...card, name: p.name };
    });

    // Leaderboard: highest score first; unscored (null) sink to the bottom.
    const leaderboard = [...scored].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const withScores = scored.filter((s) => s.score !== null) as Array<{ score: number; grade: string }>;
    const averageScore = withScores.length
      ? Math.round(withScores.reduce((sum, s) => sum + s.score, 0) / withScores.length)
      : null;
    const gradeDistribution: Record<string, number> = {};
    for (const s of scored) gradeDistribution[s.grade] = (gradeDistribution[s.grade] ?? 0) + 1;

    ctx.log('COMPLETED', 'Computed org-wide scorecard roll-up', {
      pipelineCount: scored.length, averageScore, truncated,
    });
    incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');
    return sendSuccess(res, 200, {
      rollup: {
        orgId,
        pipelineCount: scored.length,
        scored: withScores.length,
        averageScore,
        gradeDistribution,
        leaderboard,
        computedAt: to.toISOString(),
        truncated,
      },
    });
  }));

  return router;
}
