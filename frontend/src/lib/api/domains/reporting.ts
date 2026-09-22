// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse } from '@/types';

/** DORA performance band for a metric (elite → low), or null when unrated. */
export type DoraLevel = 'elite' | 'high' | 'medium' | 'low' | null;

/**
 * DORA metrics for a single deployment environment. Deploy-basis only — computed
 * over deploy-stage executions attributed to this environment.
 */
export interface DoraEnvMetrics {
  environment: string;
  /** Successful deploy-stage executions in the window (+ per-day rate). */
  deploymentFrequency: { deployments: number; perDay: number };
  /**
   * Measured commit→deploy lead time. `medianSeconds` null = "unknown" (commit
   * timestamps couldn't be resolved for the in-window deploys). No proxy.
   */
  leadTime: { deployments: number; medianSeconds: number | null; level: DoraLevel };
  /**
   * Change-failure rate = (deploy-time failures + post-deploy failures) / attempts.
   * `rate` is a percentage (0–100). Deploy-time failures come from failed deploy
   * stages; post-deploy failures from deployments manually marked failed.
   */
  changeFailureRate: {
    rate: number;
    deployTimeFailures: number;
    postDeployFailures: number;
    attempts: number;
    level: DoraLevel;
  };
}

/**
 * DORA metrics envelope returned under `data.dora`. Deploy-basis, per-environment
 * (no run-basis fallback, no lead-time proxy, no inferred CFR/MTTR). Deployment
 * frequency / lead time / CFR are per-environment; MTTR + coverage are top-level.
 */
export interface DoraMetrics {
  window: { from: string; to: string };
  /** Active scoping filters echoed back by the backend. */
  filters: { pipelineId: string | null; environment: string | null };
  /** The headline environment name (e.g. `production`). */
  headline: string;
  /** Per-environment metrics, sorted headline-first then A→Z. */
  environments: DoraEnvMetrics[];
  /**
   * Mean (median) time to restore over post-deploy incidents (production-only).
   * `medianSeconds` is null when no incidents were restored in-window.
   */
  meanTimeToRestore: { incidents: number; restored: number; medianSeconds: number | null };
  /**
   * Coverage reconciliation: registered pipelines vs. how many produced observed
   * deploys (`deploying`) vs. none (`withoutDeploys`) in the window.
   */
  coverage: { registered: number; deploying: number; withoutDeploys: number };
}

/** One deploy execution row for the DORA deploy list (mark failed/restored). */
export interface DeploymentRow {
  execution_id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  failing_stage: string | null;
  failing_action: string | null;
}

/** One bucket of the DORA trend series returned under `data.trend`. */
export interface DoraTrendPoint {
  period: string;
  deployments: number;
  failed: number;
  total: number;
}

/** Per-stage build-health metrics for one pipeline (Phase 6). */
export interface BuildHealthStage {
  stage: string;
  runs: number;
  successes: number;
  failures: number;
  /** successes / runs as a percent (0–100). */
  successRate: number;
  /** Duration percentiles (ms) over the stage's terminal runs; null when no durations. */
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
}

/**
 * Per-pipeline build-health breakdown (Phase 6), returned under `data.buildHealth`.
 * Standard reporting — available on EVERY tier (NOT `advanced_reporting`-gated).
 */
export interface BuildHealth {
  stages: BuildHealthStage[];
  totals: { runs: number; failures: number; failureRate: number };
}

/**
 * What the AWS events forwarder last reported for this org (Phase 3). Written by
 * the ingest Lambda's heartbeat; read by the Reports freshness indicator.
 */
export interface IngestHealth {
  /** When the forwarder last posted a heartbeat (ISO 8601). */
  updatedAt: string;
  /** Timestamp of the newest event it had forwarded, or null if it has seen none. */
  lastEventAt: string | null;
  /** Cumulative events forwarded, or null when the forwarder doesn't report it. */
  forwarded: number | null;
  /** Cumulative events dropped — non-zero means data loss upstream of the reports. */
  dropped: number | null;
}

/**
 * `GET /reports/ingest-health`. `health` is null when the deployment has NEVER
 * reported — a state the UI must state plainly rather than dress up as "stale".
 * `now` is the SERVER clock, so a skewed browser can't fake (or hide) staleness.
 */
