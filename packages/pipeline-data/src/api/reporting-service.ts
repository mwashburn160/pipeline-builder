// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService, createLogger, errorMessage, REPORT_INTERVALS, scrubAwsIdentifiers, scrubAwsIdentifiersFromString } from '@pipeline-builder/api-core';
import { inArray, sql } from 'drizzle-orm';
import { drizzleRows } from './crud-service.js';
import { schema } from '../database/drizzle-schema.js';
import { withTenantTx, runWithTenantContext } from '../database/tenancy.js';

const logger = createLogger('reporting-service');

/**
 * Defense-in-depth guard for the `DATE_TRUNC(${interval}, …)` bucket argument.
 * The route layer (`parseReportInterval`) is the security boundary and already
 * rejects unknown intervals; this assert makes an invalid value fail fast at the
 * service boundary with a clear error instead of surfacing a raw Postgres error
 * if a caller ever bypasses the route validation. Shares api-core's
 * REPORT_INTERVALS allow-list so the two can't drift.
 */
function assertReportInterval(interval: string): void {
  if (!(REPORT_INTERVALS as readonly string[]).includes(interval)) {
    throw new Error(`Invalid report interval: ${interval}. Expected one of: ${REPORT_INTERVALS.join(', ')}`);
  }
}

/**
 * Scrub AWS identifiers from an optional free-form string, preserving `undefined`
 * (so an absent field stays absent rather than becoming an empty scrubbed string).
 * The DURABLE persistence boundary for the ingest paths — every user/AWS-derived
 * string field is funneled through this before insert.
 */
function scrubOptional(value: string | undefined): string | undefined {
  return value !== undefined ? scrubAwsIdentifiersFromString(value) : undefined;
}

/**
 * Cache for reporting aggregations. Two tiers:
 * - Inventory queries (plugin summary/distribution/versions): 5 min TTL — changes on plugin CRUD
 * - Execution/build queries with date ranges: 2 min TTL — new events arrive continuously
 */
const inventoryCache = createCacheService('report:inv:', parseInt(process.env.CACHE_TTL_REPORT_INVENTORY || '300', 10));
const timeseriesCache = createCacheService('report:ts:', parseInt(process.env.CACHE_TTL_REPORT_TIMESERIES || '120', 10));

// ─── Types ──────────────────────────────────────────────

interface ExecutionCount {
  id: string;
  project: string;
  organization: string;
  pipelineName: string | null;
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  firstExecution: string | null;
  lastExecution: string | null;
}

interface TimeSeriesEntry {
  period: string;
  succeeded: number;
  failed: number;
  canceled: number;
  successPct: number;
}

interface DurationStats {
  id: string;
  project: string;
  pipelineName: string | null;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  executions: number;
}

