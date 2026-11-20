// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Delivery reports (`GET /reports/delivery/*`).
 *  - `runners`: run latency and runner reliability. `reports:read` (free).
 *  - `calendar`: deployment calendar and change volume. `reports:read` +
 *    `advanced_reporting`.
 * Org-scoped, rollup-aware, bucketed / day-counted in `tz` (and `weekStart` for
 * the runner series). The shapes mirror packages/pipeline-data's
 * `api/reporting/delivery.ts` (kept in step by test/wire-type-drift).
 */

import type { RunnerErrorCategory, RunnerHealth, RunnerStatus } from '@pipeline-builder/api-core/pipeline-runners';
import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ReportBucketParams } from './reporting';
import type { ApiResponse } from '@/types';

export interface RunOutcomeCounts {
  requests: number;
  started: number;
  failed: number;
  expired: number;
  refused: number;
  pending: number;
}

/** One bucket of the run-request series. `period` is a local wall-clock bucket start. */
export interface RunRequestTrendPoint extends RunOutcomeCounts {
  period: string;
}

export interface RunnerFailureCode {
  /** A RUNNER_ERRORS code, or `OTHER`. */
  code: string;
  category: RunnerErrorCategory | 'other';
  count: number;
}

export interface RunnerReliabilityRow extends RunOutcomeCounts {
  runnerId: string;
  /** Null for a parent's runner that is no longer shared. */
  label: string | null;
  ownership: 'own' | 'shared';
  health: RunnerHealth | null;
  status: RunnerStatus | null;
  consecutiveFailures: number | null;
  lastDeliveryAt: string | null;
  failureRatePct: number | null;
}

export interface RunnerReliabilityReport {
  window: { from: string; to: string };
  totals: RunOutcomeCounts & { failureRatePct: number | null };
  trend: RunRequestTrendPoint[];
  latency: { n: number; medianSeconds: number | null; p90Seconds: number | null };
  topFailureCodes: RunnerFailureCode[];
  runners: RunnerReliabilityRow[];
}

export interface CalendarDay {
  /** `YYYY-MM-DD` in the report timezone. */
  day: string;
  environment: string;
  deployments: number;
  failed: number;
}

export type ProductionDeployOutcome = 'succeeded' | 'failed' | 'post_deploy_failure';

export interface ProductionDeploy {
  executionId: string;
  pipelineId: string | null;
  pipelineName: string | null;
  environment: string;
  deployedAt: string;
  commitCount: number | null;
  outcome: ProductionDeployOutcome;
}

export interface DeploymentCalendarReport {
  window: { from: string; to: string };
  tz: string;
  days: CalendarDay[];
  environments: string[];
  totals: { deployments: number; failed: number; commits: number };
  commitsPerDeploy: { n: number; median: number | null; p90: number | null };
  productionDeploys: { count: number; items: ProductionDeploy[] };
}

/** The query both reads take. */
export type DeliveryReportParams = {
  from?: string;
  to?: string;
  interval?: 'day' | 'week' | 'month';
  includeDescendants?: boolean;
} & ReportBucketParams;

export function reportingDeliveryApi(core: ApiCore) {
  return {
    /** Run latency and runner reliability. `reports:read` (free). */
    getRunnerReliability: async (params?: DeliveryReportParams, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ runners: RunnerReliabilityReport }>>(
        `/api/reports/delivery/runners${buildQuery(params)}`, { signal: opts?.signal },
      );
      return res.data?.runners ?? null;
    },

    /** Deployment calendar and change volume. `advanced_reporting`. */
    getDeploymentCalendar: async (params?: DeliveryReportParams, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ calendar: DeploymentCalendarReport }>>(
        `/api/reports/delivery/calendar${buildQuery(params)}`, { signal: opts?.signal },
      );
      return res.data?.calendar ?? null;
    },
  };
}