export interface IngestHealthResponse {
  health: IngestHealth | null;
  now: string;
}

/**
 * Per-org reporting settings — the incident correlation-window override (Phase 5b)
 * plus the two split retention windows (Phase 7). Each override is null when unset
 * (the paired default* field shows the env fallback applied).
 */
export interface IncidentSettings {
  /** The org's stored override in hours, or null when unset (env default applies). */
  incidentWindowHours: number | null;
  /** The global env default applied when no override is stored. */
  defaultWindowHours: number;
  /** Standard-event retention override in days, or null when unset (Phase 7). */
  eventRetentionDays: number | null;
  /** DORA-source retention override in days, or null when unset (Phase 7). */
  doraRetentionDays: number | null;
  /** Global standard-event retention default applied when unset (days). */
  defaultEventRetentionDays: number;
  /** Global DORA-source retention default applied when unset (days). */
  defaultDoraRetentionDays: number;
}

/**
 * `GET /reports/retention` — the org's EFFECTIVE report retention (override ??
 * env default), readable with `reports:read` alone. The Retention Pack is sold
 * to every tier, so this is what the Reports date-range cap reads (the
 * incident settings above carry the same numbers but need `advanced_reporting`).
 */
export interface ReportRetention {
  /** Standard-event retention horizon in days (`-1` = unlimited). */
  eventRetentionDays: number;
  /** DORA-source retention horizon in days (`-1` = unlimited). */
  doraRetentionDays: number;
  /** Widest Pipelines/Plugins window the backend serves (horizon ∧ 730-day ceiling). */
  eventMaxRangeDays: number;
  /** Widest DORA window the backend serves (horizon ∧ 730-day ceiling). */
  doraMaxRangeDays: number;
}

/**
 * A partial reporting-settings write. Only the incident correlation window is
 * admin-writable — retention is BILLING-OWNED (synced from the retention/DORA-
 * History packs), so it is NOT part of this patch and is shown read-only.
 */
export interface ReportingSettingsPatch {
  incidentWindowHours?: number;
}

/** One row of the org-admin incidents list (recent incidents + deploy correlation). */
export interface IncidentListItem {
  incidentId: string;
  environment: string;
  severity: string;
  openedAt: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  resolved: boolean;
  correlatedExecutionId: string | null;
  deployCompletedAt: string | null;
}

/** Result of the wiring-test dry-run correlation (Phase 5b). */
export interface IncidentTestResult {
  environment: string;
  openedAt: string;
  windowHours: number;
  correlated: boolean;
  executionId: string | null;
  deployCompletedAt: string | null;
}