interface PipelineExecution {
  executionId: string;
  /** Rolled-up terminal status: succeeded | failed | canceled | in-progress. */
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** First failing stage/action for the execution (null when it didn't fail). */
  failingStage: string | null;
  failingAction: string | null;
}

interface StageFailure {
  stageName: string;
  failures: number;
  total: number;
  failurePct: number;
}

interface StageBottleneck {
  id: string;
  pipelineName: string | null;
  stageName: string;
  avgMs: number;
  maxMs: number;
}

interface ActionFailure {
  actionName: string;
  failures: number;
  total: number;
  failurePct: number;
}

interface ErrorEntry {
  errorPattern: string;
  occurrences: number;
  affectedPipelines: number;
  lastSeen: string;
}

interface PluginSummary {
  total: number;
  active: number;
  inactive: number;
  public: number;
  private: number;
  uniqueNames: number;
}

interface TypeComputeDistribution {
  pluginType: string;
  computeType: string;
  count: number;
}

interface VersionCount {
  name: string;
  versionCount: number;
  latestVersion: string;
  hasDefault: boolean;
}

interface BuildTimeSeriesEntry {
  period: string;
  succeeded: number;
  failed: number;
  successPct: number;
}

interface BuildDuration {
  pluginName: string;
  avgMs: number;
  maxMs: number;
  builds: number;
}

interface BuildFailure {
  pluginName: string;
  errorMessage: string;
  occurrences: number;
  lastSeen: string;
}

/**
 * The DORA headline environment. Deployment to this literal env name is the
 * industry-standard DORA signal; MTTR is measured production-only, and this
 * environment's card is the summary shown at the top of the panel.
 */
const HEADLINE_ENV = 'production';

/**
 * Incident→deploy correlation window (Phase 5). An incident is attributed to the
 * most recent SUCCESSFUL deploy to its environment whose `completed_at` is within
 * this many hours before the incident's `opened_at`. Default 24h; override via
 * `DORA_INCIDENT_WINDOW_HOURS`. Guarded to a positive finite number.
 */
const DORA_INCIDENT_WINDOW_HOURS = (() => {
  const raw = Number(process.env.DORA_INCIDENT_WINDOW_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
})();

/**
 * Resolve the effective incident→deploy correlation window (Phase 5b). A per-org
 * override (from `dora_settings.incident_window_hours`, surfaced through the
 * settings endpoint and threaded into {@link DoraOptions.incidentWindowHours})
 * wins when it is a positive finite number; otherwise the global env default
 * `DORA_INCIDENT_WINDOW_HOURS` applies. Centralized so the DORA correlation, the
 * incidents list, and the wiring-test dry-run all agree on the same rule.
 */
function resolveIncidentWindowHours(override?: number | null): number {
  return override != null && Number.isFinite(override) && override > 0 ? override : DORA_INCIDENT_WINDOW_HOURS;
}

/**
 * Reporting retention windows (Phase 7). Records in `pipeline_events`,
 * `deployment_outcomes`, and `incidents` grow unbounded without a sweep, so a
 * split, per-org retention purge (see {@link ReportingService.purgeExpiredReportingData})
 * hard-deletes rows older than these windows, by `created_at`:
 *  - **Standard events** — `pipeline_events` with `environment IS NULL`
 *    (non-deploy STAGE/ACTION/build). High volume → short default (30 days).
 *  - **DORA source** — `pipeline_events` with `environment IS NOT NULL` (deploy
 *    stages) plus all of `deployment_outcomes` and `incidents`. Low volume →
 *    longer default (180 days). DORA history is therefore bounded by this window;
 *    the report query still hard-caps at 365 days (a longer per-org override only
 *    retains raw source rows, never widens a report).
 * `ingest_health` and `dora_settings` are never purged. Env-overridable globals;
 * a per-org override in `dora_settings` wins (see {@link resolveEventRetentionDays}).
 */
const RETENTION_MIN_DAYS = 1;
const RETENTION_MAX_DAYS = 730;

/** Parse a positive-int env day-count, clamped to [MIN, MAX], else `fallback`. */
function retentionEnvDays(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < RETENTION_MIN_DAYS) return fallback;
  return Math.min(raw, RETENTION_MAX_DAYS);
}

const REPORTING_EVENT_RETENTION_DAYS = retentionEnvDays('REPORTING_EVENT_RETENTION_DAYS', 30);
const REPORTING_DORA_RETENTION_DAYS = retentionEnvDays('REPORTING_DORA_RETENTION_DAYS', 180);

/** Effective standard-event retention (days): a valid per-org override wins,
 *  else the global env default. Shared by the sweep + the settings surface so
 *  they can't drift. The `-1` unlimited sentinel (Phase 8) passes straight
 *  through — the sweep reads it as "keep forever, skip this org's standard
 *  events". A positive override clamps to [1, RETENTION_MAX_DAYS]; a `null`, a
 *  non-integer, or any other out-of-range value (e.g. 0, -2) falls back to the
 *  env default. */
export function resolveEventRetentionDays(override?: number | null): number {
  if (override === -1) return -1;
  return override != null && Number.isInteger(override) && override >= RETENTION_MIN_DAYS
    ? Math.min(override, RETENTION_MAX_DAYS) : REPORTING_EVENT_RETENTION_DAYS;
}

/** Effective DORA-source retention (days): a valid per-org override wins, else
 *  the global env default. The `-1` unlimited sentinel (Phase 8) passes straight
 *  through — the sweep reads it as "keep forever, skip this org's DORA-source
 *  windows". A positive override clamps to [1, RETENTION_MAX_DAYS]; a `null`, a
 *  non-integer, or any other out-of-range value (e.g. 0, -2) falls back to the
 *  env default. */
export function resolveDoraRetentionDays(override?: number | null): number {
  if (override === -1) return -1;
  return override != null && Number.isInteger(override) && override >= RETENTION_MIN_DAYS
    ? Math.min(override, RETENTION_MAX_DAYS) : REPORTING_DORA_RETENTION_DAYS;
}

/** The cutoff instant for a retention window: rows with `created_at` strictly
 *  before this (`< cutoff`) are expired. Deterministic for a fixed `now`. */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** Per-org retention override row (Phase 7). Both nullable ⇒ global defaults. */
export interface ReportingRetentionSettings {
  eventRetentionDays: number | null;
  doraRetentionDays: number | null;
  defaultEventRetentionDays: number;
  defaultDoraRetentionDays: number;
}

/** Options for the reporting retention sweep. */
export interface ReportingRetentionOptions {
  /** Rows deleted per statement (default 1000). */
  batchSize?: number;
  /** Max batches per table per org per tick (default 50); the rest defers to
   *  the next tick so a huge backlog can't hold locks too long. */
  maxBatchesPerTable?: number;
  /** Fixed "now" for the whole sweep (default `new Date()`). */
  now?: Date;
}

/** Per-run purge tallies (also logged). */
export interface ReportingRetentionCounts {
  /** Orgs swept this run. */
  orgs: number;
  /** Standard `pipeline_events` (environment IS NULL) rows purged. */
  standardEvents: number;
  /** DORA-source `pipeline_events` (environment IS NOT NULL) rows purged. */
  doraEvents: number;
  /** `deployment_outcomes` rows purged. */
  deploymentOutcomes: number;
  /** `incidents` rows purged. */
  incidents: number;
}

/**
 * DORA performance band. `null` = insufficient data to classify (no
 * deployments/failures/lead-time sample in the window), so the UI shows a
 * neutral state rather than mislabeling an empty window as "low".
 */
export type DoraLevel = 'elite' | 'high' | 'medium' | 'low' | null;

/** Optional scoping for {@link ReportingService.getDoraMetrics}. */
export interface DoraOptions {
  /** Restrict to a single pipeline (per-pipeline DORA). */
  pipelineId?: string;
  /** Restrict to a single deploy environment (else all deploy environments). */
  environment?: string;
  /**
   * Per-org incident→deploy correlation window override (hours). When set (a
   * positive finite number), the incident correlation uses it instead of the
   * global `DORA_INCIDENT_WINDOW_HOURS`. The route resolves this from the org's
   * `dora_settings` row (see {@link ReportingService.getIncidentSettings}) and
   * passes it in; unset falls back to the env default.
   */
  incidentWindowHours?: number;
}

/**
 * Per-org reporting settings surfaced to the org-admin panel. `incidentWindowHours`
 * (Phase 5b) is the incident→deploy correlation window; `eventRetentionDays` /
 * `doraRetentionDays` (Phase 7) are the two retention-sweep windows. Each override
 * is `null` when unset (the paired `default*` field shows the env fallback applied).
 */
export interface IncidentSettings {
  /** The org's stored correlation-window override in hours, or `null` when unset. */
  incidentWindowHours: number | null;
  /** The global env default applied when no override is stored. */
  defaultWindowHours: number;
  /** Standard-event retention override in days, or `null` when unset (Phase 7). */
  eventRetentionDays: number | null;
  /** DORA-source retention override in days, or `null` when unset (Phase 7). */
  doraRetentionDays: number | null;
  /** Global standard-event retention default applied when unset (days). */
  defaultEventRetentionDays: number;
  /** Global DORA-source retention default applied when unset (days). */
  defaultDoraRetentionDays: number;
}

/** A partial reporting-settings write (Phase 5b + 7). Only provided fields are
 *  upserted; omitted fields are left unchanged (an omitted retention field keeps
 *  its stored override / the global default). */
export interface ReportingSettingsPatch {
  incidentWindowHours?: number;
  eventRetentionDays?: number;
  doraRetentionDays?: number;
}

/** One row of the org-admin incidents list (recent incidents + deploy correlation). */
export interface IncidentListItem {
  incidentId: string;
  environment: string;
  severity: string;
  openedAt: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  /** True once the incident has a `resolved_at`. */
  resolved: boolean;
  /** The correlated deploy execution id (most recent successful deploy in-window), or null. */
  correlatedExecutionId: string | null;
  /** That deploy's completion instant, or null when uncorrelated. */
  deployCompletedAt: string | null;
}

/** Result of the wiring-test dry-run correlation ({@link ReportingService.testIncidentCorrelation}). */
export interface IncidentTestResult {
  environment: string;
  /** The synthetic incident's openedAt (now, ISO). */
  openedAt: string;
  /** The effective correlation window used. */
  windowHours: number;
  /** Whether a recent successful deploy to `environment` correlated. */
  correlated: boolean;
  /** The correlated deploy execution id, or null. */
  executionId: string | null;
  /** That deploy's completion instant, or null. */
  deployCompletedAt: string | null;
}

// DORA performance bands (thresholds from the DORA/Accelerate reports). Each
// helper returns `null` when there's no sample to classify.
/** Deployment frequency by deploys/day: elite ≥1/day, high ≥1/week, medium ≥1/month. */
function doraLevelForFrequency(perDay: number, deployments: number): DoraLevel {
  if (deployments <= 0) return null;
  if (perDay >= 1) return 'elite';
  if (perDay >= 1 / 7) return 'high';
  if (perDay >= 1 / 30) return 'medium';
  return 'low';
}
/** Change failure rate by percent: elite ≤5%, high ≤10%, medium ≤15%. */
function doraLevelForChangeFailure(pct: number, total: number): DoraLevel {
  if (total <= 0) return null;
  if (pct <= 5) return 'elite';
  if (pct <= 10) return 'high';
  if (pct <= 15) return 'medium';
  return 'low';
}
/** Time to restore by seconds: elite <1h, high <1 day, medium <1 week. */
function doraLevelForRestore(avgSeconds: number | null): DoraLevel {
  if (avgSeconds == null) return null;
  if (avgSeconds < 3600) return 'elite';
  if (avgSeconds < 86400) return 'high';
  if (avgSeconds < 604800) return 'medium';
  return 'low';
}
/** Lead time by seconds: elite <1 day, high <1 week, medium <1 month. */
function doraLevelForLeadTime(medianSeconds: number | null): DoraLevel {
  if (medianSeconds == null) return null;
  if (medianSeconds < 86400) return 'elite';
  if (medianSeconds < 604800) return 'high';
  if (medianSeconds < 2592000) return 'medium';
  return 'low';
}

/**
 * Round `value` to `digits` decimal places, returning a real number. Small
 * module-private helper so the DORA shaping doesn't repeat the
 * `Number(Number(x).toFixed(n))` pattern (toFixed alone yields a string).
 */
function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/**
 * Median of a numeric sample, or `null` when empty. Used for measured lead time
 * and MTTR — both are cross-source gaps computed in JS from clamped deltas, so
 * the median lives here rather than in SQL PERCENTILE_CONT (keeps the golden
 * fixture tests able to prove the metric math without a live Postgres).
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Roll a group of deploy/stage events (grouped per execution) up to one terminal
 * status: FAILED wins, then SUCCEEDED, else OTHER (still-running / non-terminal).
 * Shared by the three per-(env|stage, execution) rollup CTEs — DORA metrics, DORA
 * trend, and build health — so the precedence can't drift between them. Assumes the
 * grouped event alias is `e`.
 */
const terminalStatusRollup = sql`CASE
              WHEN bool_or(e.status = 'FAILED') THEN 'FAILED'
              WHEN bool_or(e.status = 'SUCCEEDED') THEN 'SUCCEEDED'
              ELSE 'OTHER'
            END`;

/** Optional `[from,to]` window on `e.started_at` for the execution reports —
 *  a no-op `sql` fragment when either bound is absent (all-time). Shared by the
 *  execution-count and per-pipeline-execution reports so they narrow identically. */
function optionalStartedAtRange(range?: { from?: string; to?: string }): ReturnType<typeof sql> {
  return range?.from && range?.to
    ? sql`AND e.started_at >= ${range.from}::timestamptz AND e.started_at <= ${range.to}::timestamptz`
    : sql``;
}

/**
 * Per-execution terminal deploy row (D1 — one row per (environment, execution),
 * NOT per stage). The SQL rolls every deploy STAGE targeting an env within an
 * execution up to a single terminal status; the JS shaping buckets these by
 * environment. `commit_ts` (D2) is the execution's EARLIEST commit time across
 * all its events — commit enrichment rides the PIPELINE/source event, not the
 * deploy STAGE — joined by execution_id (null when unresolved → lead `unknown`).
 * `in_window` is false for a look-back-only row kept solely so incidents opened
 * near `from` can correlate to a deploy that completed just before the window.
 */
interface DeployRow {
  environment: string;
  status: 'SUCCEEDED' | 'FAILED' | string;
  /** Deploy execution id — the attribution key for dedup against outcomes/incidents. */
  execution_id: string | null;
  completed_at: string | null;
  commit_ts: string | null;
  /**
   * Whether the deploy completed inside [from,to]. Absent (undefined) in unit
   * fixtures ⇒ treated as in-window. `t`/`f` tolerated (pg boolean text form).
   */
  in_window?: boolean | string | null;
}

/** Raw post-deploy outcome marker row (from `deployment_outcomes`, in-window). */
interface OutcomeRow {
  environment: string | null;
  outcome: 'failed' | 'restored' | string;
  /** Execution the user marked — dedup key against incident-correlated deploys. */
  execution_id: string | null;
}

/** Production restored-incident pair: recovery time + the deploy's completion. */
interface MttrPairRow {
  restored_at: string | null;
  deployed_at: string | null;
  /** Execution id — lets incident precedence override the manual outcome per deploy. */
  execution_id: string | null;
}

/**
 * Raw incident row (from `incidents`, opened in-window). Correlated in JS to the
 * most recent successful deploy to `environment` within DORA_INCIDENT_WINDOW_HOURS
 * → an automated post-deploy failure (CFR) + real recovery time (MTTR).
 */
interface IncidentRow {
  environment: string;
  opened_at: string | null;
  resolved_at: string | null;
}

/** Coverage counts: registered pipelines vs those that actually deployed. */
interface CoverageRow {
  registered: number | string | null;
  deploying: number | string | null;
}

/**
 * DORA metrics over a [from,to] window, org-scoped (single-org or rollup subtree).
 *
 * DEPLOY-BASIS — every metric derives from real DEPLOY-STAGE executions, i.e.
 * `pipeline_events` rows with `event_type='STAGE'` and a non-null `environment`
 * (the forwarder sets `environment` only for the stages a user declared in
 * `pb.deploys`). A CI-only build/test pipeline with no deploy stage produces NO
 * DORA data — there is no run-based fallback. The panel is empty until deployed
 * pipelines re-synth with the new deploy tags and start emitting deploy events.
 *
 * `production` is the headline environment; MTTR is measured production-only.
 */
export interface DoraMetrics {
  /** The [from,to] window echoed back (deploy `completed_at` range). */
  window: { from: string; to: string };
  /** The scoping applied (echoed for the UI); `null` when unscoped. */
  filters: { pipelineId: string | null; environment: string | null };
  /** The headline environment name (`production`). */
  headline: string;
  /** Per-environment DF / CFR / lead time. Sorted headline-first, then A→Z. */
  environments: DoraEnvMetrics[];
  /**
   * Mean Time To Restore — PRODUCTION-ONLY, from `deployment_outcomes`.
   * `median(restored.at − deployed.completed_at)` over restored production
   * incidents (deltas clamped ≥0). `incidents` counts production deploys marked
   * failed; `restored` counts those that recovered; `medianSeconds` is null when
   * no restored incident has a resolvable deploy time.
   */
  meanTimeToRestore: {
    incidents: number;
    restored: number;
    medianSeconds: number | null;
    level: DoraLevel;
  };
  /**
   * Coverage reconciliation — registered pipelines with no observed deploy in
   * the window. A high `withoutDeploys` count means DORA is blind to most of the
   * fleet (pipelines that haven't re-synthed with deploy tags, or don't deploy).
   */
  coverage: {
    /** Pipelines in the registry (org-scoped). */
    registered: number;
    /** Registered pipelines with ≥1 deploy-stage execution in the window. */
    deploying: number;
    /** registered − deploying (clamped ≥0). */
    withoutDeploys: number;
  };
}

/** Per-environment DORA metrics (deployment frequency, CFR, lead time). */
export interface DoraEnvMetrics {
  environment: string;
  /** Deployment Frequency — successful deploy-stage executions for this env. */
  deploymentFrequency: {
    deployments: number;
    perDay: number;
    level: DoraLevel;
  };
  /**
   * Change Failure Rate — two-class:
   * `(deployTimeFailures + postDeployFailures) / attempts`.
   * - `deployTimeFailures` — deploy stage `result=failed` (from events).
   * - `postDeployFailures` — a successful deploy later marked failed in prod
   *   (from `deployment_outcomes`).
   * - `attempts` — all terminal deploy-stage attempts (succeeded + failed).
   */
  changeFailureRate: {
    rate: number;
    deployTimeFailures: number;
    postDeployFailures: number;
    attempts: number;
    level: DoraLevel;
  };
  /**
   * Lead Time — MEASURED: `median(deploy_completed − oldest_commit_time)` over
   * successful deploys with a resolvable commit timestamp (deltas clamped ≥0).
   * `medianSeconds` is `null` (= unknown) when no successful deploy in this env
   * carried a `commit_timestamp`. The old median-run-duration proxy is removed.
   */
  leadTime: {
    /** Successful deploys with a resolvable commit time (the median sample). */
    deployments: number;
    medianSeconds: number | null;
    level: DoraLevel;
  };
}

/** One interval bucket of the DORA trend (deploy frequency + change failure). */
export interface DoraTrendPoint {
  /** Bucket start (DATE_TRUNC of the deploy `completed_at`), ISO text. */
  period: string;
  /** Successful deploy-stage executions in the bucket. */
  deployments: number;
  /** Failed deploy-stage executions in the bucket. */
  failed: number;
  /** succeeded + failed in the bucket (deploy attempts). */
  total: number;
  /** failed/total as a percent (0 when total is 0). Deploy-time CFR only. */
  changeFailurePct: number;
}

/** Per-stage build-health metrics (Phase 6) for one pipeline over a window. */
export interface BuildHealthStage {
  stage: string;
  /** Terminal stage runs (succeeded + failed) in the window. */
  runs: number;
  successes: number;
  failures: number;
  /** successes / runs as a percent (0 when runs is 0). */
  successRate: number;
  /** Duration percentiles over the stage's terminal runs; null when no durations. */
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
}

/**
 * Per-pipeline build-health breakdown (Phase 6). Standard reporting (NOT
 * `advanced_reporting`-gated) — per-stage success rate + timing percentiles, with
 * totals summed across stages.
 */
export interface BuildHealth {
  stages: BuildHealthStage[];
  totals: { runs: number; failures: number; failureRate: number };
}

/** Post-deploy incident marker (Phase 5) accepted by `ReportingService.recordIncident`. */
export interface IncidentInput {
  incidentId: string;
  environment: string;
  openedAt: string;
  resolvedAt?: string;
  severity: string;
}

/** Event payload accepted by `ReportingService.ingestEvents`. Mirrors the route's Zod shape. */
export interface IngestEvent {
  /** Stable pipeline id the events Lambda read from the `pb.pipeline-id`
   *  tag (= the platform pipelineId). The registry join key. */
  pipelineId: string;
  eventSource: 'codepipeline' | 'codebuild' | 'plugin-build';
  eventType: 'PIPELINE' | 'STAGE' | 'ACTION' | 'BUILD';
  status: string;
  executionId?: string;
  stageName?: string;
  actionName?: string;
  /** Human-readable failure reason (Action events). */
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Source commit id of the change being shipped (DORA deploy attribution). */
  commitSha?: string;
  /** Source ref/branch (DORA deploy attribution). */
  commitRef?: string;
  /** Deploy target (e.g. "production"). Its presence on a STAGE/ACTION event
   *  marks a real deployment (derived server-side — there is no `isDeploy`). */
  environment?: string;
  /** Oldest unshipped commit timestamp (ISO 8601) for measured lead time. */
  commitTimestamp?: string;
  /** Number of commits shipped in this change (≥1). */
  commitCount?: number;
  detail?: Record<string, unknown>;
}

/**
 * Per-event metric descriptor emitted (via the {@link ReportingService.ingestEvents}
 * `onMetric` hook) for each REGISTERED terminal deploy/stage event, so the route
 * layer can fan them into Prometheus counters without pipeline-data importing
 * api-server's metrics registry. `result` is the terminal outcome; `environment`
 * is non-null only for a deploy-stage event.
 */
export interface IngestMetric {
  pipelineId: string;
  orgId: string;
  stage: string;
  environment: string | null;
  result: 'succeeded' | 'failed';
}

/** Counts + the (possibly truncated) list of unregistered pipeline ids the caller can log. */
export interface IngestResult {
  inserted: number;
  skipped: number;
  unregisteredPipelineIds: string[];
}

// ─── Service ────────────────────────────────────────────

/**
 * Read-only reporting service for pipeline execution and plugin inventory aggregations.
 * Does not extend CrudService — reports are aggregate queries, not entity CRUD.
 *
 * All queries are cached in-memory to avoid repeated expensive SQL aggregations:
 * - Inventory queries (plugin summary/distribution/versions): 5 min TTL
 * - Timeseries queries (execution/build metrics with date ranges): 2 min TTL
 */
export class ReportingService {

