// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Flow reports (`GET /reports/flow/*`): where pipeline time goes waiting.
 * All `reports:read`, org-scoped, rollup-aware, bucketed by `interval` / `tz` /
 * `weekStart`.
 *  - `/approvals`   manual approval waits — `advanced_reporting`.
 *  - `/queue`       queue / provisioning time, pipeline start → first stage — free.
 *  - `/queue/trend` the same per bucket — `advanced_reporting`.
 * Wire types mirror packages/pipeline-data/src/api/reporting/flow.ts.
 */

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ReportBucketParams } from './reporting';
import type { ApiResponse } from '@/types';

/** A wait distribution in whole seconds; null figures when nothing was measured. */
export interface WaitStats {
  n: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface ApprovalTrendPoint {
  /** Local wall-clock bucket start. */
  period: string;
  approvals: number;
  approved: number;
  /** AWS reports a rejection and an expiry the same way (FAILED). */
  rejectedOrExpired: number;
  /** Stopped / superseded / abandoned around the approval. */
  undecided: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface ApprovalStage {
  pipelineId: string;
  pipelineName: string | null;
  stageName: string;
  approvals: number;
  rejectedOrExpired: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  maxSeconds: number | null;
}

export interface ApprovalWaitReport {
  window: { from: string; to: string };
  totals: { approvals: number; approved: number; rejectedOrExpired: number; undecided: number; wait: WaitStats };
  trend: ApprovalTrendPoint[];
  slowestStages: ApprovalStage[];
}

export interface QueueByComputeType {
  computeType: string;
  builds: number;
  queueMedianSeconds: number | null;
  queueP90Seconds: number | null;
  provisioningMedianSeconds: number | null;
  provisioningP90Seconds: number | null;
}

export interface QueueAction {
  pipelineId: string;
  pipelineName: string | null;
  stageName: string | null;
  actionName: string | null;
  builds: number;
  queueMedianSeconds: number | null;
  queueP90Seconds: number | null;
  provisioningMedianSeconds: number | null;
  provisioningP90Seconds: number | null;
  totalWaitP90Seconds: number | null;
}

export interface QueueWaitReport {
  window: { from: string; to: string };
  builds: number;
  queue: WaitStats;
  provisioning: WaitStats;
  byComputeType: QueueByComputeType[];
  slowestActions: QueueAction[];
  startToFirstStage: WaitStats;
}

export interface QueueTrendPoint {
  period: string;
  builds: number;
  queueMedianSeconds: number | null;
  queueP90Seconds: number | null;
  provisioningMedianSeconds: number | null;
  provisioningP90Seconds: number | null;
  executions: number;
  startToFirstStageMedianSeconds: number | null;
  startToFirstStageP90Seconds: number | null;
}

/** The query every Flow read takes. */
export type FlowReportParams = {
  from?: string;
  to?: string;
  interval?: 'day' | 'week' | 'month';
  includeDescendants?: boolean;
} & ReportBucketParams;

export function reportingFlowApi(core: ApiCore) {
  return {
    /** Manual approval waits. `advanced_reporting`. */
    getApprovalWaits: async (params?: FlowReportParams, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ approvals: ApprovalWaitReport }>>(
        `/api/reports/flow/approvals${buildQuery(params)}`, { signal: opts?.signal },
      );
      return res.data?.approvals ?? null;
    },

    /** Queue / provisioning time and pipeline start → first stage, current figures. Free. */
    getQueueWaits: async (params?: FlowReportParams, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ queue: QueueWaitReport }>>(
        `/api/reports/flow/queue${buildQuery(params)}`, { signal: opts?.signal },
      );
      return res.data?.queue ?? null;
    },

    /** The queue-time series per bucket. `advanced_reporting`. */
    getQueueWaitTrend: async (params?: FlowReportParams, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ trend: QueueTrendPoint[] }>>(
        `/api/reports/flow/queue/trend${buildQuery(params)}`, { signal: opts?.signal },
      );
      return res.data?.trend ?? [];
    },
  };
}
