// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Reports → Insights tab: the stakeholder report's analytics sections, on
 * demand (`GET /api/reports/insights`, `reports:read` + `advanced_reporting`).
 *
 * The shapes mirror pipeline-data's analytics reads exactly — the backend runs the
 * SAME registered section a stakeholder report runs, so each `data` is what a
 * report over the same window stores as that section's `current`.
 */

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ReportBucketParams } from './reporting';
import type { ApiResponse } from '@/types';

export type InsightSectionId =
  | 'needs_attention'
  | 'failure_analysis'
  | 'promotion'
  | 'resource_consumption'
  | 'outdated_plugins'
  | 'adoption';

export interface AttentionItem {
  pipelineId: string;
  pipelineName: string | null;
  severity: 'high' | 'medium';
  findings: Array<{ rule: string; evidence: string; severity: 'high' | 'medium' }>;
}

export interface NeedsAttentionData {
  items: AttentionItem[];
  pipelinesEvaluated?: number;
  /** Rules that could not run this period because their input failed to load. */
  unavailableRules?: string[];
}

export interface FailureAnalysisData {
  categories: Array<{
    category: string;
    label: string;
    count: number;
    sharePct: number;
    teamActionable: boolean;
    /** Change vs the previous equal-length window, in failures. */
    change: number | null;
    topPipelines: Array<{ pipelineId: string; pipelineName: string | null; count: number }>;
  }>;
  total: number;
  actionableTotal: number;
}

export interface PromotionData {
  commits: Array<{
    commitSha: string;
    stops: Array<{ environment: string; deployedAt: string; hoursFromPrevious: number | null }>;
    stuck: boolean;
    furthest: string;
  }>;
  stuckCount: number;
}

export interface ResourceConsumptionData {
  pipelines: Array<{ project: string | null; pipelineId: string; pipelineName: string | null; buildSeconds: number; runs: number; sharePct: number }>;
  totalBuildSeconds: number;
}

export interface OutdatedPluginsData {
  rows: Array<{
    pipelineId: string;
    pipelineName: string | null;
    stageName: string;
    stepName: string;
    plugin: string;
    inUse: string | null;
    latest: string | null;
    gap: string | null;
    withinPolicy: boolean;
  }>;
  behindPipelines: number;
  majorBehind: number;
}

export interface AdoptionData {
  activePipelines: number;
  totalPipelines: number;
  deployTrackedPipelines: number;
  bySource: Record<string, number>;
  activeTeams: number;
  estimatedMinutesSaved: number | null;
}

/** Section id → its `data` shape. */
export interface InsightDataById {
  needs_attention: NeedsAttentionData;
  failure_analysis: FailureAnalysisData;
  promotion: PromotionData;
  resource_consumption: ResourceConsumptionData;
  outdated_plugins: OutdatedPluginsData;
  adoption: AdoptionData;
}

/** One section's result; `failed` is isolated to its own card. */
export interface InsightSection<K extends InsightSectionId = InsightSectionId> {
  id: K;
  title: string;
  state: 'ok' | 'failed';
  data?: InsightDataById[K];
}

export interface InsightsResult {
  window: { from: string; to: string; tz: string; weekStart: 'monday' | 'sunday'; previous: { from: string; to: string } };
  sections: InsightSection[];
}

export type InsightsParams = {
  from?: string;
  to?: string;
  includeDescendants?: boolean;
  /** Comma-separated subset of {@link InsightSectionId}; omitted = all six. */
  sections?: string;
} & ReportBucketParams;

export function reportingInsightsApi(core: ApiCore) {
  return {
    /** The Insights tab's analytics sections over one window (advanced_reporting). */
    getInsights: async (params?: InsightsParams, opts?: { signal?: AbortSignal }): Promise<InsightsResult | null> => {
      const res = await core.request<ApiResponse<{ insights: InsightsResult }>>(`/api/reports/insights${buildQuery(params)}`, { signal: opts?.signal });
      return res.data?.insights ?? null;
    },
  };
}
