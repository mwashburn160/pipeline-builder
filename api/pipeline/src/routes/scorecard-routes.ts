// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createCacheService,
  getParam,
  ErrorCode,
  sendBadRequest,
  sendSuccess,
  sendEntityNotFound,
  getServiceAuthHeader,
  createComplianceClient,
  requireFeature,
  runConcurrent,
  envInt,
  errorMessage,
  requirePermission,
  toComplianceAttributes,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService, viewerCacheSegment } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';
import { buildScorecard, NO_SECURITY_SIGNAL, unavailableScorecard, type Scorecard, type ScorecardSecurityInput } from '../helpers/scorecard.js';
import { securitySignals } from '../helpers/security-signal.js';
import { pipelineService } from '../services/pipeline-service.js';

const complianceClient = createComplianceClient();

/** Scoring window: DORA over the trailing 30 days. */
const SCORECARD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Cap on pipelines scored per org-wide roll-up (bounds the N× compliance+DORA cost). */
const ORG_SCORECARD_MAX = envInt('ORG_SCORECARD_MAX_PIPELINES', 50, { min: 1 });
/** Max concurrent per-pipeline computes in a roll-up (bounds load on the compliance service). */
const ORG_SCORECARD_CONCURRENCY = envInt('ORG_SCORECARD_CONCURRENCY', 4, { min: 1 });

/**
 * How long one computed roll-up page is reused (seconds). Every page costs up to
 * ORG_SCORECARD_MAX DORA scans + compliance dry-runs, and the scores move on a
 * 30-day window, so five minutes of reuse is invisible to a reader (the page
 * shows `computedAt`) and turns a refresh-happy tab into one compute.
 */
const ORG_SCORECARD_CACHE_SECONDS = 300;
const rollupCache = createCacheService('pipeline:scorecard-rollup:', ORG_SCORECARD_CACHE_SECONDS);

/**
 * Roll-up query: a page of the org's OWN pipelines (system samples and a parent
 * org's shared pipelines are never graded here — they are not this org's
 * software), newest-changed first, optionally narrowed by project / name.
 */
const RollupQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(ORG_SCORECARD_MAX).default(ORG_SCORECARD_MAX),
  project: z.string().trim().min(1).max(255).optional(),
  pipelineName: z.string().trim().min(1).max(255).optional(),
});

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
  security: ScorecardSecurityInput = NO_SECURITY_SIGNAL,
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

  return buildScorecard(id, dora, compliance, to.toISOString(), security);
}

/** Log sink a roll-up compute writes through (the request's `ctx.log`). */
type RollupLog = (level: 'WARN' | 'COMPLETED', msg: string, meta?: Record<string, unknown>) => void;

/**
 * Compute one roll-up page: grade a page of the org's OWN pipelines and
 * aggregate them. Callers cache the result (see {@link rollupCache}).
 */
async function computeRollup(orgId: string, query: z.infer<typeof RollupQuerySchema>, log: RollupLog) {
  const { offset, limit, project, pipelineName } = query;
  const to = new Date();
  const from = new Date(to.getTime() - SCORECARD_WINDOW_MS);
  const { incidentWindowHours } = await reportingService.getReportingSettings(orgId);

  // One page of the org's OWN pipelines (the `orgId` filter narrows inside the
  // access clause, so system samples and a parent's public rows drop out),
  // most recently changed first — a stable, total order, so `offset` pages.
  const listed = await pipelineService.findPaginated(
    { orgId, ...(project && { project }), ...(pipelineName && { pipelineName }) },
    orgId,
    { limit, offset, sortBy: 'updatedAt', sortOrder: 'desc', includeTotal: true },
  );
  const pipelines = listed.data.slice(0, limit) as ScorablePipeline[];
  const hasMore = listed.hasMore === true;

  // Compute each pipeline's scorecard with bounded concurrency (each does a
  // compliance dry-run + DORA scan).
  //
  // PER-PIPELINE ISOLATION: only the COMPLIANCE half of computeScorecard was
  // fail-soft — the DORA await was unguarded, so a single pipeline's failure
  // rejected the whole roll-up and the Scorecard tab 500'd with nothing
  // rendered. An org-wide leaderboard must degrade per row: one unmeasurable
  // pipeline is a gap in the table, not an outage of the page.
  let failed = 0;
  const warn = (msg: string, meta?: Record<string, unknown>) => log('WARN', msg, meta);
  // The security signal for every listed pipeline in one pass (two reads, not 2N).
  const security = await securitySignals(orgId, pipelines.map((p) => p.id), warn);
  const scored = await runConcurrent(pipelines, ORG_SCORECARD_CONCURRENCY, async (p) => {
    try {
      const card = await computeScorecard(p, orgId, from, to, incidentWindowHours, warn, security.get(p.id));
      return { ...card, name: p.name };
    } catch (err) {
      // Logged per pipeline WITH its id: the roll-up stays up, and the id is
      // what an operator needs to find the underlying failure.
      failed += 1;
      log('WARN', 'Scorecard compute failed for pipeline; excluding it from the roll-up', {
        pipelineId: p.id, error: errorMessage(err),
      });
      return { ...unavailableScorecard(p.id, to.toISOString()), name: p.name };
    }
  });

  // Leaderboard: highest score first; unscored (null) sink to the bottom.
  const leaderboard = [...scored].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const withScores = scored.filter((s) => s.score !== null) as Array<{ score: number; grade: string }>;
  const averageScore = withScores.length
    ? Math.round(withScores.reduce((sum, s) => sum + s.score, 0) / withScores.length)
    : null;
  const gradeDistribution: Record<string, number> = {};
  for (const s of scored) gradeDistribution[s.grade] = (gradeDistribution[s.grade] ?? 0) + 1;

  log('COMPLETED', 'Computed org-wide scorecard roll-up', {
    pipelineCount: scored.length, averageScore, offset, hasMore, failed,
  });
  return {
    orgId,
    pipelineCount: scored.length,
    scored: withScores.length,
    averageScore,
    gradeDistribution,
    leaderboard,
    computedAt: to.toISOString(),
    // More of the org's pipelines exist beyond this page: request the next
    // one with `offset = nextOffset`. The stats above cover THIS page only.
    truncated: hasMore,
    pagination: {
      offset,
      limit,
      ...(typeof listed.total === 'number' && { total: listed.total }),
      hasMore,
      nextOffset: hasMore ? offset + pipelines.length : null,
    },
    // Surfaced so the page can say "3 pipelines couldn't be scored" rather
    // than quietly averaging over a partial set.
    failed,
  };
}

