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
  clampRetentionDays,
  parseDateRange,
  parseReportTimezone,
  parseWeekStart,
  RETENTION_MAX_DAYS,
  RETENTION_UNLIMITED,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService, viewerCacheSegment } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';
import {
  averageScore,
  buildScorecard,
  gradeForScore,
  NO_SECURITY_SIGNAL,
  SCORECARD_HISTORY_INTERVALS,
  SCORECARD_HISTORY_MAX_PERIODS,
  scorecardWindows,
  unavailableScorecard,
  type Scorecard,
  type ScorecardComplianceInput,
  type ScorecardGrade,
  type ScorecardSecurityInput,
  type ScorecardWindow,
} from '../helpers/scorecard.js';
import { securitySignals } from '../helpers/security-signal.js';
import { pipelineService } from '../services/pipeline-service.js';

const complianceClient = createComplianceClient();

const DAY_MS = 24 * 60 * 60 * 1000;
/** Default scoring window: DORA over the trailing 30 days (when no `?from&to`). */
const SCORECARD_DEFAULT_DAYS = 30;

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
type RollupQuery = z.infer<typeof RollupQuerySchema>;

/** Grade-history query: N (capped) weekly or monthly windows, bucketed in `tz`. */
const HistoryQuerySchema = z.object({
  interval: z.enum(SCORECARD_HISTORY_INTERVALS).default('week'),
  periods: z.coerce.number().int().min(1).max(SCORECARD_HISTORY_MAX_PERIODS).default(SCORECARD_HISTORY_MAX_PERIODS),
});

/** The zod issues as one 400 message. */
const issuesOf = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

/** The reporting-settings fields the scorecard reads (incident window + DORA retention). */
type ScorecardSettings = Awaited<ReturnType<typeof reportingService.getReportingSettings>>;

/**
 * The org whose DORA retention governs the request: the account ROOT (billing
 * syncs retention onto the root only), unless a sysadmin is acting on another
 * org. Mirrors reporting's `retentionOrgIdFor`, so the scorecard and `/dora`
 * floor the same window.
 */
function retentionOrgIdFor(
  req: { user?: { isSuperAdmin?: boolean; organizationId?: string; rootOrganizationId?: string } },
  orgId: string,
): string {
  const user = req.user;
  if (!user || user.isSuperAdmin === true || user.organizationId !== orgId) return orgId;
  return user.rootOrganizationId ?? orgId;
}

/**
 * The org's DORA retention window: the widest `[from,to]` (ms) and the earliest
 * `from` (epoch ms, 0 = unlimited). The same arithmetic as reporting's
 * `orgRetentionWindowFromSettings(settings, 'dora')`.
 */
function doraRetentionWindow(s: ScorecardSettings, now: number): { maxRangeMs: number; minFromMs: number } {
  const eff = s.doraRetentionDays ?? s.defaultDoraRetentionDays;
  const days = eff === RETENTION_UNLIMITED ? RETENTION_MAX_DAYS : clampRetentionDays(eff);
  return { maxRangeMs: days * DAY_MS, minFromMs: eff === RETENTION_UNLIMITED ? 0 : Math.max(0, now - eff * DAY_MS) };
}

/** A resolved scoring window, or the 400 to send. */
type ScoringWindow = { from: Date; to: Date; explicit: boolean };

/**
 * `?from&to` (optional; default the trailing 30 days, exactly as before) capped
 * at the org's DORA retention width and floored at its horizon, plus a validated
 * `?tz` (the scorecard is one aggregate over the window, so tz only matters to
 * the grade history's window boundaries; it is validated here for parity).
 */