  /** Invalidate all cached reports for an org (call after event ingest). */
  async invalidateOrg(orgId: string): Promise<void> {
    await Promise.all([
      inventoryCache.invalidatePattern(`${orgId}:*`),
      timeseriesCache.invalidatePattern(`${orgId}:*`),
    ]);
  }

  /**
   * Resolve incoming events against the pipeline registry, batch-insert the
   * matched ones, and invalidate reporting caches for affected orgs.
   * Events for unregistered pipeline ids are dropped (and logged at WARN
   * with sample ids so an operator can see when EventBridge is delivering
   * events for pipelines that haven't called POST /pipelines/registry yet).
   *
   * Returns counts + a sample of unregistered pipeline ids for observability.
   */
  async ingestEvents(events: IngestEvent[], onMetric?: (m: IngestMetric) => void): Promise<IngestResult> {
    // Multi-org batch insert: the caller resolves to multiple orgs via the
    // pipeline-registry lookup below, so the route layer MUST establish a
    // `runWithTenantContext({ isSuperAdmin: true }, ...)` scope before calling
    // this method. Under FORCE'd RLS, a single tx with `app.org_id = <one
    // org>` could only write events for that org; bypass via sysadmin is
    // the right gate for this server-internal cross-tenant endpoint. See
    // api/reporting/src/routes/event-ingest.ts for the wrapper.
    // Run insert inside the tx, but COLLECT affected orgs and invalidate
    // caches AFTER the tx resolves. Keeping invalidation inside the tx held
    // the pg locks open for the duration of the cache round-trips (Redis or
    // in-memory invalidations are unrelated to the tx but still serialized
    // its commit). Cache TTL is 2-5 min so fire-and-forget post-commit is
    // an acceptable trade for tighter lock windows.
    const { inserted, skipped, unregisteredPipelineIds, affectedOrgs } = await withTenantTx(async (tx) => {
      // Batch-resolve all unique pipeline ids in one query
      const uniqueIds = [...new Set(events.map(e => e.pipelineId))];
      const registryRows = await tx
        .select({
          pipelineId: schema.pipelineRegistry.pipelineId,
          orgId: schema.pipelineRegistry.orgId,
        })
        .from(schema.pipelineRegistry)
        .where(inArray(schema.pipelineRegistry.pipelineId, uniqueIds));

      const idMap = new Map(registryRows.map(r => [r.pipelineId, r]));

      // Build insert batch (skip events whose pipeline isn't registered)
      const rows: Array<typeof schema.pipelineEvent.$inferInsert> = [];
      let skippedLocal = 0;
      const unregisteredLocal: string[] = [];

      for (const event of events) {
        const registry = idMap.get(event.pipelineId);
        if (!registry) {
          skippedLocal++;
          unregisteredLocal.push(event.pipelineId);
          continue;
        }

        rows.push({
          // registry.pipelineId === event.pipelineId; use the registry's so the
          // FK is always a row that exists, and pull orgId from the registry for
          // tenancy (never trust the caller's claimed org).
          pipelineId: registry.pipelineId,
          orgId: registry.orgId,
          eventSource: event.eventSource,
          eventType: event.eventType,
          status: event.status,
          // executionId is an AWS-ASSIGNED identifier (a UUID), not free-form
          // user text, so it can't carry an account id — and scrubbing a UUID
          // that happens to contain a 12-digit run would corrupt the correlation
          // key. Left intact by design.
          executionId: event.executionId,
          // stageName/actionName are USER-AUTHORED pipeline-structure names
          // promoted from the CodePipeline detail — same untrusted-AWS-derived
          // origin as errorMessage below, so scrub them at this persistence
          // boundary too (a stage named with an ARN/12-digit id must not persist).
          stageName: scrubOptional(event.stageName),
          actionName: scrubOptional(event.actionName),
          // HARD CONSTRAINT: an AWS account id must NEVER be persisted. This is
          // the DURABLE persistence boundary and must not trust upstream:
          // CodePipeline/CodeBuild failure detail & messages routinely carry
          // ARNs (arn:aws:…:<account-id>:…) and bare 12-digit account ids. Scrub
          // both free-form fields here before insert (per-event, non-mutating).
          errorMessage: scrubOptional(event.errorMessage),
          startedAt: event.startedAt ? new Date(event.startedAt) : undefined,
          completedAt: event.completedAt ? new Date(event.completedAt) : undefined,
          durationMs: event.durationMs,
          // Deploy-attribution fields — scrubbed like the other free-form strings
          // so an ARN/account id can never enter via a ref or environment name.
          commitSha: scrubOptional(event.commitSha),
          commitRef: scrubOptional(event.commitRef),
          environment: scrubOptional(event.environment),
          // Measured lead time (Phase 4): oldest unshipped commit time + count.
          // commitTimestamp is an AWS/SCM-derived instant (never account-id
          // shaped); commitCount is a plain integer. Neither needs scrubbing.
          commitTimestamp: event.commitTimestamp ? new Date(event.commitTimestamp) : undefined,
          commitCount: event.commitCount,
          detail: event.detail !== undefined
            ? scrubAwsIdentifiers(event.detail)
            : undefined,
        });

        // Phase 3b: fan terminal STAGE outcomes into Prometheus counters via the
        // route's hook (pipeline-data can't import api-server's registry). Emit
        // per registered stage event with a terminal succeeded/failed result;
        // a non-null environment additionally marks it a deploy result.
        if (onMetric && event.eventType === 'STAGE' && (event.status === 'SUCCEEDED' || event.status === 'FAILED')) {
          onMetric({
            pipelineId: registry.pipelineId,
            orgId: registry.orgId,
            stage: scrubOptional(event.stageName) ?? '',
            environment: scrubOptional(event.environment) ?? null,
            result: event.status === 'SUCCEEDED' ? 'succeeded' : 'failed',
          });
        }
      }

      // SQS is at-least-once, so EventBridge can deliver the same state-change
      // twice. `onConflictDoNothing` + the partial unique index on
      // (pipeline_id, execution_id, event_type, status, stage_name, action_name)
      // makes re-delivery idempotent. `returning` gives the REAL inserted set so
      // counts + cache invalidation ignore duplicates.
      const insertedRows = rows.length > 0
        ? await tx.insert(schema.pipelineEvent).values(rows)
          .onConflictDoNothing()
          .returning({ orgId: schema.pipelineEvent.orgId })
        : [];

      return {
        inserted: insertedRows.length,
        skipped: skippedLocal,
        unregisteredPipelineIds: unregisteredLocal,
        affectedOrgs: [...new Set(insertedRows.map(r => r.orgId))],
      };
    });

    // Surface the silent skip: an unregistered pipeline id usually means the
    // pipeline hasn't called POST /pipelines/registry yet (or its
    // pb.pipeline-id tag is missing/unreadable by the Lambda). Logging it
    // makes a broken join visible instead of looking like "no activity".
    if (unregisteredPipelineIds.length > 0) {
      logger.warn('Pipeline events skipped: pipeline id not found in registry', {
        count: unregisteredPipelineIds.length,
        sample: unregisteredPipelineIds.slice(0, 3),
      });
    }

    // Post-commit cache invalidation. Fire-and-forget with logging — TTL is
    // short enough that a missed invalidation self-heals.
    if (affectedOrgs.length > 0) {
      void Promise.all(affectedOrgs.map((org) =>
        this.invalidateOrg(org).catch((err) => {
          logger.warn('Reporting cache invalidation failed', { orgId: org, error: errorMessage(err) });
        }),
      ));
    }

    return { inserted, skipped, unregisteredPipelineIds };
  }

  // ── Category 1: Pipeline Execution & Performance ──

