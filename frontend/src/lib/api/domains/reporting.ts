// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, Plugin, Pipeline } from '@/types';

export function reportingApi(core: ApiCore) {
  return {
    // ============================================
    // Reporting endpoints
    // ============================================

    /** Pipeline execution count per pipeline with status breakdown. */
    getExecutionCount: async (params?: { includeDescendants?: boolean }) => {
      return core.request<ApiResponse<{ pipelines: Array<{ id: string; project: string; organization: string; pipeline_name: string | null; total: number; succeeded: number; failed: number; canceled: number; first_execution: string | null; last_execution: string | null }> }>>(`/api/reports/execution/count${buildQuery(params)}`);
    },

    /** Pipeline success rate over time. */
    getSuccessRate: async (params?: { interval?: string; from?: string; to?: string; includeDescendants?: boolean }) => {
      return core.request<ApiResponse<{ timeline: Array<{ period: string; succeeded: number; failed: number; canceled: number; success_pct: number }> }>>(`/api/reports/execution/success-rate${buildQuery(params)}`);
    },

    /** Average pipeline duration stats. */
    getPipelineDuration: async (params?: { from?: string; to?: string; includeDescendants?: boolean }) => {
      return core.request<ApiResponse<{ pipelines: Array<{ id: string; project: string; pipeline_name: string | null; avg_ms: number; min_ms: number; max_ms: number; p95_ms: number; executions: number }> }>>(`/api/reports/execution/duration${buildQuery(params)}`);
    },

    /** Stage failure heatmap. */
    getStageFailures: async (params?: { from?: string; to?: string }) => {
      return core.request<ApiResponse<{ stages: Array<{ stage_name: string; failures: number; total: number; failure_pct: number }> }>>(`/api/reports/execution/stage-failures${buildQuery(params)}`);
    },

    /** Stage bottlenecks — slowest stages. */
    getStageBottlenecks: async (params?: { from?: string; to?: string }) => {
      return core.request<ApiResponse<{ stages: Array<{ id: string; pipeline_name: string | null; stage_name: string; avg_ms: number; max_ms: number }> }>>(`/api/reports/execution/stage-bottlenecks${buildQuery(params)}`);
    },

    /** Action failure rate. */
    getActionFailures: async (params?: { from?: string; to?: string }) => {
      return core.request<ApiResponse<{ actions: Array<{ action_name: string; failures: number; total: number; failure_pct: number }> }>>(`/api/reports/execution/action-failures${buildQuery(params)}`);
    },

    /** Error categorization. */
    getExecutionErrors: async (params?: { from?: string; to?: string; limit?: number }) => {
      return core.request<ApiResponse<{ errors: Array<{ error_pattern: string; occurrences: number; affected_pipelines: number; last_seen: string }> }>>(`/api/reports/execution/errors${buildQuery(params)}`);
    },

    /** Plugin inventory summary. */
    getPluginSummary: async () => {
      return core.request<ApiResponse<{ summary: { total: number; active: number; inactive: number; public: number; private: number; unique_names: number } }>>('/api/reports/plugins/summary');
    },

    /** Plugin type & compute distribution. */
    getPluginDistribution: async () => {
      return core.request<ApiResponse<{ distribution: Array<{ plugin_type: string; compute_type: string; count: number }> }>>('/api/reports/plugins/distribution');
    },

    /** Plugin version counts. */
    getPluginVersions: async () => {
      return core.request<ApiResponse<{ plugins: Array<{ name: string; version_count: number; latest_version: string; has_default: boolean }> }>>('/api/reports/plugins/versions');
    },

    /** Plugin build success rate over time. */
    getBuildSuccessRate: async (params?: { interval?: string; from?: string; to?: string }) => {
      return core.request<ApiResponse<{ timeline: Array<{ period: string; succeeded: number; failed: number; success_pct: number }> }>>(`/api/reports/plugins/build-success-rate${buildQuery(params)}`);
    },

    /** Plugin build duration stats. */
    getBuildDuration: async (params?: { from?: string; to?: string }) => {
      return core.request<ApiResponse<{ plugins: Array<{ plugin_name: string; avg_ms: number; max_ms: number; builds: number }> }>>(`/api/reports/plugins/build-duration${buildQuery(params)}`);
    },

    /** Plugin build failures. */
    getBuildFailures: async (params?: { from?: string; to?: string; limit?: number }) => {
      return core.request<ApiResponse<{ failures: Array<{ plugin_name: string; error_message: string; occurrences: number; last_seen: string }> }>>(`/api/reports/plugins/build-failures${buildQuery(params)}`);
    },
  };
}