function parseScoringWindow(query: Record<string, unknown>, settings: ScorecardSettings, now = Date.now()): ScoringWindow | { error: string } {
  const tz = parseReportTimezone(query);
  if (typeof tz !== 'string') return tz;
  const explicit = query.from !== undefined || query.to !== undefined;
  if (!explicit) {
    const to = new Date(now);
    return { from: new Date(now - SCORECARD_DEFAULT_DAYS * DAY_MS), to, explicit };
  }
  const win = doraRetentionWindow(settings, now);
  const parsed = parseDateRange(query, { maxRangeMs: win.maxRangeMs, defaultDaysBack: SCORECARD_DEFAULT_DAYS });
  if ('error' in parsed) return parsed;
  // Floor `from` at the retention horizon (never past `to`), as `/dora` does.
  const toMs = Date.parse(parsed.to);
  const requestedFromMs = Date.parse(parsed.from);
  const fromMs = win.minFromMs > 0 ? Math.min(Math.max(requestedFromMs, win.minFromMs), toMs) : requestedFromMs;
  return { from: new Date(fromMs), to: new Date(toMs), explicit };
}

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
  const dora = await doraFor(pipeline.id, orgId, from, to, incidentWindowHours);
  const compliance = await complianceFor(pipeline, orgId, warn);
  return buildScorecard(pipeline.id, dora, compliance, to.toISOString(), security);
}

/** Per-pipeline DORA over `[from,to]`, with the org's incident-window override. */
function doraFor(pipelineId: string, orgId: string, from: Date, to: Date, incidentWindowHours: number | null | undefined) {
  return reportingService.getDoraMetrics(orgId, from.toISOString(), to.toISOString(), [orgId], {
    pipelineId,
    incidentWindowHours: incidentWindowHours ?? undefined,
  });
}

/**
 * Compliance posture — dry-run against the org's CURRENT rules. Fail-soft: if
 * compliance is unavailable, score on DORA alone (rulesEvaluated stays 0). Not
 * windowed (a dry-run grades today's config), so a grade history runs it once.
 */