  /**
   * Build the org-scope predicate for a report query. With `orgIds` (the
   * org → team rollup — a parent's `[self, ...descendants]`) it becomes an
   * `IN (...)` over the subtree; otherwise the single-org `= $org`. Returns a
   * `multi` flag so callers can run multi-org reads under sysadmin context
   * (the subtree spans orgs outside the request's RLS scope) and salt the
   * cache key.
   */
  private orgScope(orgId: string, orgIds?: string[]) {
    // Defense-in-depth: the multi-org rollup runs under sysadmin context (RLS
    // OFF, see runReport), so `orgIds` is the ONLY tenancy gate on the read. The
    // route resolves it from the platform's authoritative descendants endpoint as
    // `[self, ...descendants]`, but validate the subtree defensively here before
    // the bypass: the requesting (anchor) org MUST appear in the set. A set that
    // omits the caller's own org is a malformed/spoofed rollup — collapse to the
    // safe single-org scope rather than reading an arbitrary org under sysadmin.
    // (Full descendant-membership validation needs the org tree, which this
    // service does not hold — see the report FLAG.)
    const anchor = orgId.toLowerCase();
    const provided = (orgIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    const anchored = provided.some((id) => id.toLowerCase() === anchor);
    if (provided.length > 0 && !anchored) {
      logger.warn('Reporting rollup rejected: requesting org absent from resolved subtree; using single-org scope', {
        orgId: anchor, subtreeSize: provided.length,
      });
    }
    const ids = provided.length > 0 && anchored ? provided : [orgId];
    const multi = ids.length > 1;
    const pred = multi
      ? sql`IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
      : sql`= ${ids[0]}`;
    return { pred, multi };
  }

  /**
   * Run a report read. Single-org reads use the per-org cache (invalidated on
   * that org's event ingest). Rollup (multi-org) reads **bypass the cache** and
   * run under sysadmin context: they're admin-only and lower-frequency, and a
   * child org's event ingest can't invalidate a parent's rollup entry (reporting
   * has no org tree), so caching them would serve stale aggregates. Always fresh.
   */
  private runReport<T>(cacheKey: string, multi: boolean, exec: () => Promise<T>): Promise<T> {
    return multi
      ? runWithTenantContext({ isSuperAdmin: true }, exec)
      : timeseriesCache.getOrSet(cacheKey, exec);
  }

  /** 1.1 Execution count per pipeline with status breakdown. */
  async getExecutionCount(orgId: string, orgIds?: string[], range?: { from?: string; to?: string }): Promise<ExecutionCount[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    // Optional [from,to] window on the execution's started_at, mirroring the
    // sibling timeseries reports so the dashboard date-range picker narrows the
    // count too (an empty range = all-time, preserving the prior behavior). The
    // range rides the JOIN so pipelines with no in-window events still list
    // (LEFT semantics preserved via the inner-join filter — a pipeline with zero
    // matching events drops from the count, same as before for its window).
    const rangeClause = optionalStartedAtRange(range);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          p.id, p.project, p.organization, p.pipeline_name,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE e.status = 'CANCELED')::int AS canceled,
          MIN(e.started_at)::text AS first_execution,
          MAX(e.started_at)::text AS last_execution
        FROM ${schema.pipeline} p
        JOIN ${schema.pipelineEvent} e ON e.pipeline_id = p.id
          AND e.event_type = 'PIPELINE' AND e.status != 'STARTED'
          ${rangeClause}
        WHERE p.org_id ${pred} AND p.is_active = true
        GROUP BY p.id
        ORDER BY total DESC
      `).then(r => drizzleRows<ExecutionCount>(r.rows)));
    return this.runReport(`${orgId}:exec-count:${range?.from ?? ''}:${range?.to ?? ''}`, multi, exec);
  }