/**
 * Per-pipeline maturity scorecard: blends compliance posture (dry-run against the
 * org's rules) with per-pipeline DORA bands and the security signal into a
 * graded 0–100 score. DORA is computed in-process (reportingService); compliance
 * is an S2S dry-run against the compliance service (fail-soft). Gated on
 * `advanced_reporting`, the same feature that gates DORA itself.
 */
export function createScorecardRoutes(): Router {
  const router: Router = Router();

  // Mounted behind the shared auth chain and under the '/pipelines' apiCalls
  // meter + check (see app-routes.ts), so this heavy endpoint (compliance dry-run + DORA scan) is
  // metered like other reads rather than being a free cost-amplification path.
  router.get('/:id/scorecard', requirePermission('pipelines:read'), requireFeature('advanced_reporting'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // pipelineService.findById applies the READ access clause (own org, plus
    // public rows incl. the system samples). No parentOrgId is passed, so a
    // team's parent-org public pipelines are not scored here.
    const pipeline = await pipelineService.findById(id, orgId);
    if (!pipeline) return sendEntityNotFound(res, 'Pipeline');

    const to = new Date();
    const from = new Date(to.getTime() - SCORECARD_WINDOW_MS);

    // Thread the org's incident→deploy correlation-window override into the DORA
    // compute so the scorecard's CFR/MTTR (post-deploy correlation) match what the
    // `/dora` report shows for the same org (both then key the same cache entry).
    const { incidentWindowHours } = await reportingService.getReportingSettings(orgId);

    const warn = (msg: string, meta?: Record<string, unknown>) => ctx.log('WARN', msg, meta);
    const security = (await securitySignals(orgId, [id], warn)).get(id);
    const scorecard = await computeScorecard(pipeline as ScorablePipeline, orgId, from, to, incidentWindowHours, warn, security);
    ctx.log('COMPLETED', 'Computed pipeline scorecard', { id, score: scorecard.score, grade: scorecard.grade });
    return sendSuccess(res, 200, { scorecard });
  }));

  // Org-wide maturity roll-up: a "software health" leaderboard grading every
  // pipeline in the org, plus aggregate stats. Turns the per-pipeline widget into
  // a platform-team view. Bounded (ORG_SCORECARD_MAX pipelines, ORG_SCORECARD_CONCURRENCY
  // parallelism) so it can't become a cost-amplification path; metered like other
  // reads. `/scorecard` doesn't collide with the two-segment `/:id/scorecard`
  // above, but it DOES match the read router's single-segment `GET /:id` — so
  // app-routes.ts must mount this router BEFORE the read router (else the roll-up
  // is looked up as a pipeline with id "scorecard" and 404s).
  router.get('/scorecard', requirePermission('pipelines:read'), requireFeature('advanced_reporting'), withRoute(async ({ req, res, ctx, orgId }) => {
    const query = RollupQuerySchema.safeParse(req.query ?? {});
    if (!query.success) {
      return sendBadRequest(res, query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), ErrorCode.VALIDATION_ERROR);
    }
    const { offset, limit, project, pipelineName } = query.data;

    // The page a viewer sees depends on the rungs they can read (a private
    // pipeline is its author's), so the viewer is part of the key.
    const cacheKey = `${orgId}:v:${viewerCacheSegment()}:o:${offset}:l:${limit}:p:${project ?? ''}:n:${pipelineName ?? ''}`;
    const rollup = await rollupCache.getOrSet(cacheKey, () => computeRollup(orgId, query.data, ctx.log.bind(ctx)));
    return sendSuccess(res, 200, { rollup });
  }));

  return router;
}