async function complianceFor(
  pipeline: ScorablePipeline,
  orgId: string,
  warn: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<ScorecardComplianceInput> {
  const id = pipeline.id;
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
  return compliance;
}

/** One point of a grade history. */
interface HistoryPoint extends ScorecardWindow {
  score: number | null;
  grade: ScorecardGrade;
  /** The window's DORA compute failed — a gap, never an F. */
  unavailable?: boolean;
}

/**
 * Score one pipeline over each window with the SAME function the scorecard uses
 * (buildScorecard), compliance + security read once — they are current-state
 * signals, identical for every window and for a `?from&to` scorecard. A window
 * whose DORA scan fails is an `unavailable` point, not a failed history.
 */
async function scoreWindows(
  pipeline: ScorablePipeline,
  orgId: string,
  windows: ScorecardWindow[],
  incidentWindowHours: number | null | undefined,
  compliance: ScorecardComplianceInput,
  security: ScorecardSecurityInput,
  log: RollupLog,
): Promise<HistoryPoint[]> {
  return runConcurrent(windows, ORG_SCORECARD_CONCURRENCY, async (w) => {
    try {
      const dora = await doraFor(pipeline.id, orgId, new Date(w.from), new Date(w.to), incidentWindowHours);
      const card = buildScorecard(pipeline.id, dora, compliance, w.to, security);
      return { ...w, score: card.score, grade: card.grade };
    } catch (err) {
      log('WARN', 'Scorecard history window failed; leaving a gap', { pipelineId: pipeline.id, window: w.label, error: errorMessage(err) });
      return { ...w, score: null, grade: 'N/A' as const, unavailable: true };
    }
  });
}

/** Parse the history query (interval/periods + tz/weekStart), or `{ error }`. */
function parseHistoryQuery(query: Record<string, unknown>) {
  const parsed = HistoryQuerySchema.safeParse(query);
  if (!parsed.success) return { error: issuesOf(parsed.error) };
  const tz = parseReportTimezone(query);
  if (typeof tz !== 'string') return tz;
  const weekStart = parseWeekStart(query);
  if (typeof weekStart !== 'string') return weekStart;
  return { ...parsed.data, tz, weekStart };
}
type HistoryQuery = Exclude<ReturnType<typeof parseHistoryQuery>, { error: string }>;

/** Log sink a roll-up compute writes through (the request's `ctx.log`). */
type RollupLog = (level: 'WARN' | 'COMPLETED', msg: string, meta?: Record<string, unknown>) => void;

/**
 * Compute one roll-up page: grade a page of the org's OWN pipelines and
 * aggregate them. Callers cache the result (see {@link rollupCache}).
 */
async function listRollupPage(orgId: string, query: RollupQuery) {
  const { offset, limit, project, pipelineName } = query;
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
  return {
    pipelines,
    hasMore,
    pagination: {
      offset,
      limit,
      ...(typeof listed.total === 'number' && { total: listed.total }),
      hasMore,
      nextOffset: hasMore ? offset + pipelines.length : null,
    },
  };
}

async function computeRollup(
  orgId: string,
  query: RollupQuery,
  log: RollupLog,
  window: { from: Date; to: Date },
  incidentWindowHours: number | null | undefined,
) {
  const { offset } = query;
  const { from, to } = window;
  const { pipelines, hasMore, pagination } = await listRollupPage(orgId, query);

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
  const average = averageScore(scored.map((s) => s.score));
  const gradeDistribution: Record<string, number> = {};
  for (const s of scored) gradeDistribution[s.grade] = (gradeDistribution[s.grade] ?? 0) + 1;

  log('COMPLETED', 'Computed org-wide scorecard roll-up', {
    pipelineCount: scored.length, averageScore: average, offset, hasMore, failed,
  });
  return {
    orgId,
    pipelineCount: scored.length,
    scored: withScores.length,
    averageScore: average,
    gradeDistribution,
    leaderboard,
    computedAt: to.toISOString(),
    // More of the org's pipelines exist beyond this page: request the next
    // one with `offset = nextOffset`. The stats above cover THIS page only.
    truncated: hasMore,
    pagination,
    // Surfaced so the page can say "3 pipelines couldn't be scored" rather
    // than quietly averaging over a partial set.
    failed,
  };
}

/**
 * Org grade history: the roll-up page's pipelines scored over each window, and
 * each window's org average — the same `averageScore` the roll-up reports for
 * that `?from&to`, so the strip and the leaderboard agree. Compliance + security
 * are read once per pipeline (current state); DORA once per (pipeline, window).
 * Cost: up to limit × periods DORA scans, run ORG_SCORECARD_CONCURRENCY at a
 * time and cached like the roll-up.
 */
async function computeOrgHistory(
  orgId: string,
  query: RollupQuery,
  history: HistoryQuery,
  windows: ScorecardWindow[],
  incidentWindowHours: number | null | undefined,
  log: RollupLog,
) {
  const { pipelines, pagination } = await listRollupPage(orgId, query);
  const warn = (msg: string, meta?: Record<string, unknown>) => log('WARN', msg, meta);
  const security = await securitySignals(orgId, pipelines.map((p) => p.id), warn);
  const compliance = await runConcurrent(pipelines, ORG_SCORECARD_CONCURRENCY, (p) => complianceFor(p, orgId, warn));
  // Pipelines run one at a time here; each pipeline's windows run
  // ORG_SCORECARD_CONCURRENCY wide inside scoreWindows — the same bound.
  const rows: Array<{ pipelineId: string; name?: string; points: HistoryPoint[] }> = [];
  for (const [i, p] of pipelines.entries()) {
    const points = await scoreWindows(p, orgId, windows, incidentWindowHours, compliance[i], security.get(p.id) ?? NO_SECURITY_SIGNAL, log);
    rows.push({ pipelineId: p.id, name: p.name, points });
  }
  const summary = windows.map((w, i) => {
    const avg = averageScore(rows.map((r) => r.points[i].score));
    return { ...w, averageScore: avg, grade: gradeForScore(avg), scored: rows.filter((r) => r.points[i].score !== null).length };
  });
  log('COMPLETED', 'Computed org-wide scorecard history', { pipelineCount: rows.length, windows: windows.length });
  return {
    orgId,
    interval: history.interval,
    tz: history.tz,
    weekStart: history.weekStart,
    windows: summary,
    pipelines: rows,
    pagination,
    computedAt: new Date().toISOString(),
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
  //
  // PERMISSION: `pipelines:read`, not `reports:read`. The card is a section of
  // the pipeline detail page, and a role holding `pipelines:read` without
  // `reports:read` (the Release Manager template, the pipeline-automation
  // bundle) sees that page — moving the card to `reports:read` would lock them
  // out of what they see today. The ORG leaderboard below is reporting data and
  // is on `reports:read`.
  //
  // `?from&to` (optional, default the trailing 30 days) are capped at the org's
  // DORA retention width and floored at its horizon; `?tz` is validated.
  router.get('/:id/scorecard', requirePermission('pipelines:read'), requireFeature('advanced_reporting'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // pipelineService.findById applies the READ access clause (own org, plus
    // public rows incl. the system samples). No parentOrgId is passed, so a
    // team's parent-org public pipelines are not scored here.
    const pipeline = await pipelineService.findById(id, orgId);
    if (!pipeline) return sendEntityNotFound(res, 'Pipeline');

    // Thread the org's incident→deploy correlation-window override into the DORA
    // compute so the scorecard's CFR/MTTR (post-deploy correlation) match what the
    // `/dora` report shows for the same org (both then key the same cache entry).
    // The same row carries the DORA retention the range is capped/floored to.
    const settings = await reportingService.getReportingSettings(orgId, retentionOrgIdFor(req, orgId));
    const { incidentWindowHours } = settings;
    const window = parseScoringWindow((req.query ?? {}) as Record<string, unknown>, settings);
    if ('error' in window) return sendBadRequest(res, window.error, ErrorCode.VALIDATION_ERROR);
    const { from, to } = window;

    const warn = (msg: string, meta?: Record<string, unknown>) => ctx.log('WARN', msg, meta);
    // Keyed by the ROW's id, not the path segment: findById matches a
    // mixed-case UUID, but exposure and security-report pipeline ids are stored
    // lower-case and compared exactly — the raw segment would score it clean.
    const security = (await securitySignals(orgId, [pipeline.id], warn)).get(pipeline.id);
    const scorecard = await computeScorecard(pipeline as ScorablePipeline, orgId, from, to, incidentWindowHours, warn, security);
    ctx.log('COMPLETED', 'Computed pipeline scorecard', { id, score: scorecard.score, grade: scorecard.grade });
    return sendSuccess(res, 200, { scorecard });
  }));

  // Per-pipeline grade history: score + grade for each of the last `?periods`
  // (1..12, default 12) `?interval=week|month` windows in `?tz` / `?weekStart`,
  // computed on the fly with the scorecard's own scoring over each window (no
  // stored history). Same gates as the card it decorates.
  router.get('/:id/scorecard/history', requirePermission('pipelines:read'), requireFeature('advanced_reporting'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Pipeline ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    const history = parseHistoryQuery((req.query ?? {}) as Record<string, unknown>);
    if ('error' in history) return sendBadRequest(res, history.error, ErrorCode.VALIDATION_ERROR);

    const pipeline = await pipelineService.findById(id, orgId);
    if (!pipeline) return sendEntityNotFound(res, 'Pipeline');

    const settings = await reportingService.getReportingSettings(orgId, retentionOrgIdFor(req, orgId));
    const now = new Date();
    const windows = scorecardWindows(now, history.interval, history.periods, {
      tz: history.tz, weekStart: history.weekStart, minFromMs: doraRetentionWindow(settings, now.getTime()).minFromMs,
    });
    const warn = (msg: string, meta?: Record<string, unknown>) => ctx.log('WARN', msg, meta);
    const row = pipeline as ScorablePipeline;
    const security = (await securitySignals(orgId, [row.id], warn)).get(row.id) ?? NO_SECURITY_SIGNAL;
    const compliance = await complianceFor(row, orgId, warn);
    const points = await scoreWindows(row, orgId, windows, settings.incidentWindowHours, compliance, security, ctx.log.bind(ctx));
    ctx.log('COMPLETED', 'Computed pipeline scorecard history', { id, windows: points.length });
    return sendSuccess(res, 200, {
      history: {
        pipelineId: row.id,
        interval: history.interval,
        tz: history.tz,
        weekStart: history.weekStart,
        points,
        computedAt: now.toISOString(),
      },
    });
  }));

  // Org-wide maturity roll-up: a "software health" leaderboard grading every
  // pipeline in the org, plus aggregate stats. Turns the per-pipeline widget into
  // a platform-team view. Bounded (ORG_SCORECARD_MAX pipelines, ORG_SCORECARD_CONCURRENCY
  // parallelism) so it can't become a cost-amplification path; metered like other
  // reads. `/scorecard` doesn't collide with the two-segment `/:id/scorecard`
  // above, but it DOES match the read router's single-segment `GET /:id` — so
  // app-routes.ts must mount this router BEFORE the read router (else the roll-up
  // is looked up as a pipeline with id "scorecard" and 404s).
  //
  // PERMISSION: `reports:read` (+ `advanced_reporting`) — an org-wide grade
  // table is reporting data, the same pairing as `/reports/execution/dora`.
  // `?from&to&tz` as on the per-pipeline card.
  router.get('/scorecard', requirePermission('reports:read'), requireFeature('advanced_reporting'), withRoute(async ({ req, res, ctx, orgId }) => {
    const query = RollupQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return sendBadRequest(res, issuesOf(query.error), ErrorCode.VALIDATION_ERROR);
    const { offset, limit, project, pipelineName } = query.data;

    const settings = await reportingService.getReportingSettings(orgId, retentionOrgIdFor(req, orgId));
    const window = parseScoringWindow((req.query ?? {}) as Record<string, unknown>, settings);
    if ('error' in window) return sendBadRequest(res, window.error, ErrorCode.VALIDATION_ERROR);

    // The page a viewer sees depends on the rungs they can read (a private
    // pipeline is its author's), so the viewer is part of the key. An explicit
    // window is too; the default (trailing 30 days) keeps the original key.
    const range = window.explicit ? `:r:${window.from.toISOString()}:${window.to.toISOString()}` : '';
    const cacheKey = `${orgId}:v:${viewerCacheSegment()}:o:${offset}:l:${limit}:p:${project ?? ''}:n:${pipelineName ?? ''}${range}`;
    const rollup = await rollupCache.getOrSet(cacheKey, () => computeRollup(orgId, query.data, ctx.log.bind(ctx), window, settings.incidentWindowHours));
    return sendSuccess(res, 200, { rollup });
  }));

  // Org-wide grade history: the roll-up page's per-pipeline history plus each
  // window's org average and grade. `reports:read` like the leaderboard it
  // decorates (it carries every row's points, so the leaderboard needs no
  // per-pipeline call). Paged/narrowed like `/scorecard`, plus the history
  // query. Cached per viewer + query like the roll-up.
  router.get('/scorecard/history', requirePermission('reports:read'), requireFeature('advanced_reporting'), withRoute(async ({ req, res, ctx, orgId }) => {
    const rawQuery = (req.query ?? {}) as Record<string, unknown>;
    const query = RollupQuerySchema.safeParse(rawQuery);
    if (!query.success) return sendBadRequest(res, issuesOf(query.error), ErrorCode.VALIDATION_ERROR);
    const history = parseHistoryQuery(rawQuery);
    if ('error' in history) return sendBadRequest(res, history.error, ErrorCode.VALIDATION_ERROR);
    const { offset, limit, project, pipelineName } = query.data;

    const settings = await reportingService.getReportingSettings(orgId, retentionOrgIdFor(req, orgId));
    const now = new Date();
    const windows = scorecardWindows(now, history.interval, history.periods, {
      tz: history.tz, weekStart: history.weekStart, minFromMs: doraRetentionWindow(settings, now.getTime()).minFromMs,
    });
    const cacheKey = `${orgId}:v:${viewerCacheSegment()}:o:${offset}:l:${limit}:p:${project ?? ''}:n:${pipelineName ?? ''}`
      + `:h:${history.interval}:${history.periods}:${history.tz}:${history.weekStart}`;
    const result = await rollupCache.getOrSet(cacheKey, () => computeOrgHistory(
      orgId, query.data, history, windows, settings.incidentWindowHours, ctx.log.bind(ctx),
    ));
    return sendSuccess(res, 200, { history: result });
  }));

  return router;
}