export function reportingApi(core: ApiCore) {
  return {
    // ============================================
    // Reporting endpoints
    // ============================================

    /** Distinct deploy environments observed in the window (for the DORA env datalist). */
    getReportEnvironments: async (params?: { from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ environments: string[] }>>(`/api/reports/execution/environments${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Exchange the JWT for a single-use, org-bound ticket to open the live execution-status SSE stream. */
    getExecutionStreamTicket: async (): Promise<string> => {
      const res = await core.request<ApiResponse<{ ticket: string }>>('/api/reports/execution/stream/ticket', { method: 'POST' });
      if (!res.data?.ticket) throw new Error('Failed to obtain execution-stream ticket');
      return res.data.ticket;
    },

    /** Pipeline execution count per pipeline with status breakdown. */
    getExecutionCount: async (params?: { from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ pipelines: Array<{ id: string; project: string; organization: string; pipeline_name: string | null; total: number; succeeded: number; failed: number; canceled: number; first_execution: string | null; last_execution: string | null }> }>>(`/api/reports/execution/count${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Per-pipeline execution history — recent runs for a single pipeline, newest first. */
    listPipelineExecutions: async (pipelineId: string, params?: { from?: string; to?: string; limit?: number; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ executions: Array<{ execution_id: string; status: string; started_at: string | null; ended_at: string | null; duration_ms: number | null; failing_stage: string | null; failing_action: string | null }> }>>(`/api/reports/execution/list${buildQuery({ pipelineId, ...params })}`, { signal: opts?.signal });
    },

    /** Pipeline success rate over time. */
    getSuccessRate: async (params?: { interval?: string; from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ timeline: Array<{ period: string; succeeded: number; failed: number; canceled: number; success_pct: number }> }>>(`/api/reports/execution/success-rate${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Average pipeline duration stats. */
    getPipelineDuration: async (params?: { from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ pipelines: Array<{ id: string; project: string; pipeline_name: string | null; avg_ms: number; min_ms: number; max_ms: number; p95_ms: number; executions: number }> }>>(`/api/reports/execution/duration${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Stage failure heatmap. */
    getStageFailures: async (params?: { from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ stages: Array<{ stage_name: string; failures: number; total: number; failure_pct: number }> }>>(`/api/reports/execution/stage-failures${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Stage bottlenecks — slowest stages. */
    getStageBottlenecks: async (params?: { from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ stages: Array<{ id: string; pipeline_name: string | null; stage_name: string; avg_ms: number; max_ms: number }> }>>(`/api/reports/execution/stage-bottlenecks${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Action failure rate. */
    getActionFailures: async (params?: { from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ actions: Array<{ action_name: string; failures: number; total: number; failure_pct: number }> }>>(`/api/reports/execution/action-failures${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Error categorization. System-admin only on the backend. */
    getExecutionErrors: async (params?: { from?: string; to?: string; limit?: number; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ errors: Array<{ error_pattern: string; occurrences: number; affected_pipelines: number; last_seen: string }> }>>(`/api/reports/execution/errors${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** DORA metrics (deployment frequency, change failure rate, MTTR, lead time). Deploy-basis. */
    getDora: async (params?: { from?: string; to?: string; includeDescendants?: boolean; pipelineId?: string; environment?: string }, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ dora: DoraMetrics }>>(`/api/reports/execution/dora${buildQuery(params)}`, { signal: opts?.signal });
      return res.data?.dora;
    },

    /** DORA change-failure trend over time (deployments / failures per bucket). Deploy-basis. */
    getDoraTrend: async (params?: { interval?: string; from?: string; to?: string; includeDescendants?: boolean; pipelineId?: string; environment?: string }, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ trend: DoraTrendPoint[] }>>(`/api/reports/execution/dora/trend${buildQuery(params)}`, { signal: opts?.signal });
      return res.data?.trend ?? [];
    },

    /**
     * Mark a deployment's post-deploy outcome — `failed` (a shipped deploy later
     * found broken) or `restored` (the recovery). Feeds the post-deploy component
     * of change-failure rate + MTTR. `advanced_reporting`-gated on the backend.
     * `at` is the ISO 8601 time the failure/restoration occurred.
     */
    markDeploymentOutcome: async (
      executionId: string,
      body: { outcome: 'failed' | 'restored'; at: string; environment: string },
    ) => {
      return core.request<ApiResponse<{ message: string }>>(
        `/api/reports/deployments/${encodeURIComponent(executionId)}/outcome`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    // ============================================
    // Ingestion health (Phase 3)
    // ============================================

    /**
     * This org's ingestion health — what the AWS events forwarder last reported.
     * `health: null` means the deployment has NEVER reported (no row), which is
     * NOT the same as stale; `now` is the server clock, so staleness is measured
     * without trusting the browser's. `reports:read`, org-scoped.
     */
    getIngestHealth: async (signal?: AbortSignal) => {
      const res = await core.request<ApiResponse<IngestHealthResponse>>('/api/reports/ingest-health', { signal });
      return res.data;
    },

    /** The org's effective retention windows + servable range caps (`reports:read`). */
    getReportRetention: async (opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ retention: ReportRetention }>>('/api/reports/retention', { signal: opts?.signal });
      return res.data?.retention;
    },

    // ============================================
    // Incident reporting config + surfaces (Phase 5b)
    // ============================================

    /** Read the per-org incident correlation-window setting (+ the env default). */
    getIncidentSettings: async () => {
      const res = await core.request<ApiResponse<{ settings: IncidentSettings }>>('/api/reports/settings/incidents');
      return res.data?.settings;
    },

    /**
     * Update per-org reporting settings (org-admin). Only the incident
     * correlation window is writable here; retention is billing-owned (synced
     * from purchased packs) and must NOT be sent. Backend validates bounds +
     * org-admin `org:settings`.
     */
    putReportingSettings: async (patch: ReportingSettingsPatch) => {
      const res = await core.request<ApiResponse<{ settings: IncidentSettings }>>('/api/reports/settings/incidents', {
        method: 'PUT', body: JSON.stringify(patch),
      });
      return res.data?.settings;
    },

    /** Recent incidents + their deploy correlation + resolved state (org-admin), paginated. */
    listIncidents: async (params?: { limit?: number; offset?: number }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ incidents: IncidentListItem[]; pagination: { limit: number; offset: number; hasMore: boolean } }>>(
        `/api/reports/incidents${buildQuery(params)}`, { signal: opts?.signal },
      );
    },

    /** Send a synthetic (non-persisting) test incident to verify wiring/correlation (org-admin). */
    sendTestIncident: async (environment?: string) => {
      const res = await core.request<ApiResponse<{ test: IncidentTestResult }>>('/api/reports/incidents/test', {
        method: 'POST', body: JSON.stringify(environment ? { environment } : {}),
      });
      return res.data?.test;
    },

    /**
     * Per-pipeline build health — per-stage success rate + duration percentiles
     * over a [from,to] window. Standard reporting (every tier); `reports:read`
     * only (NOT `advanced_reporting`). `pipelineId` is required.
     */
    getBuildHealth: async (pipelineId: string, params?: { from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ buildHealth: BuildHealth }>>(`/api/reports/execution/build-health${buildQuery({ pipelineId, ...params })}`, { signal: opts?.signal });
      return res.data?.buildHealth;
    },

    /** Plugin inventory summary. */
    getPluginSummary: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ summary: { total: number; active: number; inactive: number; public: number; private: number; unique_names: number } }>>('/api/reports/plugins/summary', { signal: opts?.signal });
    },

    /** Plugin type & compute distribution. */
    getPluginDistribution: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ distribution: Array<{ plugin_type: string; compute_type: string; count: number }> }>>('/api/reports/plugins/distribution', { signal: opts?.signal });
    },

    /** Plugin version counts. */
    getPluginVersions: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ plugins: Array<{ name: string; version_count: number; latest_version: string; has_default: boolean }> }>>('/api/reports/plugins/versions', { signal: opts?.signal });
    },

    /** Plugin build success rate over time. */
    getBuildSuccessRate: async (params?: { interval?: string; from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ timeline: Array<{ period: string; succeeded: number; failed: number; success_pct: number }> }>>(`/api/reports/plugins/build-success-rate${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Plugin build duration stats. */
    getBuildDuration: async (params?: { from?: string; to?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ plugins: Array<{ plugin_name: string; avg_ms: number; max_ms: number; builds: number }> }>>(`/api/reports/plugins/build-duration${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** How plugins behave when pipelines RUN them: runs/succeeded/failed per plugin version. */
    getPluginRuntimeSuccessRate: async (params?: { from?: string; to?: string; name?: string; publisher?: string; version?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ plugins: Array<{ pluginPublisher: string | null; pluginName: string; pluginVersion: string; runs: number; succeeded: number; failed: number; successPct: number; lastRun: string }> }>>(`/api/reports/plugins/runtime-success-rate${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Run-time step duration (p50/p95) per plugin version. */
    getPluginRuntimeDuration: async (params?: { from?: string; to?: string; name?: string; publisher?: string; version?: string; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ plugins: Array<{ pluginPublisher: string | null; pluginName: string; pluginVersion: string; runs: number; p50Ms: number | null; p95Ms: number | null }> }>>(`/api/reports/plugins/runtime-duration${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Plugin build failures. System-admin only on the backend. */
    getBuildFailures: async (params?: { from?: string; to?: string; limit?: number; includeDescendants?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ failures: Array<{ plugin_name: string; error_message: string; occurrences: number; last_seen: string }> }>>(`/api/reports/plugins/build-failures${buildQuery(params)}`, { signal: opts?.signal });
    },
  };
}