  /**
   * 1.1b Per-pipeline execution history — DISTINCT executions for one pipeline,
   * newest first. Groups all events by `execution_id` in a single scan and
   * rolls each execution up to one row:
   *   - status: derived from the PIPELINE-type events. FAILED wins, then
   *     SUCCEEDED, then CANCELED; an execution with no terminal PIPELINE event
   *     is still `in-progress`.
   *   - startedAt/endedAt/durationMs: from the PIPELINE lifecycle events.
   *   - failingStage/failingAction: the first FAILED STAGE/ACTION event (cheap —
   *     same scan, no extra query).
   *
   * ORG-SCOPING: identical to the sibling execution reports — joins the pipeline
   * registry table (`pipeline`) and gates on `p.org_id ${pred}`, where `pred` is
   * the single-org `= $org` or (with a rollup) an `IN (...)` over the org→team
   * subtree. A pipelineId belonging to another org yields zero rows.
   */
  async listPipelineExecutions(
    orgId: string,
    pipelineId: string,
    orgIds?: string[],
    range?: { from?: string; to?: string },
    limit: number = 50,
  ): Promise<PipelineExecution[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const rangeClause = optionalStartedAtRange(range);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.execution_id,
          CASE
            WHEN bool_or(e.event_type = 'PIPELINE' AND e.status = 'FAILED') THEN 'failed'
            WHEN bool_or(e.event_type = 'PIPELINE' AND e.status = 'SUCCEEDED') THEN 'succeeded'
            WHEN bool_or(e.event_type = 'PIPELINE' AND e.status = 'CANCELED') THEN 'canceled'
            ELSE 'in-progress'
          END AS status,
          MIN(e.started_at) FILTER (WHERE e.event_type = 'PIPELINE')::text AS started_at,
          MAX(e.completed_at) FILTER (WHERE e.event_type = 'PIPELINE')::text AS ended_at,
          MAX(e.duration_ms) FILTER (WHERE e.event_type = 'PIPELINE')::int AS duration_ms,
          (ARRAY_AGG(e.stage_name) FILTER (WHERE e.event_type = 'STAGE' AND e.status = 'FAILED'))[1] AS failing_stage,
          (ARRAY_AGG(e.action_name) FILTER (WHERE e.event_type = 'ACTION' AND e.status = 'FAILED'))[1] AS failing_action
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.pipeline_id = ${pipelineId} AND e.execution_id IS NOT NULL
          ${rangeClause}
        GROUP BY e.execution_id
        ORDER BY MAX(e.created_at) DESC
        LIMIT ${limit}
      `).then(r => drizzleRows<PipelineExecution>(r.rows)));
    return this.runReport(`${orgId}:pipeline-executions:${pipelineId}:${range?.from ?? ''}:${range?.to ?? ''}:${limit}`, multi, exec);
  }

  /** 1.2 Success rate over time for an org. */
  async getSuccessRate(orgId: string, interval: string, from: string, to: string, orgIds?: string[]): Promise<TimeSeriesEntry[]> {
    assertReportInterval(interval);
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          DATE_TRUNC(${interval}, e.started_at)::text AS period,
          COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE e.status = 'CANCELED')::int AS canceled,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'SUCCEEDED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS success_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'PIPELINE'
          AND e.status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY period ORDER BY period
      `).then(r => drizzleRows<TimeSeriesEntry>(r.rows)));
    return this.runReport(`${orgId}:success-rate:${interval}:${from}:${to}`, multi, exec);
  }

  /** 1.3 Average duration per pipeline. */
  async getAverageDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<DurationStats[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          p.id, p.project, p.pipeline_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MIN(e.duration_ms)::int AS min_ms,
          MAX(e.duration_ms)::int AS max_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::int AS p95_ms,
          COUNT(*)::int AS executions
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'PIPELINE' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY p.id ORDER BY avg_ms DESC
      `).then(r => drizzleRows<DurationStats>(r.rows)));
    return this.runReport(`${orgId}:avg-duration:${from}:${to}`, multi, exec);
  }

  /** 1.5 Stage failure heatmap — which stages fail most. */
  async getStageFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<StageFailure[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.stage_name,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failures,
          COUNT(*)::int AS total,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'FAILED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS failure_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.stage_name IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY e.stage_name ORDER BY failures DESC
      `).then(r => drizzleRows<StageFailure>(r.rows)));
    return this.runReport(`${orgId}:stage-failures:${from}:${to}`, multi, exec);
  }

  /**
   * Distinct deploy `environment` values observed in the window — powers the
   * DORA environment-scope datalist. Org-scoped + rollup-aware like the sibling
   * reports; only non-null environments (i.e. deploy-attributed executions).
   */
  async getReportEnvironments(orgId: string, from: string, to: string, orgIds?: string[]): Promise<string[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT DISTINCT e.environment AS environment
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.environment IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        ORDER BY environment
      `).then(r => drizzleRows<{ environment: string }>(r.rows).map((row) => row.environment)));
    return this.runReport(`${orgId}:report-envs:${from}:${to}`, multi, exec);
  }

  /** 1.6 Stage bottlenecks — slowest stages per pipeline. */
  async getStageBottlenecks(orgId: string, from: string, to: string, orgIds?: string[]): Promise<StageBottleneck[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          p.id, p.pipeline_name, e.stage_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY p.id, e.stage_name ORDER BY avg_ms DESC
      `).then(r => drizzleRows<StageBottleneck>(r.rows)));
    return this.runReport(`${orgId}:stage-bottlenecks:${from}:${to}`, multi, exec);
  }

  /** 1.7 Action failure rate — which plugin steps fail most. */
  async getActionFailures(orgId: string, from: string, to: string, orgIds?: string[]): Promise<ActionFailure[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.action_name,
          COUNT(*) FILTER (WHERE e.status = 'FAILED')::int AS failures,
          COUNT(*)::int AS total,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'FAILED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS failure_pct
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.event_type = 'ACTION' AND e.action_name IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY e.action_name ORDER BY failures DESC
      `).then(r => drizzleRows<ActionFailure>(r.rows)));
    return this.runReport(`${orgId}:action-failures:${from}:${to}`, multi, exec);
  }

  /**
   * 1.8 Error categorization — group failure messages. Execution report, so
   * rollup-aware exactly like the sibling execution reports: with `orgIds`
   * (the org→team subtree) the org gate becomes an `IN (...)` and the read runs
   * fresh under sysadmin via `runReport`; single-org reads keep the per-org cache.
   */
  async getErrors(orgId: string, from: string, to: string, limit: number = 20, orgIds?: string[]): Promise<ErrorEntry[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          SUBSTRING(e.error_message FROM 1 FOR 200) AS error_pattern,
          COUNT(*)::int AS occurrences,
          COUNT(DISTINCT e.pipeline_id)::int AS affected_pipelines,
          MAX(e.started_at)::text AS last_seen
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id ${pred} AND e.status = 'FAILED' AND e.error_message IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY error_pattern ORDER BY occurrences DESC
        LIMIT ${limit}
      `).then(r => drizzleRows<ErrorEntry>(r.rows)));
    return this.runReport(`${orgId}:errors:${from}:${to}:${limit}`, multi, exec);
  }

  /**
   * 1.9 DORA metrics over a [from,to] deploy-completion window, org-scoped +
   * rollup-aware. DEPLOY-BASIS ONLY — every metric derives from real deploy-stage
   * executions (`event_type='STAGE'` with a non-null `environment`, set by the
   * forwarder for the stages a user declared in `pb.deploys`). No run-based
   * fallback: a pipeline with no deploy stage produces no DORA data.
   *
   * Four scoped SQL scans run inside one tx (each org-gated by `p.org_id ${pred}`
   * / `o.org_id ${pred}` so a rollup passes the org→team subtree and a foreign
   * org's rows never enter): (1) terminal deploy rows PER (execution, env) — one
   * "deployment" = one execution reaching an env (D1) — → DF / deploy-time CFR /
   * measured lead time (lead time joins the execution's earliest commit, D2);
   * the scan also reaches back `windowHours` before `from` so incidents opened
   * near the window start can correlate to a just-prior deploy; (2) `deployment_outcomes`
   * in-window → post-deploy CFR component; (3) production restored/failed
   * outcomes joined to their deploy → MTTR; (4) registry vs deploying → coverage.
   * The cross-source medians (lead time, MTTR) are computed in JS from clamped
   * (≥0) deltas.
   *
   * @param opts.pipelineId    restrict to one pipeline (per-pipeline DORA)
   * @param opts.environment   restrict to one deploy environment
   */
  async getDoraMetrics(
    orgId: string,
    from: string,
    to: string,
    orgIds?: string[],
    opts: DoraOptions = {},
  ): Promise<DoraMetrics> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const { pipelineId, environment } = opts;
    const pipelineClause = pipelineId ? sql`AND e.pipeline_id = ${pipelineId}` : sql``;
    const pipelineClauseR = pipelineId ? sql`AND r.pipeline_id = ${pipelineId}` : sql``;
    const envClause = environment ? sql`AND e.environment = ${environment}` : sql``;
    const outcomeEnvClause = environment ? sql`AND o.environment = ${environment}` : sql``;
    const incidentEnvClause = environment ? sql`AND i.environment = ${environment}` : sql``;

    // Effective incident-correlation window (per-org override or the global
    // default). Computed here (not just in shapeDora) because the deploy scan
    // needs it for BOTH the correlation look-back lower bound AND the cache key.
    const effectiveWindowHours = resolveIncidentWindowHours(opts.incidentWindowHours);
    // Correlation look-back: incidents opened just inside `from` can attribute to
    // a deploy that completed up to `windowHours` BEFORE `from` (mirrors the
    // LATERAL look-back in listIncidents). Widen the deploy scan's lower bound to
    // `from − windowHours`; DF/CFR/lead still count only the in-`from`..`to`
    // subset (flagged by `in_window`), while correlation sees the wider set.
    const fromMs = Date.parse(from);
    const lookbackFrom = Number.isFinite(fromMs)
      ? new Date(fromMs - effectiveWindowHours * 3600 * 1000).toISOString()
      : from;

    // (1) Terminal deploy rows: PER-EXECUTION (D1), one row per (environment,
    // execution) — every deploy STAGE targeting that env within the execution is
    // rolled up to a terminal status (FAILED wins, then SUCCEEDED). A single
    // execution with two deploy stages to the same env is ONE deployment, not two.
    // completed_at = the deploy's completion (MAX over its stages). `commit_ts`
    // (D2) is the execution's EARLIEST commit time across ALL its events (commit
    // enrichment rides the PIPELINE/source event where environment IS NULL, never
    // the deploy STAGE row), joined by execution_id. `in_window` marks whether the
    // deploy completed inside [from,to] (vs. a look-back-only row kept solely for
    // incident correlation). execution_id is projected so post-deploy failures
    // (manual outcomes + correlated incidents) can dedup against their deploy.
    const deploySql = sql`
        WITH deploy_stages AS (
          SELECT
            e.environment AS environment,
            e.execution_id AS execution_id,
            ${terminalStatusRollup} AS status,
            MAX(e.completed_at) AS completed_at
          FROM ${schema.pipelineEvent} e
          JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
          WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.environment IS NOT NULL
            ${pipelineClause} ${envClause}
            AND e.completed_at >= ${lookbackFrom}::timestamptz AND e.completed_at <= ${to}::timestamptz
          GROUP BY e.environment, e.execution_id
        ),
        exec_commits AS (
          SELECT c.execution_id AS execution_id, MIN(c.commit_timestamp) AS commit_ts
          FROM ${schema.pipelineEvent} c
          JOIN ${schema.pipeline} p ON p.id = c.pipeline_id
          WHERE p.org_id ${pred} AND c.commit_timestamp IS NOT NULL
            AND c.execution_id IN (SELECT execution_id FROM deploy_stages)
          GROUP BY c.execution_id
        )
        SELECT
          ds.environment AS environment,
          ds.execution_id AS execution_id,
          ds.status AS status,
          ds.completed_at::text AS completed_at,
          (ds.completed_at >= ${from}::timestamptz) AS in_window,
          ec.commit_ts::text AS commit_ts
        FROM deploy_stages ds
        LEFT JOIN exec_commits ec ON ec.execution_id = ds.execution_id`;

    // (2) Post-deploy outcome markers in-window (per env). Post-deploy failures
    // (outcome='failed') add to the CFR numerator without changing attempts.
    // execution_id lets the CFR dedup a manual failure against an incident that
    // correlates to the same deploy (no double-count).
    const outcomeSql = sql`
        SELECT o.environment AS environment, o.outcome AS outcome, o.execution_id AS execution_id
        FROM ${schema.deploymentOutcome} o
        WHERE o.org_id ${pred} ${outcomeEnvClause}
          AND o.at >= ${from}::timestamptz AND o.at <= ${to}::timestamptz`;

    // (3) MTTR — PRODUCTION-ONLY, independent of the env filter. Every production
    // outcome in-window; for a 'restored' one, correlate to its deploy's
    // completion via execution_id to measure restored.at − deployed.completed_at.
    // execution_id is projected so an incident-sourced recovery for the same
    // deploy takes precedence over the manual restored gap.
    const mttrSql = sql`
        SELECT
          o.outcome AS outcome,
          o.execution_id AS execution_id,
          o.at::text AS restored_at,
          (SELECT MAX(d.completed_at) FROM ${schema.pipelineEvent} d
             JOIN ${schema.pipeline} p2 ON p2.id = d.pipeline_id
             WHERE p2.org_id ${pred} AND d.execution_id = o.execution_id
               AND d.event_type = 'STAGE' AND d.environment = ${HEADLINE_ENV})::text AS deployed_at
        FROM ${schema.deploymentOutcome} o
        WHERE o.org_id ${pred} AND o.environment = ${HEADLINE_ENV}
          AND o.at >= ${from}::timestamptz AND o.at <= ${to}::timestamptz`;

    // (5) Incidents opened in-window (per env). Correlated in JS to the most
    // recent successful deploy → automated post-deploy failure (CFR) + real
    // recovery time (resolved_at − opened_at) for MTTR (production).
    const incidentSql = sql`
        SELECT i.environment AS environment, i.opened_at::text AS opened_at, i.resolved_at::text AS resolved_at
        FROM ${schema.incident} i
        WHERE i.org_id ${pred} ${incidentEnvClause}
          AND i.opened_at >= ${from}::timestamptz AND i.opened_at <= ${to}::timestamptz`;

    // (4) Coverage: registered pipelines vs those that actually deployed in-window.
    const coverageSql = sql`
        SELECT
          (SELECT COUNT(*)::int FROM ${schema.pipelineRegistry} r
             WHERE r.org_id ${pred} ${pipelineClauseR}) AS registered,
          (SELECT COUNT(DISTINCT e.pipeline_id)::int FROM ${schema.pipelineEvent} e
             JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
             WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.environment IS NOT NULL
               ${pipelineClause} ${envClause}
               AND e.completed_at >= ${from}::timestamptz AND e.completed_at <= ${to}::timestamptz) AS deploying`;

    const exec = () => withTenantTx(async (tx) => {
      // Scan order is load-bearing for the generated-SQL tests: 0=deploy,
      // 1=outcomes, 2=mttr, 3=coverage, 4=incidents (appended last so the
      // earlier indices stay stable).
      const deployRows = drizzleRows<DeployRow>((await tx.execute(deploySql)).rows);
      const outcomeRows = drizzleRows<OutcomeRow>((await tx.execute(outcomeSql)).rows);
      const mttrRows = drizzleRows<MttrPairRow & { outcome: string }>((await tx.execute(mttrSql)).rows);
      const coverageRow = drizzleRows<CoverageRow>((await tx.execute(coverageSql)).rows)[0];
      const incidentRows = drizzleRows<IncidentRow>((await tx.execute(incidentSql)).rows);
      return this.shapeDora(deployRows, outcomeRows, mttrRows, coverageRow, incidentRows, from, to, {
        pipelineId, environment,
      }, effectiveWindowHours);
    });
    // Cache key MUST include the effective incident window: the scorecard reads
    // /dora with the org's default window while an explicit /dora call may pass an
    // override — different windows yield different CFR/MTTR, so they must not
    // collide on the same key.
    const key = `${orgId}:dora:${from}:${to}:${pipelineId ?? ''}:${environment ?? ''}:${effectiveWindowHours}`;
    return this.runReport(key, multi, exec);
  }

  /**
   * Shape the raw DORA scan rows into the public {@link DoraMetrics}. Buckets the
   * terminal deploy rows by environment (DF / deploy-time CFR / measured lead),
   * folds in the post-deploy failure counts (manual outcomes + webhook-ingested
   * incidents, deduped by deploy execution), computes production MTTR from both
   * sources (incident `resolved_at − opened_at` taking precedence over the manual
   * `restored − deployed`), and reconciles coverage — all cross-source medians
   * over deltas clamped ≥0.
   *
   * Phase 5 incident correlation: each incident is attributed to the most recent
   * SUCCESSFUL deploy to its environment with `completed_at ≤ opened_at` within
   * {@link DORA_INCIDENT_WINDOW_HOURS}. That deploy is a post-deploy failure; an
   * uncorrelated incident (no eligible deploy) contributes nothing.
   */
  private shapeDora(
    deployRows: DeployRow[],
    outcomeRows: OutcomeRow[],
    mttrRows: Array<MttrPairRow & { outcome: string }>,
    coverageRow: CoverageRow | undefined,
    incidentRows: IncidentRow[],
    from: string,
    to: string,
    filters: { pipelineId?: string; environment?: string },
    windowHours: number = DORA_INCIDENT_WINDOW_HOURS,
  ): DoraMetrics {
    // Window length in days (floored at 1 so a sub-day window yields the count as
    // the rate, never /0 or an extrapolation). Guard unparseable dates → 1 day.
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86400000;
    const days = Number.isFinite(spanDays) ? Math.max(spanDays, 1) : 1;
    // Window end instant for MTTR right-censoring (a resolution after `to` is
    // unobserved). +Infinity when `to` is unparseable ⇒ no censoring (fail-open).
    const toParsed = Date.parse(to);
    const toMs = Number.isFinite(toParsed) ? toParsed : Number.POSITIVE_INFINITY;

    // Per-env accumulator.
    interface Acc {
      deployments: number; deployTimeFailures: number; attempts: number;
      leadGaps: number[];
    }
    const envs = new Map<string, Acc>();
    const accFor = (env: string): Acc => {
      let a = envs.get(env);
      if (!a) { a = { deployments: 0, deployTimeFailures: 0, attempts: 0, leadGaps: [] }; envs.set(env, a); }
      return a;
    };

    // A deploy row counts toward DF/CFR/lead only if it completed inside [from,to].
    // Look-back-only rows (in_window=false, kept for incident correlation) are
    // skipped here. Absent in a fixture ⇒ in-window (unit tests omit the flag).
    const isInWindow = (row: DeployRow): boolean =>
      row.in_window == null ? true : (row.in_window === true || row.in_window === 't');

    for (const row of deployRows) {
      const env = row.environment;
      if (!env) continue;
      if (!isInWindow(row)) continue; // look-back-only row → correlation, not DF/CFR
      const a = accFor(env);
      if (row.status === 'SUCCEEDED') {
        a.deployments++;
        a.attempts++;
        // Measured lead time: deploy completion − execution's earliest commit time.
        if (row.commit_ts != null && row.completed_at != null) {
          const gap = (Date.parse(row.completed_at) - Date.parse(row.commit_ts)) / 1000;
          if (Number.isFinite(gap)) a.leadGaps.push(Math.max(gap, 0));
        }
      } else if (row.status === 'FAILED') {
        a.deployTimeFailures++;
        a.attempts++;
      }
    }

    // Incident→deploy correlation (Phase 5). Index the SUCCESSFUL deploys per env
    // (execution id + completion instant), newest first, so each incident can be
    // attributed to the most recent deploy that completed within the window
    // before it opened. That execution is a post-deploy failure.
    const windowMs = windowHours * 3600 * 1000;
    const successfulByEnv = new Map<string, Array<{ exec: string; completedMs: number }>>();
    for (const row of deployRows) {
      if (row.status !== 'SUCCEEDED' || !row.environment || row.execution_id == null || row.completed_at == null) continue;
      const ms = Date.parse(row.completed_at);
      if (!Number.isFinite(ms)) continue;
      const list = successfulByEnv.get(row.environment) ?? [];
      list.push({ exec: row.execution_id, completedMs: ms });
      successfulByEnv.set(row.environment, list);
    }
    for (const list of successfulByEnv.values()) list.sort((a, b) => b.completedMs - a.completedMs);

    /** Correlate an incident to the most recent in-window successful deploy execution. */
    const correlate = (env: string, openedMs: number): string | null => {
      const list = successfulByEnv.get(env);
      if (!list) return null;
      for (const d of list) {
        if (d.completedMs <= openedMs && openedMs - d.completedMs <= windowMs) return d.exec;
      }
      return null;
    };

    // Correlated incidents (all envs → CFR; production subset → MTTR). Each carries
    // the deploy execution it attributes to + its real recovery gap (when resolved).
    interface CorrelatedIncident { environment: string; exec: string; resolvedGap: number | null }
    const correlatedIncidents: CorrelatedIncident[] = [];
    for (const inc of incidentRows) {
      if (!inc.environment || inc.opened_at == null) continue;
      const openedMs = Date.parse(inc.opened_at);
      if (!Number.isFinite(openedMs)) continue;
      const exec = correlate(inc.environment, openedMs);
      if (exec == null) continue; // uncorrelated → not attributable to a deploy
      let resolvedGap: number | null = null;
      if (inc.resolved_at != null) {
        const resolvedMs = Date.parse(inc.resolved_at);
        // Right-censoring: a resolution AFTER the window end (`to`) is not observed
        // within the window — treat the incident as still open (gap stays null) so
        // MTTR never reads unbounded past `to`. The incident still counts toward the
        // incident total (unresolved), it just contributes no recovery time.
        if (Number.isFinite(resolvedMs) && resolvedMs <= toMs) {
          const g = (resolvedMs - openedMs) / 1000;
          if (Number.isFinite(g)) resolvedGap = Math.max(g, 0);
        }
      }
      correlatedIncidents.push({ environment: inc.environment, exec, resolvedGap });
    }

    // Post-deploy failures per env — the DISTINCT set of deploy executions flagged
    // by a manual `failed` outcome OR a correlated incident (deduped by execution,
    // so a deploy flagged by both counts once). A manual outcome without an
    // execution id (legacy/unresolvable) still counts via a per-row sentinel.
    const postDeployExecsByEnv = new Map<string, Set<string>>();
    let sentinel = 0;
    const flagFor = (env: string): Set<string> => {
      let s = postDeployExecsByEnv.get(env);
      if (!s) { s = new Set<string>(); postDeployExecsByEnv.set(env, s); }
      return s;
    };
    for (const o of outcomeRows) {
      if (o.outcome !== 'failed' || !o.environment) continue;
      flagFor(o.environment).add(o.execution_id ?? `manual-${sentinel++}`);
      accFor(o.environment); // ensure env appears even with no deploy events
    }
    for (const ci of correlatedIncidents) {
      flagFor(ci.environment).add(ci.exec);
      accFor(ci.environment); // ensure env appears even if the deploy is out-of-window
    }
    const postDeployByEnv = new Map<string, number>();
    for (const [env, set] of postDeployExecsByEnv) postDeployByEnv.set(env, set.size);

    const environments: DoraEnvMetrics[] = [...envs.entries()]
      .map(([environment, a]) => {
        const postDeployFailures = postDeployByEnv.get(environment) ?? 0;
        const rawPerDay = a.deployments / days;
        const numerator = a.deployTimeFailures + postDeployFailures;
        const rawRate = a.attempts > 0 ? (numerator / a.attempts) * 100 : 0;
        const ltMedian = median(a.leadGaps);
        return {
          environment,
          deploymentFrequency: {
            deployments: a.deployments,
            perDay: round(rawPerDay, 2),
            level: doraLevelForFrequency(rawPerDay, a.deployments),
          },
          changeFailureRate: {
            rate: round(rawRate, 1),
            deployTimeFailures: a.deployTimeFailures,
            postDeployFailures,
            attempts: a.attempts,
            level: doraLevelForChangeFailure(rawRate, a.attempts),
          },
          leadTime: {
            deployments: a.leadGaps.length,
            medianSeconds: ltMedian != null ? round(ltMedian, 1) : null,
            level: doraLevelForLeadTime(ltMedian),
          },
        };
      })
      .sort((x, y) => {
        if (x.environment === HEADLINE_ENV) return -1;
        if (y.environment === HEADLINE_ENV) return 1;
        return x.environment.localeCompare(y.environment);
      });

    // MTTR — PRODUCTION-ONLY, from BOTH sources. Incidents take precedence: a
    // production incident correlated to a deploy contributes the real recovery
    // (`resolved_at − opened_at`), and any manual outcome on the SAME deploy is
    // skipped. Manual outcomes on other deploys keep the Phase-2 behavior
    // (`failed` → an incident; `restored` → a recovery gap of `restored − deployed`).
    let incidents = 0, restored = 0;
    const mttrGaps: number[] = [];
    // Executions already attributed to a production incident (precedence guard).
    const incidentExecs = new Set<string>();
    for (const ci of correlatedIncidents) {
      if (ci.environment !== HEADLINE_ENV) continue; // MTTR is production-only
      incidents++;
      incidentExecs.add(ci.exec);
      if (ci.resolvedGap != null) { restored++; mttrGaps.push(ci.resolvedGap); }
    }
    for (const m of mttrRows) {
      // Incident precedence: don't double-count a deploy already flagged by an incident.
      if (m.execution_id != null && incidentExecs.has(m.execution_id)) continue;
      if (m.outcome === 'failed') { incidents++; continue; }
      if (m.outcome === 'restored') {
        restored++;
        if (m.restored_at != null && m.deployed_at != null) {
          const gap = (Date.parse(m.restored_at) - Date.parse(m.deployed_at)) / 1000;
          if (Number.isFinite(gap)) mttrGaps.push(Math.max(gap, 0));
        }
      }
    }
    const mttrMedian = median(mttrGaps);

    const registered = Number(coverageRow?.registered) || 0;
    const deploying = Number(coverageRow?.deploying) || 0;

    return {
      window: { from, to },
      filters: { pipelineId: filters.pipelineId ?? null, environment: filters.environment ?? null },
      headline: HEADLINE_ENV,
      environments,
      meanTimeToRestore: {
        incidents,
        restored,
        medianSeconds: mttrMedian != null ? round(mttrMedian, 1) : null,
        level: doraLevelForRestore(mttrMedian),
      },
      coverage: {
        registered,
        deploying,
        withoutDeploys: Math.max(registered - deploying, 0),
      },
    };
  }

  /**
   * 1.9b DORA trend — deployment frequency + deploy-time change-failure rate
   * bucketed by `interval` (day/week/month) for a sparkline. Deploy-basis like
   * getDoraMetrics: buckets terminal deploy-stage executions on their
   * `completed_at`. Shares the org/rollup + pipelineId/environment scoping. MTTR,
   * lead time, and post-deploy CFR are intentionally omitted (too heavy to bucket).
   */
  async getDoraTrend(
    orgId: string,
    interval: string,
    from: string,
    to: string,
    orgIds?: string[],
    opts: DoraOptions = {},
  ): Promise<DoraTrendPoint[]> {
    assertReportInterval(interval);
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const { pipelineId, environment } = opts;
    const pipelineClause = pipelineId ? sql`AND e.pipeline_id = ${pipelineId}` : sql``;
    const envClause = environment ? sql`AND e.environment = ${environment}` : sql``;
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        WITH deploys AS (
          -- PER-EXECUTION deploy unit (D1): one row per (environment, execution),
          -- every deploy STAGE to that env within the execution rolled up to a
          -- single terminal status — NOT one row per stage.
          SELECT
            ${terminalStatusRollup} AS status,
            MAX(e.completed_at) AS completed_at
          FROM ${schema.pipelineEvent} e
          JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
          WHERE p.org_id ${pred} AND e.event_type = 'STAGE' AND e.environment IS NOT NULL
            ${pipelineClause} ${envClause}
            AND e.completed_at >= ${from}::timestamptz AND e.completed_at <= ${to}::timestamptz
          GROUP BY e.environment, e.execution_id
        )
        SELECT
          DATE_TRUNC(${interval}, completed_at)::text AS period,
          COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS deployments,
          COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE status IN ('SUCCEEDED', 'FAILED'))::int AS total,
          -- quoted alias so the raw row key is exactly the DoraTrendPoint field
          COALESCE(ROUND(COUNT(*) FILTER (WHERE status = 'FAILED')::numeric
            / NULLIF(COUNT(*) FILTER (WHERE status IN ('SUCCEEDED', 'FAILED')), 0) * 100, 1), 0)::float AS "changeFailurePct"
        FROM deploys
        GROUP BY period ORDER BY period
      `).then(r => drizzleRows<DoraTrendPoint>(r.rows)));
    const key = `${orgId}:dora-trend:${interval}:${from}:${to}:${pipelineId ?? ''}:${environment ?? ''}`;
    return this.runReport(key, multi, exec);
  }

  /**
   * 1.10 Per-pipeline BUILD HEALTH (Phase 6) — a standard (NOT `advanced_reporting`)
   * per-stage breakdown for one pipeline over a [from,to] window. Aggregates the
   * existing `pipeline_events` STAGE rows: each stage is rolled up per execution
   * to a terminal status (FAILED wins, then SUCCEEDED) + its max duration, then
   * grouped per stage into run/success/failure counts, a success rate, and
   * duration percentiles (p50/p90/p99). Totals sum across stages. Org-scoped via
   * the pipeline join (`p.org_id ${pred}`) + rollup-aware like the sibling reports;
   * a pipelineId owned by another org returns an empty breakdown.
   */
  async getBuildHealth(
    orgId: string,
    pipelineId: string,
    from: string,
    to: string,
    orgIds?: string[],
  ): Promise<BuildHealth> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx(async (tx) => {
      const rows = drizzleRows<BuildHealthStage>((await tx.execute(sql`
        WITH stage_runs AS (
          SELECT
            e.stage_name AS stage,
            ${terminalStatusRollup} AS status,
            MAX(e.duration_ms) AS duration_ms
          FROM ${schema.pipelineEvent} e
          JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
          WHERE p.org_id ${pred} AND e.pipeline_id = ${pipelineId}
            AND e.event_type = 'STAGE' AND e.stage_name IS NOT NULL
            AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
          GROUP BY e.stage_name, e.execution_id
        )
        SELECT
          stage,
          COUNT(*)::int AS runs,
          COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS successes,
          COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failures,
          COALESCE(ROUND(COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1), 0)::float AS "successRate",
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS "p50Ms",
          PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duration_ms)::int AS "p90Ms",
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS "p99Ms"
        FROM stage_runs
        WHERE status IN ('SUCCEEDED', 'FAILED')
        GROUP BY stage
        ORDER BY runs DESC, stage
      `)).rows);

      // Totals sum across stages (total stage-runs / stage-failures in the window).
      let runs = 0, failures = 0;
      for (const s of rows) { runs += s.runs; failures += s.failures; }
      const failureRate = runs > 0 ? round((failures / runs) * 100, 1) : 0;
      return { stages: rows, totals: { runs, failures, failureRate } };
    });
    return this.runReport(`${orgId}:build-health:${pipelineId}:${from}:${to}`, multi, exec);
  }

  // ── Category 2: Plugin Inventory & Builds ──

  /** 2.1 Plugin summary — counts and breakdowns.
   *  INTENTIONALLY SINGLE-ORG (no rollup): plugin inventory is an org-owned
   *  asset count, not an execution/build activity report, so a parent's view is
   *  its own plugins — teams manage their own inventory. Single `= $org` scope. */
  async getPluginSummary(orgId: string): Promise<PluginSummary> {
    return inventoryCache.getOrSet(`${orgId}:plugin-summary`, async () => {
      const rows = await withTenantTx((tx) => tx.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE ${schema.plugin.isActive})::int AS active,
          COUNT(*) FILTER (WHERE NOT ${schema.plugin.isActive})::int AS inactive,
          COUNT(*) FILTER (WHERE ${schema.plugin.accessModifier} = 'public')::int AS public,
          COUNT(*) FILTER (WHERE ${schema.plugin.accessModifier} = 'private')::int AS private,
          COUNT(DISTINCT ${schema.plugin.name})::int AS unique_names
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId}
      `));
      return (drizzleRows<PluginSummary>(rows.rows)[0] || { total: 0, active: 0, inactive: 0, public: 0, private: 0, uniqueNames: 0 });
    });
  }

  /** 2.2 Type & compute distribution.
   *  INTENTIONALLY SINGLE-ORG (no rollup): plugin inventory is per-org (see
   *  getPluginSummary). Single `= $org` scope. */
  async getPluginDistribution(orgId: string): Promise<TypeComputeDistribution[]> {
    return inventoryCache.getOrSet(`${orgId}:plugin-distribution`, () =>
      withTenantTx((tx) => tx.execute(sql`
        SELECT
          ${schema.plugin.pluginType} AS plugin_type,
          ${schema.plugin.computeType} AS compute_type,
          COUNT(*)::int AS count
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId} AND ${schema.plugin.isActive} = true
        GROUP BY ${schema.plugin.pluginType}, ${schema.plugin.computeType}
        ORDER BY count DESC
      `).then(r => drizzleRows<TypeComputeDistribution>(r.rows))),
    );
  }

  /** 2.3 Version counts per plugin name.
   *  INTENTIONALLY SINGLE-ORG (no rollup): plugin inventory is per-org (see
   *  getPluginSummary). Single `= $org` scope. */
  async getPluginVersions(orgId: string): Promise<VersionCount[]> {
    return inventoryCache.getOrSet(`${orgId}:plugin-versions`, () =>
      withTenantTx((tx) => tx.execute(sql`
        SELECT
          ${schema.plugin.name},
          COUNT(*)::int AS version_count,
          -- Highest version by NUMERIC semver core (not lexical: '10.0.0' > '9.0.0').
          -- Strip any -prerelease/+build suffix before the int[] cast so it can't
          -- error on valid semver; keep the original string for display.
          -- GUARD: a non-numeric-dotted version ('latest', '', 'v1') would make the
          -- ::int[] cast throw and blow up the WHOLE org summary. Only cast rows
          -- whose stripped core matches a numeric-dotted shape; sort everything
          -- else to the bottom via a sentinel ARRAY[-1] so the row still counts.
          (array_agg(${schema.plugin.version}
             ORDER BY CASE
               WHEN regexp_replace(${schema.plugin.version}, '[-+].*$', '') ~ '^[0-9]+([.][0-9]+)*$'
                 THEN string_to_array(regexp_replace(${schema.plugin.version}, '[-+].*$', ''), '.')::int[]
               ELSE ARRAY[-1]
             END DESC
          ))[1] AS latest_version,
          bool_or(${schema.plugin.isDefault}) AS has_default
        FROM ${schema.plugin}
        WHERE ${schema.plugin.orgId} = ${orgId} AND ${schema.plugin.isActive} = true
        GROUP BY ${schema.plugin.name}
        ORDER BY version_count DESC
      `).then(r => drizzleRows<VersionCount>(r.rows))),
    );
  }

  /**
   * 2.4 Build success rate over time.
   *
   * STATUS CASING NOTE: This query filters by `event_source = 'plugin-build'`
   * and uses lowercase status values (`'completed'`, `'failed'`), while
   * `getSuccessRate` (1.2) filters by `event_type = 'PIPELINE'` with
   * uppercase AWS-style statuses (`'SUCCEEDED'`, `'FAILED'`, `'CANCELED'`).
   * The casing drift is intentional and tracks the producer:
   *   - `plugin-build` events come from our own build pipeline (lowercase)
   *   - `PIPELINE` events come from AWS CodePipeline (uppercase)
   * The ingest Zod schema at api/reporting/src/routes/event-ingest.ts
   * SHOULD enum these per-eventSource so we catch drift at ingest rather
   * than silently producing zero rows here. See findings N71.
   */
  async getBuildSuccessRate(orgId: string, interval: string, from: string, to: string, orgIds?: string[]): Promise<BuildTimeSeriesEntry[]> {
    assertReportInterval(interval);
    // Build activity report — rollup-aware like the execution reports. These
    // rows are gated on the pipeline_event `org_id` directly (no pipeline join),
    // so `pred` applies to `e.org_id`.
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          DATE_TRUNC(${interval}, e.started_at)::text AS period,
          COUNT(*) FILTER (WHERE e.status = 'completed')::int AS succeeded,
          COUNT(*) FILTER (WHERE e.status = 'failed')::int AS failed,
          ROUND(COUNT(*) FILTER (WHERE e.status = 'completed')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1)::float AS success_pct
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build'
          AND e.status IN ('completed', 'failed')
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY period ORDER BY period
      `).then(r => drizzleRows<BuildTimeSeriesEntry>(r.rows)));
    return this.runReport(`${orgId}:build-success:${interval}:${from}:${to}`, multi, exec);
  }

  /** 2.5 Build duration per plugin. Build activity report — rollup-aware. */
  async getBuildDuration(orgId: string, from: string, to: string, orgIds?: string[]): Promise<BuildDuration[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          AVG(e.duration_ms)::int AS avg_ms,
          MAX(e.duration_ms)::int AS max_ms,
          COUNT(*)::int AS builds
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build' AND e.duration_ms IS NOT NULL
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY plugin_name ORDER BY avg_ms DESC
      `).then(r => drizzleRows<BuildDuration>(r.rows)));
    return this.runReport(`${orgId}:build-duration:${from}:${to}`, multi, exec);
  }

  /** 2.6 Build failures — top error messages. Build activity report — rollup-aware. */
  async getBuildFailures(orgId: string, from: string, to: string, limit: number = 20, orgIds?: string[]): Promise<BuildFailure[]> {
    const { pred, multi } = this.orgScope(orgId, orgIds);
    const exec = () => withTenantTx((tx) => tx.execute(sql`
        SELECT
          e.detail->>'pluginName' AS plugin_name,
          e.error_message,
          COUNT(*)::int AS occurrences,
          MAX(e.started_at)::text AS last_seen
        FROM ${schema.pipelineEvent} e
        WHERE e.org_id ${pred} AND e.event_source = 'plugin-build' AND e.status = 'failed'
          AND e.started_at >= ${from}::timestamptz AND e.started_at <= ${to}::timestamptz
        GROUP BY plugin_name, e.error_message
        ORDER BY occurrences DESC
        LIMIT ${limit}
      `).then(r => drizzleRows<BuildFailure>(r.rows)));
    return this.runReport(`${orgId}:build-failures:${from}:${to}:${limit}`, multi, exec);
  }

  // ── Category 3: DORA write paths (post-deploy outcomes + ingest health) ──

  /**
   * Record a manual post-deploy outcome marker (Phase 2): a user marks a
   * deployment `failed` (a production incident linked to the deploy) or
   * `restored` (recovered). Idempotent — keyed on (execution_id, outcome) so a
   * duplicate POST refreshes `at` rather than double-counting, while a
   * failed→restored pair stays two rows. Feeds the post-deploy CFR component and
   * the real MTTR. Runs under the caller's org context (RLS WITH CHECK).
   */
  async recordDeploymentOutcome(
    orgId: string,
    executionId: string,
    input: { outcome: 'failed' | 'restored'; at: string; environment?: string },
  ): Promise<void> {
    await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.insert(schema.deploymentOutcome).values({
        executionId,
        orgId,
        environment: scrubOptional(input.environment),
        outcome: input.outcome,
        at: new Date(input.at),
      }).onConflictDoUpdate({
        target: [schema.deploymentOutcome.executionId, schema.deploymentOutcome.outcome],
        set: {
          at: new Date(input.at),
          environment: scrubOptional(input.environment) ?? null,
        },
      })),
    );
    // Outcome changes the DORA aggregate — drop the org's cached reports.
    await this.invalidateOrg(orgId).catch((err) => {
      logger.warn('Reporting cache invalidation failed', { orgId, error: errorMessage(err) });
    });
  }

  /**
   * Ingest a production incident (Phase 5) from the org's incident tooling
   * (PagerDuty / Datadog / Alertmanager webhook). Idempotent — keyed on
   * (org_id, incident_id) so a later resolve re-post upserts `resolved_at`
   * (and refreshes the other mutable fields) instead of inserting a duplicate.
   * DORA correlates each incident to the most recent successful deploy to its
   * `environment`, producing an automated post-deploy failure + a real MTTR.
   * Runs under the caller's org context (RLS WITH CHECK); free-form fields are
   * AWS-id scrubbed at this persistence boundary like the other ingest paths.
   */
  async recordIncident(orgId: string, input: IncidentInput): Promise<void> {
    const incidentId = scrubAwsIdentifiersFromString(input.incidentId);
    const environment = scrubAwsIdentifiersFromString(input.environment);
    const severity = scrubAwsIdentifiersFromString(input.severity);
    const openedAt = new Date(input.openedAt);
    const resolvedAt = input.resolvedAt ? new Date(input.resolvedAt) : null;
    await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.insert(schema.incident).values({
        incidentId,
        orgId,
        environment,
        openedAt,
        resolvedAt,
        severity,
      }).onConflictDoUpdate({
        target: [schema.incident.orgId, schema.incident.incidentId],
        set: { environment, openedAt, resolvedAt, severity },
      })),
    );
    // A new/updated incident changes the DORA aggregate — drop cached reports.
    await this.invalidateOrg(orgId).catch((err) => {
      logger.warn('Reporting cache invalidation failed', { orgId, error: errorMessage(err) });
    });
  }

  /**
   * Read the per-org DORA settings (Phase 5b). Returns the stored
   * `incidentWindowHours` override (or `null` when unset) plus the global env
   * default, so the settings UI can show both. Runs under the caller's tenant
   * context (RLS-scoped); a single-org read.
   */
  async getIncidentSettings(orgId: string): Promise<IncidentSettings> {
    const rows = drizzleRows<{
      incident_window_hours: number | null;
      event_retention_days: number | null;
      dora_retention_days: number | null;
    }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT ${schema.doraSettings.incidentWindowHours} AS incident_window_hours,
               ${schema.doraSettings.eventRetentionDays} AS event_retention_days,
               ${schema.doraSettings.doraRetentionDays} AS dora_retention_days
        FROM ${schema.doraSettings}
        WHERE ${schema.doraSettings.orgId} = ${orgId}
        LIMIT 1
      `))).rows);
    const row = rows[0];
    return {
      incidentWindowHours: row?.incident_window_hours != null ? Number(row.incident_window_hours) : null,
      defaultWindowHours: DORA_INCIDENT_WINDOW_HOURS,
      eventRetentionDays: row?.event_retention_days != null ? Number(row.event_retention_days) : null,
      doraRetentionDays: row?.dora_retention_days != null ? Number(row.dora_retention_days) : null,
      defaultEventRetentionDays: REPORTING_EVENT_RETENTION_DAYS,
      defaultDoraRetentionDays: REPORTING_DORA_RETENTION_DAYS,
    };
  }

  /**
   * Upsert per-org reporting settings (Phase 5b incident window + Phase 7
   * retention overrides), idempotent on `org_id`. A partial write — only the
   * fields present in `patch` are set (so updating retention never clears the
   * incident window, and vice-versa). Set self-serve by an org admin via
   * `PUT /api/reports/settings/incidents`. Runs under the caller's org context
   * (RLS WITH CHECK); a changed value affects DORA aggregates so the org's
   * cached reports are dropped.
   */
  async setReportingSettings(orgId: string, patch: ReportingSettingsPatch): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.incidentWindowHours !== undefined) set.incidentWindowHours = patch.incidentWindowHours;
    if (patch.eventRetentionDays !== undefined) set.eventRetentionDays = patch.eventRetentionDays;
    if (patch.doraRetentionDays !== undefined) set.doraRetentionDays = patch.doraRetentionDays;
    await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.insert(schema.doraSettings).values({
        orgId,
        incidentWindowHours: patch.incidentWindowHours,
        eventRetentionDays: patch.eventRetentionDays,
        doraRetentionDays: patch.doraRetentionDays,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: schema.doraSettings.orgId,
        set,
      })),
    );
    await this.invalidateOrg(orgId).catch((err) => {
      logger.warn('Reporting cache invalidation failed', { orgId, error: errorMessage(err) });
    });
  }

  /**
   * List recent incidents for an org (Phase 5b org-admin surface), newest first,
   * paginated. Each row carries its resolved state and its deploy correlation —
   * the most recent SUCCESSFUL deploy to the incident's `environment` whose
   * `completed_at` falls within the effective per-org correlation window before
   * `opened_at` (the same rule DORA's CFR/MTTR correlation applies). Single-org
   * (no rollup) — an org admin views their own org's incidents. RLS-scoped via
   * the `p.org_id`/`i.org_id` predicates + the tenant context.
   */
  async listIncidents(orgId: string, opts: { limit: number; offset: number }): Promise<IncidentListItem[]> {
    const { incidentWindowHours } = await this.getIncidentSettings(orgId);
    const windowHours = resolveIncidentWindowHours(incidentWindowHours);
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const offset = Math.max(0, opts.offset);
    return withTenantTx((tx) => tx.execute(sql`
        SELECT
          i.incident_id AS "incidentId",
          i.environment AS environment,
          i.severity AS severity,
          i.opened_at::text AS "openedAt",
          i.resolved_at::text AS "resolvedAt",
          i.created_at::text AS "createdAt",
          (i.resolved_at IS NOT NULL) AS resolved,
          corr.execution_id AS "correlatedExecutionId",
          corr.completed_at::text AS "deployCompletedAt"
        FROM ${schema.incident} i
        LEFT JOIN LATERAL (
          SELECT e.execution_id, e.completed_at
          FROM ${schema.pipelineEvent} e
          JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
          WHERE p.org_id = ${orgId} AND e.event_type = 'STAGE'
            AND e.environment = i.environment AND e.status = 'SUCCEEDED'
            AND e.completed_at <= i.opened_at
            AND e.completed_at >= i.opened_at - make_interval(hours => ${windowHours}::int)
          ORDER BY e.completed_at DESC
          LIMIT 1
        ) corr ON true
        WHERE i.org_id = ${orgId}
        ORDER BY i.opened_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `).then((r) => drizzleRows<IncidentListItem>(r.rows).map((row) => ({
        ...row,
        resolved: row.resolved === true || (row.resolved as unknown) === 't',
        correlatedExecutionId: row.correlatedExecutionId ?? null,
        deployCompletedAt: row.deployCompletedAt ?? null,
      }))));
  }

  /**
   * Wiring-test dry-run (Phase 5b): would a synthetic incident opening NOW for
   * `environment` correlate to a recent successful deploy under the org's
   * effective window? This is a NON-persisting correlation check — it verifies
   * the admin's environment naming + window line up with real deploy events
   * WITHOUT writing an incident (so a "test" never pollutes CFR/MTTR). RLS-scoped.
   */
  async testIncidentCorrelation(orgId: string, environment: string): Promise<IncidentTestResult> {
    const env = scrubAwsIdentifiersFromString(environment);
    const openedAt = new Date().toISOString();
    const { incidentWindowHours } = await this.getIncidentSettings(orgId);
    const windowHours = resolveIncidentWindowHours(incidentWindowHours);
    const rows = drizzleRows<{ execution_id: string | null; completed_at: string | null }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT e.execution_id AS execution_id, e.completed_at::text AS completed_at
        FROM ${schema.pipelineEvent} e
        JOIN ${schema.pipeline} p ON p.id = e.pipeline_id
        WHERE p.org_id = ${orgId} AND e.event_type = 'STAGE'
          AND e.environment = ${env} AND e.status = 'SUCCEEDED'
          AND e.completed_at <= ${openedAt}::timestamptz
          AND e.completed_at >= ${openedAt}::timestamptz - make_interval(hours => ${windowHours}::int)
        ORDER BY e.completed_at DESC
        LIMIT 1
      `))).rows);
    const hit = rows[0];
    return {
      environment: env,
      openedAt,
      windowHours,
      correlated: hit?.execution_id != null,
      executionId: hit?.execution_id ?? null,
      deployCompletedAt: hit?.completed_at ?? null,
    };
  }

  /**
   * Upsert per-org ingestion health (Phase 3): the AWS events Lambda periodically
   * reports forwarded/dropped counters + the last event timestamp so the Reports
   * UI can show flowing / stale / dropping. One row per org (upsert on org_id).
   */
  async recordIngestHealth(
    orgId: string,
    input: { forwarded?: number; dropped?: number; lastEventAt?: string },
  ): Promise<void> {
    const lastEventAt = input.lastEventAt ? new Date(input.lastEventAt) : undefined;
    await runWithTenantContext({ orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.insert(schema.ingestHealth).values({
        orgId,
        forwarded: input.forwarded,
        dropped: input.dropped,
        lastEventAt,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: schema.ingestHealth.orgId,
        set: {
          forwarded: input.forwarded,
          dropped: input.dropped,
          lastEventAt,
          updatedAt: new Date(),
        },
      })),
    );
  }

  /**
   * Batched hard-DELETE of one reporting table's rows expired past a `created_at`
   * cutoff, scoped to an org and an optional row predicate (Phase 7). Uses a
   * `ctid`-in-subquery LIMIT so each statement touches at most `batchSize` rows
   * (short lock windows, no long table scan under lock); `RETURNING 1` lets us
   * count via `.rows.length` without depending on the driver's `rowCount`. Loops
   * until a short batch (drained) or the per-tick cap, then defers the rest.
   * MUST run inside a sysadmin tenant scope (see purgeExpiredReportingData) so it
   * bypasses RLS and can delete across the org's rows.
   */
  async #purgeReportingTableBatched(
    tableSql: ReturnType<typeof sql>,
    predicate: ReturnType<typeof sql>,
    batchSize: number,
    maxBatches: number,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const res = await withTenantTx((tx) => tx.execute(sql`
        DELETE FROM ${tableSql}
        WHERE ctid IN (
          SELECT ctid FROM ${tableSql}
          WHERE ${predicate}
          LIMIT ${batchSize}
        )
        RETURNING 1
      `));
      const purged = drizzleRows<unknown>(res.rows).length;
      total += purged;
      if (purged < batchSize) break; // drained
      if (i === maxBatches - 1) {
        logger.warn('Reporting retention hit per-tick cap; remaining rows deferred', {
          purgedThisTick: total,
        });
      }
    }
    return total;
  }

  /**
   * Reporting retention sweep (Phase 7). Hard-deletes rows older than their
   * retention window, by `created_at`, across every org that has reporting data —
   * a **split** policy so high-volume standard events expire faster than the
   * low-volume DORA source:
   *  - `pipeline_events WHERE environment IS NULL` → standard-event window.
   *  - `pipeline_events WHERE environment IS NOT NULL` (deploy stages),
   *    `deployment_outcomes`, and `incidents` → DORA-source window.
   * Each org's windows come from its `dora_settings` override, else the global
   * env defaults (see {@link resolveEventRetentionDays} / {@link resolveDoraRetentionDays}).
   * `ingest_health` and `dora_settings` are never purged. One `now` for the whole
   * tick (rows crossing the boundary mid-sweep wait for the next). Establishes a
   * sysadmin tenant scope so the deletes span all orgs / bypass RLS — this is a
   * cross-tenant housekeeping job. Returns (and logs) per-window purge tallies.
   */
  async purgeExpiredReportingData(opts: ReportingRetentionOptions = {}): Promise<ReportingRetentionCounts> {
    const batchSize = Math.max(1, opts.batchSize ?? 1000);
    const maxBatches = Math.max(1, opts.maxBatchesPerTable ?? 50);
    const now = opts.now ?? new Date();
    const counts: ReportingRetentionCounts = {
      orgs: 0, standardEvents: 0, doraEvents: 0, deploymentOutcomes: 0, incidents: 0,
    };

    return runWithTenantContext({ isSuperAdmin: true }, async () => {
      // Enumerate every org with reporting data (union across the three tables).
      const orgRows = drizzleRows<{ org_id: string }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT DISTINCT org_id FROM (
          SELECT ${schema.pipelineEvent.orgId} AS org_id FROM ${schema.pipelineEvent}
          UNION
          SELECT ${schema.deploymentOutcome.orgId} AS org_id FROM ${schema.deploymentOutcome}
          UNION
          SELECT ${schema.incident.orgId} AS org_id FROM ${schema.incident}
        ) AS orgs
      `))).rows);
      if (orgRows.length === 0) return counts;

      // Per-org retention overrides (a single read; orgs without a row use defaults).
      const overrideRows = drizzleRows<{
        org_id: string;
        event_retention_days: number | null;
        dora_retention_days: number | null;
      }>((await withTenantTx((tx) => tx.execute(sql`
        SELECT ${schema.doraSettings.orgId} AS org_id,
               ${schema.doraSettings.eventRetentionDays} AS event_retention_days,
               ${schema.doraSettings.doraRetentionDays} AS dora_retention_days
        FROM ${schema.doraSettings}
      `))).rows);
      const overrides = new Map(overrideRows.map((r) => [r.org_id, r]));

      const eventsTable = sql`${schema.pipelineEvent}`;
      const outcomesTable = sql`${schema.deploymentOutcome}`;
      const incidentsTable = sql`${schema.incident}`;

      for (const { org_id: orgId } of orgRows) {
        const ov = overrides.get(orgId);
        const eventDays = resolveEventRetentionDays(ov?.event_retention_days);
        const doraDays = resolveDoraRetentionDays(ov?.dora_retention_days);
        // `-1` = unlimited (Phase 8): keep forever, skip that window's deletes for
        // this org. Standard-event and DORA-source windows are independent; an org
        // with both `-1` is fully skipped. Log the skip so it's observable.
        const skipEvents = eventDays === -1;
        const skipDora = doraDays === -1;
        if (skipEvents || skipDora) {
          logger.info('Reporting retention sweep skipping unlimited window(s)', {
            orgId,
            standardEvents: skipEvents ? 'unlimited' : eventDays,
            doraSource: skipDora ? 'unlimited' : doraDays,
          });
        }

        if (!skipEvents) {
          const eventCutoff = retentionCutoff(now, eventDays);
          counts.standardEvents += await this.#purgeReportingTableBatched(
            eventsTable,
            sql`org_id = ${orgId} AND environment IS NULL AND created_at < ${eventCutoff}`,
            batchSize, maxBatches,
          );
        }

        if (!skipDora) {
          const doraCutoff = retentionCutoff(now, doraDays);
          counts.doraEvents += await this.#purgeReportingTableBatched(
            eventsTable,
            sql`org_id = ${orgId} AND environment IS NOT NULL AND created_at < ${doraCutoff}`,
            batchSize, maxBatches,
          );
          counts.deploymentOutcomes += await this.#purgeReportingTableBatched(
            outcomesTable,
            sql`org_id = ${orgId} AND created_at < ${doraCutoff}`,
            batchSize, maxBatches,
          );
          counts.incidents += await this.#purgeReportingTableBatched(
            incidentsTable,
            sql`org_id = ${orgId} AND created_at < ${doraCutoff}`,
            batchSize, maxBatches,
          );
        }
        counts.orgs += 1;
      }

      const purgedAny = counts.standardEvents + counts.doraEvents + counts.deploymentOutcomes + counts.incidents;
      if (purgedAny > 0) logger.info('Reporting retention sweep purged expired rows', { ...counts });
      return counts;
    });
  }
}

export const reportingService = new ReportingService();
