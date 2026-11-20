// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Team benchmarking (the Reports → Teams tab) and the period-over-period
 * comparison on the dashboard headlines (`?compare=previous`).
 *
 * The benchmark shapes mirror pipeline-data's `team-benchmark.ts` exactly (kept
 * in step by test/wire-type-drift.test.ts): one row per team plus the parent org,
 * each built from that team's OWN dashboard reads. All three reads here are
 * `advanced_reporting`; the benchmark additionally needs `reports:rollup`.
 */

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { DoraLevel, DoraMetrics, ReportBucketParams } from './reporting';
import type { ApiResponse } from '@/types';

/** A DORA measure as a benchmark cell: the value, its band and the sample it rests on. */
export interface BenchmarkCell<V> {
  value: V;
  /** `insufficient` when `n` is under MIN_DORA_SAMPLE; null when there is no sample. */
  level: DoraLevel;
  n: number;
}

/** Success rate over the window, from the success-rate report's buckets. */
export interface BenchmarkSuccess {
  /** Succeeded ÷ (succeeded + failed + canceled) × 100, one decimal; null with no runs. */
  pct: number | null;
  runs: number;
  succeeded: number;
  failed: number;
  canceled: number;
}

export interface TeamBenchmarkRow {
  orgId: string;
  name: string | null;
  /** `parent` = the org the table was read for; `team` = a descendant. */
  role: 'parent' | 'team';
  /** `failed` = this org's reads failed; its figures are absent. */
  state: 'ok' | 'failed';
  /** The headline environment the DORA cells describe, or null when none deployed. */
  environment: string | null;
  deploymentFrequency: BenchmarkCell<{ deployments: number; perDay: number }> | null;
  changeFailureRate: BenchmarkCell<{ rate: number; attempts: number }> | null;
  leadTime: BenchmarkCell<{ medianSeconds: number | null }> | null;
  timeToRestore: BenchmarkCell<{ medianSeconds: number | null }> | null;
  successRate: BenchmarkSuccess | null;
}

/** `GET /reports/benchmark/teams`. `hasTeams: false` ⇒ no rows (the org parents no teams). */
export interface TeamBenchmarkResult {
  hasTeams: boolean;
  window?: {
    dora: { from: string; to: string };
    events: { from: string; to: string };
    tz: string;
    weekStart: 'monday' | 'sunday';
  };
  rows: TeamBenchmarkRow[];
}

export type TeamBenchmarkParams = {
  from?: string;
  to?: string;
  interval?: string;
} & ReportBucketParams;

/** One success-rate bucket (the /execution/success-rate timeline row). */
export interface SuccessRatePoint { period: string; succeeded: number; failed: number; canceled: number; success_pct: number }

/** `/execution/dora?compare=previous`: the range and the equal-length window before it. */
export interface DoraComparison {
  dora: DoraMetrics;
  /** Null when the previous window starts before the DORA retention horizon. */
  previous: DoraMetrics | null;
}

/** `/execution/success-rate?compare=previous`. */
export interface SuccessRateComparison {
  timeline: SuccessRatePoint[];
  previous: { window: { from: string; to: string }; timeline: SuccessRatePoint[] } | null;
}

export function reportingBenchmarkApi(core: ApiCore) {
  return {
    /** One row per team plus the org itself (reports:rollup + advanced_reporting). */
    getTeamBenchmark: async (params?: TeamBenchmarkParams, opts?: { signal?: AbortSignal }): Promise<TeamBenchmarkResult | null> => {
      const res = await core.request<ApiResponse<{ benchmark: TeamBenchmarkResult }>>(`/api/reports/benchmark/teams${buildQuery(params)}`, { signal: opts?.signal });
      return res.data?.benchmark ?? null;
    },

    /** The DORA headline for the range AND the previous equal-length window (advanced_reporting). */
    getDoraComparison: async (
      params: { from: string; to: string; includeDescendants?: boolean; pipelineId?: string; environment?: string },
      opts?: { signal?: AbortSignal },
    ): Promise<DoraComparison | null> => {
      const res = await core.request<ApiResponse<DoraComparison>>(`/api/reports/execution/dora${buildQuery({ ...params, compare: 'previous' })}`, { signal: opts?.signal });
      return res.data?.dora ? { dora: res.data.dora, previous: res.data.previous ?? null } : null;
    },

    /** The success-rate timeline for the range AND the previous equal-length window (advanced_reporting). */
    getSuccessRateComparison: async (
      params: { interval?: string; from?: string; to?: string; includeDescendants?: boolean } & ReportBucketParams,
      opts?: { signal?: AbortSignal },
    ): Promise<SuccessRateComparison | null> => {
      const res = await core.request<ApiResponse<SuccessRateComparison>>(`/api/reports/execution/success-rate${buildQuery({ ...params, compare: 'previous' })}`, { signal: opts?.signal });
      return res.data?.timeline ? { timeline: res.data.timeline, previous: res.data.previous ?? null } : null;
    },
  };
}
