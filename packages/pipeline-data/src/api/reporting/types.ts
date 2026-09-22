// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Public result shapes for the reporting service.
 *
 * Split out of reporting-service.ts purely for size: these are data contracts
 * with no behaviour. reporting-service.ts re-exports them, so the
 * `@pipeline-builder/pipeline-data` public surface is unchanged.
 */

export interface ExecutionCount {
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

export interface TimeSeriesEntry {
  period: string;
  succeeded: number;
  failed: number;
  canceled: number;
  successPct: number;
}

export interface DurationStats {
  id: string;
  project: string;
  pipelineName: string | null;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  executions: number;
}

export interface PipelineExecution {
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

export interface StageFailure {
  stageName: string;
  failures: number;
  total: number;
  failurePct: number;
}

export interface StageBottleneck {
  id: string;
  pipelineName: string | null;
  stageName: string;
  avgMs: number;
  maxMs: number;
}

export interface ActionFailure {
  actionName: string;
  failures: number;
  total: number;
  failurePct: number;
}

export interface ErrorEntry {
  errorPattern: string;
  occurrences: number;
  affectedPipelines: number;
  lastSeen: string;
}

export interface PluginSummary {
  total: number;
  active: number;
  inactive: number;
  /** Counts per sharing rung — one bucket per `visibility` value. */
  public: number;
  org: number;
  private: number;
  uniqueNames: number;
}

export interface TypeComputeDistribution {
  pluginType: string;
  computeType: string;
  count: number;
}

export interface VersionCount {
  name: string;
  versionCount: number;
  latestVersion: string;
  hasDefault: boolean;
}

export interface BuildTimeSeriesEntry {
  period: string;
  succeeded: number;
  failed: number;
  successPct: number;
}

export interface BuildDuration {
  pluginName: string;
  avgMs: number;
  maxMs: number;
  builds: number;
}

/**
 * Plugin runtime report filters (W0.1). `publisher: null` selects own-org
 * (publisher-less) plugins; an omitted field doesn't filter.
 */
export interface PluginRuntimeFilter {
  name?: string;
  publisher?: string | null;
  version?: string;
}

/** Per plugin version runtime stats over a window (terminal ACTION runs). */
export interface PluginRuntimeStats {
  pluginPublisher: string | null;
  pluginName: string;
  pluginVersion: string;
  runs: number;
  succeeded: number;
  failed: number;
  /** 0–100, one decimal. */
  successPct: number;
  /** Null when no run in the group carried a duration. */
  p50Ms: number | null;
  p95Ms: number | null;
  lastRun: string;
}

/** Cross-org 30-day aggregate for one `(publisher, name)` listing. */
export interface PluginRuntimeAggregate {
  runs30d: number;
  /** 0–1; null when there were no runs. */
  successRate30d: number | null;
  activeOrgCount30d: number;
}

export interface BuildFailure {
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
  /**
   * Every org with at least one row in this batch, deduped.
   *
   * Already computed for post-commit cache invalidation; surfaced because the
   * ingest route needs the same set to push its live SSE frame. That fan-out
   * used to be driven off the stage-metric hook, which only fires for STAGE
   * events — so a batch of PIPELINE or BUILD events landed rows and pushed no
   * frame at all, and the dashboard silently went back to needing a manual
   * refresh for exactly the events an execution view is about.
   */
  affectedOrgs: string[];
}

/**
 * One org's ingestion-health row as READ back by the Reports UI (Phase 3). The
 * AWS events Lambda writes it; this is the shape that lets the UI tell
 * "ingestion is healthy, there were simply no deploys in the range" apart from
 * "we haven't heard from the ingest pipeline since X".
 *
 * `null` from {@link ReportingService.getIngestHealth} means the deployment has
 * NEVER reported — not "stale". The two must not be conflated: a fresh install
 * (or one whose forwarder was never wired up) has no heartbeat at all, and
 * calling that "stale" would invent a regression that never happened.
 */
export interface IngestHealthStatus {
  /** When the forwarder last posted a heartbeat (its own clock, ISO 8601). */
  updatedAt: string;
  /** Timestamp of the newest event it had forwarded, or null if it has seen none. */
  lastEventAt: string | null;
  /** Cumulative events forwarded, or null when the forwarder doesn't report it. */
  forwarded: number | null;
  /** Cumulative events DROPPED (non-zero ⇒ data loss upstream of the reports). */
  dropped: number | null;
}


/**
 * Read-only reporting service for pipeline execution and plugin inventory aggregations.
 * Does not extend CrudService — reports are aggregate queries, not entity CRUD.
 *
 * All queries are cached in-memory to avoid repeated expensive SQL aggregations:
 * - Inventory queries (plugin summary/distribution/versions): 5 min TTL
 * - Timeseries queries (execution/build metrics with date ranges): 2 min TTL
 */

/**
 * Internal row shapes for the DORA queries. Exported because ./dora.ts consumes
 * them; not part of the package's public surface (reporting-service.ts
 * re-exports this module wholesale, which is a deliberate simplification — these
 * describe query results, not API contracts).
 */
export interface DeployRow {
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
export interface OutcomeRow {
  environment: string | null;
  outcome: 'failed' | 'restored' | string;
  /** Execution the user marked — dedup key against incident-correlated deploys. */
  execution_id: string | null;
}

/** Production restored-incident pair: recovery time + the deploy's completion. */
export interface MttrPairRow {
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
export interface IncidentRow {
  environment: string;
  opened_at: string | null;
  resolved_at: string | null;
}

/** Coverage counts: registered pipelines vs those that actually deployed. */
export interface CoverageRow {
  registered: number | string | null;
  deploying: number | string | null;
}
